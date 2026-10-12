// Dashboard actions. Requires a Supabase Auth session whose email is in public.app_admins.
//   preview        build the next digest text (no send, no digest row)
//   test_send      send a clearly-labelled TEST digest to Telegram — requires {"confirm":"SEND TEST"}
//   rerun_collect  re-run collection/verification for the upcoming window (never sends)
//   snapshot       run an India availability snapshot now
//   review         confirm/exclude an unresolved release (human checkpoint)
//   status         configuration/health summary (booleans only — never secret values)
import { buildDigest, runCollect, runDeliver, runSnapshot, upcomingWindow } from "../_shared/pipeline.ts";
import { background, json, makeCtx, readEnv, serviceClient } from "../_shared/server.ts";
import { nextBoundary } from "../_shared/time.ts";

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = [Deno.env.get("DASHBOARD_URL") ?? "", "http://localhost:5173", "http://127.0.0.1:5173"]
    .filter(Boolean).map((u) => new URL(u).origin);
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] ?? "",
    "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, h);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign in required" }, 401, h);
  const admin = serviceClient();
  const { data: u, error: authErr } = await admin.auth.getUser(token);
  const email = u?.user?.email?.toLowerCase();
  if (authErr || !email) return json({ error: "invalid session" }, 401, h);
  const { data: allowed } = await admin.from("app_admins").select("email, role").eq("email", email).maybeSingle();
  if (!allowed) return json({ error: "not authorised for this dashboard" }, 403, h);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = String(body.action ?? "");
  const ctx = makeCtx();
  const w = upcomingWindow(new Date());

  try {
    switch (action) {
      case "status": {
        const env = readEnv();
        return json({
          next_digest_at: nextBoundary(new Date()).toISOString(),
          live_send_enabled: (env.LIVE_SEND_ENABLED ?? "").toLowerCase() === "true",
          configured: {
            tmdb: !!env.TMDB_READ_TOKEN, streaming_availability: !!env.RAPIDAPI_KEY, gemini: !!env.GEMINI_API_KEY,
            telegram: !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID,
          },
          gemini_model: env.GEMINI_MODEL || "gemini-2.5-flash",
          you: { email, role: allowed.role },
        }, 200, h);
      }
      case "preview": {
        const d = await buildDigest(ctx, w, false);
        return json({ window: { start: w.start, end: w.end, key: w.key }, chunks: d.chunks, items: d.items.length }, 200, h);
      }
      case "test_send": {
        if (body.confirm !== "SEND TEST") return json({ error: 'confirmation required: {"confirm":"SEND TEST"}' }, 400, h);
        const r = await runDeliver(ctx, w, { isTest: true, trigger: "manual" });
        return json(r, 200, h);
      }
      case "rerun_collect": {
        background(runCollect(ctx, w, "manual", "manual_collect"), "manual_collect");
        return json({ accepted: true, window: w.key, note: "Collection re-run started; it never sends Telegram messages." }, 202, h);
      }
      case "snapshot": {
        background(runSnapshot(ctx, "manual"), "manual_snapshot");
        return json({ accepted: true }, 202, h);
      }
      case "review": {
        const id = String(body.release_id ?? "");
        const decision = body.decision;
        const note = String(body.note ?? "").slice(0, 500);
        const date = typeof body.available_date === "string" ? body.available_date : null;
        if (!/^[0-9a-f-]{36}$/.test(id) || !["confirm", "exclude"].includes(String(decision))) return json({ error: "bad request" }, 400, h);
        if (decision === "confirm" && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))) return json({ error: "available_date (YYYY-MM-DD) required to confirm" }, 400, h);
        if (decision === "confirm" && note.length < 5) return json({ error: "add a short note naming the source you checked" }, 400, h);
        const { data: rel, error } = await admin.from("releases").select("*").eq("id", id).single();
        if (error || !rel) return json({ error: "release not found" }, 404, h);
        const patch = decision === "confirm"
          ? { verification_status: "confirmed", date_basis: "human_review", available_date: date, confidence: 0.9 }
          : { verification_status: "excluded" };
        const newKey = decision === "confirm"
          ? [rel.media_type, rel.tmdb_id, rel.provider, rel.release_type, rel.season_number ?? "", rel.episode_number ?? "", date].join(":")
          : rel.dedupe_key;
        const up = await admin.from("releases").update({
          ...patch, dedupe_key: newKey, reviewed_by: email, reviewed_at: new Date().toISOString(),
          verification_notes: [rel.verification_notes, `Reviewed by ${email}: ${decision}${note ? ` — ${note}` : ""}`].filter(Boolean).join("\n"),
        }).eq("id", id);
        if (up.error) return json({ error: up.error.message }, 409, h);
        await admin.from("release_evidence").insert({
          release_id: id, evidence_type: "human_review", stance: decision === "confirm" ? "supports" : "conflicts",
          stated_date: date, quote: note || null, detail: { reviewer: email, decision },
        });
        return json({ ok: true }, 200, h);
      }
      default:
        return json({ error: "unknown action" }, 400, h);
    }
  } catch (e) {
    console.error(`[radar-api:${action}]`, e instanceof Error ? e.message : e);
    return json({ error: "internal error" }, 500, h);
  }
});
