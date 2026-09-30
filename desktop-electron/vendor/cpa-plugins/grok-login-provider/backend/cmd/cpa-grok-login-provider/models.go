package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	modeldomain "github.com/chenyme/grok2api/backend/internal/domain/model"
	"github.com/chenyme/grok2api/backend/internal/infra/provider/console"
	"github.com/chenyme/grok2api/backend/internal/infra/provider/web"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const modelDiscoveryTimeout = 30 * time.Second

// staticModels is intentionally empty: every Grok account lists its own models, because
// Web models depend on the account tier and Build models come from the live catalog.
func staticModels() ([]byte, error) {
	return okEnvelope(pluginapi.ModelResponse{Provider: providerIdentifier})
}

func modelsForAuth(raw []byte) ([]byte, error) {
	var req rpcAuthModelRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	rememberHost(req.Host)
	value, errDecode := decodeStorage(req.StorageJSON)
	if errDecode != nil {
		return okEnvelope(pluginapi.ModelResponse{Provider: providerIdentifier})
	}
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		return nil, errRuntime
	}
	ctx, cancel := context.WithTimeout(context.Background(), modelDiscoveryTimeout)
	defer cancel()

	response := pluginapi.ModelResponse{Provider: providerIdentifier}
	var ids []string
	switch value.Upstream {
	case upstreamBuild:
		ids = buildModels(ctx, rt, value)
	case upstreamWeb:
		updated := syncWebTier(ctx, rt, value)
		if updated.WebTier != value.WebTier {
			response.AuthUpdate = authData(updated, patchStorage(req.StorageJSON, updated), "")
			response.AuthUpdate.ID = req.AuthID
			value = updated
		}
		credential, _ := rt.credential(value)
		ids, _ = rt.web.ListModels(ctx, credential)
	case upstreamConsole:
		for _, spec := range console.Catalog() {
			ids = append(ids, spec.UpstreamModel)
		}
	}
	response.Models = modelInfos(value, chatModels(ids))
	return okEnvelope(response)
}

// buildModels asks cli-chat-proxy for the account's live catalog and falls back to the known
// Build/Console chat models when discovery fails (expired token before refresh, network).
func buildModels(ctx context.Context, rt *grokRuntime, value grokStorage) []string {
	if strings.TrimSpace(value.AccessToken) != "" {
		if credential, errCredential := rt.credential(value); errCredential == nil {
			if ids, errList := rt.build.ListModels(ctx, credential); errList == nil && len(ids) > 0 {
				return ids
			} else if errList != nil {
				hostLog("warn", "grok build model discovery failed; using fallback catalog", map[string]any{"error": errList.Error()})
			}
		}
	}
	ids := []string{"grok-4.6", "grok-4.7", "grok-composer-2.5-fast"}
	for _, spec := range console.Catalog() {
		ids = append(ids, spec.UpstreamModel)
	}
	return ids
}

// syncWebTier reads the account's quota windows once to learn Basic/Super/Heavy, which gates
// grok-chat-auto/expert/heavy. Failures leave the tier unchanged (Basic models only).
func syncWebTier(ctx context.Context, rt *grokRuntime, value grokStorage) grokStorage {
	if value.WebTier != "" && value.WebTier != "auto" {
		return value
	}
	credential, errCredential := rt.credential(value)
	if errCredential != nil {
		return value
	}
	snapshot, errQuota := rt.web.SyncQuota(ctx, credential)
	if errQuota != nil || snapshot.Tier == "" {
		return value
	}
	value.WebTier = string(snapshot.Tier)
	return value
}

// chatModels drops media and voice models; this executor serves text protocols only.
func chatModels(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	values := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		lower := strings.ToLower(id)
		if id == "" || strings.Contains(lower, "imagine") || strings.Contains(lower, "voice") || strings.HasSuffix(lower, "-stt") || lower == "grok-stt" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		values = append(values, id)
	}
	sort.Strings(values)
	return values
}

func modelInfos(value grokStorage, ids []string) []pluginapi.ModelInfo {
	provider := value.accountProvider()
	webNames := map[string]string{}
	for _, spec := range web.Catalog() {
		webNames[spec.UpstreamModel] = "Grok Web " + strings.TrimPrefix(spec.PublicID, "grok-chat-")
	}
	models := make([]pluginapi.ModelInfo, 0, len(ids))
	for _, id := range ids {
		info := pluginapi.ModelInfo{
			ID: id, Object: "model", Created: time.Now().Unix(), OwnedBy: "xai", Type: providerIdentifier,
			Name: id, DisplayName: firstNonEmpty(webNames[id], id),
			Description: "Grok " + upstreamTitle(value.Upstream) + " via grok-login-provider",
		}
		if modeldomain.SupportsReasoningForProvider(provider, id) {
			info.Thinking = &pluginapi.ThinkingSupport{Levels: []string{"low", "medium", "high"}, DynamicAllowed: true}
		}
		models = append(models, info)
	}
	return models
}
