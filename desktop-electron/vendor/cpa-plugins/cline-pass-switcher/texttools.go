package main

// Tool calls a model wrote as text. MiMo (and other Qwen-style models) sometimes answer through
// Cline Pass with the call in the assistant's text instead of OpenAI tool_calls:
//
//	<tool_call><function=mcp__coding-tools__exec_command><parameter=cmd>curl -s …</parameter></function></tool_call>
//
// CPA then hands Claude Code a text block, so the call shows as text and never runs. A toolSieve
// rewrites such text into tool_calls before CPA translates the response. Only a complete call to a
// tool the request offered is converted; anything else, an unclosed call included, stays text.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

const (
	toolCallOpen  = "<tool_call>"
	toolCallClose = "</tool_call>"
	functionOpen  = "<function="
	functionClose = "</function>"
	// A capture longer than this without its closing tag is released as text.
	maxCapturedCall = 1 << 20
)

type textToolCall struct {
	ID        string
	Name      string
	Arguments string
}

type toolSieve struct {
	// tool name -> parameter name -> JSON schema type ("" when the schema gives none)
	tools     map[string]map[string]string
	held      strings.Builder // text not yet released: a possible opener, or a call being captured
	capturing string          // the closing tag awaited, "" when not inside a call
	found     int             // calls converted so far
	nextIndex int             // the tool_calls index the next converted call takes
	template  map[string]any  // the latest chunk's id, object, created, model and choice index
}

// newToolSieve returns a sieve for a chat-completions request body, or nil when the request offers
// no function tools (then no text can be a call).
func newToolSieve(body map[string]any) *toolSieve {
	list, _ := body["tools"].([]any)
	tools := map[string]map[string]string{}
	for _, item := range list {
		tool, _ := item.(map[string]any)
		fn, _ := tool["function"].(map[string]any)
		name, _ := fn["name"].(string)
		if name == "" {
			continue
		}
		params := map[string]string{}
		schema, _ := fn["parameters"].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		for key, raw := range props {
			prop, _ := raw.(map[string]any)
			kind, _ := prop["type"].(string)
			params[key] = kind
		}
		tools[name] = params
	}
	if len(tools) == 0 {
		return nil
	}
	return &toolSieve{tools: tools}
}

// feed takes the next piece of the assistant's text and returns the text that is safe to show now
// and the calls completed by this piece.
func (s *toolSieve) feed(text string) (string, []textToolCall) {
	s.held.WriteString(text)
	var out strings.Builder
	var calls []textToolCall
	for {
		buf := s.held.String()
		if s.capturing == "" {
			at, opener := firstOpener(buf)
			if at < 0 {
				// Keep back only a tail that could still grow into an opener.
				keep := partialOpenerTail(buf)
				out.WriteString(buf[:len(buf)-keep])
				s.reset(buf[len(buf)-keep:])
				return out.String(), calls
			}
			out.WriteString(buf[:at])
			s.reset(buf[at:])
			if opener == toolCallOpen {
				s.capturing = toolCallClose
			} else {
				s.capturing = functionClose
			}
			continue
		}
		end := strings.Index(buf, s.capturing)
		if end < 0 {
			if len(buf) > maxCapturedCall {
				out.WriteString(buf)
				s.reset("")
				s.capturing = ""
			}
			return out.String(), calls
		}
		block := buf[:end+len(s.capturing)]
		s.reset(buf[end+len(s.capturing):])
		s.capturing = ""
		if call, ok := s.parse(block); ok {
			calls = append(calls, call)
		} else {
			out.WriteString(block)
		}
	}
}

// flush releases whatever is still held (a partial opener or an unclosed call) as text.
func (s *toolSieve) flush() string {
	rest := s.held.String()
	s.reset("")
	s.capturing = ""
	return rest
}

func (s *toolSieve) reset(to string) {
	s.held.Reset()
	s.held.WriteString(to)
}

func firstOpener(buf string) (int, string) {
	call, fn := strings.Index(buf, toolCallOpen), strings.Index(buf, functionOpen)
	switch {
	case call < 0 && fn < 0:
		return -1, ""
	case fn < 0 || (call >= 0 && call <= fn):
		return call, toolCallOpen
	default:
		return fn, functionOpen
	}
}

