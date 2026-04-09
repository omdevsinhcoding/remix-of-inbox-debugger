import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token, x-client-ip',
};

function getClientIp(req: Request): string | null {
  // x-client-ip is forwarded by our Cloudflare worker proxy
  const clientIp = req.headers.get('x-client-ip')?.trim();
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = req.headers.get('x-real-ip')?.trim();
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  const candidate = clientIp || forwardedFor || cfIp || realIp || null;
  if (!candidate || candidate === '127.0.0.1' || candidate === '::1' || candidate === '') return null;
  return candidate;
}

async function resolveCoordsFromIp(ip: string): Promise<{ lat: number; lon: number; city?: string; state?: string } | null> {
  try {
    const ipRes = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SecureOTPViewer/1.0' },
    });

    if (!ipRes.ok) {
      console.error('[location] IP geolocation failed with status:', ipRes.status);
      return null;
    }

    const ipData = await ipRes.json();
    const lat = Number(ipData?.latitude);
    const lon = Number(ipData?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.error('[location] IP geolocation returned invalid coords:', ipData?.latitude, ipData?.longitude);
      return null;
    }

    console.log('[location] IP geolocation resolved:', ipData?.city, ipData?.region, `(${lat}, ${lon})`);
    return {
      lat,
      lon,
      city: typeof ipData?.city === 'string' ? ipData.city : '',
      state: typeof ipData?.region === 'string' ? ipData.region : '',
    };
  } catch (err) {
    console.error('[location] IP geolocation request failed:', err);
    return null;
  }
}

async function getTelegramConfig(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "config")
      .single();
    if (data?.value) {
      const config = data.value as any;
      if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
        return { botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_CHAT_ID };
      }
    }
  } catch {}

  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (botToken && chatId) return { botToken, chatId };
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { username, name, status, lat, lon, city, state, locationSource } = await req.json();
    const clientIp = getClientIp(req);

    console.log(`[notification] Received: locationSource=${locationSource || 'unknown'}, lat=${lat}, lon=${lon}, clientIp=${clientIp || 'none'}`);

    const tgConfig = await getTelegramConfig();
    if (!tgConfig) {
      console.error('[notification] Telegram not configured');
      return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let resolvedCity = city || '';
    let resolvedState = state || '';
    let numLat = Number(lat);
    let numLon = Number(lon);
    let hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon);
    let finalSource = locationSource || (hasCoords ? 'client' : 'none');

    // Server-side IP fallback if no coords from client
    if (!hasCoords && clientIp) {
      console.log('[location] No coords from client, trying IP geolocation for:', clientIp);
      const ipLocation = await resolveCoordsFromIp(clientIp);
      if (ipLocation) {
        numLat = ipLocation.lat;
        numLon = ipLocation.lon;
        hasCoords = true;
        finalSource = 'server-ip';
        resolvedCity ||= ipLocation.city || '';
        resolvedState ||= ipLocation.state || '';
      }
    }

    // Reverse geocode if we have coords but no city/state
    if (hasCoords && (!resolvedCity || !resolvedState)) {
      try {
        console.log('[location] Reverse geocoding coords:', numLat, numLon);
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${numLat}&lon=${numLon}&zoom=10&addressdetails=1`,
          { headers: { 'User-Agent': 'SecureOTPViewer/1.0', 'Accept': 'application/json', 'Accept-Language': 'en' } }
        );
        if (geoRes.ok) {
          const geoData = await geoRes.json();
          const addr = geoData?.address ?? {};
          resolvedCity ||= addr.city || addr.town || addr.village || addr.county || addr.state_district || geoData?.name || '';
          resolvedState ||= addr.state || addr.region || addr.province || '';
          console.log('[location] Reverse geocode result:', resolvedCity, resolvedState);
        } else {
          console.error('[location] Reverse geocoding HTTP error:', geoRes.status);
        }
      } catch (geoErr) {
        console.error('[location] Reverse geocoding failed:', geoErr);
      }
    }

    // Build location string - never show "Unknown Location" if we have any data
    let locationData: string;
    if (resolvedCity || resolvedState) {
      locationData = `${resolvedCity || 'Unknown City'}, ${resolvedState || 'Unknown State'}`;
    } else if (hasCoords) {
      locationData = `Coordinates: ${numLat.toFixed(4)}, ${numLon.toFixed(4)}`;
    } else if (clientIp) {
      locationData = `IP: ${clientIp} (geolocation unavailable)`;
    } else {
      locationData = 'Unknown Location';
    }

    const displayName = name || username || 'Unknown User';
    const actionText = status === 'success' ? 'logged in' : 'had a failed login attempt';
    const statusEmoji = status === 'success' ? '✅ Success' : '❌ Failed';
    const mapsLink = hasCoords
      ? `\n<b>Maps:</b> <a href="https://www.google.com/maps?q=${numLat},${numLon}">View on Map</a>`
      : '';

    const message = `
<b>🔐 Login Attempt</b>
<b>${displayName}</b> ${actionText} from <b>${locationData}</b>
<b>User:</b> ${displayName}
<b>Status:</b> ${statusEmoji}
<b>Location:</b> ${locationData}${mapsLink}
<b>Source:</b> ${finalSource}
<b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
    `.trim();

    console.log('[notification] Sending Telegram message, location source:', finalSource);

    const telegramRes = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgConfig.chatId, text: message, parse_mode: 'HTML' }),
    });

    if (!telegramRes.ok) {
      const errText = await telegramRes.text();
      console.error('[notification] Telegram API error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send Telegram notification' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log('[notification] Telegram message sent successfully');
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[notification] Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
