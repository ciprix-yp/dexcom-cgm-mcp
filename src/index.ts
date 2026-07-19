import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  DEXCOM_CLIENT_ID: string;
  DEXCOM_CLIENT_SECRET: string;
  DEXCOM_REDIRECT_URI: string;
  DEXCOM_ENV?: string;
  MCP_API_KEY: string;
  DEXCOM_TOKENS: KVNamespace;
};

interface DexcomTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

const BASES: Record<string, string> = {
  sandbox: "https://sandbox-api.dexcom.com",
  production_us: "https://api.dexcom.com",
  production_eu: "https://api.dexcom.eu",
  production_jp: "https://api.dexcom.jp",
};

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function getBase(env: Env) {
  return BASES[env.DEXCOM_ENV || "sandbox"] || BASES.sandbox;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function requireAuth(request: Request, env: Env) {
  const expected = env.MCP_API_KEY;
  const auth = request.headers.get("authorization") || "";

  if (!expected) {
    return new Response("Missing MCP_API_KEY server secret", { status: 500 });
  }

  if (!timingSafeEqual(auth, `Bearer ${expected}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

function requireAdminKey(url: URL, env: Env) {
  const expected = env.MCP_API_KEY;

  if (!expected) {
    return new Response("Missing MCP_API_KEY server secret", { status: 500 });
  }

  const key = url.searchParams.get("key") || "";

  if (!timingSafeEqual(key, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }

  return null;
}

export class DexcomMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "dexcom-cgm-mcp",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "get_data_range",
      "Get Dexcom API v3 available data ranges for EGVs, events, and calibrations.",
      {},
      async () => {
        const data = await dexcomSimpleRequest(getBase(this.env), this.env, "dataRange");
        return textResult(data);
      }
    );

    this.server.tool(
      "get_devices",
      "Get Dexcom device information for the connected account.",
      {},
      async () => {
        const data = await dexcomSimpleRequest(getBase(this.env), this.env, "devices");
        return textResult(data);
      }
    );

    this.server.tool(
      "get_egvs",
      "Get Dexcom estimated glucose values for a time window. Maximum 30 days. Use Dexcom timestamp format YYYY-MM-DDTHH:mm:ss.",
      {
        startDate: z.string().describe("Start timestamp, e.g. 2026-07-18T00:00:00"),
        endDate: z.string().describe("End timestamp, e.g. 2026-07-19T00:00:00"),
      },
      async ({ startDate, endDate }) => {
        const data = await dexcomWindowData(getBase(this.env), this.env, "egvs", startDate, endDate);
        return textResult(data);
      }
    );

    this.server.tool(
      "get_latest_egvs",
      "Get recent Dexcom EGV readings for the last N hours, ending now, using UTC systemTime. Maximum 24 hours.",
      {
        hours: z.number().optional().describe("Lookback hours. Default 6. Maximum 24."),
      },
      async ({ hours }) => {
        const h = Math.min(Math.max(Number(hours || 6), 1), 24);
        const end = new Date();
        const start = new Date(end.getTime() - h * 60 * 60 * 1000);

        const data = await dexcomWindowData(
          getBase(this.env),
          this.env,
          "egvs",
          formatDexcomDate(start),
          formatDexcomDate(end)
        );

        return textResult(data);
      }
    );

    this.server.tool(
      "get_events",
      "Get Dexcom user-entered events for a time window. Maximum 30 days.",
      {
        startDate: z.string(),
        endDate: z.string(),
      },
      async ({ startDate, endDate }) => {
        const data = await dexcomWindowData(getBase(this.env), this.env, "events", startDate, endDate);
        return textResult(data);
      }
    );

    this.server.tool(
      "get_alerts",
      "Get Dexcom alert records for a time window. Maximum 30 days.",
      {
        startDate: z.string(),
        endDate: z.string(),
      },
      async ({ startDate, endDate }) => {
        const data = await dexcomWindowData(getBase(this.env), this.env, "alerts", startDate, endDate);
        return textResult(data);
      }
    );

    this.server.tool(
      "get_calibrations",
      "Get Dexcom calibration records for a time window. Maximum 30 days.",
      {
        startDate: z.string(),
        endDate: z.string(),
      },
      async ({ startDate, endDate }) => {
        const data = await dexcomWindowData(getBase(this.env), this.env, "calibrations", startDate, endDate);
        return textResult(data);
      }
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const base = getBase(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        env: env.DEXCOM_ENV || "sandbox",
        hasClientId: Boolean(env.DEXCOM_CLIENT_ID),
        hasRedirectUri: Boolean(env.DEXCOM_REDIRECT_URI),
        hasKvBinding: Boolean(env.DEXCOM_TOKENS),
        hasMcpApiKey: Boolean(env.MCP_API_KEY),
      });
    }

    if (url.pathname === "/oauth/start") {
      const authError = requireAdminKey(url, env);
      if (authError) return authError;

      const state = crypto.randomUUID();
      await env.DEXCOM_TOKENS.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

      const auth = new URL(`${base}/v3/oauth2/login`);
      auth.searchParams.set("client_id", env.DEXCOM_CLIENT_ID);
      auth.searchParams.set("redirect_uri", env.DEXCOM_REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "offline_access");
      auth.searchParams.set("state", state);
      return Response.redirect(auth.toString(), 302);
    }

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state) return json({ error: "missing_code_or_state" }, 400);

      const stateKey = `oauth_state:${state}`;
      const validState = await env.DEXCOM_TOKENS.get(stateKey);
      if (!validState) return json({ error: "invalid_or_expired_state" }, 400);
      await env.DEXCOM_TOKENS.delete(stateKey);

      const token = await exchangeCodeForToken(base, env, code);
      await saveToken(env, token);

      return new Response("Dexcom connected. You can close this tab.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/sse") || url.pathname.startsWith("/message")) {
      const authError = requireAuth(request, env);
      if (authError) return authError;

      return DexcomMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/") {
      return json({
        name: "Dexcom CGM MCP Bridge",
        status: "ok",
        mcp_server_url: `${url.origin}/sse`,
      });
    }

    return json({ error: "not_found", path: url.pathname }, 404);
  },
};

async function dexcomSimpleRequest(base: string, env: Env, resource: string) {
  const token = await getValidAccessToken(base, env);
  const res = await fetch(`${base}/v3/users/self/${resource}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return readDexcomJson(res);
}

async function dexcomWindowData(
  base: string,
  env: Env,
  resource: string,
  startDate: string,
  endDate: string
) {
  validateDateWindowOrThrow(startDate, endDate);

  const token = await getValidAccessToken(base, env);
  const dexcomUrl = new URL(`${base}/v3/users/self/${resource}`);
  dexcomUrl.searchParams.set("startDate", normalizeDexcomDate(startDate));
  dexcomUrl.searchParams.set("endDate", normalizeDexcomDate(endDate));

  const res = await fetch(dexcomUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return readDexcomJson(res);
}

function validateDateWindowOrThrow(startDate: string, endDate: string) {
  const start = new Date(addZIfMissing(startDate));
  const end = new Date(addZIfMissing(endDate));

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("Use timestamps like 2026-07-18T00:00:00.");
  }

  if (end <= start) throw new Error("endDate must be after startDate.");
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error("Dexcom allows a maximum 30-day query window.");
  }
}

async function readDexcomJson(res: Response) {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new Error(`dexcom_api_error_${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

function normalizeDexcomDate(value: string) {
  return String(value).replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
}

function addZIfMissing(value: string) {
  const s = String(value);
  if (/[zZ]$/.test(s) || /[+-]\d\d:\d\d$/.test(s)) return s;
  return `${s}Z`;
}

function formatDexcomDate(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

async function exchangeCodeForToken(base: string, env: Env, code: string): Promise<DexcomTokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", env.DEXCOM_REDIRECT_URI);
  body.set("client_id", env.DEXCOM_CLIENT_ID);
  body.set("client_secret", env.DEXCOM_CLIENT_SECRET);

  const res = await fetch(`${base}/v3/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`token_exchange_failed_${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<DexcomTokenResponse>;
}

async function refreshAccessToken(base: string, env: Env, refreshToken: string): Promise<DexcomTokenResponse> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  body.set("client_id", env.DEXCOM_CLIENT_ID);
  body.set("client_secret", env.DEXCOM_CLIENT_SECRET);

  const res = await fetch(`${base}/v3/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`token_refresh_failed_${res.status}: ${await res.text()}`);
  }

  return res.json() as Promise<DexcomTokenResponse>;
}

async function saveToken(env: Env, token: DexcomTokenResponse) {
  const now = Math.floor(Date.now() / 1000);
  const existingRaw = await env.DEXCOM_TOKENS.get("dexcom_token");
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  const saved = {
    access_token: token.access_token,
    refresh_token: token.refresh_token || existing.refresh_token,
    expires_at: now + Number(token.expires_in || 3600),
    token_type: token.token_type || "Bearer",
    saved_at: now,
  };

  await env.DEXCOM_TOKENS.put("dexcom_token", JSON.stringify(saved));
}

async function getValidAccessToken(base: string, env: Env) {
  const raw = await env.DEXCOM_TOKENS.get("dexcom_token");
  if (!raw) throw new Error("dexcom_not_connected_open_/oauth/start_first");

  const saved = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);

  if (saved.access_token && saved.expires_at && saved.expires_at > now + 120) {
    return saved.access_token;
  }

  if (!saved.refresh_token) {
    throw new Error("dexcom_missing_refresh_token_reconnect_via_/oauth/start");
  }

  const refreshed = await refreshAccessToken(base, env, saved.refresh_token);
  await saveToken(env, {
    ...refreshed,
    refresh_token: refreshed.refresh_token || saved.refresh_token,
  });

  const raw2 = await env.DEXCOM_TOKENS.get("dexcom_token");
  return JSON.parse(raw2!).access_token;
}

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
  };
}
