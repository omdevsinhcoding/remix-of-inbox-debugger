// Plan reminders cron: sends Telegram notifications to admin about paid users' plans.
//   - On plan start day (first time only): "Plan started for <user>".
//   - In the last 7 days before expiry: hourly reminders (throttled by plan_last_reminder_at).
//
// Intended to be invoked by pg_cron every hour. Uses the shared cron secret so
// only cron / admin can trigger it. Verify_jwt is false in config.toml.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SHARED_SECRET') || '';
const TG_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
const TG_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') || '';

async function tg(text: string) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch { /* ignore telegram errors */ }
}

function fmt(dateIso: string): string {
  try { return new Date(dateIso).toISOString().replace('T', ' ').replace(/\..+/, ' UTC'); } catch { return dateIso; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Auth: cron secret in header, or admin session (we're generous here — cron path is the main caller).
  const secret = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = Date.now();
  const in7d = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now - 55 * 60 * 1000).toISOString();

  let startNotified = 0;
  let reminded = 0;
  let expiredNotified = 0;

  // 1) Plan-start notifications (once per user).
  {
    const { data: startsToday } = await supabase
      .from('app_users')
      .select('id, name, username, plan_starts_at, plan_ends_at, plan_start_notified_at')
      .eq('is_free', false)
      .neq('role', 'admin')
      .not('plan_starts_at', 'is', null)
      .is('plan_start_notified_at', null)
      .lte('plan_starts_at', new Date(now).toISOString());
    for (const u of (startsToday || [])) {
      const endsLine = u.plan_ends_at ? `\nEnds: ${fmt(u.plan_ends_at)}` : '';
      await tg(`▶️ <b>Plan started</b>\nUser: ${u.name || u.username || u.id}\nStarted: ${fmt(u.plan_starts_at!)}${endsLine}`);
      await supabase.from('app_users').update({ plan_start_notified_at: new Date().toISOString() }).eq('id', u.id);
      startNotified++;
    }
  }

  // 2) Last-7-days reminders (hourly, throttled by plan_last_reminder_at ≥ 55 min).
  {
    const { data: ending } = await supabase
      .from('app_users')
      .select('id, name, username, plan_ends_at, plan_last_reminder_at')
      .eq('is_free', false)
      .neq('role', 'admin')
      .not('plan_ends_at', 'is', null)
      .gt('plan_ends_at', new Date(now).toISOString())
      .lte('plan_ends_at', in7d);
    for (const u of (ending || [])) {
      if (u.plan_last_reminder_at && u.plan_last_reminder_at > oneHourAgo) continue;
      const endMs = Date.parse(String(u.plan_ends_at));
      const hoursLeft = Math.max(0, Math.round((endMs - now) / (60 * 60 * 1000)));
      const daysLeft = Math.max(0, Math.floor(hoursLeft / 24));
      const timeStr = daysLeft > 0 ? `${daysLeft}d ${hoursLeft % 24}h` : `${hoursLeft}h`;
      await tg(`⏳ <b>Plan ending soon</b>\nUser: ${u.name || u.username || u.id}\nTime left: <b>${timeStr}</b>\nEnds: ${fmt(u.plan_ends_at!)}`);
      await supabase.from('app_users').update({ plan_last_reminder_at: new Date().toISOString() }).eq('id', u.id);
      reminded++;
    }
  }

  // 3) Plan-expired notifications (fires once, the minute the plan ends).
  {
    const { data: expired } = await supabase
      .from('app_users')
      .select('id, name, username, plan_starts_at, plan_ends_at, plan_end_notified_at')
      .eq('is_free', false)
      .neq('role', 'admin')
      .not('plan_ends_at', 'is', null)
      .lte('plan_ends_at', new Date(now).toISOString())
      .is('plan_end_notified_at', null);
    for (const u of (expired || [])) {
      const startedLine = u.plan_starts_at ? `\nStarted: ${fmt(u.plan_starts_at)}` : '';
      await tg(`🛑 <b>Plan expired</b>\nUser: ${u.name || u.username || u.id}${startedLine}\nEnded: ${fmt(u.plan_ends_at!)}`);
      await supabase.from('app_users').update({ plan_end_notified_at: new Date().toISOString() }).eq('id', u.id);
      expiredNotified++;
    }
  }

  return new Response(JSON.stringify({ success: true, startNotified, reminded, expiredNotified }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
