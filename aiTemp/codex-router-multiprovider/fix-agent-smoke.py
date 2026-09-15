from pathlib import Path

path = Path("runtime-web/scripts/smoke-codex-router-agent-types.ts")
text = path.read_text(encoding="utf-8")
old = '''  if (failures.length > 0) {\n    throw new Error(\n      `${failures.join("; ")}\\nRoot requests: ${JSON.stringify(rootRequests)}`\n        + `\\nRouted requests: ${JSON.stringify(routedRequests.map(entry => ({`\n        + ` authorization: entry.authorization ? "Bearer [REDACTED]" : null, body: entry.body }))}`\n        + `\\nCodex stdout: ${stdout.slice(-8_000)}\\nCodex stderr: ${stderr.slice(-8_000)}`,\n    );\n  }\n'''
new = '''  if (failures.length > 0) {\n    const redactedRoutedRequests = routedRequests.map(entry => ({\n      authorization: entry.authorization ? "Bearer [REDACTED]" : null,\n      body: entry.body,\n    }));\n    throw new Error(\n      `${failures.join("; ")}\\nRoot requests: ${JSON.stringify(rootRequests)}`\n        + `\\nRouted requests: ${JSON.stringify(redactedRoutedRequests)}`\n        + `\\nCodex stdout: ${stdout.slice(-8_000)}\\nCodex stderr: ${stderr.slice(-8_000)}`,\n    );\n  }\n'''
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("routed agent smoke diagnostics anchor missing")

root_provider_old = '''  'env_key = "OPENAI_API_KEY"',\n  'wire_api = "responses"',\n  "supports_websockets = false",\n'''
root_provider_new = '''  'env_key = "OPENAI_API_KEY"',\n  'wire_api = "responses"',\n  "requires_openai_auth = false",\n  "supports_websockets = false",\n'''
if root_provider_old in text:
    text = text.replace(root_provider_old, root_provider_new, 1)
elif root_provider_new not in text:
    raise SystemExit("model-free root provider auth anchor missing")

path.write_text(text, encoding="utf-8")
print("ROUTED_AGENT_SMOKE_DIAGNOSTICS_PATCH_OK")
