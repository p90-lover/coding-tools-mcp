package plugin

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

func TestCommandCodeLoginCallback(t *testing.T) {
	p := &CommandCodeGoPlugin{}
	start, err := p.StartLogin(context.Background(), pluginapi.AuthLoginStartRequest{})
	if err != nil {
		t.Fatal(err)
	}
	loginURL, err := url.Parse(start.URL)
	if err != nil {
		t.Fatal(err)
	}
	callback := loginURL.Query().Get("callback")
	if callback == "" || loginURL.Query().Get("state") != start.State {
		t.Fatal("invalid login URL")
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
	pending, err := p.PollLogin(context.Background(), pluginapi.AuthLoginPollRequest{State: start.State})
	if err != nil || pending.Status != pluginapi.AuthLoginStatusPending {
		t.Fatalf("pending: %#v %v", pending, err)
	}

	good, err := client.Post(callback+"?state="+start.State, "application/x-www-form-urlencoded", strings.NewReader("apiKey=user_test"))
	if err != nil {
		t.Fatal(err)
	}
	good.Body.Close()
	if good.StatusCode != http.StatusOK {
		t.Fatalf("callback: %d", good.StatusCode)
	}
	done, err := p.PollLogin(context.Background(), pluginapi.AuthLoginPollRequest{State: start.State})
	if err != nil || done.Status != pluginapi.AuthLoginStatusSuccess {
		t.Fatalf("done: %#v %v", done, err)
	}
	if keyFromStorage(done.Auth.StorageJSON) != "user_test" {
		t.Fatal("auth key not saved")
	}
	parsed, err := p.ParseAuth(context.Background(), pluginapi.AuthParseRequest{FileName: done.Auth.FileName, RawJSON: done.Auth.StorageJSON})
	if err != nil || !parsed.Handled {
		t.Fatalf("parse: %#v %v", parsed, err)
	}
}
