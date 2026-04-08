import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PASSWORD_RESET_SUBJECTS = [
  "reset your password", "forgot password", "password reset",
  "change your password", "password change", "password recovery",
  "account recovery", "reset password",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let body: any = {};
    try { body = await req.json(); } catch {}
    const mode = body.mode || "sync";

    // MODE: CACHE — return cached emails instantly from database
    if (mode === "cache") {
      const { data: cached, error: cacheErr } = await supabase
        .from("cached_emails")
        .select("*")
        .order("date", { ascending: false });

      if (cacheErr) {
        console.error("Cache read error:", cacheErr);
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const emails = (cached || []).map((e: any) => ({
        id: e.id,
        subject: e.subject,
        from: e.from_address,
        to: e.to_address,
        date: e.date,
        otp: e.otp,
        preview: e.preview,
        html: e.html,
      }));

      return new Response(JSON.stringify(emails), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MODE: SYNC — fetch from IMAP using SEARCH, save to cache
    console.log("Sync mode: fetching from IMAP server");

    let imapHost = "";
    let imapPort = 993;
    let imapUser = "";
    let imapPassword = "";

    try {
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "config")
        .single();

      if (data?.value) {
        const config = data.value as any;
        if (config.IMAP_HOST) imapHost = config.IMAP_HOST;
        if (config.IMAP_PORT) imapPort = parseInt(config.IMAP_PORT) || 993;
        if (config.IMAP_USER) imapUser = config.IMAP_USER;
        if (config.IMAP_PASSWORD) imapPassword = config.IMAP_PASSWORD;
      }
    } catch (e) {
      console.log("Could not read app_settings, falling back to env vars");
    }

    if (!imapHost) imapHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    if (!imapUser) imapUser = Deno.env.get("IMAP_USER") || "";
    if (!imapPassword) imapPassword = Deno.env.get("IMAP_PASSWORD") || "";
    const envPort = Deno.env.get("IMAP_PORT");
    if (imapPort === 993 && envPort) imapPort = parseInt(envPort) || 993;

    if (!imapUser || !imapPassword) {
      return new Response(
        JSON.stringify({ success: false, error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Connecting to IMAP:", imapHost, "as", imapUser);

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
    });

    const emails: any[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; }, 25000);

    try {
      await client.connect();
      console.log("IMAP connected");
      const lock = await client.getMailboxLock("INBOX");

      try {
        // Get already cached UIDs to skip them
        const { data: cachedRows } = await supabase
          .from("cached_emails")
          .select("id");
        const cachedIds = new Set((cachedRows || []).map((r: any) => String(r.id)));
        console.log("Already cached:", cachedIds.size, "emails");

        // Use IMAP SEARCH to find Netflix emails from last 30 days (server-side, fast)
        const since = new Date();
        since.setDate(since.getDate() - 30);
        
        let netflixUids: number[] = [];
        try {
          console.log("Using IMAP SEARCH for Netflix emails since", since.toISOString().split("T")[0]);
          const searchResults = await client.search({
            from: "info@account.netflix.com",
            since: since,
          }, { uid: true });
          
          if (searchResults && searchResults.length > 0) {
            netflixUids = searchResults as number[];
            console.log("IMAP SEARCH found", netflixUids.length, "Netflix messages");
          }
        } catch (searchErr) {
          console.log("IMAP SEARCH failed, falling back to envelope scan:", searchErr);
        }

        // Fallback: if SEARCH didn't work, scan last 500 envelopes
        if (netflixUids.length === 0) {
          const totalMessages = (client.mailbox as any)?.exists || 0;
          console.log("Fallback: scanning last 500 of", totalMessages, "messages");
          
          if (totalMessages > 0) {
            const startSeq = Math.max(1, totalMessages - 499);
            const range = `${startSeq}:${totalMessages}`;
            
            for await (const message of client.fetch(range, { envelope: true, uid: true })) {
              if (timedOut) break;
              const fromAddr = message.envelope?.from?.[0]?.address?.toLowerCase() || "";
              if (fromAddr === "info@account.netflix.com") {
                netflixUids.push(message.uid);
              }
            }
            console.log("Envelope scan found", netflixUids.length, "Netflix messages");
          }
        }

        // Process NEWEST first (reverse order) so latest emails are always fetched
        netflixUids.sort((a, b) => b - a);

        // Skip already cached UIDs
        const uncachedUids = netflixUids.filter(uid => !cachedIds.has(String(uid)));
        const alreadyCachedUids = netflixUids.filter(uid => cachedIds.has(String(uid)));
        console.log("New UIDs to fetch:", uncachedUids.length, "| Already cached:", alreadyCachedUids.length);

        // Only fetch NEW uncached emails — cached ones are already in DB
        // Fetch full content for each new Netflix email
        for (const uid of uncachedUids) {
          if (timedOut) {
            console.log("Timeout reached, returning what we have");
            break;
          }
          try {
            const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
            if (!fullMsg?.source) continue;

            // Check subject for password reset BEFORE parsing (faster)
            const envSubject = (fullMsg.envelope?.subject || "").toLowerCase();
            const isPasswordReset = PASSWORD_RESET_SUBJECTS.some(kw => envSubject.includes(kw));
            if (isPasswordReset) {
              console.log("Skipping password reset:", fullMsg.envelope?.subject);
              continue;
            }

            const parsed = await simpleParser(fullMsg.source, {
              skipImageLinks: true,
              skipTextLinks: true,
            });

            const bodyText = (parsed.text || "").trim();
            const otpMatch = bodyText.match(/\b\d{4,8}\b/);
            const otp = otpMatch ? otpMatch[0] : null;

            emails.push({
              id: String(uid),
              subject: parsed.subject || fullMsg.envelope?.subject || "",
              from: parsed.from?.text || "Netflix <info@account.netflix.com>",
              to: parsed.to
                ? Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text
                : undefined,
              date: parsed.date,
              otp,
              preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
              html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            });
          } catch (parseErr) {
            console.error("Parse error for UID", uid, ":", parseErr);
          }
        }

        console.log("Collected", emails.length, "Netflix emails (password resets excluded)");
      } finally {
        lock.release();
      }

      try { await client.logout(); } catch {}
    } catch (connErr) {
      if (emails.length === 0) throw connErr;
      console.error("IMAP error (returning partial):", connErr);
    } finally {
      clearTimeout(timeout);
    }

    emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Save to cache
    if (emails.length > 0) {
      console.log("Caching", emails.length, "emails to database");
      const rows = emails.map((e: any) => ({
        id: String(e.id),
        subject: e.subject,
        from_address: e.from,
        to_address: e.to || null,
        date: e.date,
        otp: e.otp || null,
        preview: e.preview || null,
        html: e.html || null,
        cached_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase
        .from("cached_emails")
        .upsert(rows, { onConflict: "id" });

      if (upsertErr) {
        console.error("Cache upsert error:", upsertErr);
      } else {
        console.log("Cache updated successfully");
      }
    }

    return new Response(JSON.stringify(emails), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Email fetch error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

    return new Response(
      JSON.stringify({
        success: false,
        error: isImapAuthError
          ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
          : "Failed to fetch emails.",
      }),
      {
        status: isImapAuthError ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
