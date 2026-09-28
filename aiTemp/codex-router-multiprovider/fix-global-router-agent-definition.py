from pathlib import Path

source = Path("runtime-web/src/routed-agent-catalog.ts")
text = source.read_text(encoding="utf-8")
old = '''    'model_provider = "codex-router"',\n    `model = ${tomlString(model)}`,\n'''
new = '''    `model = ${tomlString(model)}`,\n'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("routed agent provider/model anchor missing")
source.write_text(text, encoding="utf-8")

test = Path("runtime-web/tests/routed-agent-catalog.test.ts")
test_text = test.read_text(encoding="utf-8")
old_assert = '''    expect(first.contents).toContain('model_provider = "codex-router"');\n    expect(first.contents).toContain('model = "commandcode-proxy/claude-sonnet-4-6"');\n'''
new_assert = '''    expect(first.contents).not.toContain("model_provider");\n    expect(first.contents).toContain('model = "commandcode-proxy/claude-sonnet-4-6"');\n'''
if old_assert in test_text:
    test_text = test_text.replace(old_assert, new_assert, 1)
elif new_assert not in test_text:
    raise SystemExit("routed agent provider assertion anchor missing")
test.write_text(test_text, encoding="utf-8")
print("GLOBAL_ROUTER_AGENT_DEFINITION_PATCH_OK")
