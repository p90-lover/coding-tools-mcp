package plugin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v7/sdk/pluginapi"
)

// Executor forwards OpenAI chat-completions payloads to the vendor's
// /alpha/generate wire (the only inference path a Go plan grants) and
// converts the JSONL event stream back into standard OpenAI shape.
type Executor struct {
	cfg *pluginConfig
}

func NewExecutor(cfg *pluginConfig) *Executor { return &Executor{cfg: cfg} }

func (e *Executor) Identifier() string { return Provider }

const missingKeyMsg = "commandcode-go executor: no CommandCode account is selected; sign in through CPA Accounts"

func (e *Executor) endpoint() string {
	return e.cfg.baseURL() + "/alpha/generate"
}

// upstreamHeaders: the gateway gates on the CLI-flavoured identity headers;
// requests that look like a plain SDK call are rejected.
func upstreamHeaders(apiKey string) http.Header {
	h := http.Header{}
	h.Set("Content-Type", "application/json")
	h.Set("Authorization", "Bearer "+apiKey)
	h.Set("User-Agent", "cli")
	h.Set("X-Command-Code-Version", "1.53.1")
	h.Set("X-Cli-Environment", "production")
	return h
}

func (e *Executor) buildBody(model string, payload []byte) ([]byte, error) {
	upstream := strings.TrimSpace(e.cfg.upstreamName(model))
	if upstream == "" {
		upstream = model
	}
	return buildGenerateBody(upstream, payload)
}

// Execute performs a completion by draining the (always-streaming) generate
// wire and assembling one chat.completion object.
func (e *Executor) Execute(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorResponse, error) {
	key := keyFromStorage(req.StorageJSON)
	if key == "" {
		key = strings.TrimSpace(e.cfg.firstKey())
	}
	if key == "" {
		return pluginapi.ExecutorResponse{}, statusError{statusCode: http.StatusUnauthorized, msg: missingKeyMsg}
	}
	body, err := e.buildBody(req.Model, req.Payload)
	if err != nil {
		return pluginapi.ExecutorResponse{}, err
	}
	client := req.HTTPClient
	if client == nil {
		return pluginapi.ExecutorResponse{}, fmt.Errorf("commandcode-go executor: host HTTP client is required")
	}
	resp, err := client.Do(ctx, pluginapi.HTTPRequest{
		Method:  http.MethodPost,
		URL:     e.endpoint(),
		Headers: upstreamHeaders(key),
		Body:    body,
	})
	if err != nil {
		return pluginapi.ExecutorResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return pluginapi.ExecutorResponse{}, statusError{statusCode: resp.StatusCode, body: resp.Body}
	}
	asm := newCompletionAssembler(req.Model)
	scanner := bufio.NewScanner(bytes.NewReader(resp.Body))
	scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return pluginapi.ExecutorResponse{}, ctx.Err()
		}
		ev, ok := decodeEvent(scanner.Bytes())
		if !ok {
			continue
		}
		if ev.Type == "error" {
			return pluginapi.ExecutorResponse{}, statusError{statusCode: http.StatusBadGateway,
				msg: "commandcode-go: " + ev.errorMessage()}
		}
		asm.apply(ev)
	}
	if err := scanner.Err(); err != nil {
		return pluginapi.ExecutorResponse{}, fmt.Errorf("commandcode-go: reading reply: %w", err)
	}
	raw, err := asm.render()
	if err != nil {
		return pluginapi.ExecutorResponse{}, err
	}
	return pluginapi.ExecutorResponse{Payload: raw}, nil
}

