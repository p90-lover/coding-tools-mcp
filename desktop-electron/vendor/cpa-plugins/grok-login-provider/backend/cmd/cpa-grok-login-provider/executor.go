package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/chenyme/grok2api/backend/internal/domain/account"
	modeldomain "github.com/chenyme/grok2api/backend/internal/domain/model"
	"github.com/chenyme/grok2api/backend/internal/infra/provider"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// grok2api operation names; they select the adapters' protocol conversion.
const (
	operationChat      = "chat"
	operationResponses = "responses"
	operationMessages  = "messages"
	errorBodyLimit     = 64 << 10
)

// executorCall is one resolved CPA request against one Grok account.
type executorCall struct {
	storage    grokStorage
	credential account.Credential
	adapter    provider.ResponseAdapter
	operation  string
	model      string
	body       []byte
	cacheKey   string
}

func operationForFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "openai-response", "openai-responses", "responses", "codex":
		return operationResponses
	case "claude", "anthropic":
		return operationMessages
	default:
		return operationChat
	}
}

func buildExecutorCall(req pluginapi.ExecutorRequest) (executorCall, error) {
	value, errDecode := decodeStorage(req.StorageJSON)
	if errDecode != nil {
		return executorCall{}, requestFault(http.StatusUnauthorized, errDecode.Error())
	}
	if value.Upstream == upstreamBuild && strings.TrimSpace(value.AccessToken) == "" {
		return executorCall{}, requestFault(http.StatusUnauthorized, "grok build auth has no access token yet; waiting for refresh")
	}
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		return executorCall{}, errRuntime
	}
	credential, errCredential := rt.credential(value)
	if errCredential != nil {
		return executorCall{}, errCredential
	}
	body := req.Payload
	if len(bytes.TrimSpace(body)) == 0 {
		body = req.OriginalRequest
	}
	return executorCall{
		storage: value, credential: credential, adapter: rt.adapterFor(value.Upstream),
		operation: operationForFormat(firstNonEmpty(req.Format, req.SourceFormat)),
		model:     strings.TrimSpace(req.Model), body: body,
		cacheKey: firstNonEmpty(req.Headers.Get("X-Session-Id"), req.Headers.Get("Session_id"), req.Headers.Get("Conversation_id")),
	}, nil
}

func (c executorCall) forward(ctx context.Context, streaming bool) (*provider.Response, error) {
	return c.adapter.ForwardResponse(ctx, provider.ResponseResourceRequest{
		Credential: c.credential, Method: http.MethodPost, Path: "/responses", Body: c.body,
		Model: c.model, Streaming: streaming, NormalizeBody: true, Operation: c.operation,
		PromptCacheKey: c.cacheKey,
	})
}

