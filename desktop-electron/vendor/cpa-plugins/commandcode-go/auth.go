package plugin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

type commandCodeAuth struct {
	Type     string `json:"type"`
	APIKey   string `json:"api_key"`
	AltKey   string `json:"apiKey"`
	Label    string `json:"label"`
	ProxyURL string `json:"proxy_url"`
	Disabled bool   `json:"disabled"`
}

func keyFromStorage(raw []byte) string {
	var auth commandCodeAuth
	if json.Unmarshal(raw, &auth) != nil {
		return ""
	}
	if key := strings.TrimSpace(auth.APIKey); key != "" {
		return key
	}
	return strings.TrimSpace(auth.AltKey)
}

func authData(key, label, proxyURL string, disabled bool) (pluginapi.AuthData, error) {
	digest := sha256.Sum256([]byte(key))
	name := Provider + "-" + hex.EncodeToString(digest[:8]) + ".json"
	storage, err := json.Marshal(commandCodeAuth{
		Type: Provider, APIKey: key, Label: label, ProxyURL: proxyURL, Disabled: disabled,
	})
	if err != nil {
		return pluginapi.AuthData{}, err
	}
	if label == "" {
		label = "CommandCode " + hex.EncodeToString(digest[:4])
	}
	return pluginapi.AuthData{
		Provider: Provider, ID: name, FileName: name, Label: label,
		ProxyURL: proxyURL, Disabled: disabled, StorageJSON: storage,
		Metadata:         map[string]any{"type": Provider},
		NextRefreshAfter: time.Now().UTC().Add(365 * 24 * time.Hour),
	}, nil
}

func (p *CommandCodeGoPlugin) ParseAuth(_ context.Context, req pluginapi.AuthParseRequest) (pluginapi.AuthParseResponse, error) {
	var auth commandCodeAuth
	if json.Unmarshal(req.RawJSON, &auth) != nil || auth.Type != Provider {
		return pluginapi.AuthParseResponse{Handled: false}, nil
	}
	key := keyFromStorage(req.RawJSON)
	if key == "" {
		return pluginapi.AuthParseResponse{}, fmt.Errorf("commandcode auth file has no api_key")
	}
	data, err := authData(key, auth.Label, auth.ProxyURL, auth.Disabled)
	if err != nil {
		return pluginapi.AuthParseResponse{}, err
	}
	if req.FileName != "" {
		data.FileName = req.FileName
		data.ID = req.FileName
	}
	data.StorageJSON = req.RawJSON
	return pluginapi.AuthParseResponse{Handled: true, Auth: data}, nil
}

func (p *CommandCodeGoPlugin) RefreshAuth(_ context.Context, req pluginapi.AuthRefreshRequest) (pluginapi.AuthRefreshResponse, error) {
	var auth commandCodeAuth
	if json.Unmarshal(req.StorageJSON, &auth) != nil || keyFromStorage(req.StorageJSON) == "" {
		return pluginapi.AuthRefreshResponse{}, fmt.Errorf("commandcode auth file has no api_key")
	}
	data, err := authData(keyFromStorage(req.StorageJSON), auth.Label, auth.ProxyURL, auth.Disabled)
	if err != nil {
		return pluginapi.AuthRefreshResponse{}, err
	}
	data.ID = req.AuthID
	data.StorageJSON = req.StorageJSON
	data.Metadata = req.Metadata
	data.Attributes = req.Attributes
	return pluginapi.AuthRefreshResponse{Auth: data, NextRefreshAfter: data.NextRefreshAfter}, nil
}

type loginSession struct {
	sync.Mutex
	key     string
	expires time.Time
	server  *http.Server
}

var commandCodeLogins = struct {
	sync.Mutex
	sessions map[string]*loginSession
}{sessions: make(map[string]*loginSession)}

func (p *CommandCodeGoPlugin) StartLogin(_ context.Context, _ pluginapi.AuthLoginStartRequest) (pluginapi.AuthLoginStartResponse, error) {
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return pluginapi.AuthLoginStartResponse{}, err
	}
	state := hex.EncodeToString(random)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return pluginapi.AuthLoginStartResponse{}, err
	}
	session := &loginSession{expires: time.Now().Add(5 * time.Minute)}
	mux := http.NewServeMux()
	mux.HandleFunc("/commandcode/callback", func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		_ = r.ParseForm()
		values := r.Form
		if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
			var body map[string]string
			if json.NewDecoder(r.Body).Decode(&body) == nil {
				for key, value := range body {
					values.Set(key, value)
				}
			}
		}
		if values.Get("state") != state {
			http.Error(w, "CommandCode login state did not match", http.StatusBadRequest)
			return
		}
		key := ""
		for _, field := range []string{"apiKey", "api_key", "token", "credential", "key"} {
			if key = strings.TrimSpace(values.Get(field)); key != "" {
				break
			}
		}
		if key == "" {
			http.Error(w, "CommandCode login did not return a key", http.StatusBadRequest)
			return
		}
		session.Lock()
		session.key = key
		session.Unlock()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>CommandCode connected</title><h1>CommandCode connected</h1><p>Return to Coding Tools.</p>")
		go session.server.Close()
	})
	session.server = &http.Server{Handler: mux}
	commandCodeLogins.Lock()
	commandCodeLogins.sessions[state] = session
	commandCodeLogins.Unlock()
	go session.server.Serve(listener)
	time.AfterFunc(5*time.Minute, func() {
		commandCodeLogins.Lock()
		delete(commandCodeLogins.sessions, state)
		commandCodeLogins.Unlock()
		_ = session.server.Close()
	})
	callback := fmt.Sprintf("http://127.0.0.1:%d/commandcode/callback", listener.Addr().(*net.TCPAddr).Port)
	loginURL, _ := url.Parse("https://commandcode.ai/studio/auth/cli")
	query := loginURL.Query()
	query.Set("callback", callback)
	query.Set("state", state)
	loginURL.RawQuery = query.Encode()
	return pluginapi.AuthLoginStartResponse{
		Provider: Provider, URL: loginURL.String(), State: state, ExpiresAt: session.expires,
	}, nil
}

func (p *CommandCodeGoPlugin) PollLogin(_ context.Context, req pluginapi.AuthLoginPollRequest) (pluginapi.AuthLoginPollResponse, error) {
	commandCodeLogins.Lock()
	session := commandCodeLogins.sessions[req.State]
	commandCodeLogins.Unlock()
	if session == nil || time.Now().After(session.expires) {
		return pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusError, Message: "CommandCode login expired"}, nil
	}
	session.Lock()
	key := session.key
	session.Unlock()
	if key == "" {
		return pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusPending}, nil
	}
	data, err := authData(key, "", "", false)
	if err != nil {
		return pluginapi.AuthLoginPollResponse{}, err
	}
	commandCodeLogins.Lock()
	delete(commandCodeLogins.sessions, req.State)
	commandCodeLogins.Unlock()
	return pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusSuccess, Auth: data}, nil
}
