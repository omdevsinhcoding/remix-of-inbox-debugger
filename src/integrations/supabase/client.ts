// Supabase client — resilient to missing Vercel env vars.
// The anon/publishable key is safe to ship in the browser bundle
// (Supabase project ref: jsqchutnfdeljajkxmly).
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const FALLBACK_URL = "https://jsqchutnfdeljajkxmly.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcWNodXRuZmRlbGphamt4bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjI5MzksImV4cCI6MjA4OTY5ODkzOX0.HYN4zMEYEiP-H5KD_iIbFpr0GsatNoeyw40FI2mW_eA";

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || FALLBACK_URL;
const SUPABASE_PUBLISHABLE_KEY =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  FALLBACK_ANON_KEY;

if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
  // Not fatal — using baked-in publishable defaults so the app still boots.
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY missing at build time; using baked-in publishable defaults."
  );
}

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
  }
});
