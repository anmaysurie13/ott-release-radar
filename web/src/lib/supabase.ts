import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Publishable key only (safe in the browser). The dashboard is public read-only; RLS blocks all browser writes.
// Changes go through the radar-api Edge Function and require the owner code (kept in this tab's sessionStorage only).
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
export const functionsUrl = url ? `${url}/functions/v1` : null;

const CODE_KEY = "radar-owner-code";
export function getOwnerCode(): string | null {
  try { return sessionStorage.getItem(CODE_KEY); } catch { return null; }
}
export function setOwnerCode(code: string | null) {
  try { if (code) sessionStorage.setItem(CODE_KEY, code); else sessionStorage.removeItem(CODE_KEY); } catch { /* storage unavailable */ }
}

export async function callApi<T = unknown>(action: string, body: Record<string, unknown> = {}, code = getOwnerCode()): Promise<T> {
  if (!functionsUrl) throw new Error("Supabase is not configured");
  if (!code) throw new Error("Enter the owner code first");
  const res = await fetch(`${functionsUrl}/radar-api`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-code": code, apikey: key! },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}
