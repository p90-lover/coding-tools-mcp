// Package plugin implements the CommandCode Go-plan provider for CLIProxyAPI.
//
// The vendor's Go plan ($1/mo) has no Provider API access:
// POST /provider/v1/chat/completions answers 403 upgrade_required. The only
// inference path the plan grants is the official CLI's own wire:
//
//	POST {base}/alpha/generate
//	body:  { config, memory, taste, skills,
//	         params: { model, messages, tools, system, max_tokens,
//	                   temperature, stream, reasoning_effort? }, threadId }
//	reply: JSONL events — start | start-step | text-delta | reasoning-start/
//	       delta/end | tool-call | finish | error
//
// (protocol verified live 2026-09-12 against command-code@1.53.1 and
// independently implemented by Mars-Sea/dsh-commandcode-provider)
//
// Design: the host feeds this executor OpenAI chat-completions payloads
// (input/output format "openai"; claude/responses are translated by the host).
// The executor converts them to the generate wire, streams the reply back as
// OpenAI chat-completion chunks (bare JSON — the host adds "data:" framing),
// and preserves reasoning_content round-trips, which DeepSeek thinking-mode
// tool loops require.
package plugin

import (
	"context"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

const (
	// Provider is the executor/model provider key.
	Provider = "commandcode-go"

	// executorFormat: the host translates claude/openai-responses/gemini
	// around us; we only speak OpenAI chat-completions.
	executorFormat = "openai"

	// upstreamBaseURL is the CommandCode API root (the generate path is
	// appended by the executor).
	upstreamBaseURL = "https://api.commandcode.ai"
)

const pluginVersion = "1.0.0-codingtools.1"

// CommandCodeGoPlugin wires auth, model metadata and execution.
type CommandCodeGoPlugin struct {
	models   *ModelProvider
	executor *Executor
	cfg      *pluginConfig
}

// Build constructs the host-facing plugin description from the raw
// plugins.configs.<id> YAML the host passes at register/reconfigure time.
func Build(configYAML []byte) (pluginapi.Plugin, *CommandCodeGoPlugin) {
	cfg := parseConfig(configYAML)
	p := &CommandCodeGoPlugin{
		models:   NewModelProvider(cfg),
		cfg:      cfg,
		executor: NewExecutor(cfg),
	}
	desc := pluginapi.Plugin{
		Metadata: pluginapi.Metadata{
			Name:    "CommandCode Go Provider",
			Version: pluginVersion,
			Author:  "speroai",
			// The host rejects plugins with an empty repository field
			// (internal/pluginhost validPlugin).
			GitHubRepository: "https://github.com/sperictao/cpa-plugin-commandcode-go",
		},
		Capabilities: pluginapi.Capabilities{
			AuthProvider:          p,
			ModelProvider:         p.models,
			Executor:              p.executor,
			ExecutorModelScope:    pluginapi.ExecutorModelScopeBoth,
			ExecutorInputFormats:  []string{executorFormat},
			ExecutorOutputFormats: []string{executorFormat},
		},
	}
	return desc, p
}

// Identifier returns the provider key.
func (p *CommandCodeGoPlugin) Identifier() string { return Provider }

// StaticModels returns the models served through this executor.
func (p *CommandCodeGoPlugin) StaticModels(ctx context.Context, req pluginapi.StaticModelRequest) (pluginapi.ModelResponse, error) {
	return p.models.StaticModels(ctx, req)
}

// ModelsForAuth mirrors static models for each CPA auth file.
func (p *CommandCodeGoPlugin) ModelsForAuth(ctx context.Context, req pluginapi.AuthModelRequest) (pluginapi.ModelResponse, error) {
	return p.models.ModelsForAuth(ctx, req)
}

// Execute performs a non-streaming upstream call.
func (p *CommandCodeGoPlugin) Execute(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorResponse, error) {
	return p.executor.Execute(ctx, req)
}

// ExecuteStream performs a streaming upstream call.
func (p *CommandCodeGoPlugin) ExecuteStream(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorStreamResponse, error) {
	return p.executor.ExecuteStream(ctx, req)
}

// CountTokens estimates tokens without calling upstream.
func (p *CommandCodeGoPlugin) CountTokens(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorResponse, error) {
	return p.executor.CountTokens(ctx, req)
}

// HttpRequest bridges executor-owned raw HTTP through the host client.
func (p *CommandCodeGoPlugin) HttpRequest(ctx context.Context, req pluginapi.ExecutorHTTPRequest) (pluginapi.ExecutorHTTPResponse, error) {
	return p.executor.HttpRequest(ctx, req)
}

var (
	_ pluginapi.AuthProvider     = (*CommandCodeGoPlugin)(nil)
	_ pluginapi.ModelProvider    = (*CommandCodeGoPlugin)(nil)
	_ pluginapi.ProviderExecutor = (*CommandCodeGoPlugin)(nil)
)

// normalizeModel strips provider prefixes, alias suffixes and whitespace so
// "deepseek-v4.1-flash", "commandcode-go/deepseek-v4.1-flash" and
// "deepseek/deepseek-v4.1-flash" compare equal downstream.
func normalizeModel(model string) string {
	m := strings.TrimSpace(model)
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	if i := strings.Index(m, "("); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	return strings.ToLower(m)
}
