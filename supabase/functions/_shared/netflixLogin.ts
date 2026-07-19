const COOKIE_KEYS = ["NetflixId", "SecureNetflixId", "nfvdid", "OptanonConsent"];

const decodeVal = (v: string) => {
  if (typeof v === "string" && v.includes("%")) {
    try { return decodeURIComponent(v); } catch { return v; }
  }
  return v;
};

function parseCookies(cookieText: string): Record<string, string> {
  const cookies: Record<string, string> = {};

  for (const raw of cookieText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length >= 7) cookies[parts[5]] = parts[6];
  }

  let data: any = null;
  try { data = JSON.parse(cookieText); } catch { /* not JSON */ }
  const takeArr = (arr: any[]) => {
    for (const c of arr) {
      if (COOKIE_KEYS.includes(c?.name) && typeof c?.value === "string") cookies[c.name] = decodeVal(c.value);
    }
  };
  if (Array.isArray(data)) takeArr(data);
  else if (data && typeof data === "object") {
    if (COOKIE_KEYS.some((k) => k in data)) {
      for (const k of COOKIE_KEYS) if (typeof data[k] === "string") cookies[k] = decodeVal(data[k]);
    } else if (Array.isArray(data.cookies)) takeArr(data.cookies);
  }

  for (const key of COOKIE_KEYS) {
    if (cookies[key]) continue;
    const m = cookieText.match(new RegExp(`(?<!\\w)${key}=([^;,\\s]+)`));
    if (m) cookies[key] = decodeVal(m[1]);
  }

  return cookies;
}

const QP: Record<string, string> = {
  appVersion: "15.48.1",
  config: '{"gamesInTrailersEnabled":"false","isTrailersEvidenceEnabled":"false","cdsMyListSortEnabled":"true","kidsBillboardEnabled":"true","addHorizontalBoxArtToVideoSummariesEnabled":"false","skOverlayTestEnabled":"false","homeFeedTestTVMovieListsEnabled":"false","baselineOnIpadEnabled":"true","trailersVideoIdLoggingFixEnabled":"true","postPlayPreviewsEnabled":"false","bypassContextualAssetsEnabled":"false","roarEnabled":"true","useSeason1AltLabelEnabled":"false","disableCDSSearchPaginationSectionKinds":["searchVideoCarousel"],"cdsSearchHorizontalPaginationEnabled":"true","searchPreQueryGamesEnabled":"true","kidsMyListEnabled":"true","billboardEnabled":"true","useCDSGalleryEnabled":"true","contentWarningEnabled":"true","videosInPopularGamesEnabled":"true","avifFormatEnabled":"false","sharksEnabled":"true"}',
  device_type: "NFAPPL-02-",
  esn: "NFAPPL-02-IPHONE8=1-PXA-02026U9VV5O8AUKEAEO8PUJETCGDD4PQRI9DEB3MDLEMD0EACM4CS78LMD334MN3MQ3NMJ8SU9O9MVGS6BJCURM1PH1MUTGDPF4S4200",
  idiom: "phone", iosVersion: "15.8.5", isTablet: "false", languages: "en-US", locale: "en-US",
  maxDeviceWidth: "375", model: "saget", modelType: "IPHONE8-1", odpAware: "true",
  path: '["account","token","default"]', pathFormat: "graph", pixelDensity: "2.0",
  progressive: "false", responseFormat: "json",
};

const BH: Record<string, string> = {
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

export async function createNetflixLoginLink(cookieText: string): Promise<{ url: string; expires: number | null }> {
  if (!cookieText.trim()) throw new Error("Missing cookies input");
  if (cookieText.length > 200_000) throw new Error("Cookies too large");

  const cookies = parseCookies(cookieText);
  const netflixId = cookies.NetflixId;
  if (!netflixId) throw new Error("Missing required cookie: NetflixId");

  const url = new URL("https://ios.prod.ftl.netflix.com/iosui/user/15.48");
  for (const [k, v] of Object.entries(QP)) url.searchParams.set(k, v);

  const nfResp = await fetch(url.toString(), { method: "GET", headers: { ...BH, Cookie: `NetflixId=${netflixId}` } });
  if (!nfResp.ok) {
    const errBody = await nfResp.text().catch(() => "");
    throw new Error(`Netflix responded ${nfResp.status}${errBody ? `: ${errBody.slice(0, 160)}` : ""}`);
  }

  const nfData: any = await nfResp.json();
  const tok = nfData?.value?.account?.token?.default ?? {};
  const token = tok?.token;
  let expires = tok?.expires;
  if (!token || typeof token !== "string") throw new Error("No token in Netflix response — cookies may be expired");
  if (typeof expires === "number" && String(expires).length === 13) expires = Math.floor(expires / 1000);

  return { url: `https://netflix.com/?nftoken=${token}`, expires: typeof expires === "number" ? expires : null };
}