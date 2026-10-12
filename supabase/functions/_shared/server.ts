// Deno-only helpers for Edge Function entrypoints (not imported by unit tests).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import type { Ctx, Env } from "./pipeline.ts";

/** Stay under the Edge Function wall-clock limit (150 s on the Free plan). */
export const BUDGET_MS = 120_000;

export function readEnv(): Env {
  const g = (k: string) => Deno.env.get(k) ?? undefined;
  return {
    TMDB_READ_TOKEN: g("TMDB_READ_TOKEN") ?? "",
    RAPIDAPI_KEY: g("RAPIDAPI_KEY"),
    GEMINI_API_KEY: g("GEMINI_API_KEY"),
    GEMINI_API_KEY_FALLBACK: g("GEMINI_API_KEY_FALLBACK"),
    GEMINI_MODEL: g("GEMINI_MODEL"),
    TELEGRAM_BOT_TOKEN: g("TELEGRAM_BOT_TOKEN"),
    TELEGRAM_CHAT_ID: g("TELEGRAM_CHAT_ID"),
    LIVE_SEND_ENABLED: g("LIVE_SEND_ENABLED"),
    DASHBOARD_URL: g("DASHBOARD_URL"),
  };
}

export function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL")!;
  // Prefer an explicitly configured secret key (sb_secret_…); fall back to the platform-injected service role key.
  const key = Deno.env.get("RADAR_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function makeCtx(): Ctx {
  return { db: serviceClient(), env: readEnv(), now: () => new Date(), deadline: Date.now() + BUDGET_MS };
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Run work after responding (pg_net and browsers shouldn't wait on long pipelines). */
export function background(p: Promise<unknown>, label: string) {
  const guarded = p.catch((e) => console.error(`[${label}] ${e instanceof Error ? e.message : String(e)}`));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(guarded);
}
