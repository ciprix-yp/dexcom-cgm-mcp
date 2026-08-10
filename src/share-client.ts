// Client pentru Dexcom Share API (neoficial, reverse-engineered de comunitate -- vezi
// github.com/gagebenne/pydexcom, 254 stele, folosit în integrarea oficială Home Assistant).
// Login direct cu username+parolă de cont Dexcom, fără OAuth, fără app review. Adăugat ca
// alternativă la fluxul OAuth existent (rămas neatins mai jos) după ce automatizarea de
// sandbox-consent a Dexcom s-a blocat intern, fără termen de reparare, fără răspuns la suport.

type ShareEnv = {
  DEXCOM_SHARE_USERNAME?: string;
  DEXCOM_SHARE_PASSWORD?: string;
  DEXCOM_SHARE_REGION?: string; // "us" | "ous" | "jp", default "ous"
  DEXCOM_TOKENS: KVNamespace;
};

const SHARE_BASE_URLS: Record<string, string> = {
  us: "https://share2.dexcom.com/ShareWebServices/Services",
  ous: "https://shareous1.dexcom.com/ShareWebServices/Services",
  jp: "https://share.dexcom.jp/ShareWebServices/Services",
};

// Același application ID pentru US și OUS (verificat direct în sursa pydexcom) -- Dexcom nu
// pare să distingă regiunea la acest nivel, doar prin base URL.
const SHARE_APPLICATION_ID = "d89443d2-327c-4a6f-89e5-496bbb0317db";

const SHARE_MAX_MINUTES = 1440; // 24h -- capul hard al Share API, spre deosebire de v3 (30 zile)
const SHARE_MAX_COUNT = 288; // 1 citire/5min * 24h

// Vocabular Share API pentru trend -- PascalCase, diferit de v3 (camelCase). Mapat direct pe
// enum-ul din schema cgm_readings.trend (rising_fast|rising|stable|falling|falling_fast).
const SHARE_TREND_MAP: Record<string, string | null> = {
  DoubleUp: "rising_fast",
  SingleUp: "rising",
  FortyFiveUp: "rising",
  Flat: "stable",
  FortyFiveDown: "falling",
  SingleDown: "falling",
  DoubleDown: "falling_fast",
  None: null,
  NotComputable: null,
  RateOutOfRange: null,
};

export type ShareEgv = {
  systemTime: string; // ISO, din câmpul DT (are offset de fus orar real, spre deosebire de v3 systemTime)
  displayTime: string; // ISO, din câmpul WT (fără offset explicit -- vezi parseShareDate)
  value: number;
  trend: string | null; // deja mapat pe enum-ul nostru, nu string brut Dexcom
  unit: "mg/dL";
};

type ShareRawReading = { WT: string; DT: string; Value: number; Trend: string };

function shareBase(env: ShareEnv): string {
  return SHARE_BASE_URLS[env.DEXCOM_SHARE_REGION || "ous"] || SHARE_BASE_URLS.ous;
}

// Formatul Dexcom Share e "Date(1234567890000+0200)" -- epoch ms + offset de fus orar, format
// JSON legacy Microsoft. WT nu are offset (naiv, ora device-ului); DT are offset real.
function parseShareDate(raw: string): string {
  const match = raw.match(/Date\((\d+)([+-]\d{4})?\)/);
  if (!match) throw new Error(`unparseable_share_date: ${raw}`);
  const epochMs = Number(match[1]);
  return new Date(epochMs).toISOString();
}

