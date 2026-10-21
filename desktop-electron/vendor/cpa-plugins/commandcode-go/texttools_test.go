package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

// A Command Code model that writes its call as text (as MiMo did through Cline Pass) gets a real
// tool call: the streamed frames translateEvent builds go through the request's sieve.
func TestStreamedTextCallBecomesARealCall(t *testing.T) {
	payload := []byte(`{"model":"m","messages":[{"role":"user","content":"status?"}],"tools":[{"type":"function","function":{"name":"mcp__coding-tools__exec_command","parameters":{"type":"object","properties":{"cmd":{"type":"string"},"timeout_ms":{"type":"integer"}}}}}]}`)
	sieve := sieveFor(payload)
	if sieve == nil {
		t.Fatal("a request with tools is sieved")
	}
	text := `Checking. <tool_call><function=mcp__coding-tools__exec_command><parameter=cmd>curl -s http://127.0.0.1:8765/api/status</parameter><parameter=timeout_ms>15000</parameter></function></tool_call>`
	builder := newChunkBuilder("m")
	var frames [][]byte
	for len(text) > 0 {
		piece := text[:min(5, len(text))]
		text = text[len(piece):]
		frame, err := translateEvent(builder, &generateEvent{Type: "text-delta", Text: piece})
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, sieve.sieveChunk(frame)...)
	}
	finish, err := translateEvent(builder, &generateEvent{Type: "finish", FinishReason: "stop"})
	if err != nil {
		t.Fatal(err)
	}
	frames = append(frames, sieve.sieveChunk(finish)...)
	var said strings.Builder
	var calls []map[string]any
	last := ""
	for _, frame := range frames {
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string           `json:"content"`
					ToolCalls []map[string]any `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(frame, &chunk); err != nil {
			t.Fatal(err)
		}
		said.WriteString(chunk.Choices[0].Delta.Content)
		calls = append(calls, chunk.Choices[0].Delta.ToolCalls...)
		if chunk.Choices[0].FinishReason != nil {
			last = *chunk.Choices[0].FinishReason
		}
	}
	if said.String() != "Checking. " || len(calls) != 1 || last != "tool_calls" {
		t.Fatalf("text %q, calls %v, finish %q", said.String(), calls, last)
	}
	if args := calls[0]["function"].(map[string]any)["arguments"]; args != `{"cmd":"curl -s http://127.0.0.1:8765/api/status","timeout_ms":15000}` {
		t.Fatalf("arguments typed by the schema: %v", args)
	}
	if sieveFor([]byte(`{"messages":[]}`)) != nil {
		t.Fatal("no tools, no sieve")
	}
}
