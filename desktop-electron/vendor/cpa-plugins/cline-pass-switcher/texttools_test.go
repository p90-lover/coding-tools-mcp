package main

import (
	"encoding/json"
	"strings"
	"testing"
	"testing/iotest"
)

// The call MiMo V2.6 Pro wrote as text through Cline Pass (seen live, 2026-10-21).
const liveTextCall = `<tool_call><function=mcp__coding-tools__exec_command><parameter=cmd>curl -s http://127.0.0.1:8765/api/status</parameter><parameter=timeout_ms>15000</parameter><parameter=workdir>F:\clash of clan macro</parameter><parameter=yield_time_ms>8000</parameter></function></tool_call>`

func execTools() map[string]any {
	return map[string]any{"tools": []any{map[string]any{"type": "function", "function": map[string]any{
		"name": "mcp__coding-tools__exec_command",
		"parameters": map[string]any{"type": "object", "properties": map[string]any{
			"cmd": map[string]any{"type": "string"}, "workdir": map[string]any{"type": "string"},
			"timeout_ms": map[string]any{"type": "integer"}, "yield_time_ms": map[string]any{"type": "number"},
		}},
	}}}}
}

// streamOf is an OpenAI chat-completions SSE stream sending text in pieces of size n, then stop.
func streamOf(text string, n int) string {
	var wire strings.Builder
	chunk := func(delta map[string]any, finish any) {
		b, _ := json.Marshal(map[string]any{"id": "c1", "object": "chat.completion.chunk", "model": "mimo-v2.6-pro",
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
		wire.WriteString("data: " + string(b) + "\n\n")
	}
	chunk(map[string]any{"role": "assistant", "content": ""}, nil)
	for len(text) > 0 {
		piece := text[:min(n, len(text))]
		text = text[len(piece):]
		chunk(map[string]any{"content": piece}, nil)
	}
	chunk(map[string]any{}, "stop")
	wire.WriteString("data: [DONE]\n\n")
	return wire.String()
}

type relayed struct {
	text   string
	calls  []map[string]any
	finish []string
	chunks int
}

func relay(t *testing.T, wire string, sieve *toolSieve) relayed {
	t.Helper()
	var got relayed
	err := relaySSEWith(iotest.OneByteReader(strings.NewReader(wire)), false, sieve, func(b []byte) error {
		got.chunks++
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string           `json:"content"`
					ToolCalls []map[string]any `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(b, &chunk); err != nil {
			t.Fatalf("chunk is not JSON: %s", b)
		}
		for _, choice := range chunk.Choices {
			got.text += choice.Delta.Content
			got.calls = append(got.calls, choice.Delta.ToolCalls...)
			if choice.FinishReason != nil {
				got.finish = append(got.finish, *choice.FinishReason)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestTextToolCallBecomesARealCallAcrossAnySplit(t *testing.T) {
	for _, n := range []int{1, 3, 7, 40, len(liveTextCall) + 20} {
		got := relay(t, streamOf("Checking the backend. "+liveTextCall, n), newToolSieve(execTools()))
		if got.text != "Checking the backend. " {
			t.Fatalf("pieces of %d: the text keeps only what was said, got %q", n, got.text)
		}
		if len(got.calls) != 1 {
			t.Fatalf("pieces of %d: want one call, got %v", n, got.calls)
		}
		call := got.calls[0]
		fn := call["function"].(map[string]any)
		if fn["name"] != "mcp__coding-tools__exec_command" || !strings.HasPrefix(call["id"].(string), "call_") || call["type"] != "function" {
			t.Fatalf("call carries its id and name together: %v", call)
		}
		var args map[string]any
		if err := json.Unmarshal([]byte(fn["arguments"].(string)), &args); err != nil {
			t.Fatal(err)
		}
		if args["cmd"] != "curl -s http://127.0.0.1:8765/api/status" || args["workdir"] != `F:\clash of clan macro` ||
			args["timeout_ms"] != float64(15000) || args["yield_time_ms"] != float64(8000) {
			t.Fatalf("arguments typed by the tool's schema: %v", args)
		}
		if got.finish[len(got.finish)-1] != "tool_calls" {
			t.Fatalf("the stream ends as a tool call, got %v", got.finish)
		}
	}
}

func TestTextThatIsNotAnOfferedCallStaysText(t *testing.T) {
	sieve := newToolSieve(execTools())
	unknown := strings.ReplaceAll(liveTextCall, "mcp__coding-tools__exec_command", "rm_everything")
	got := relay(t, streamOf("Use "+unknown+" maybe", 5), sieve)
	if got.text != "Use "+unknown+" maybe" || len(got.calls) != 0 || got.finish[len(got.finish)-1] != "stop" {
		t.Fatalf("a tool the request did not offer is left as text: %+v", got)
	}
	unclosed := "Plan: <tool_call><function=mcp__coding-tools__exec_command><parameter=cmd>ls"
	got = relay(t, streamOf(unclosed, 4), newToolSieve(execTools()))
	if got.text != unclosed || len(got.calls) != 0 {
		t.Fatalf("an unclosed call is released as text when the stream ends: %+v", got)
	}
	partial := "a < b and <tool"
	got = relay(t, streamOf(partial, 2), newToolSieve(execTools()))
	if got.text != partial {
		t.Fatalf("a held-back partial tag comes out at the end: %q", got.text)
	}
	if newToolSieve(map[string]any{"messages": []any{}}) != nil {
		t.Fatal("a request with no tools is never sieved")
	}
}

func TestStreamEndingWithoutFinishStillReleasesHeldText(t *testing.T) {
	wire := `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"done <tool_c"}}]}` + "\n\n"
	got := relay(t, wire, newToolSieve(execTools()))
	if got.text != "done <tool_c" {
		t.Fatalf("held text is drained at the end: %q", got.text)
	}
}

func TestWholeResponseTextCallBecomesARealCall(t *testing.T) {
	response, _ := json.Marshal(map[string]any{"id": "r1", "choices": []any{map[string]any{"index": 0, "finish_reason": "stop",
		"message": map[string]any{"role": "assistant", "content": liveTextCall}}}})
	var out struct {
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content   *string          `json:"content"`
				ToolCalls []map[string]any `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(newToolSieve(execTools()).sieveMessage(response), &out); err != nil {
		t.Fatal(err)
	}
	choice := out.Choices[0]
	if choice.FinishReason != "tool_calls" || choice.Message.Content != nil || len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("the whole response carries the call, not its text: %+v", choice)
	}
	plain, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": "just text"}}}})
	if string(newToolSieve(execTools()).sieveMessage(plain)) != string(plain) {
		t.Fatal("a response without a text call is passed through unchanged")
	}
}

func TestHermesJSONTextCall(t *testing.T) {
	got := relay(t, streamOf(`<tool_call>{"name":"mcp__coding-tools__exec_command","arguments":{"cmd":"ls"}}</tool_call>`, 6), newToolSieve(execTools()))
	if len(got.calls) != 1 || got.calls[0]["function"].(map[string]any)["arguments"] != `{"cmd":"ls"}` {
		t.Fatalf("a JSON call in tool_call tags converts too: %+v", got)
	}
}
