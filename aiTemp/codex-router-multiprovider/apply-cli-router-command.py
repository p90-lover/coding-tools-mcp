from pathlib import Path

path = Path("runtime-web/src/cli.ts")
text = path.read_text(encoding="utf-8")

import_old = 'import { VERSION } from "./version";\nimport { runDevCommand } from "./dev-chat/cli";\n'
import_new = 'import { VERSION } from "./version";\nimport { codexRouterIntegrationMain } from "../scripts/codex-router-integration";\nimport { runDevCommand } from "./dev-chat/cli";\n'
if import_old in text:
    text = text.replace(import_old, import_new, 1)
elif import_new not in text:
    raise SystemExit("CLI router integration import anchor missing")

help_old = '  codex-chatgpt-web subagents <status|compatibility-v1|native>\n  codex-chatgpt-web browser check\n'
help_new = '  codex-chatgpt-web subagents <status|compatibility-v1|native>\n  codex-chatgpt-web router integrate [--apply] [--with-commandcode-proxy] [options]\n  codex-chatgpt-web browser check\n'
if help_old in text:
    text = text.replace(help_old, help_new, 1)
elif help_new not in text:
    raise SystemExit("CLI router integration help anchor missing")

main_old = '  else if (command === "subagents") await subagentsCommand(args);\n  else if (command === "browser") {\n'
main_new = '''  else if (command === "subagents") await subagentsCommand(args);\n  else if (command === "router") {\n    const action = args.shift();\n    if (action !== "integrate") {\n      throw new Error("Router command must be: router integrate");\n    }\n    codexRouterIntegrationMain(args);\n  }\n  else if (command === "browser") {\n'''
if main_old in text:
    text = text.replace(main_old, main_new, 1)
elif main_new not in text:
    raise SystemExit("CLI router integration dispatch anchor missing")

path.write_text(text, encoding="utf-8")
print("CODEX_ROUTER_CLI_COMMAND_PATCH_OK")
