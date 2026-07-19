// Netflix nftoken generator — takes raw cookie text (JSON array from
// Cookie-Editor, Netscape format, or raw `document.cookie` string), extracts
// the NetflixId cookie, calls Netflix's iOS token endpoint, and returns a
// one-tap login URL of the form https://netflix.com/?nftoken=...
//
// The upstream Python script is intentionally kept server-side so its request
// signature (headers/query params) never leaks to browsers.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const API_URL = "https://ios.prod.ftl.netflix.com/iosui/user/15.48";

const QUERY_PARAMS: Record<string, string> = {
  appVersion: "15.48.1",
  config:
    '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"false","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
  device_type: "NFAPPL-02-",
  esn: "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  idiom: "phone",
  iosVersion: "15.8.5",
  isTablet: "false",
  languages: "en-US",
  locale: "en-US",
  maxDeviceWidth: "375",
  model: "saget",
  modelType: "IPHONE8-1",
  odpAware: "true",
  path: '["account","token","default"]',
  pathFormat: "graph",
  pixelDensity: "2.0",
  progressive: "false",
  responseFormat: "json",
};

const BASE_HEADERS: Record<string, string> = {
  "User-Agent": "Argo/15.48.1 (iPhone; iOS 15.8.5; Scale/2.00)",
  "x-netflix.request.attempt": "1",
  "x-netflix.request.client.user.guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.context.profile-guid": "A4CS633D7VCBPE2GPK2HL4EKOE",
  "x-netflix.request.routing": '{"path":"/nq/mobile/nqios/~15.48.0/user","control_tag":"iosui_argo"}',
  "x-netflix.context.app-version": "15.48.1",
  "x-netflix.argo.translated": "true",
  "x-netflix.context.form-factor": "phone",
  "x-netflix.context.sdk-version": "2012.4",
  "x-netflix.client.appversion": "15.48.1",
  "x-netflix.context.max-device-width": "375",
  "x-netflix.context.ab-tests": "",
  "x-netflix.tracing.cl.useractionid": "4DC655F2-9C3C-4343-8229-CA1B003C3053",
  "x-netflix.client.type": "argo",
  "x-netflix.client.ftl.esn": "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  "x-netflix.context.locales": "en-US",
  "x-netflix.context.top-level-uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.client.iosversion": "15.8.5",
  "accept-language": "en-US;q=1",
  "x-netflix.argo.abtests": "",
  "x-netflix.context.os-version": "15.8.5",
  "x-netflix.request.client.context": '{"appState":"foreground"}',
  "x-netflix.context.ui-flavor": "argo",
  "x-netflix.argo.nfnsm": "9",
  "x-netflix.context.pixel-density": "2.0",
  "x-netflix.request.toplevel.uuid": "90AFE39F-ADF1-4D8A-B33E-528730990FE3",
  "x-netflix.request.client.timezoneid": "Asia/Dhaka",
};

const COOKIE_KEYS = ["NetflixId", "SecureNetflixId", "nfvdid", "OptanonConsent"];

function decodeVal(v: string): string {
  if (typeof v === "string" && v.includes("%")) {
    try { return decodeURIComponent(v); } catch { return v; }
  }
  return v;
}

function extractCookies(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Netscape tab-separated lines
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length >= 7) out[parts[5]] = parts[6];
  }

  // JSON (array from Cookie-Editor, or object)
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }

  const takeFromArray = (arr: any[]) => {
    for (const c of arr) {
      const name = c?.name;
      const value = c?.value;
      if (COOKIE_KEYS.includes(name) && typeof value === "string") {
        out[name] = decodeVal(value);
      }
    }
  };

  if (Array.isArray(data)) takeFromArray(data);
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (COOKIE_KEYS.some((k) => k in obj)) {
      for (const k of COOKIE_KEYS) {
        const v = obj[k];
        if (typeof v === "string") out[k] = decodeVal(v);
      }
    } else if (Array.isArray(obj.cookies)) takeFromArray(obj.cookies as any[]);
  }

  // Regex fallback for raw "Name=value; ..." strings
  for (const key of COOKIE_KEYS) {
    if (out[key]) continue;
    const re = new RegExp(`(?<!\\w)${key}=([^;,\\s]+)`);
    const m = text.match(re);
    if (m) out[key] = decodeVal(m[1]);
  }

  return out;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const cookieText = typeof body?.cookies === "string" ? body.cookies : "";
  if (!cookieText.trim()) return json({ error: "Missing cookies" }, 400);
  if (cookieText.length > 200_000) return json({ error: "Cookies too large" }, 400);

  const cookies = extractCookies(cookieText);
  const netflixId = cookies.NetflixId;
  if (!netflixId) return json({ error: "Missing required cookie: NetflixId" }, 400);

  const url = new URL(API_URL);
  for (const [k, v] of Object.entries(QUERY_PARAMS)) url.searchParams.set(k, v);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "GET",
      headers: { ...BASE_HEADERS, Cookie: `NetflixId=${netflixId}` },
    });
  } catch (e) {
    return json({ error: `Netflix request failed: ${(e as Error).message}` }, 502);
  }

  if (!resp.ok) return json({ error: `Netflix responded ${resp.status}` }, 502);

  let data: any;
  try { data = await resp.json(); } catch { return json({ error: "Invalid Netflix response" }, 502); }

  const tokenData = data?.value?.account?.token?.default ?? {};
  const token = tokenData?.token;
  let expires = tokenData?.expires;

  if (!token || typeof token !== "string") {
    return json({ error: "No token in Netflix response — cookies may be expired" }, 401);
  }

  if (typeof expires === "number" && String(expires).length === 13) expires = Math.floor(expires / 1000);

  return json({
    url: `https://netflix.com/?nftoken=${token}`,
    expires: typeof expires === "number" ? expires : null,
  });
});
