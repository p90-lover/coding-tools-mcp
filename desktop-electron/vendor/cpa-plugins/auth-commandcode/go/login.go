package main

import (
	"crypto/rand"
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

type studioLoginSession struct {
	sync.Mutex
	key     string
	expires time.Time
	server  *http.Server
}

var studioLogins = struct {
	sync.Mutex
	sessions map[string]*studioLoginSession
}{sessions: make(map[string]*studioLoginSession)}

func loginStart(raw []byte) ([]byte, error) {
	var req pluginapi.AuthLoginStartRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	state := hex.EncodeToString(random)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	session := &studioLoginSession{expires: time.Now().Add(5 * time.Minute)}
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
	studioLogins.Lock()
	studioLogins.sessions[state] = session
	studioLogins.Unlock()
	go session.server.Serve(listener)
	time.AfterFunc(5*time.Minute, func() {
		studioLogins.Lock()
		delete(studioLogins.sessions, state)
		studioLogins.Unlock()
		_ = session.server.Close()
	})
	callback := fmt.Sprintf("http://127.0.0.1:%d/commandcode/callback", listener.Addr().(*net.TCPAddr).Port)
	loginURL, _ := url.Parse("https://commandcode.ai/studio/auth/cli")
	query := loginURL.Query()
	query.Set("callback", callback)
	query.Set("state", state)
	loginURL.RawQuery = query.Encode()
	return okEnvelope(pluginapi.AuthLoginStartResponse{
		Provider: providerIdentifier, URL: loginURL.String(), State: state, ExpiresAt: session.expires,
	})
}

func loginPoll(raw []byte) ([]byte, error) {
	var req pluginapi.AuthLoginPollRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}
	studioLogins.Lock()
	session := studioLogins.sessions[req.State]
	studioLogins.Unlock()
	if session == nil || time.Now().After(session.expires) {
		return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusError, Message: "CommandCode login expired"})
	}
	session.Lock()
	key := session.key
	session.Unlock()
	if key == "" {
		return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusPending})
	}
	studioLogins.Lock()
	delete(studioLogins.sessions, req.State)
	studioLogins.Unlock()
	auth, err := importedAuthData(key)
	if err != nil {
		return nil, err
	}
	return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusSuccess, Auth: auth})
}
