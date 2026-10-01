package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/chenyme/grok2api/backend/internal/infra/provider"
)

const ssoResolveTimeout = 2 * time.Minute

// resolveSSO turns a cookie-only account into a saved account:
//   - Web and Console: grok2api's SyncAccountIdentity checks the cookie against the upstream
//     session endpoint and fills email/user_id. A 401 rejects the cookie; any other failure
//     (Cloudflare, network) keeps the account, since chat may still work through the proxy.
//   - Build: grok2api's SSO→Build conversion drives xAI's device flow with the cookie and
//     returns real OAuth tokens (see the patched infra/provider/web/sso_build.go).
func resolveSSO(ctx context.Context, rt *grokRuntime, value grokStorage) (grokStorage, error) {
	ctx, cancel := context.WithTimeout(ctx, ssoResolveTimeout)
	defer cancel()
	if value.Upstream == upstreamBuild {
		webView := value
		webView.Upstream = upstreamWeb
		credential, errCredential := rt.credential(webView)
		if errCredential != nil {
			return grokStorage{}, errCredential
		}
		seed, errConvert := rt.web.ConvertToBuild(ctx, credential)
		if errConvert != nil {
			if errors.Is(errConvert, provider.ErrUnauthorized) {
				return grokStorage{}, fmt.Errorf("cookie is not signed in to xAI")
			}
			return grokStorage{}, fmt.Errorf("cookie to OAuth conversion failed: %w", errConvert)
		}
		converted := seedStorage(upstreamBuild, seed, "login:sso-convert")
		converted.ProxyURL = value.ProxyURL
		return converted, nil
	}

	credential, errCredential := rt.credential(value)
	if errCredential != nil {
		return grokStorage{}, errCredential
	}
	var (
		identity    provider.AccountIdentity
		errIdentity error
	)
	if value.Upstream == upstreamConsole {
		identity, errIdentity = rt.console.SyncAccountIdentity(ctx, credential)
	} else {
		identity, errIdentity = rt.web.SyncAccountIdentity(ctx, credential)
	}
	if errors.Is(errIdentity, provider.ErrUnauthorized) {
		return grokStorage{}, fmt.Errorf("cookie is signed out or expired")
	}
	if errIdentity != nil {
		hostLog("warn", "grok sso identity check failed; keeping account", map[string]any{"upstream": value.Upstream, "error": errIdentity.Error()})
		return value, nil
	}
	value.Email = firstNonEmpty(identity.Email, value.Email)
	value.UserID = firstNonEmpty(identity.UserID, value.UserID)
	value.TeamID = firstNonEmpty(identity.TeamID, value.TeamID)
	return value, nil
}
