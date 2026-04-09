import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token',
};

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
    const { username, name, status, lat, lon, city, state } = await req.json();

    const tgConfig = await getTelegramConfig();
    if (!tgConfig) {
      console.error('Telegram not configured');
      return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let resolvedCity = city || '';
    let resolvedState = state || '';
    const numLat = Number(lat);
    const numLon = Number(lon);
    const hasCoords = Number.isFinite(numLat) && Number.isFinite(numLon);

    if (hasCoords && (!resolvedCity || !resolvedState)) {
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${numLat}&lon=${numLon}&zoom=10&addressdetails=1`,
          { headers: { 'User-Agent': 'SecureOTPViewer/1.0', 'Accept': 'application/json', 'Accept-Language': 'en' } }
        );
        if (geoRes.ok) {
          const geoData = await geoRes.json();
          const addr = geoData?.address ?? {};
          resolvedCity ||= addr.city || addr.town || addr.village || addr.county || addr.state_district || geoData?.name || '';
          resolvedState ||= addr.state || addr.region || addr.province || '';
        }
      } catch (geoErr) {
        console.error('Reverse geocoding failed:', geoErr);
      }
    }

    const locationData = resolvedCity || resolvedState
      ? `${resolvedCity || 'Unknown City'}, ${resolvedState || 'Unknown State'}`
      : 'Unknown Location';

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
<b>Time:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
    `.trim();

    const telegramRes = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgConfig.chatId, text: message, parse_mode: 'HTML' }),
    });

    if (!telegramRes.ok) {
      const errText = await telegramRes.text();
      console.error('Telegram API error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send Telegram notification' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