async function sharePost(env: ShareEnv, endpoint: string, body: Record<string, unknown>) {
  const res = await fetch(`${shareBase(env)}/${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`share_api_error_${res.status}_${endpoint}: ${text.slice(0, 300)}`);
  }
  return data;
}

async function shareAuthenticateAccountId(env: ShareEnv): Promise<string> {
  if (!env.DEXCOM_SHARE_USERNAME || !env.DEXCOM_SHARE_PASSWORD) {
    throw new Error("dexcom_share_credentials_not_set");
  }
  return sharePost(env, "General/AuthenticatePublisherAccount", {
    accountName: env.DEXCOM_SHARE_USERNAME,
    password: env.DEXCOM_SHARE_PASSWORD,
    applicationId: SHARE_APPLICATION_ID,
  });
}

async function shareLoginSessionId(env: ShareEnv, accountId: string): Promise<string> {
  return sharePost(env, "General/LoginPublisherAccountById", {
    accountId,
    password: env.DEXCOM_SHARE_PASSWORD,
    applicationId: SHARE_APPLICATION_ID,
  });
}

// Autentificare completă (2 request-uri): username+parolă -> account ID -> session ID. Cache-uit
// în KV (același namespace DEXCOM_TOKENS deja existent pentru fluxul OAuth, cheie diferită) --
// nu documentat public cât ține un session ID Share, deci re-autentificăm dacă cel din cache dă
// SessionIdNotFound/SessionNotValid la citire (retry o singură dată, ca pydexcom).
async function shareEstablishSession(env: ShareEnv): Promise<string> {
  const accountId = await shareAuthenticateAccountId(env);
  const sessionId = await shareLoginSessionId(env, accountId);
  await env.DEXCOM_TOKENS.put("share_session_id", sessionId, { expirationTtl: 60 * 60 * 20 });
  return sessionId;
}

async function shareGetSessionId(env: ShareEnv): Promise<string> {
  const cached = await env.DEXCOM_TOKENS.get("share_session_id");
  if (cached) return cached;
  return shareEstablishSession(env);
}

function isShareSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("SessionIdNotFound") || msg.includes("SessionNotValid") || msg.includes("share_api_error_500");
}

// minutes: 1-1440 (cap hard Share API, ~24h). Pentru un gol mai vechi de atât, Share API pur și
// simplu nu poate ajuta -- vezi findCgmGaps în repo-ul principal, LOOKBACK_HOURS trebuie <=~21h
// (marjă sub cap-ul de 24h) ca job-ul de gap-fill să nu ceară niciodată o fereastră imposibilă.
export async function shareGetGlucoseReadings(
  env: ShareEnv,
  minutes: number,
  maxCount = SHARE_MAX_COUNT
): Promise<ShareEgv[]> {
  const clampedMinutes = Math.min(Math.max(Math.round(minutes), 1), SHARE_MAX_MINUTES);
  const clampedCount = Math.min(Math.max(Math.round(maxCount), 1), SHARE_MAX_COUNT);

  let sessionId = await shareGetSessionId(env);
  let raw: ShareRawReading[];
  try {
    raw = await fetchGlucoseReadingsQuery(env, sessionId, clampedMinutes, clampedCount);
  } catch (err) {
    if (!isShareSessionError(err)) throw err;
    sessionId = await shareEstablishSession(env); // sesiune expirată -- reautentificare, o singură reîncercare
    raw = await fetchGlucoseReadingsQuery(env, sessionId, clampedMinutes, clampedCount);
  }

  return raw.map((r) => ({
    systemTime: parseShareDate(r.DT),
    displayTime: parseShareDate(r.WT),
    value: r.Value,
    trend: SHARE_TREND_MAP[r.Trend] ?? null,
    unit: "mg/dL",
  }));
}

async function fetchGlucoseReadingsQuery(
  env: ShareEnv,
  sessionId: string,
  minutes: number,
  maxCount: number
): Promise<ShareRawReading[]> {
  const url = new URL(`${shareBase(env)}/Publisher/ReadPublisherLatestGlucoseValues`);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("minutes", String(minutes));
  url.searchParams.set("maxCount", String(maxCount));

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "application/json" },
    body: "{}",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : [];
  if (!res.ok) {
    throw new Error(`share_api_error_${res.status}_readings: ${text.slice(0, 300)}`);
  }
  return data as ShareRawReading[];
}