// ExecuteStream streams the generate wire, converting each JSONL event into
// OpenAI chunk payloads. Framing contract (verified against the host): chunks
// MUST be bare JSON — the host adds "data: " framing; empty lines and stream
// termination are the host's business.
func (e *Executor) ExecuteStream(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorStreamResponse, error) {
	key := keyFromStorage(req.StorageJSON)
	if key == "" {
		key = strings.TrimSpace(e.cfg.firstKey())
	}
	if key == "" {
		return pluginapi.ExecutorStreamResponse{}, statusError{statusCode: http.StatusUnauthorized, msg: missingKeyMsg}
	}
	body, err := e.buildBody(req.Model, req.Payload)
	if err != nil {
		return pluginapi.ExecutorStreamResponse{}, err
	}
	client := req.HTTPClient
	if client == nil {
		return pluginapi.ExecutorStreamResponse{}, fmt.Errorf("commandcode-go executor: host HTTP client is required")
	}
	resp, err := client.DoStream(ctx, pluginapi.HTTPRequest{
		Method:  http.MethodPost,
		URL:     e.endpoint(),
		Headers: upstreamHeaders(key),
		Body:    body,
	})
	if err != nil {
		return pluginapi.ExecutorStreamResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return pluginapi.ExecutorStreamResponse{}, statusError{statusCode: resp.StatusCode, body: readStreamErrorBody(ctx, resp.Chunks)}
	}

	out := make(chan pluginapi.ExecutorStreamChunk)
	go func() {
		defer close(out)
		builder := newChunkBuilder(req.Model)
		scanner := bufio.NewScanner(&streamReader{ctx: ctx, chunks: resp.Chunks})
		scanner.Buffer(make([]byte, 0, 64*1024), 8<<20)
		emit := func(payload []byte) bool {
			if len(bytes.TrimSpace(payload)) == 0 {
				return true
			}
			select {
			case <-ctx.Done():
				out <- pluginapi.ExecutorStreamChunk{Err: ctx.Err()}
				return false
			case out <- pluginapi.ExecutorStreamChunk{Payload: payload}:
				return true
			}
		}
		if frame, err := builder.roleChunk(); err == nil {
			if !emit(frame) {
				return
			}
		}
		for scanner.Scan() {
			if ctx.Err() != nil {
				out <- pluginapi.ExecutorStreamChunk{Err: ctx.Err()}
				return
			}
			ev, ok := decodeEvent(scanner.Bytes())
			if !ok {
				continue
			}
			frame, err := translateEvent(builder, ev)
			if err != nil {
				out <- pluginapi.ExecutorStreamChunk{Err: err}
				return
			}
			if len(frame) > 0 && !emit(frame) {
				return
			}
			if ev.Type == "finish" {
				// Usage rides a trailing empty-choices chunk (the OpenAI
				// include_usage shape), then the completion is over: stop
				// reading so trailing keepalives cannot extend the stream.
				if ev.TotalUsage != nil {
					if frame, err := builder.usageChunk(ev.TotalUsage.InputTokens, ev.TotalUsage.OutputTokens); err == nil {
						emit(frame)
					}
				}
				break
			}
		}
		if err := scanner.Err(); err != nil {
			if ctx.Err() == nil {
				out <- pluginapi.ExecutorStreamChunk{Err: err}
			}
		}
	}()
	return pluginapi.ExecutorStreamResponse{Chunks: out}, nil
}

// translateEvent maps one generate event to at most one OpenAI chunk frame.
func translateEvent(builder *chunkBuilder, ev *generateEvent) ([]byte, error) {
	switch ev.Type {
	case "text-delta":
		if ev.Text == "" {
			return nil, nil
		}
		return builder.textChunk(ev.Text)
	case "reasoning-delta":
		if ev.Text == "" {
			return nil, nil
		}
		return builder.reasoningChunk(ev.Text)
	case "tool-call":
		id := ev.ToolCallID
		if id == "" {
			id = "call_" + newUUID()
		}
		return builder.toolCallChunk(id, ev.ToolName, ev.toolArguments())
	case "finish":
		frame, err := builder.finishChunk(mapFinishReason(ev.FinishReason))
		if err != nil {
			return nil, err
		}
		return frame, nil
	case "error":
		return nil, fmt.Errorf("commandcode-go: upstream stream error: %s", ev.errorMessage())
	default:
		return nil, nil
	}
}

// decodeEvent parses one JSONL line. Unrecognized events (start, start-step,
// …) decode but yield no translation.
func decodeEvent(line []byte) (*generateEvent, bool) {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var ev generateEvent
	if err := json.Unmarshal(trimmed, &ev); err != nil {
		return nil, false
	}
	return &ev, true
}

// CountTokens is a local estimate; the vendor exposes no tokenize endpoint.
func (e *Executor) CountTokens(ctx context.Context, req pluginapi.ExecutorRequest) (pluginapi.ExecutorResponse, error) {
	_ = ctx
	count := int64(len(req.Payload) / 4)
	if count < 1 && len(req.Payload) > 0 {
		count = 1
	}
	raw, _ := json.Marshal(map[string]any{
		"id":      "commandcode-go-count",
		"object":  "chat.completion",
		"created": 0,
		"model":   req.Model,
		"choices": []any{},
		"usage": map[string]any{
			"prompt_tokens":     count,
			"completion_tokens": 0,
			"total_tokens":      count,
		},
	})
	return pluginapi.ExecutorResponse{Payload: raw}, nil
}

