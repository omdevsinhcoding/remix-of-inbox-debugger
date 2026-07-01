import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-session-token, x-client-ip',
};

function getClientIp(req: Request): string | null {
  const candidates = [
    req.headers.get('x-client-ip'),
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-real-ip'),
    req.headers.get('x-forwarded-for')?.split(',')[0],
  ];
  for (const raw of candidates) {
    const ip = raw?.trim();
    if (ip && ip !== '127.0.0.1' && ip !== '::1') return ip;
  }
  return null;
}

type IpWhoIsResult = {
  ip: string;
  success: boolean;
  type?: string;
  continent?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  postal?: string;
  is_eu?: boolean;
  calling_code?: string;
  capital?: string;
  flag?: { emoji?: string };
  connection?: { asn?: number; org?: string; isp?: string; domain?: string };
  timezone?: { id?: string; abbr?: string; utc?: string; current_time?: string };
};

async function fetchIpWhoIs(ip: string | null): Promise<IpWhoIsResult | null> {
  try {
    const url = ip ? `https://ipwho.is/${encodeURIComponent(ip)}` : 'https://ipwho.is/';
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as IpWhoIsResult;
    if (!data?.success) return null;
    return data;
  } catch (err) {
    console.error('[ipwho.is] fetch failed:', err);
    return null;
  }
}

async function getTelegramConfig(): Promise<{ botToken: string; chatId: string } | null> {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
    const cfg = data?.value as any;
    if (cfg?.TELEGRAM_BOT_TOKEN && cfg?.TELEGRAM_CHAT_ID) {
      return { botToken: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID };
    }
  } catch {}
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
  if (botToken && chatId) return { botToken, chatId };
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { username, name, status } = body ?? {};
    const clientIp = getClientIp(req);

    const tg = await getTelegramConfig();
    if (!tg) {
      return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const info = await fetchIpWhoIs(clientIp);
    const ip = info?.ip || clientIp || 'Unknown';
    const flag = info?.flag?.emoji || '🌐';
    const city = info?.city || 'Unknown City';
    const region = info?.region || '';
    const country = info?.country || 'Unknown Country';
    const postal = info?.postal || '';
    const lat = info?.latitude;
    const lon = info?.longitude;
    const isp = info?.connection?.isp || info?.connection?.org || 'Unknown ISP';
    const asn = info?.connection?.asn ? `AS${info.connection.asn}` : '';
    const tz = info?.timezone?.id || '';
    const tzTime = info?.timezone?.current_time || new Date().toISOString();
    const connType = info?.type ? info.type.toUpperCase() : '';

    const displayName = name || username || 'Unknown User';
    const statusEmoji = status === 'success' ? '✅ Success' : '❌ Failed';
    const actionText = status === 'success' ? 'signed in' : 'failed to sign in';

    const locLine = [city, region, country].filter(Boolean).join(', ');
    const mapsLink = (typeof lat === 'number' && typeof lon === 'number')
      ? `https://www.google.com/maps?q=${lat},${lon}`
      : null;

    // Copyable one-liner (single <code> block, tap-to-copy in Telegram)
    const copyLine = `${displayName} • ${ip} • ${locLine}`;

    const lines = [
      `<b>${flag} Login Attempt</b>`,
      `<b>User:</b> ${esc(displayName)} (<code>${esc(username || '')}</code>)`,
      `<b>Status:</b> ${statusEmoji}  •  <b>Action:</b> ${actionText}`,
      ``,
      `<b>📍 Location</b>`,
      `<b>Place:</b> ${esc(locLine)}`,
      postal ? `<b>Postal:</b> <code>${esc(postal)}</code>` : '',
      (typeof lat === 'number' && typeof lon === 'number')
        ? `<b>Coords:</b> <code>${lat.toFixed(4)}, ${lon.toFixed(4)}</code>`
        : '',
      mapsLink ? `<b>Map:</b> <a href="${mapsLink}">Open in Google Maps</a>` : '',
      ``,
      `<b>🛰 Network</b>`,
      `<b>IP:</b> <code>${esc(ip)}</code>`,
      `<b>ISP:</b> ${esc(isp)}${asn ? ` (${asn})` : ''}`,
      connType ? `<b>Type:</b> ${esc(connType)}` : '',
      ``,
      `<b>🕒 Time</b>`,
      `<b>Local:</b> ${esc(tzTime)}${tz ? ` (${esc(tz)})` : ''}`,
      `<b>IST:</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })}`,
      ``,
      `<b>📋 Quick Copy</b>`,
      `<code>${esc(copyLine)}</code>`,
    ].filter(Boolean);

    const message = lines.join('\n');

    const tgRes = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!tgRes.ok) {
      const errText = await tgRes.text();
      console.error('[notification] Telegram API error:', errText);
      return new Response(JSON.stringify({ error: 'Telegram send failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[notification] error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
