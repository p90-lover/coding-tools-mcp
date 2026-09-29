package plugin

import (
	"context"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

// ModelProvider contributes the commandcode-go model list to the host
// registry. StaticModels has no HTTPClient, so the list is derived from the
// same configuration that drives routing, keeping the two in step.
type ModelProvider struct {
	cfg *pluginConfig
}

func NewModelProvider(cfg *pluginConfig) *ModelProvider { return &ModelProvider{cfg: cfg} }

// modelDef is the registry-facing shape of one claimed model.
type modelDef struct {
	id          string
	displayName string
}

// registryModels builds the advertised list from configuration. IDs use the
// commandcode-go namespace deliberately: the host skips plugin models that
// any native executor already serves, so reusing bare vendor names could
// leave this executor permanently unregistered.
func (p *ModelProvider) registryModels() []modelDef {
	defs := make([]modelDef, 0, len(p.cfg.effectiveModels()))
	for _, entry := range p.cfg.effectiveModels() {
		name := strings.TrimSpace(entry.Alias)
		if name == "" {
			name = strings.TrimSpace(entry.Name)
		}
		if name == "" {
			continue
		}
		defs = append(defs, modelDef{
			id:          Provider + "/" + name,
			displayName: entry.label() + " via CommandCode Go",
		})
	}
	return defs
}

func (p *ModelProvider) StaticModels(context.Context, pluginapi.StaticModelRequest) (pluginapi.ModelResponse, error) {
	return pluginapi.ModelResponse{Provider: Provider, Models: p.models()}, nil
}

func (p *ModelProvider) ModelsForAuth(context.Context, pluginapi.AuthModelRequest) (pluginapi.ModelResponse, error) {
	return pluginapi.ModelResponse{Provider: Provider, Models: p.models()}, nil
}

func (p *ModelProvider) models() []pluginapi.ModelInfo {
	defs := p.registryModels()
	models := make([]pluginapi.ModelInfo, 0, len(defs))
	for _, def := range defs {
		models = append(models, pluginapi.ModelInfo{
			ID:                         def.id,
			Object:                     "model",
			OwnedBy:                    Provider,
			Type:                       "chat",
			DisplayName:                def.displayName,
			Name:                       def.id,
			Description:                def.displayName,
			SupportedGenerationMethods: []string{"chatCompletions"},
			SupportedInputModalities:   []string{"text"},
			SupportedOutputModalities:  []string{"text"},
			SupportedParameters:        []string{"temperature", "top_p", "max_tokens", "stop", "tools", "reasoning_effort"},
			Thinking: &pluginapi.ThinkingSupport{
				DynamicAllowed: true,
				Levels:         []string{"none", "auto", "low", "medium", "high", "max"},
			},
		})
	}
	return models
}
