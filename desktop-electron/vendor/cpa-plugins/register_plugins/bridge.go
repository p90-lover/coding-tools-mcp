package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"time"
)

const bridgeResponseLimit = 16 << 20

var safeIdentity = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
var safeToken = regexp.MustCompile(`^[A-Za-z0-9_-]{32,256}$`)
var errBridge = errors.New("Register service is unavailable; open Register in Coding Tools and retry")

type descriptor struct {
	SchemaVersion int    `json:"schema_version"`
	URL           string `json:"url"`
	Token         string `json:"token"`
	SourceID      string `json:"source_id"`
}

type bridge struct {
	descriptor
	client *http.Client
}

func readBoundedFile(path string, max int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return nil, errors.New("invalid private file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("private file is unavailable")
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, errors.New("private file changed")
	}
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(b)) > max {
		return nil, errors.New("invalid private file")
	}
	return b, nil
}

func openBridge(path string) (*bridge, error) {
	raw, err := readBoundedFile(path, 4096)
	if err != nil {
		return nil, errBridge
	}
	var d descriptor
	if json.Unmarshal(raw, &d) != nil || d.SchemaVersion != 1 || !safeIdentity.MatchString(d.SourceID) || !safeToken.MatchString(d.Token) {
		return nil, errBridge
	}
	u, err := url.Parse(d.URL)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.RawPath != "" || (u.Path != "" && u.Path != "/") {
		return nil, errBridge
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != "127.0.0.1:"+strconv.Itoa(port) {
		return nil, errBridge
	}
	d.URL = "http://" + u.Host
	return &bridge{descriptor: d, client: &http.Client{
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (b *bridge) request(ctx context.Context, method, path string, body any, out any) error {
	timeout := 30 * time.Second
	if path == "/v1/start" {
		timeout = 60 * time.Second
	} else if path == "/v1/refresh" {
		timeout = 120 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, b.URL+path, bytes.NewReader(data))
	if err != nil {
		return errBridge
	}
	req.Header.Set("Authorization", "Bearer "+b.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := b.client.Do(req)
	if err != nil {
		return errBridge
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errBridge
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, bridgeResponseLimit+1))
	if err != nil || len(raw) > bridgeResponseLimit {
		return errBridge
	}
	var identity struct {
		SourceID string `json:"source_id"`
	}
	if json.Unmarshal(raw, &identity) != nil || identity.SourceID != b.SourceID || json.Unmarshal(raw, out) != nil {
		return errBridge
	}
	return nil
}

type sourceStatus struct {
	SourceID string `json:"source_id"`
	Ready    bool   `json:"ready"`
	Owned    bool   `json:"owned"`
	Starting bool   `json:"starting"`
}

type sourceAccount struct {
	ID       int64  `json:"id"`
	Email    string `json:"email"`
	Eligible bool   `json:"eligible"`
	Disabled bool   `json:"disabled"`
	Revision string `json:"revision"`
}

func (b *bridge) accounts(ctx context.Context) ([]sourceAccount, error) {
	var response struct {
		Accounts []sourceAccount `json:"accounts"`
	}
	if err := b.request(ctx, "GET", "/v1/accounts", nil, &response); err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	if len(response.Accounts) > 10000 {
		return nil, errBridge
	}
	for _, a := range response.Accounts {
		if a.ID < 1 || a.ID > 9007199254740991 || seen[a.ID] || len(a.Email) > 320 || len(a.Revision) > 256 || (a.Eligible && a.Revision == "") {
			return nil, errBridge
		}
		seen[a.ID] = true
	}
	return response.Accounts, nil
}
