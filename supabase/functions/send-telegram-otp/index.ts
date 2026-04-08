import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function getTelegramConfig(): Promise<{ botToken: string; chatId: string } | null> {
  // Try app_settings first (admin panel saves here)
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

  // Fallback to env vars
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
    const { otp, userId } = await req.json();

    if (!otp || !userId) {
      return new Response(JSON.stringify({ error: 'Missing otp or userId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tgConfig = await getTelegramConfig();
    if (!tgConfig) {
      console.error('Telegram not configured in app_settings or env vars');
      return new Response(JSON.stringify({ error: 'Telegram not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const telegramRes = await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgConfig.chatId,
        text: `🛡 Admin 3FA OTP: <code>${otp}</code>\nValid for 5 minutes.`,
        parse_mode: 'HTML',
      }),
    });

    if (!telegramRes.ok) {
      const errText = await telegramRes.text();
      console.error('Telegram API error:', errText);
      return new Response(JSON.stringify({ error: 'Failed to send Telegram message' }), {
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
