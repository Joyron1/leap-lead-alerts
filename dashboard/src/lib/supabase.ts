import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// `env` is absent when the pure logic is imported outside Vite (npm run selftest).
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Rendered by App instead of a blank page when .env.local is missing.
export const configError = !url || !key
  ? "חסר קובץ dashboard/.env.local עם VITE_SUPABASE_URL ו-VITE_SUPABASE_PUBLISHABLE_KEY (ראה .env.example)."
  : null;

export const supabase: SupabaseClient = createClient(url ?? "http://invalid.local", key ?? "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
