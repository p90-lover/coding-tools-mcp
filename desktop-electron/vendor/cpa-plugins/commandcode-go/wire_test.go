package plugin

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildGenerateBody_SystemAndUser(t *testing.T) {
	payload := []byte(`{
		"model": "commandcode-go/deepseek-v4.1-flash",
		"messages": [
			{"role": "system", "content": "be terse"},
			{"role": "developer", "content": "no emoji"},
			{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,xx"}}]}
		],
		"temperature": 0.5,
		"max_tokens": 128
	}`)
	raw, err := buildGenerateBody("deepseek/deepseek-v4.1-flash", payload)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var body struct {
		Params struct {
			Model       string  `json:"model"`
			System      string  `json:"system"`
			MaxTokens   int64   `json:"max_tokens"`
			Temperature float64 `json:"temperature"`
			Stream      bool    `json:"stream"`
			Messages    []struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"messages"`
		} `json:"params"`
		ThreadID string `json:"threadId"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Params.Model != "deepseek/deepseek-v4.1-flash" {
		t.Errorf("upstream model = %q", body.Params.Model)
	}
	if body.Params.System != "be terse\n\nno emoji" {
		t.Errorf("system = %q", body.Params.System)
	}
	if body.Params.MaxTokens != 128 || body.Params.Temperature != 0.5 || !body.Params.Stream {
		t.Errorf("params = %+v", body.Params)
	}
	if body.ThreadID == "" || len(body.ThreadID) != 36 {
		t.Errorf("threadId = %q", body.ThreadID)
	}
	if len(body.Params.Messages) != 1 || body.Params.Messages[0].Role != "user" {
		t.Fatalf("messages = %+v", body.Params.Messages)
	}
	parts := body.Params.Messages[0].Content
	// text + image_url flatten into one text block; the image degrades to a
	// marker because the generate wire has no inline image form.
	if len(parts) != 1 || parts[0].Type != "text" {
		t.Fatalf("user parts = %+v", parts)
	}
	if !strings.Contains(parts[0].Text, "hi") || !strings.Contains(parts[0].Text, "[image omitted") {
		t.Errorf("user text = %q", parts[0].Text)
	}
}

func TestBuildGenerateBody_ToolRoundTripAndIDRemap(t *testing.T) {
	longID := strings.Repeat("x", 80)
	payload := []byte(`{
		"model": "kimi-k3",
		"messages": [
			{"role": "user", "content": "list files"},
			{"role": "assistant", "content": null,
			 "reasoning_content": "need to look",
			 "tool_calls": [{"id": "` + longID + `", "type": "function", "function": {"name": "shell", "arguments": "{\"cmd\":\"ls\"}"}}]},
			{"role": "tool", "tool_call_id": "` + longID + `", "content": "a.txt"}
		],
		"tools": [{"type": "function", "function": {"name": "shell", "description": "run", "parameters": {"type": "object"}}}]
	}`)
	raw, err := buildGenerateBody("moonshotai/Kimi-K3", payload)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var body struct {
		Params struct {
			Messages []struct {
				Role    string `json:"role"`
				Content []struct {
					Type       string          `json:"type"`
					Text       string          `json:"text"`
					ToolCallID string          `json:"toolCallId"`
					ToolName   string          `json:"toolName"`
					Input      json.RawMessage `json:"input"`
					Output     *struct {
						Type  string `json:"type"`
						Value string `json:"value"`
					} `json:"output"`
				} `json:"content"`
			} `json:"messages"`
			Tools []struct {
				Name string `json:"name"`
			} `json:"tools"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Params.Messages) != 3 {
		t.Fatalf("messages = %d", len(body.Params.Messages))
	}
	// assistant: reasoning + tool-call share one remapped id
	asm := body.Params.Messages[1]
	var callID string
	for _, p := range asm.Content {
		switch p.Type {
		case "reasoning":
			if p.Text != "need to look" {
				t.Errorf("reasoning = %q", p.Text)
			}
		case "tool-call":
			callID = p.ToolCallID
			if len(callID) > 64 {
				t.Errorf("toolCallId not remapped: %d chars", len(callID))
			}
			if p.ToolName != "shell" {
				t.Errorf("toolName = %q", p.ToolName)
			}
			if !strings.Contains(string(p.Input), "ls") {
				t.Errorf("input = %s", p.Input)
			}
		}
	}
	// tool result carries the same remapped id and the call's name
	res := body.Params.Messages[2]
	if res.Role != "tool" || len(res.Content) != 1 {
		t.Fatalf("tool message = %+v", res)
	}
	if res.Content[0].ToolCallID != callID {
		t.Errorf("result id %q != call id %q", res.Content[0].ToolCallID, callID)
	}
	if res.Content[0].Output == nil || res.Content[0].Output.Value != "a.txt" {
		t.Errorf("output = %+v", res.Content[0].Output)
	}
	if len(body.Params.Tools) != 1 || body.Params.Tools[0].Name != "shell" {
		t.Errorf("tools = %+v", body.Params.Tools)
	}
}

func TestBuildGenerateBody_UnpairedToolResultDropped(t *testing.T) {
	payload := []byte(`{
		"model": "glm-5.3-flash",
		"messages": [
			{"role": "user", "content": "hi"},
			{"role": "tool", "tool_call_id": "orphan", "content": "stale"}
		]
	}`)
	raw, err := buildGenerateBody("z-ai/glm-5.3-flash", payload)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var body struct {
		Params struct {
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
		} `json:"params"`
	}
	_ = json.Unmarshal(raw, &body)
	if len(body.Params.Messages) != 1 || body.Params.Messages[0].Role != "user" {
		t.Errorf("orphan result not dropped: %+v", body.Params.Messages)
	}
}

func TestTranslateEvent_TextReasoningToolFinish(t *testing.T) {
	b := newChunkBuilder("m")
	ev := &generateEvent{Type: "text-delta", Text: "hello"}
	frame, err := translateEvent(b, ev)
	if err != nil || !json.Valid(frame) || !strings.Contains(string(frame), `"content":"hello"`) {
		t.Errorf("text frame = %s err=%v", frame, err)
	}
	frame, err = translateEvent(b, &generateEvent{Type: "reasoning-delta", Text: "think"})
	if err != nil || !strings.Contains(string(frame), `"reasoning_content":"think"`) {
		t.Errorf("reasoning frame = %s err=%v", frame, err)
	}
	frame, err = translateEvent(b, &generateEvent{Type: "tool-call", ToolCallID: "t1", ToolName: "shell", Input: map[string]any{"cmd": "ls"}})
	if err != nil || !strings.Contains(string(frame), `"name":"shell"`) || !strings.Contains(string(frame), `"index":0`) {
		t.Errorf("tool frame = %s err=%v", frame, err)
	}
	frame, err = translateEvent(b, &generateEvent{Type: "finish", FinishReason: "tool_calls"})
	if err != nil || !strings.Contains(string(frame), `"finish_reason":"tool_calls"`) {
		t.Errorf("finish frame = %s err=%v", frame, err)
	}
}

func TestCompletionAssembler_RendersOpenAI(t *testing.T) {
	a := newCompletionAssembler("deepseek/deepseek-v4.1-flash")
	a.apply(&generateEvent{Type: "reasoning-delta", Text: "thinking"})
	a.apply(&generateEvent{Type: "text-delta", Text: "answer"})
	a.apply(&generateEvent{Type: "tool-call", ToolCallID: "t1", ToolName: "shell", Input: map[string]any{"cmd": "ls"}})
	in, out := int64(11), int64(7)
	a.apply(&generateEvent{Type: "finish", FinishReason: "tool-calls", TotalUsage: &struct {
		InputTokens       *int64 `json:"inputTokens"`
		OutputTokens      *int64 `json:"outputTokens"`
		InputTokenDetails *struct {
			CacheReadTokens  *int64 `json:"cacheReadTokens"`
			CacheWriteTokens *int64 `json:"cacheWriteTokens"`
			NoCacheTokens    *int64 `json:"noCacheTokens"`
		} `json:"inputTokenDetails"`
	}{InputTokens: &in, OutputTokens: &out}})
	raw, err := a.render()
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	var resp struct {
		Object  string `json:"object"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
			TotalTokens      int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Object != "chat.completion" || len(resp.Choices) != 1 {
		t.Fatalf("resp = %s", raw)
	}
	if resp.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish_reason = %q", resp.Choices[0].FinishReason)
	}
	if resp.Choices[0].Message.ReasoningContent != "thinking" || resp.Choices[0].Message.Content != "answer" {
		t.Errorf("message = %+v", resp.Choices[0].Message)
	}
	if len(resp.Choices[0].Message.ToolCalls) != 1 || resp.Choices[0].Message.ToolCalls[0].ID != "t1" {
		t.Errorf("tool_calls = %+v", resp.Choices[0].Message.ToolCalls)
	}
	if resp.Usage.TotalTokens != 18 {
		t.Errorf("usage = %+v", resp.Usage)
	}
}

func TestNormalizeModel(t *testing.T) {
	cases := map[string]string{
		"commandcode-go/deepseek-v4.1-flash": "deepseek-v4.1-flash",
		"deepseek/deepseek-v4.1-flash":       "deepseek-v4.1-flash",
		"DeepSeek-V4.1-Flash":                "deepseek-v4.1-flash",
		"glm-5.3-flash(high)":                "glm-5.3-flash",
	}
	for in, want := range cases {
		if got := normalizeModel(in); got != want {
			t.Errorf("normalizeModel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConfigDefaults(t *testing.T) {
	cfg := parseConfig(nil)
	if got := cfg.upstreamName("deepseek/deepseek-v4.1-flash"); got != "deepseek/deepseek-v4.1-flash" {
		t.Errorf("upstreamName(default) = %q", got)
	}
	if got := cfg.upstreamName("commandcode-go/kimi-k3"); got != "moonshotai/Kimi-K3" {
		t.Errorf("upstreamName(kimi) = %q", got)
	}
}
