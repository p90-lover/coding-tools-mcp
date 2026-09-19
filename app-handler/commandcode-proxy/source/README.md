# CommandCode AI Proxy

[![npm version](https://img.shields.io/npm/v/commandcode-proxy)](https://www.npmjs.com/package/commandcode-proxy)
[![license](https://img.shields.io/npm/l/commandcode-proxy)](LICENSE)

```bash
npm install -g commandcode-proxy
```

A lightweight, zero-dependency proxy server that exposes [CommandCode](https://commandcode.ai) AI models through **OpenAI-compatible** and **Anthropic-compatible** API endpoints. Use it to connect tools like [Cursor](https://cursor.sh), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Continue](https://continue.dev), [Cody](https://sourcegraph.com/cody), or any OpenAI/Anthropic SDK client to CommandCode's model gateway.

---

## Features

- **Dual API compatibility** — serves both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) formats from a single server.
- **Model routing** — automatically remaps Claude and GPT model names to the configured CommandCode model so clients work without changes.
- **Vision pipeline** — detects images in requests, routes them to a vision-capable model for description, then passes the text to the coding model. Includes an in-memory description cache to avoid re-analyzing the same image.
- **Streaming support** — full SSE streaming for both OpenAI and Anthropic protocols.
- **Tool/function calling** — translates OpenAI function-calling and Anthropic tool-use formats to CommandCode's tool schema and back.
- **Retry with back-off** — retries 429 / 5xx errors up to 5 times with exponential delay.
- **Auth gating** — requires a user-defined API key on all `/v1/*` endpoints; health checks are public.
- **CORS enabled** — allows browser-based clients out of the box.
- **Zero dependencies** — runs on Node.js built-in modules only; no `npm install` required.
- **Docker ready** — includes `Dockerfile` and `docker-compose.yml` for one-command deployment.

---

## Prerequisites

| Requirement | Minimum Version |
|---|---|
| **Node.js** | 18.0.0+ |
| **Docker** (optional) | 20.10+ |
| **CommandCode account** | Free or paid — [sign up at commandcode.ai](https://commandcode.ai) |

You need a **CommandCode API key**. Get one by either:

1. Running the `commandcode` CLI and completing the auth flow (key is saved to `~/.commandcode/auth.json`), **or**
2. Copying the key from the CommandCode dashboard and setting it as `CC_API_KEY`.

---

## Quick Start

### Option A: Install from npm (recommended)

```bash
# Install globally
npm install -g commandcode-proxy

# Set your keys
export PROXY_API_KEY=$(openssl rand -hex 32)
export CC_API_KEY=your-commandcode-api-key

# Start the proxy
commandcode-proxy
```

Or run it directly without installing:

```bash
PROXY_API_KEY=my-secret-key CC_API_KEY=your-cc-key npx commandcode-proxy
```

### Option B: Clone the repository

```bash
git clone https://github.com/zahidhussaina2l/commandcode-proxy.git
cd commandcode-proxy
cp .env.example .env
```

Edit `.env` and set the two required values:

```env
# A secret key clients must send to use this proxy (choose any random string)
PROXY_API_KEY=my-secret-proxy-key

# Your CommandCode API key (or leave unset to read from ~/.commandcode/auth.json)
CC_API_KEY=your-commandcode-api-key
```

> **Tip:** Generate a strong random key with `openssl rand -hex 32`.

Start the proxy:

```bash
node proxy.mjs
```

### Verify it's running

You should see:

```
  CommandCode AI Proxy v1.0.0
  ===========================
  Listening on 0.0.0.0:8787
  Auth: ENABLED (API key required)
```

---

## Docker

### Build and run

```bash
docker build -t commandcode-proxy .
docker run -d \
  --name commandcode-proxy \
  -p 8787:8787 \
  -e PROXY_API_KEY=my-secret-proxy-key \
  -e CC_API_KEY=your-commandcode-api-key \
  commandcode-proxy
```

### Docker Compose

```bash
cp .env.example .env
# edit .env with your keys
docker compose up -d
```

To stop:

```bash
docker compose down
```

### Using auth.json from the host

If you prefer to use the `~/.commandcode/auth.json` file from your host machine instead of setting `CC_API_KEY`:

```bash
docker run -d \
  --name commandcode-proxy \
  -p 8787:8787 \
  -e PROXY_API_KEY=my-secret-proxy-key \
  -v "$HOME/.commandcode:/home/node/.commandcode:ro" \
  commandcode-proxy
```

---

## CommandCode Authentication Setup

CommandCode requires an API key to access its model gateway. Here's how to set it up:

### Option A: Using the CommandCode CLI (recommended)

1. Install the CommandCode CLI:

```bash
npm install -g commandcode
```

2. Run the auth flow:

```bash
commandcode
```

3. Complete the browser-based authentication. The CLI saves your key to `~/.commandcode/auth.json`.

4. The proxy reads this file automatically — no need to set `CC_API_KEY`.

### Option B: Manual API key

1. Log in to [commandcode.ai](https://commandcode.ai) and navigate to your API settings.
2. Copy your API key.
3. Set it in your `.env` file:

```env
CC_API_KEY=sk-cc-your-key-here
```

---

## Client Configuration

### Cursor IDE

1. Open Cursor Settings (`Cmd+,` / `Ctrl+,`).
2. Go to **Models** > **OpenAI API Key**.
3. Set:
   - **OpenAI Base URL**: `http://YOUR_HOST:8787/v1`
   - **OpenAI API Key**: your `PROXY_API_KEY` value

Cursor will now route all model requests through the proxy.

### Claude Code CLI

Set these environment variables before running Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://YOUR_HOST:8787/v1
export ANTHROPIC_API_KEY=your-proxy-api-key
```

Or add them to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://YOUR_HOST:8787/v1",
    api_key="your-proxy-api-key",
)

response = client.chat.completions.create(
    model="deepseek/deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### OpenAI Node.js SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://YOUR_HOST:8787/v1",
  apiKey: "your-proxy-api-key",
});

const completion = await client.chat.completions.create({
  model: "deepseek/deepseek-v4-pro",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(completion.choices[0].message.content);
```

### Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://YOUR_HOST:8787/v1",
    api_key="your-proxy-api-key",
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(message.content[0].text)
```

### curl

```bash
# OpenAI format
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-pro",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Anthropic format
curl http://localhost:8787/v1/messages \
  -H "x-api-key: your-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` or `/health` | Health check — returns proxy status, available models, and account info |
| `GET` | `/v1/models` | List available models (OpenAI format) |
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI format) |
| `POST` | `/v1/messages` | Messages (Anthropic format) |
| `HEAD` | `/` | Health check (used by Claude Code) |
| `OPTIONS` | `*` | CORS preflight |

All `/v1/*` endpoints require authentication via `Authorization: Bearer <key>` or `x-api-key: <key>`.

---

## Available Models

The proxy supports these models through CommandCode's gateway:

| Model | Provider | Category |
|---|---|---|
| `deepseek/deepseek-v4-pro` | DeepSeek | Open-source |
| `deepseek/deepseek-v4-flash` | DeepSeek | Open-source |
| `moonshotai/Kimi-K2.5` | Moonshot | Open-source |
| `moonshotai/Kimi-K2.6` | Moonshot | Open-source |
| `zai-org/GLM-5` | Zhipu AI | Open-source |
| `zai-org/GLM-5.1` | Zhipu AI | Open-source |
| `MiniMaxAI/MiniMax-M2.5` | MiniMax | Open-source |
| `MiniMaxAI/MiniMax-M2.7` | MiniMax | Open-source |
| `Qwen/Qwen3.6-Max-Preview` | Alibaba | Open-source |
| `Qwen/Qwen3.6-Plus` | Alibaba | Open-source |
| `stepfun/Step-3.5-Flash` | StepFun | Open-source |
| `claude-sonnet-4-6` | Anthropic* | Premium |
| `claude-opus-4-7` | Anthropic* | Premium |
| `gpt-5.5` | OpenAI* | Premium |

> \* Premium models (Claude, GPT) are automatically remapped to the configured default model (`PROXY_DEFAULT_MODEL`). The response preserves the original model name so clients don't reject the response.

### Model aliases

Short aliases are supported — e.g. `deepseek-v4-pro` resolves to `deepseek/deepseek-v4-pro`, `kimi-k2.5` resolves to `moonshotai/Kimi-K2.5`, etc.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROXY_API_KEY` | **Yes** | — | Secret key clients must send to authenticate |
| `CC_API_KEY` | No | Read from `~/.commandcode/auth.json` | CommandCode API key |
| `PROXY_PORT` | No | `8787` | Port the server listens on |
| `PROXY_HOST` | No | `0.0.0.0` | Host/interface to bind to |
| `PROXY_PUBLIC_URL` | No | `http://localhost:$PORT` | Public URL shown in the startup banner |
| `PROXY_DEFAULT_MODEL` | No | `deepseek/deepseek-v4-pro` | Default model for all routed requests |
| `PROXY_VISION_MODEL` | No | `moonshotai/Kimi-K2.6` | Model used for image analysis |
| `PROXY_CODING_MODEL` | No | Same as default | Model used for coding tasks |
| `CC_API_BASE` | No | `https://api.commandcode.ai` | CommandCode API base URL |
| `CC_CLI_VERSION` | No | `0.26.3` | CLI version sent in request headers |
| `CC_WORKING_DIR` | No | Current working directory | Working directory sent in request config |

---

## How It Works

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────────┐
│   Client      │ ──────> │  commandcode-proxy   │ ──────> │  CommandCode API  │
│ (Cursor, SDK) │ <────── │  :8787               │ <────── │  api.commandcode  │
└──────────────┘         └─────────────────────┘         └──────────────────┘
     OpenAI or                Translates format,              Returns model
     Anthropic                routes models,                  responses via
     API format               handles vision                  streaming events
```

1. **Client sends a request** in OpenAI or Anthropic format.
2. **Auth check** — the proxy validates the `PROXY_API_KEY`.
3. **Model resolution** — Claude/GPT model names are remapped to the configured default model.
4. **Vision pipeline** (if images are present) — images are sent to the vision model for description, then the text descriptions replace the images before forwarding to the coding model.
5. **Format translation** — the request is converted to CommandCode's internal format.
6. **Forwarding** — the request is sent to CommandCode's API with retry logic.
7. **Response translation** — the CommandCode streaming response is translated back to OpenAI or Anthropic SSE format.

---

## Platform Support

| Platform | Status |
|---|---|
| **Linux** (x86_64, ARM64) | Fully supported |
| **macOS** (Intel, Apple Silicon) | Fully supported |
| **Windows** (native Node.js) | Fully supported |
| **Docker** (any architecture) | Fully supported |
| **WSL / WSL2** | Fully supported |

The proxy uses only Node.js built-in modules and has zero npm dependencies, so it runs anywhere Node.js 18+ is available.

---

## Running Tests

```bash
# All tests (unit + integration)
npm test

# Unit tests only (fast, no network)
npm run test:unit

# Integration tests only (starts proxy + mock server)
npm run test:integration

# Docker E2E tests (requires Docker; builds image, starts container, tests all endpoints)
npm run test:docker
```

Tests use Node.js built-in test runner (`node:test`) — no extra dependencies needed.

---

## Development

```bash
# Start with auto-reload on file changes
npm run dev
```

---

## Troubleshooting

### "FATAL: PROXY_API_KEY environment variable is required"

Set the `PROXY_API_KEY` environment variable. This is the key that clients use to authenticate with the proxy (not your CommandCode key).

```bash
export PROXY_API_KEY=my-secret-key
```

### "FATAL: No auth at ~/.commandcode/auth.json"

Either:
- Run `commandcode` CLI to complete the auth flow, **or**
- Set `CC_API_KEY` in your environment / `.env` file.

### "CC API 401"

Your CommandCode API key is invalid or expired. Re-run the `commandcode` CLI auth flow or update `CC_API_KEY`.

### "CC API 429"

You've hit a rate limit. The proxy automatically retries with exponential back-off (up to 5 times). If this persists, check your CommandCode plan limits.

### Cursor/Claude Code not connecting

1. Make sure the proxy is running and reachable from your machine.
2. Verify the base URL includes `/v1` — e.g. `http://localhost:8787/v1`.
3. Check that the API key in your client config matches `PROXY_API_KEY`.
4. For Claude Code, the path normalization handles `/v1/v1/messages` automatically.

### Docker container exits immediately

Check logs with `docker logs commandcode-proxy`. The most common cause is a missing `PROXY_API_KEY` environment variable.

---

## Security Notes

- **Never commit your `.env` file.** It's listed in `.gitignore`.
- The `PROXY_API_KEY` is only partially printed in the startup banner (first 8 and last 4 characters).
- The proxy does **not** log request/response bodies — only method, path, model, and message counts.
- When exposing the proxy to the internet, use a reverse proxy (nginx, Caddy) with TLS.

---

## Disclaimer

This project is provided **for educational and research purposes only**. It is an independent, community-built tool and is **not affiliated with, endorsed by, or officially supported by CommandCode, Anthropic, OpenAI, or any other AI provider** mentioned in this repository. Use of this software is at your own risk. The authors assume no liability for any misuse, service disruptions, or violations of third-party terms of service. You are solely responsible for ensuring your usage complies with all applicable terms of service, licenses, and laws.

---

## License

[MIT](LICENSE)
