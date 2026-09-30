package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// providerIdentifier is the CPA provider key shared by the auth provider, the model provider
// and the executor. CPA's built-in "xai" provider keeps plain Grok Build OAuth files; this
// plugin owns "grok" files (SSO cookies, Web, Console, and Build accounts it logs in itself).
const providerIdentifier = "grok"

// pluginVersion is reported to the host; release builds override it with -ldflags -X.
var pluginVersion = "0.1.0-codingtools.1"

var hostAvailable atomic.Bool

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

// envelopeError mirrors pluginabi.Error. HTTPStatus and Retryable let CPA decide whether to
// cool the credential and retry on another one; the anti-downgrade guard depends on that.
type envelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Retryable  bool   `json:"retryable,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

type lifecycleRequest struct {
	ConfigYAML    []byte `json:"config_yaml"`
	SchemaVersion uint32 `json:"schema_version"`
}

type rpcExecutorRequest struct {
	pluginapi.ExecutorRequest
	StreamID       string `json:"stream_id,omitempty"`
	HostCallbackID string `json:"host_callback_id,omitempty"`
}

type rpcAuthLoginStartRequest struct {
	pluginapi.AuthLoginStartRequest
	HostCallbackID string `json:"host_callback_id,omitempty"`
}

type rpcAuthLoginPollRequest struct {
	pluginapi.AuthLoginPollRequest
	HostCallbackID string `json:"host_callback_id,omitempty"`
}

type rpcAuthRefreshRequest struct {
	pluginapi.AuthRefreshRequest
	HostCallbackID string `json:"host_callback_id,omitempty"`
}

type rpcAuthModelRequest struct {
	pluginapi.AuthModelRequest
	HostCallbackID string `json:"host_callback_id,omitempty"`
}

func handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		if errConfigure := configure(request); errConfigure != nil {
			return nil, errConfigure
		}
		return okEnvelope(pluginRegistration())
	case pluginabi.MethodPluginShutdown, pluginabi.MethodPluginQuiesce:
		quiesce()
		return okEnvelope(struct{}{})
	case pluginabi.MethodAuthIdentifier, pluginabi.MethodExecutorIdentifier:
		return okEnvelope(map[string]string{"identifier": providerIdentifier})
	case pluginabi.MethodAuthParse:
		return parseAuth(request)
	case pluginabi.MethodAuthRefresh:
		return refreshAuth(request)
	case pluginabi.MethodAuthLoginStart:
		return loginStart(request)
	case pluginabi.MethodAuthLoginPoll:
		return loginPoll(request)
	case pluginabi.MethodModelStatic:
		return staticModels()
	case pluginabi.MethodModelForAuth:
		return modelsForAuth(request)
	case pluginabi.MethodExecutorExecute:
		return execute(request)
	case pluginabi.MethodExecutorExecuteStream:
		return executeStream(request)
	case pluginabi.MethodExecutorCountTokens:
		return countTokens(request)
	case pluginabi.MethodExecutorHTTPRequest:
		return unsupportedHTTPRequest()
	default:
		return errorEnvelope("unknown_method", "unknown method: "+method), nil
	}
}

type registration struct {
	SchemaVersion uint32                 `json:"schema_version"`
	Metadata      pluginapi.Metadata     `json:"metadata"`
	Capabilities  registrationCapability `json:"capabilities"`
}

type registrationCapability struct {
	AuthProvider          bool     `json:"auth_provider"`
	ModelProvider         bool     `json:"model_provider"`
	Executor              bool     `json:"executor"`
	ExecutorModelScope    string   `json:"executor_model_scope"`
	ExecutorInputFormats  []string `json:"executor_input_formats"`
	ExecutorOutputFormats []string `json:"executor_output_formats"`
}

func pluginRegistration() registration {
	return registration{
		SchemaVersion: pluginabi.SchemaVersion,
		Metadata: pluginapi.Metadata{
			Name:             "Grok Login Provider",
			Version:          pluginVersion,
			Author:           "Coding Tools (grok2api by chenyme)",
			GitHubRepository: "https://github.com/chenyme/grok2api",
			ConfigFields:     configFields(),
		},
		Capabilities: registrationCapability{
			AuthProvider:       true,
			ModelProvider:      true,
			Executor:           true,
			ExecutorModelScope: string(pluginapi.ExecutorModelScopeBoth),
			// grok2api's adapters convert all three protocols to the upstream Responses shape
			// and back, so CPA never needs to translate for this executor.
			ExecutorInputFormats:  []string{"chat-completions", "responses", "anthropic"},
			ExecutorOutputFormats: []string{"chat-completions", "responses", "anthropic"},
		},
	}
}

// inFlight tracks cancellable executor work so plugin.quiesce can drain it.
var inFlight = struct {
	mu      sync.Mutex
	next    uint64
	cancels map[uint64]context.CancelFunc
}{cancels: make(map[uint64]context.CancelFunc)}

func registerInFlight(cancel context.CancelFunc) uint64 {
	inFlight.mu.Lock()
	defer inFlight.mu.Unlock()
	inFlight.next++
	inFlight.cancels[inFlight.next] = cancel
	return inFlight.next
}

func unregisterInFlight(id uint64) {
	inFlight.mu.Lock()
	delete(inFlight.cancels, id)
	inFlight.mu.Unlock()
}

func quiesce() {
	inFlight.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(inFlight.cancels))
	for _, cancel := range inFlight.cancels {
		cancels = append(cancels, cancel)
	}
	inFlight.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	stopLoginServers()
}

func unwrapHostEnvelope(method string, rawResponse []byte, callCode int) (json.RawMessage, error) {
	if len(rawResponse) == 0 {
		return nil, fmt.Errorf("host callback %s returned no response, code=%d", method, callCode)
	}
	var env envelope
	if errUnmarshal := json.Unmarshal(rawResponse, &env); errUnmarshal != nil {
		return nil, fmt.Errorf("decode host envelope %s: %w", method, errUnmarshal)
	}
	if !env.OK {
		if env.Error != nil {
			return nil, fmt.Errorf("%s: %s", env.Error.Code, env.Error.Message)
		}
		return nil, fmt.Errorf("host callback %s failed", method)
	}
	if callCode != 0 {
		return nil, fmt.Errorf("host callback %s returned code=%d", method, callCode)
	}
	return append(json.RawMessage(nil), env.Result...), nil
}

func okEnvelope(v any) ([]byte, error) {
	raw, errMarshal := json.Marshal(v)
	if errMarshal != nil {
		return nil, errMarshal
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{Code: code, Message: message}})
	return raw
}

func upstreamErrorEnvelope(code, message string, httpStatus int, retryable bool) []byte {
	raw, _ := json.Marshal(envelope{OK: false, Error: &envelopeError{
		Code: code, Message: message, Retryable: retryable, HTTPStatus: httpStatus,
	}})
	return raw
}

type rpcHostLogRequest struct {
	HostCallbackID string         `json:"host_callback_id,omitempty"`
	Level          string         `json:"level,omitempty"`
	Message        string         `json:"message,omitempty"`
	Fields         map[string]any `json:"fields,omitempty"`
}

// hostLog writes through CPA's logger; plugins share the host process, so stdout is off limits.
func hostLog(level, message string, fields map[string]any) {
	if !hostAvailable.Load() {
		return
	}
	if fields == nil {
		fields = map[string]any{}
	}
	fields["plugin"] = providerIdentifier
	_, _ = hostCall(pluginabi.MethodHostLog, rpcHostLogRequest{Level: level, Message: message, Fields: fields})
}

type rpcStreamEmitRequest struct {
	StreamID string `json:"stream_id"`
	Payload  []byte `json:"payload,omitempty"`
	Error    string `json:"error,omitempty"`
}

type rpcStreamCloseRequest struct {
	StreamID string `json:"stream_id"`
	Error    string `json:"error,omitempty"`
}

func emitStreamChunk(streamID string, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	_, errCall := hostCall(pluginabi.MethodHostStreamEmit, rpcStreamEmitRequest{StreamID: streamID, Payload: payload})
	return errCall
}

func closeStream(streamID, errMsg string) {
	_, _ = hostCall(pluginabi.MethodHostStreamClose, rpcStreamCloseRequest{StreamID: streamID, Error: strings.TrimSpace(errMsg)})
}