// partialOpenerTail is how many trailing bytes of buf could be the start of an opener.
func partialOpenerTail(buf string) int {
	keep := 0
	for _, opener := range []string{toolCallOpen, functionOpen} {
		for n := min(len(opener)-1, len(buf)); n > keep; n-- {
			if strings.HasSuffix(buf, opener[:n]) {
				keep = n
				break
			}
		}
	}
	return keep
}

// parse reads one captured block: Qwen's <function=NAME><parameter=K>V</parameter>…</function>,
// optionally wrapped in <tool_call>, or a Hermes-style JSON {"name", "arguments"} in <tool_call>.
func (s *toolSieve) parse(block string) (textToolCall, bool) {
	inner := strings.TrimSpace(block)
	if strings.HasPrefix(inner, toolCallOpen) {
		inner = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(inner, toolCallOpen), toolCallClose))
	}
	if strings.HasPrefix(inner, "{") {
		var call struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal([]byte(inner), &call) != nil || s.tools[call.Name] == nil {
			return textToolCall{}, false
		}
		args := string(call.Arguments)
		var asString string
		if json.Unmarshal(call.Arguments, &asString) == nil {
			args = asString // arguments given as an encoded JSON string
		}
		if !json.Valid([]byte(args)) {
			return textToolCall{}, false
		}
		return s.called(call.Name, args), true
	}
	if !strings.HasPrefix(inner, functionOpen) || !strings.HasSuffix(inner, functionClose) {
		return textToolCall{}, false
	}
	head := strings.Index(inner, ">")
	if head < 0 {
		return textToolCall{}, false
	}
	name := strings.TrimSpace(inner[len(functionOpen):head])
	params, known := s.tools[name]
	if !known {
		return textToolCall{}, false
	}
	body := inner[head+1 : len(inner)-len(functionClose)]
	args := map[string]any{}
	for {
		start := strings.Index(body, "<parameter=")
		if start < 0 {
			break
		}
		rest := body[start+len("<parameter="):]
		nameEnd := strings.Index(rest, ">")
		if nameEnd < 0 {
			return textToolCall{}, false
		}
		key := strings.TrimSpace(rest[:nameEnd])
		value := rest[nameEnd+1:]
		end := strings.Index(value, "</parameter>")
		if end < 0 {
			return textToolCall{}, false
		}
		args[key] = typedValue(value[:end], params[key])
		body = value[end+len("</parameter>"):]
	}
	if strings.TrimSpace(body) != "" {
		return textToolCall{}, false // text between parameters that is not one: not a call
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		return textToolCall{}, false
	}
	return s.called(name, string(encoded)), true
}

func (s *toolSieve) called(name, arguments string) textToolCall {
	s.found++
	return textToolCall{ID: "call_" + randomHex(12), Name: name, Arguments: arguments}
}

// typedValue converts a parameter's text by its schema type, as Qwen's own parser does: the
// newline the format puts around a value is not part of it.
func typedValue(raw, kind string) any {
	value := strings.TrimSuffix(strings.TrimPrefix(raw, "\n"), "\n")
	trimmed := strings.TrimSpace(value)
	switch kind {
	case "string":
		return value
	case "integer":
		if n, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			return n
		}
	case "number":
		if n, err := strconv.ParseFloat(trimmed, 64); err == nil {
			return n
		}
	case "boolean":
		if b, err := strconv.ParseBool(strings.ToLower(trimmed)); err == nil {
			return b
		}
	default:
		// object, array or no type: JSON when it reads as JSON, the text otherwise.
		var parsed any
		if trimmed != "" && json.Unmarshal([]byte(trimmed), &parsed) == nil {
			if _, isString := parsed.(string); !isString || kind != "" {
				return parsed
			}
		}
	}
	return value
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(int64(n), 16)
	}
	return hex.EncodeToString(b)
}

