# Moltbot — Multi-AI Orchestration Feasibility Report

## 1. Overview

The original goal was to use Moltbot as an **API-triggered orchestrator** to:

- Coordinate multiple AI systems in a single workflow
- Send a single prompt to several AI providers in parallel
- Collect and aggregate structured responses for downstream use

This report documents what was tested and what works in practice.

---

## 2. What Was Tested

The feasibility build evaluated two approaches:

| Approach | Technology | Outcome |
|----------|------------|---------|
| **Browser-based automation** | Playwright + Chromium, persistent profiles | Blocked by platform security controls |
| **API-based orchestration** | OpenAI, Anthropic, and Google Gemini APIs | Works reliably |

---

## 3. Browser Automation Findings (Evidence-based)

Browser control was tested with Playwright, Chromium, and persistent profiles to mimic a logged-in user session. The following issues were observed:

- **ChatGPT and Claude** — Cloudflare human verification challenges blocked access. The pages required interactive verification that could not be reliably automated.
- **Google / Gemini** — Google sign-in rejected the automated Chromium instance with: *"This browser or app may not be secure. Try using a different browser."* Sign-in failed even with a visible browser and manual interaction attempts.
- **Root cause** — Major AI platforms use bot-detection and security layers. Automated or headless browsers are flagged as untrusted. Failures occurred consistently across different configurations.

### Supporting Screenshots

Place screenshots in `screenshots/` to illustrate the findings:

- `screenshots/chatgpt-cloudflare.png` — Cloudflare verification on ChatGPT
- `screenshots/claude-cloudflare.png` — Cloudflare verification on Claude
- `screenshots/gemini-browser-block.png` — Google “browser not secure” sign-in block

---

## 4. Why API-First Works

API-based integration avoids the layers that block browser automation:

- **No authentication friction** — API keys replace interactive login.
- **No bot-detection exposure** — Requests are standard HTTP from server-side code.
- **Stability** — No browser upgrades, page changes, or CAPTCHAs affecting the flow.
- **Scalability** — Parallel requests, retries, and rate limiting follow familiar patterns.
- **Production fit** — This is the standard way to integrate multiple AI providers in real systems.

---

## 5. Moltbot's Role

Moltbot is implemented as an **API-triggered orchestrator**:

- Accepts prompts via HTTP `POST /orchestrate`
- Routes the same prompt to multiple AI backends (OpenAI, Anthropic, Google)
- Runs requests in parallel
- Returns structured, per-provider responses with latency data

**No UI. No browser dependency.** Moltbot is a backend service that clients call via JSON over HTTP.

---

## 6. Feasibility Verdict

| Approach | Result |
|----------|--------|
| ✅ **Hybrid API-first orchestration** | **PASS** — Proven and suitable for production integration |
| ❌ **Pure browser control for major AI platforms** | **FAIL** — Blocked by platform security controls |

---

## Quick Start

1. Copy `.env.example` to `.env` and add your API keys.
2. Run the server: `npm run server`
3. Send a request:

```bash
curl -X POST http://localhost:3000/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain Kubernetes to a product manager", "models": ["openai", "claude", "gemini"]}'
```

Example response:

```json
{
  "request_id": "550e8400-e29b-41d4-a716-446655440000",
  "total_latency_ms": 1200,
  "status": "success",
  "openai": { "text": "...", "latency_ms": 820 },
  "claude": { "text": "...", "latency_ms": 640 },
  "gemini": { "text": "...", "latency_ms": 910 }
}
```

`status` is `success`, `partial`, or `failed` depending on how many providers returned valid text.
