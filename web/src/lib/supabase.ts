import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Publishable key only (safe in the browser; RLS protects data). Privileged keys live in Edge Functions.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;
export const functionsUrl = url ? `${url}/functions/v1` : null;

export async function callApi<T = unknown>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase || !functionsUrl) throw new Error("Supabase is not configured");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in first");
  const res = await fetch(`${functionsUrl}/radar-api`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, apikey: key! },
    body: JSON.stringify({ action, ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}
