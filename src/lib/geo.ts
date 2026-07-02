// Browser-side geolocation via ipwho.is.
// The browser's request hits ipwho.is directly, so we always get the true
// visitor IP (not the Cloudflare/Supabase edge IP that server-side lookups see).
// Result is cached in sessionStorage for the lifetime of the tab.

export type VisitorGeo = {
  success: true;
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  country_code?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  isp?: string;
  org?: string;
  asn?: number | string;
  timezone_id?: string;
  flag_emoji?: string;
  source: "ipwho.is";
};

const CACHE_KEY = "visitor_geo_v1";
let inflight: Promise<VisitorGeo | null> | null = null;

function readCache(): VisitorGeo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.success === true && typeof parsed.ip === "string") return parsed as VisitorGeo;
  } catch {}
  return null;
}

function writeCache(g: VisitorGeo) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(g)); } catch {}
}

export async function getVisitorGeo(): Promise<VisitorGeo | null> {
  const cached = readCache();
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      const res = await fetch("https://ipwho.is/?output=json", { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data: any = await res.json();
      if (!data || data.success !== true || typeof data.ip !== "string") return null;
      const geo: VisitorGeo = {
        success: true,
        ip: data.ip,
        city: data.city,
        region: data.region,
        country: data.country,
        country_code: data.country_code,
        postal: data.postal,
        latitude: typeof data.latitude === "number" ? data.latitude : undefined,
        longitude: typeof data.longitude === "number" ? data.longitude : undefined,
        isp: data.connection?.isp,
        org: data.connection?.org,
        asn: data.connection?.asn,
        timezone_id: data.timezone?.id,
        flag_emoji: data.flag?.emoji,
        source: "ipwho.is",
      };
      writeCache(geo);
      return geo;
    } catch (err) {
      console.warn("[visitor-geo] ipwho.is failed:", err);
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function getCachedVisitorGeo(): VisitorGeo | null {
  return readCache();
}
