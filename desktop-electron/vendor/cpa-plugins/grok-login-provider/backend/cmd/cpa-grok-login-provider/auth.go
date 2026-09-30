package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/chenyme/grok2api/backend/internal/infra/provider"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const (
	ssoRefreshInterval  = 365 * 24 * time.Hour
	oauthRefreshLead    = 10 * time.Minute
	defaultOAuthRefresh = 50 * time.Minute
	refreshTimeout      = 45 * time.Second
)

func parseAuth(raw []byte) ([]byte, error) {
	var req pluginapi.AuthParseRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	rememberHost(req.Host)
	if requested := strings.ToLower(strings.TrimSpace(req.Provider)); requested != "" && requested != providerIdentifier {
		return okEnvelope(pluginapi.AuthParseResponse{Handled: false})
	}
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		return nil, errRuntime
	}
	accounts, format, errDetect := detectedAccounts(rt, req.RawJSON)
	if format == formatUnknown {
		return okEnvelope(pluginapi.AuthParseResponse{Handled: false})
	}
	if errDetect != nil {
		return upstreamErrorEnvelope("invalid_auth", "grok "+format.String()+" file: "+errDetect.Error(), 400, false), nil
	}
	if len(accounts) == 0 {
		return upstreamErrorEnvelope("invalid_auth", "grok "+format.String()+" file has no accounts", 400, false), nil
	}
	auths := make([]pluginapi.AuthData, 0, len(accounts))
	for _, value := range accounts {
		storage := value.marshal()
		if format == formatGrokStorage {
			storage = req.RawJSON // our own file: keep CPA-owned keys byte for byte
		}
		data := authData(value, storage, req.FileName)
		// CPA derives an empty ID from the file path, so every account of a multi-account
		// export would share one ID and all but the last would be dropped. The suffix is the
		// account's stable identity, so re-parsing the same file keeps the same IDs.
		if len(accounts) > 1 {
			data.ID = firstNonEmpty(req.FileName, "grok.json") + "#" + strings.TrimSuffix(value.fileName(), ".json")
		}
		auths = append(auths, data)
	}
	hostLog("info", "grok auth file recognized", map[string]any{"format": format.String(), "accounts": len(auths), "file": req.FileName})
	return okEnvelope(pluginapi.AuthParseResponse{Handled: true, Auth: auths[0], Auths: auths})
}

func authData(value grokStorage, storage []byte, fileName string) pluginapi.AuthData {
	return pluginapi.AuthData{
		Provider:    providerIdentifier,
		FileName:    firstNonEmpty(fileName, value.fileName()),
		Label:       value.displayLabel(),
		ProxyURL:    strings.TrimSpace(value.ProxyURL),
		Disabled:    value.Disabled,
		StorageJSON: storage,
		Metadata: map[string]any{
			"type": providerIdentifier, "grok_upstream": value.Upstream, "auth_kind": value.AuthKind,
			"email": value.Email,
		},
		Attributes:       map[string]string{"grok_upstream": value.Upstream},
		NextRefreshAfter: nextRefresh(value),
	}
}

// nextRefresh schedules OAuth refresh ahead of expiry. A refresh-token-only import (no access
// token yet) refreshes immediately; SSO cookies have no refresh flow.
func nextRefresh(value grokStorage) time.Time {
	now := time.Now().UTC()
	if value.Upstream != upstreamBuild {
		return now.Add(ssoRefreshInterval)
	}
	if strings.TrimSpace(value.AccessToken) == "" {
		return now
	}
	expires := value.expiresAt()
	if expires.IsZero() {
		if claims := jwtClaims(value.AccessToken); claims != nil {
			if exp, ok := claims["exp"].(float64); ok && exp > 0 {
				expires = time.Unix(int64(exp), 0).UTC()
			}
		}
	}
	if expires.IsZero() {
		return now.Add(defaultOAuthRefresh)
	}
	if next := expires.Add(-oauthRefreshLead); next.After(now) {
		return next
	}
	return now
}

func refreshAuth(raw []byte) ([]byte, error) {
	var req rpcAuthRefreshRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	rememberHost(req.Host)
	value, errDecode := decodeStorage(req.StorageJSON)
	if errDecode != nil {
		return upstreamErrorEnvelope("invalid_auth", errDecode.Error(), 401, false), nil
	}
	if value.Upstream == upstreamBuild {
		refreshed, errRefresh := refreshBuildTokens(value)
		if errRefresh != nil {
			status, retryable := refreshFailureStatus(errRefresh)
			return upstreamErrorEnvelope("refresh_failed", errRefresh.Error(), status, retryable), nil
		}
		value = refreshed
	}
	data := authData(value, patchStorage(req.StorageJSON, value), "")
	data.ID = req.AuthID
	data.Metadata = mergeMetadata(req.Metadata, data.Metadata)
	data.Attributes = req.Attributes
	return okEnvelope(pluginapi.AuthRefreshResponse{Auth: data, NextRefreshAfter: data.NextRefreshAfter})
}

// refreshBuildTokens runs grok2api's OAuth refresh (auth.x.ai, rotating refresh tokens).
func refreshBuildTokens(value grokStorage) (grokStorage, error) {
	if strings.TrimSpace(value.RefreshToken) == "" {
		return grokStorage{}, &provider.CredentialRefreshError{Code: "missing_refresh_token", Message: "grok build auth has no refresh_token", Permanent: true}
	}
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		return grokStorage{}, errRuntime
	}
	credential, errCredential := rt.credential(value)
	if errCredential != nil {
		return grokStorage{}, errCredential
	}
	ctx, cancel := context.WithTimeout(context.Background(), refreshTimeout)
	defer cancel()
	result, errRefresh := rt.build.RefreshCredential(ctx, credential)
	if errRefresh != nil {
		return grokStorage{}, errRefresh
	}
	access, errAccess := rt.cipher.Decrypt(result.EncryptedAccessToken)
	if errAccess != nil {
		return grokStorage{}, errAccess
	}
	refresh, errRefreshToken := rt.cipher.Decrypt(result.EncryptedRefreshToken)
	if errRefreshToken != nil {
		return grokStorage{}, errRefreshToken
	}
	value.AccessToken = access
	value.RefreshToken = firstNonEmpty(refresh, value.RefreshToken)
	if !result.ExpiresAt.IsZero() {
		value.ExpiresAt = result.ExpiresAt.UTC().Format(time.RFC3339Nano)
	}
	if claims := jwtClaims(access); claims != nil {
		value.UserID = firstNonEmpty(value.UserID, claimString(claims, "sub"))
		value.Email = firstNonEmpty(value.Email, claimString(claims, "email"))
	}
	return value, nil
}

// refreshFailureStatus maps grok2api's refresh errors onto CPA: permanent OAuth failures are
// 401 (re-login needed); transport and 5xx failures stay retryable.
func refreshFailureStatus(err error) (int, bool) {
	var refreshErr *provider.CredentialRefreshError
	if errors.As(err, &refreshErr) {
		if refreshErr.Permanent {
			return 401, false
		}
		if refreshErr.Status >= 500 || refreshErr.Status == 429 {
			return refreshErr.Status, true
		}
		if refreshErr.Status == 400 || refreshErr.Status == 401 || refreshErr.Status == 403 {
			return 401, false
		}
	}
	return 502, true
}

func mergeMetadata(base, overlay map[string]any) map[string]any {
	merged := make(map[string]any, len(base)+len(overlay))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range overlay {
		merged[key] = value
	}
	return merged
}
