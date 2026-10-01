package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

func TestStudioBrowserLogin(t *testing.T) {
	raw, err := loginStart(mustJSON(t, pluginapi.AuthLoginStartRequest{Provider: providerIdentifier}))
	if err != nil {
		t.Fatal(err)
	}
	env := decodeEnvelope(t, raw)
	if !env.OK {
		t.Fatalf("start: %+v", env.Error)
	}
	var start pluginapi.AuthLoginStartResponse
	if err := json.Unmarshal(env.Result, &start); err != nil {
		t.Fatal(err)
	}
	loginURL, err := url.Parse(start.URL)
	if err != nil {
		t.Fatal(err)
	}
	callback := loginURL.Query().Get("callback")
	if callback == "" || loginURL.Query().Get("state") != start.State {
		t.Fatal("invalid callback")
	}

	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	bad, err := client.Get(callback + "?state=wrong&apiKey=user_bad")
	if err != nil {
		t.Fatal(err)
	}
	bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong state: %d", bad.StatusCode)
	}

	pendingRaw, err := loginPoll(mustJSON(t, pluginapi.AuthLoginPollRequest{State: start.State}))
	if err != nil {
		t.Fatal(err)
	}
	var pending pluginapi.AuthLoginPollResponse
	_ = json.Unmarshal(decodeEnvelope(t, pendingRaw).Result, &pending)
	if pending.Status != pluginapi.AuthLoginStatusPending {
		t.Fatalf("pending: %s", pending.Status)
	}

	good, err := client.Post(callback+"?state="+start.State, "application/x-www-form-urlencoded", strings.NewReader("apiKey=user_test"))
	if err != nil {
		t.Fatal(err)
	}
	good.Body.Close()
	if good.StatusCode != http.StatusOK {
		t.Fatalf("callback: %d", good.StatusCode)
	}
	doneRaw, err := loginPoll(mustJSON(t, pluginapi.AuthLoginPollRequest{State: start.State}))
	if err != nil {
		t.Fatal(err)
	}
	var done pluginapi.AuthLoginPollResponse
	_ = json.Unmarshal(decodeEnvelope(t, doneRaw).Result, &done)
	if done.Status != pluginapi.AuthLoginStatusSuccess || apiKeyFromStorage(done.Auth.StorageJSON) != "user_test" {
		t.Fatalf("login did not persist Studio auth: %s %s", done.Status, done.Message)
	}
}
