# Additional harness brand assets

Each harness shows the icon its own product site or repository shows. Checked against those sites on 2026-11-10.

- `brand/*`: copied byte for byte (no line-ending changes, see `.gitattributes`). `harness-picker.test.cjs` checks every SHA-256 below.
  - `brand/claude-code.png`: Claude Code. Claude Code docs' apple-touch icon, <https://code.claude.com/docs/mintlify-assets/_mintlify/favicons/claude-code/pLsy-mRpNksna2sx/_generated/favicon/apple-touch-icon.png>. SHA-256 `9b1fa78fa1d19195076f30cd386a76c51688fee7b36eb1af51a87c68548d20cf`.
  - `brand/cursor.svg`: Cursor. <https://cursor.com/marketing-static/favicon-light.svg>. SHA-256 `78f169abca311d70e18ada789ccf1a55b4ca0306822f21a9ab0c2658ed88dbe0`.
  - `brand/kilocode.svg`: Kilo Code. <https://kilo.ai/favicon/favicon.svg?v=3>. SHA-256 `729bf088d9a114d567f133acf36f613cabd83662e4616afcea5ea403e87be8d2`.
  - `brand/cline.svg`: Cline. <https://cline.bot/assets/branding/logos/cline-icon-dark.svg>. SHA-256 `a34dcb49437c420e107c986e1e63b721d64843e82238ba0c43786447c92e0589`.
  - `brand/opencode.png`: opencode. <https://opencode.ai/apple-touch-icon-v3.png>. SHA-256 `2f2d5687a641f7fc1c3931072249a5984660375c091064fe8b374e4e43a8656c`.
  - `brand/amp.svg`: Amp. <https://ampcode.com/favicon.svg?v=2>. SHA-256 `480fa1640e709361fb73f0c85b3cb7e1d4a2c5a4ab9eecf9a1e3619d47c25a66`.
  - `brand/pi.svg`: Pi. The logo in Pi's README (`earendil-works/pi`), <https://pi.dev/logo-auto.svg>. SHA-256 `abd66e7868b2d24f0f0895f9237ee8a6dcb22337583b0dc54aeb595acecb4d6b`.
  - `brand/grok-build.png`: Grok Build. The SpaceXAI symbol in Grok Build's README (`xai-org/grok-build`), <https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png>. SHA-256 `d2ce9e34b770aeb1e6155646e37573a9eabc380c3fe48e72f7fe19c4b0b59e07`.
  - `brand/gemini-cli.svg`: Gemini CLI. The ">" tile geminicli.com shows, as LobeHub Icons `geminicli-color.svg` (MIT; the site serves only a 1645 px PNG), <https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/geminicli-color.svg>. SHA-256 `c2f54ebaa4c3b9191c6a07f7b0c66bc78e4abe486003dc564469cf650672663e`.
- Kimi Code, Qwen Code and Muse Code use their maker's mark, the same file the model lists use:
  - Kimi Code: `kimi.svg`, Kimi's "K" from kimi.com.
  - Qwen Code: `qwen.svg`, Qwen's star from the Qwen Code docs.
  - Muse Code: `meta.svg`, Meta's mark from dev.meta.ai, where Muse Code installs from.
- `ao/*`: copied without modification from the Agent Orchestrator frontend's agent logos at `module/agent-orchestrator/frontend/src/renderer/assets/agents/`, AO commit `cc9a0d94aebbeeb161f54a106a57336dd61ac706` (2026-11-08), with `ao/LICENSE-mimo-code.txt` as AO ships it. Only the files that match the product's own icon are kept:
  - Codex, Antigravity, Aider, Auggie, Autohand, Continue, Copilot, Crush, DeepSeek, Devin, Droid, fx, Goose, Kimchi, Kiro, MiMo Code, OMP, Prime Agent and Mistral Vibe.
  - Unreal Agent is AO's own harness, so AO's file is its icon.
  - AO's Claude Code, Cline, Cursor, Kilo Code, opencode, Amp, Pi, Grok, Kimi, Qwen, Gemini and Muse files were removed on 2026-11-10: they were not those products' icons.
- The files below are model-maker marks for the model lists, not harness marks.
- `gemini.svg`: LobeHub Icons `gemini-color.svg`, MIT licensed, fetched from <https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/gemini-color.svg>. SHA-256: `8ab0a9bafec11f7e69bcb9fc4ffd8f1bc927d1ddcbbb6ff36dee5ae8b5a9d602`. Upstream license: <https://github.com/lobehub/lobe-icons/blob/master/LICENSE>.

- `../models/zhipu.svg` (GLM), `../models/minimax.svg`, `../models/stepfun.svg`: LobeHub Icons `zhipu-color.svg`, `minimax-color.svg` and `stepfun-color.svg`, MIT licensed, fetched unmodified from <https://raw.githubusercontent.com/lobehub/lobe-icons/master/packages/static-svg/icons/> on 2026-11-07. SHA-256: `8174e65ff71647d5c705c920c953a82bd723d9e3e42887bdd4ffc9dfe51207a0`, `7f7187fa6d9b341ac5f22f6c5a970523afb439dc45566d64eb4f4b9b604d6b01`, `f55afc0e6004c8854f76bd5bbcc0fce9fc0ed9316691d54fb02d088c24fab40d`.

Brand marks identify their respective products; bundling them does not imply endorsement. The remaining harness assets and model icons are unchanged.

## LobeHub Icons license

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