// HttpRequest bridges raw executor HTTP through the host client with the
// configured key injected when the caller did not set Authorization.
func (e *Executor) HttpRequest(ctx context.Context, req pluginapi.ExecutorHTTPRequest) (pluginapi.ExecutorHTTPResponse, error) {
	if strings.TrimSpace(req.URL) == "" {
		return pluginapi.ExecutorHTTPResponse{}, fmt.Errorf("commandcode-go executor: request URL is required")
	}
	headers := req.Headers.Clone()
	if headers == nil {
		headers = http.Header{}
	}
	if headers.Get("Authorization") == "" {
		key := strings.TrimSpace(e.cfg.firstKey())
		if key == "" {
			return pluginapi.ExecutorHTTPResponse{}, statusError{statusCode: http.StatusUnauthorized, msg: missingKeyMsg}
		}
		headers.Set("Authorization", "Bearer "+key)
	}
	client := req.HTTPClient
	if client == nil {
		return pluginapi.ExecutorHTTPResponse{}, fmt.Errorf("commandcode-go executor: host HTTP client is required")
	}
	resp, err := client.Do(ctx, pluginapi.HTTPRequest{Method: req.Method, URL: req.URL, Headers: headers, Body: req.Body})
	if err != nil {
		return pluginapi.ExecutorHTTPResponse{}, err
	}
	return pluginapi.ExecutorHTTPResponse{StatusCode: resp.StatusCode, Headers: resp.Headers, Body: resp.Body}, nil
}

// statusError carries an upstream HTTP status back to the host (the ABI error
// envelope preserves it as http_status for retry classification).
type statusError struct {
	statusCode int
	msg        string
	body       []byte
}

func (e statusError) Error() string {
	if strings.TrimSpace(e.msg) != "" {
		return e.msg
	}
	if len(e.body) > 0 {
		return upstreamErrorMessage(e.body)
	}
	return fmt.Sprintf("status %d", e.statusCode)
}

func (e statusError) StatusCode() int { return e.statusCode }

func upstreamErrorMessage(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}
	var decoded struct {
		Message string          `json:"message"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal([]byte(trimmed), &decoded); err == nil {
		if len(decoded.Error) > 0 {
			var obj struct {
				Message string `json:"message"`
			}
			if errObj := json.Unmarshal(decoded.Error, &obj); errObj == nil && strings.TrimSpace(obj.Message) != "" {
				return strings.TrimSpace(obj.Message)
			}
			var s string
			if errStr := json.Unmarshal(decoded.Error, &s); errStr == nil && strings.TrimSpace(s) != "" {
				return strings.TrimSpace(s)
			}
		}
		if strings.TrimSpace(decoded.Message) != "" {
			return strings.TrimSpace(decoded.Message)
		}
	}
	if len(trimmed) > 500 {
		return trimmed[:500]
	}
	return trimmed
}

func readStreamErrorBody(ctx context.Context, chunks <-chan pluginapi.HTTPStreamChunk) []byte {
	const maxBytes = 1 << 20
	body := make([]byte, 0)
	if chunks == nil {
		return body
	}
	for len(body) < maxBytes {
		select {
		case <-ctx.Done():
			return body
		case chunk, ok := <-chunks:
			if !ok {
				return body
			}
			if len(chunk.Payload) > 0 {
				remaining := maxBytes - len(body)
				if len(chunk.Payload) > remaining {
					return append(body, chunk.Payload[:remaining]...)
				}
				body = append(body, chunk.Payload...)
			}
			if chunk.Err != nil {
				return body
			}
		}
	}
	return body
}

// streamReader adapts the host's chunk channel to io.Reader for bufio
// (the host delivers arbitrary raw reads; lines may straddle chunks).
type streamReader struct {
	ctx    context.Context
	chunks <-chan pluginapi.HTTPStreamChunk
	buf    []byte
	off    int
	eof    bool
}

func (r *streamReader) Read(p []byte) (int, error) {
	for {
		if r.off < len(r.buf) {
			n := copy(p, r.buf[r.off:])
			r.off += n
			return n, nil
		}
		if r.eof {
			return 0, io.EOF
		}
		select {
		case <-r.ctx.Done():
			return 0, r.ctx.Err()
		case chunk, ok := <-r.chunks:
			if !ok {
				r.eof = true
				continue
			}
			if chunk.Err != nil {
				return 0, chunk.Err
			}
			r.buf = append(r.buf[:0], chunk.Payload...)
			r.off = 0
		}
	}
}