// sieveChunk rewrites one streamed chat-completions chunk: its first choice's text loses any calls
// written in it, the calls follow in a chunk of their own, and a stream that converted a call ends
// with finish_reason "tool_calls". It returns the payloads to emit in order.
func (s *toolSieve) sieveChunk(payload []byte) [][]byte {
	var chunk map[string]any
	if json.Unmarshal(payload, &chunk) != nil {
		return [][]byte{payload}
	}
	choices, _ := chunk["choices"].([]any)
	if len(choices) == 0 {
		return [][]byte{payload}
	}
	choice, _ := choices[0].(map[string]any)
	delta, _ := choice["delta"].(map[string]any)
	if delta == nil {
		return [][]byte{payload}
	}
	for _, raw := range asSlice(delta["tool_calls"]) {
		call, _ := raw.(map[string]any)
		if index, ok := call["index"].(float64); ok && int(index) >= s.nextIndex {
			s.nextIndex = int(index) + 1
		}
	}
	text, hasText := delta["content"].(string)
	var calls []textToolCall
	if hasText {
		text, calls = s.feed(text)
	}
	finish, _ := choice["finish_reason"].(string)
	if finish != "" {
		text += s.flush()
	}
	if hasText || finish != "" {
		if text == "" {
			delete(delta, "content")
		} else {
			delta["content"] = text
		}
	}
	if finish == "stop" && s.found > 0 {
		choice["finish_reason"] = "tool_calls"
	}
	s.template = map[string]any{"index": choice["index"]}
	for _, key := range []string{"id", "object", "created", "model"} {
		if v, ok := chunk[key]; ok {
			s.template[key] = v
		}
	}
	b, err := json.Marshal(chunk)
	if err != nil {
		return [][]byte{payload}
	}
	if len(calls) == 0 {
		return [][]byte{b}
	}
	items := make([]any, 0, len(calls))
	for _, call := range calls {
		items = append(items, map[string]any{"index": s.nextIndex, "id": call.ID, "type": "function",
			"function": map[string]any{"name": call.Name, "arguments": call.Arguments}})
		s.nextIndex++
	}
	callsChunk, err := json.Marshal(s.chunkWith(map[string]any{"tool_calls": items}))
	if err != nil {
		return [][]byte{b}
	}
	// The calls come before a chunk that ends the stream, after any other.
	if finish != "" {
		return [][]byte{callsChunk, b}
	}
	return [][]byte{b, callsChunk}
}

// chunkWith builds a chunk like the stream's latest, carrying delta in its first choice.
func (s *toolSieve) chunkWith(delta map[string]any) map[string]any {
	chunk := map[string]any{}
	for key, v := range s.template {
		if key != "index" {
			chunk[key] = v
		}
	}
	chunk["choices"] = []any{map[string]any{"index": s.template["index"], "delta": delta, "finish_reason": nil}}
	return chunk
}

// drain is the chunk releasing text still held when a stream ended without a finish chunk, or nil.
func (s *toolSieve) drain() []byte {
	rest := s.flush()
	if rest == "" || s.template == nil {
		return nil
	}
	b, err := json.Marshal(s.chunkWith(map[string]any{"content": rest}))
	if err != nil {
		return nil
	}
	return b
}

// sieveMessage rewrites a whole chat-completions response the same way (the non-streaming path).
func (s *toolSieve) sieveMessage(payload []byte) []byte {
	var response map[string]any
	if json.Unmarshal(payload, &response) != nil {
		return payload
	}
	changed := false
	for _, raw := range asSlice(response["choices"]) {
		choice, _ := raw.(map[string]any)
		message, _ := choice["message"].(map[string]any)
		text, ok := message["content"].(string)
		if !ok {
			continue
		}
		existing := asSlice(message["tool_calls"])
		s.nextIndex = len(existing)
		safe, calls := s.feed(text)
		safe += s.flush()
		if len(calls) == 0 {
			continue
		}
		changed = true
		for _, call := range calls {
			existing = append(existing, map[string]any{"id": call.ID, "type": "function",
				"function": map[string]any{"name": call.Name, "arguments": call.Arguments}})
		}
		message["tool_calls"] = existing
		if strings.TrimSpace(safe) == "" {
			message["content"] = nil
		} else {
			message["content"] = safe
		}
		if finish, _ := choice["finish_reason"].(string); finish == "stop" || finish == "" {
			choice["finish_reason"] = "tool_calls"
		}
	}
	if !changed {
		return payload
	}
	b, err := json.Marshal(response)
	if err != nil {
		return payload
	}
	return b
}

func asSlice(v any) []any {
	list, _ := v.([]any)
	return list
}
