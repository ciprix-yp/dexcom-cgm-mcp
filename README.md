# dexcom-cgm-mcp

An MCP (Model Context Protocol) server that bridges the [Dexcom](https://developer.dexcom.com/) Continuous Glucose Monitor API to AI agents — ask an LLM about glucose trends, devices, and alerts through standard MCP tool calls.

Runs on Cloudflare Workers, using a Durable Object per session and KV for token storage.

## Tools exposed over MCP

| Tool | Description |
|---|---|
| `get_data_range` | Available data ranges for EGVs, events, and calibrations |
| `get_devices` | Connected Dexcom device info |
| `get_egvs` | Estimated glucose values for a time window (max 30 days) |
| `get_latest_egvs` | Recent EGVs for the last N hours (max 24) |
| `get_events` | User-entered events for a time window |
| `get_alerts` | Alert records for a time window |
| `get_calibrations` | Calibration records for a time window |

## Architecture

- **OAuth2 (Dexcom API v3)** — `/oauth/start` → `/oauth/callback`, with HMAC-signed, time-boxed state to prevent CSRF. Tokens are refreshed automatically and persisted in a KV namespace.
- **Share API fallback** (`/internal/egvs`) — an alternate, unofficial path used when the OAuth v3 sandbox-consent flow is unavailable; capped at Dexcom Share's ~24h lookback window.
- **Auth** — all `/mcp` and admin routes require a bearer/query API key, checked with a timing-safe comparison.
- **Transport** — served via `agents/mcp`'s `McpAgent`, auto-negotiated transport at `/mcp`.

## Endpoints

- `GET /health` — reports which required secrets/bindings are configured, without leaking values
- `GET /oauth/start`, `GET /oauth/callback` — Dexcom OAuth2 flow
- `GET /internal/egvs` — internal Share API bridge (separate key)
- `ALL /mcp` — the MCP server itself

## Setup

```bash
npm install
npx wrangler secret put DEXCOM_CLIENT_ID
npx wrangler secret put DEXCOM_CLIENT_SECRET
npx wrangler secret put DEXCOM_REDIRECT_URI
npx wrangler secret put MCP_API_KEY
npx wrangler secret put INTERNAL_SYNC_KEY
npm run build     # typecheck
npm run deploy     # wrangler deploy
```

`DEXCOM_ENV` selects the Dexcom API base (`sandbox`, `production_us`, `production_eu`, `production_jp`; defaults to sandbox).

## Stack

Cloudflare Workers · Durable Objects · KV · TypeScript · [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol) · [`agents`](https://github.com/cloudflare/agents) · Zod