func execute(raw []byte) ([]byte, error) {
	var req rpcExecutorRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	call, errBuild := buildExecutorCall(req.ExecutorRequest)
	if errBuild != nil {
		return failureEnvelope(errBuild), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	flight := registerInFlight(cancel)
	defer unregisterInFlight(flight)

	resp, errForward := call.forward(ctx, false)
	if errForward != nil {
		return failureEnvelope(errForward), nil
	}
	defer resp.Body.Close()
	body, errRead := io.ReadAll(resp.Body)
	if errRead != nil {
		return failureEnvelope(errRead), nil
	}
	if resp.StatusCode >= http.StatusBadRequest {
		return upstreamStatusEnvelope(resp.StatusCode, body), nil
	}
	return okEnvelope(pluginapi.ExecutorResponse{
		Payload: body, Headers: http.Header{"Content-Type": []string{"application/json"}},
	})
}

// executeStream opens the upstream stream inside the RPC call. When the anti-downgrade guard
// applies, it also holds the stream until the verdict, so a withheld (downgraded) answer is
// reported as a retryable 503 before any byte reaches the client and CPA retries another
// Grok account. Delivered streams continue asynchronously through host.stream.emit.
func executeStream(raw []byte) ([]byte, error) {
	var req rpcExecutorRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	streamID := strings.TrimSpace(req.StreamID)
	if streamID == "" {
		return errorEnvelope("executor_error", "stream_id is required for executor.execute_stream"), nil
	}
	call, errBuild := buildExecutorCall(req.ExecutorRequest)
	if errBuild != nil {
		return failureEnvelope(errBuild), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	flight := registerInFlight(cancel)
	release := func() { unregisterInFlight(flight); cancel() }

	resp, errForward := call.forward(ctx, true)
	if errForward != nil {
		release()
		return failureEnvelope(errForward), nil
	}
	if resp.StatusCode >= http.StatusBadRequest {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
		_ = resp.Body.Close()
		release()
		return upstreamStatusEnvelope(resp.StatusCode, body), nil
	}
	body := resp.Body
	if cfg := loadedConfig().qualityRuntime(); call.qualityGuarded(cfg) {
		held, verdict, _, _, errPeek := peekQualityStream(ctx, body, qualityProtocolForOperation(call.operation), cfg)
		if errPeek != nil {
			_ = held.Close()
			release()
			hostLog("warn", "grok stream empty or idle during quality hold", map[string]any{"upstream": call.storage.Upstream, "model": call.model, "error": errPeek.Error()})
			return upstreamErrorEnvelope("quality_degraded", "Grok returned an empty stream; retrying another account", http.StatusServiceUnavailable, true), nil
		}
		if verdict == QualityWithhold {
			action := withholds.record(call.fingerprint(), cfg)
			if action != QualityActionDeliverLast {
				_ = held.Close()
				release()
				hostLog("warn", "grok stream withheld: missing reasoning (downgraded model)", map[string]any{"upstream": call.storage.Upstream, "model": call.model, "account": call.storage.displayLabel()})
				retryable := action == QualityActionRetry
				return upstreamErrorEnvelope("quality_degraded", "Grok answered without its reasoning model (downgraded); retrying another account", http.StatusServiceUnavailable, retryable), nil
			}
			hostLog("warn", "grok quality retries exhausted; delivering held stream (fail_open)", map[string]any{"model": call.model})
		}
		body = held
	}

	go func() {
		defer release()
		defer body.Close()
		defer func() {
			if recovered := recover(); recovered != nil {
				closeStream(streamID, fmt.Sprintf("grok stream panic: %v", recovered))
			}
		}()
		if errPump := pumpSSE(body, call.operation, func(chunk []byte) error { return emitStreamChunk(streamID, chunk) }); errPump != nil {
			closeStream(streamID, errPump.Error())
			return
		}
		closeStream(streamID, "")
	}()
	return okEnvelope(map[string]any{"headers": http.Header{"Content-Type": []string{"text/event-stream"}}})
}

// qualityGuarded mirrors grok2api's shouldHoldQualityStream: Build and Console reasoning
// models only, never when the client disabled reasoning.
func (c executorCall) qualityGuarded(cfg QualityRetryRuntime) bool {
	if !cfg.Enabled {
		return false
	}
	if c.credential.Provider != account.ProviderBuild && c.credential.Provider != account.ProviderConsole {
		return false
	}
	if qualityRequestDisablesReasoning(c.body) || bytes.Contains(c.body, []byte(`"/responses/compact"`)) {
		return false
	}
	return modeldomain.SupportsReasoningForProvider(c.credential.Provider, c.model)
}

// fingerprint identifies "the same client request" across CPA's retries on other accounts.
func (c executorCall) fingerprint() string {
	sum := sha256.Sum256(append([]byte(c.model+"\x00"+c.operation+"\x00"), c.body...))
	return fmt.Sprintf("%x", sum[:12])
}

// withholdTracker counts withheld attempts per request so the guard can apply grok2api's
// attempt budget (DecideQualityRetry) even though CPA, not the plugin, drives the retries.
type withholdTracker struct {
	mu      sync.Mutex
	entries map[string]withholdEntry
}

type withholdEntry struct {
	count   int
	expires time.Time
}

var withholds = &withholdTracker{entries: make(map[string]withholdEntry)}

func (t *withholdTracker) record(key string, cfg QualityRetryRuntime) QualityRetryAction {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	for k, entry := range t.entries {
		if now.After(entry.expires) {
			delete(t.entries, k)
		}
	}
	entry := t.entries[key]
	action := DecideQualityRetry(QualityWithhold, entry.count, cfg.MaxAttempts, cfg.OnExhausted)
	entry.count++
	entry.expires = now.Add(10 * time.Minute)
	t.entries[key] = entry
	return action
}

// pumpSSE re-frames grok2api's SSE output for CPA. CPA's chat-completions handler adds
// "data: " and "[DONE]" itself, so chat chunks are bare JSON; Responses and Claude handlers
// write chunks verbatim, so those get whole SSE events. grok2api's internal ": grok2api-*"
// comments (quality-guard evidence) are dropped in both cases.
func pumpSSE(body io.Reader, operation string, emit func([]byte) error) error {
	reader := bufio.NewReaderSize(body, 64<<10)
	var event bytes.Buffer
	flush := func() error {
		defer event.Reset()
		if event.Len() == 0 {
			return nil
		}
		if operation != operationChat {
			return emit(append(bytes.Clone(event.Bytes()), '\n'))
		}
		for _, line := range bytes.Split(event.Bytes(), []byte("\n")) {
			data, found := bytes.CutPrefix(line, []byte("data:"))
			if !found {
				continue
			}
			data = bytes.TrimSpace(data)
			if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
				continue
			}
			if errEmit := emit(bytes.Clone(data)); errEmit != nil {
				return errEmit
			}
		}
		return nil
	}
	for {
		line, errRead := reader.ReadBytes('\n')
		trimmed := bytes.TrimRight(line, "\r\n")
		switch {
		case len(line) > 0 && len(trimmed) == 0:
			if errFlush := flush(); errFlush != nil {
				return errFlush
			}
		case bytes.HasPrefix(trimmed, []byte(":")):
			// SSE comment: keepalive or grok2api-internal evidence.
		case len(trimmed) > 0:
			event.Write(trimmed)
			event.WriteByte('\n')
		}
		if errRead == io.EOF {
			return flush()
		}
		if errRead != nil {
			return errRead
		}
	}
}

type requestFaultError struct {
	status  int
	message string
}

func (e *requestFaultError) Error() string { return e.message }

func requestFault(status int, message string) error {
	return &requestFaultError{status: status, message: message}
}

// failureEnvelope classifies local and transport failures for CPA's retry logic.
func failureEnvelope(err error) []byte {
	var fault *requestFaultError
	switch {
	case errors.As(err, &fault):
		return upstreamErrorEnvelope("executor_error", fault.message, fault.status, false)
	case errors.Is(err, provider.ErrUnauthorized):
		return upstreamErrorEnvelope("unauthorized", "Grok rejected the account credentials", http.StatusUnauthorized, false)
	case errors.Is(err, context.Canceled):
		return upstreamErrorEnvelope("canceled", "request canceled", 499, false)
	}
	var statusErr provider.HTTPStatusError
	if errors.As(err, &statusErr) {
		status := statusErr.HTTPStatusCode()
		return upstreamErrorEnvelope("upstream_error", err.Error(), status, status == 429 || status >= 500)
	}
	return upstreamErrorEnvelope("upstream_error", err.Error(), http.StatusBadGateway, true)
}

func upstreamStatusEnvelope(status int, body []byte) []byte {
	message := strings.TrimSpace(string(body))
	var parsed struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != nil {
		switch typed := parsed.Error.(type) {
		case string:
			message = typed
		case map[string]any:
			if text, ok := typed["message"].(string); ok && text != "" {
				message = text
			}
		}
	}
	if len(message) > 1000 {
		message = message[:1000] + "…"
	}
	if message == "" {
		message = http.StatusText(status)
	}
	return upstreamErrorEnvelope("upstream_error", "Grok: "+message, status, status == 429 || status >= 500)
}

func countTokens(raw []byte) ([]byte, error) {
	var req rpcExecutorRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	estimate := (len(req.Payload) + 3) / 4
	payload, _ := json.Marshal(map[string]int{"input_tokens": estimate, "total_tokens": estimate})
	return okEnvelope(pluginapi.ExecutorResponse{Payload: payload})
}

func unsupportedHTTPRequest() ([]byte, error) {
	return okEnvelope(pluginapi.ExecutorHTTPResponse{
		StatusCode: http.StatusNotImplemented,
		Headers:    http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"error":{"message":"grok provider does not support raw HTTP passthrough","type":"unsupported"}}`),
	})
}
