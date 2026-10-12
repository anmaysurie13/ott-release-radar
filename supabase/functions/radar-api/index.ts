// Dashboard write actions. The dashboard itself is public read-only (owner decision: no email sign-in);
// every action here requires the OWNER_CODE secret in the `x-owner-code` header.
//   status           validate the code + configuration booleans (never secret values)
//   preview          build the next digest text (no send)
//   test_send        one TEST-labelled Telegram message — requires {"confirm":"SEND TEST"}, throttled
//   rerun_collect    re-run collection/verification for the upcoming window (never sends)
//   snapshot         take an India availability snapshot now
//   review           confirm/exclude an unresolved release (human checkpoint)
//   save_preferences update Naman's preferences
//   feedback         record watched / watchlist / not interested
import { buildDigest, runCollect, runDeliver, runSnapshot, upcomingWindow } from "../_shared/pipeline.ts";
import { background, json, makeCtx, readEnv, serviceClient, timingSafeEqual } from "../_shared/server.ts";
import { nextBoundary } from "../_shared/time.ts";

const GENRES = new Set(["Thriller", "Science Fiction", "Indie Drama", "Drama", "Crime", "Mystery", "Action", "Comedy", "Romance", "Horror", "Documentary", "Animation", "Fantasy", "Reality"]);
const LANGS = new Set(["hi", "en", "ta", "te", "ml", "kn", "bn", "mr", "ko", "ja"]);
const PROVIDERS = new Set(["netflix", "prime", "jiohotstar"]);
const MEDIA = new Set(["movie", "tv"]);
const RTYPES = new Set(["new_title", "new_season", "new_episode"]);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = [Deno.env.get("DASHBOARD_URL") ?? "", "http://localhost:5173", "http://127.0.0.1:5173"]
    .filter(Boolean).map((u) => new URL(u).origin);
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] ?? "",
    "access-control-allow-headers": "content-type, x-owner-code, apikey, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

const onlyFrom = (v: unknown, allowed: Set<string>) =>
  Array.isArray(v) ? [...new Set(v.map(String).filter((x) => allowed.has(x)))] : null;

Deno.serve(async (req) => {
  const h = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, h);

  const code = Deno.env.get("OWNER_CODE") ?? "";
  const got = req.headers.get("x-owner-code") ?? "";
  if (code.length < 12 || !timingSafeEqual(got, code)) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return json({ error: "owner code required" }, 401, h);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const action = String(body.action ?? "");
  const ctx = makeCtx();
  const admin = serviceClient();
  const w = upcomingWindow(new Date());

  try {
    switch (action) {
      case "status": {
        const env = readEnv();
        return json({
          ok: true, next_digest_at: nextBoundary(new Date()).toISOString(),
          live_send_enabled: (env.LIVE_SEND_ENABLED ?? "").toLowerCase() === "true",
          configured: { tmdb: !!env.TMDB_READ_TOKEN, streaming_availability: !!env.RAPIDAPI_KEY, gemini: !!env.GEMINI_API_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID },
          gemini_model: env.GEMINI_MODEL || "gemini-3.1-flash-lite",
        }, 200, h);
      }
      case "preview": {
        const d = await buildDigest(ctx, w, false);
        return json({ window: { start: w.start, end: w.end, key: w.key }, chunks: d.chunks, items: d.items.length }, 200, h);
      }
      case "test_send": {
        if (body.confirm !== "SEND TEST") return json({ error: 'confirmation required: {"confirm":"SEND TEST"}' }, 400, h);
        return json(await runDeliver(ctx, w, { isTest: true, trigger: "manual" }), 200, h);
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
          ...patch, dedupe_key: newKey, reviewed_by: "owner", reviewed_at: new Date().toISOString(),
          verification_notes: [rel.verification_notes, `Owner review: ${decision}${note ? ` — ${note}` : ""}`].filter(Boolean).join("\n"),
        }).eq("id", id);
        if (up.error) return json({ error: up.error.message }, 409, h);
        await admin.from("release_evidence").insert({
          release_id: id, evidence_type: "human_review", stance: decision === "confirm" ? "supports" : "conflicts",
          stated_date: date, quote: note || null, detail: { reviewer: "owner", decision },
        });
        return json({ ok: true }, 200, h);
      }
      case "save_preferences": {
        const p = (body.preferences ?? {}) as Record<string, unknown>;
        const patch = {
          genres: onlyFrom(p.genres, GENRES), languages: onlyFrom(p.languages, LANGS), platforms: onlyFrom(p.platforms, PROVIDERS),
          media_types: onlyFrom(p.media_types, MEDIA), release_types: onlyFrom(p.release_types, RTYPES),
          include_older_additions: typeof p.include_older_additions === "boolean" ? p.include_older_additions : null,
          digest_enabled: typeof p.digest_enabled === "boolean" ? p.digest_enabled : null,
          notes: typeof p.notes === "string" ? p.notes.slice(0, 500) || null : null,
        };
        if (!patch.genres || !patch.languages || !patch.platforms?.length || !patch.media_types?.length || !patch.release_types ||
          patch.include_older_additions === null || patch.digest_enabled === null) return json({ error: "invalid preferences" }, 400, h);
        const { error } = await admin.from("preferences").update(patch).eq("id", 1);
        return error ? json({ error: error.message }, 400, h) : json({ ok: true }, 200, h);
      }
      case "feedback": {
        const id = String(body.release_id ?? "");
        const decision = String(body.decision ?? "");
        if (!/^[0-9a-f-]{36}$/.test(id) || !["watched", "watchlist", "not_interested", "wrong_info"].includes(decision)) return json({ error: "bad request" }, 400, h);
        const { error } = await admin.from("feedback").insert({ release_id: id, decision, created_by: "owner" });
        return error ? json({ error: error.message }, 400, h) : json({ ok: true }, 200, h);
      }
      default:
        return json({ error: "unknown action" }, 400, h);
    }
  } catch (e) {
    console.error(`[radar-api:${action}]`, e instanceof Error ? e.message : e);
    return json({ error: "internal error" }, 500, h);
  }
});
