// Scheduled entrypoint. Called by pg_cron via pg_net with header x-cron-secret (stored in Vault).
//   POST /radar-cron?task=snapshot   daily India availability snapshot
//   POST /radar-cron?task=weekly     Friday 18:30 IST collect → verify → recommend → digest → Telegram (idempotent)
//   POST /radar-cron?task=collect    operator: re-run collection for the upcoming window (never sends)
//   POST /radar-cron?task=preview    operator: build next digest text (never sends, nothing stored)
//   POST /radar-cron?task=test_send&confirm=SEND%20TEST   operator: one TEST-labelled Telegram message
// Add &wait=1 to run synchronously (manual ops checks).
import { buildDigest, runAdhoc, runCollect, runDeliver, runSnapshot, runWeekly, upcomingWindow } from "../_shared/pipeline.ts";
import { background, json, makeCtx, timingSafeEqual } from "../_shared/server.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = Deno.env.get("CRON_SECRET");
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!secret || secret.length < 32 || !timingSafeEqual(got, secret)) return json({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const task = url.searchParams.get("task");
  const ctx = makeCtx();
  const trigger = "cron";
  let work: Promise<unknown>;
  if (task === "snapshot") work = runSnapshot(ctx, trigger);
  else if (task === "weekly") work = runWeekly(ctx, trigger);
  // owner-requested extra digests: 18:30 IST via date-guarded cron jobs, or immediately with &now=1 (same per-day key → never twice)
  else if (task === "adhoc") work = runAdhoc(ctx, url.searchParams.get("now") === "1" ? "manual" : trigger, url.searchParams.get("now") === "1");
  // operator checks — never send Telegram messages
  else if (task === "collect") work = runCollect(ctx, upcomingWindow(new Date()), "manual", "manual_collect");
  else if (task === "preview") work = buildDigest(ctx, upcomingWindow(new Date()), false).then((d) => ({ chunks: d.chunks, items: d.items.length }));
  // operator: one clearly-labelled TEST message (owner-approved); requires explicit confirmation, throttled to 1 per 2 min
  else if (task === "test_send") {
    if (url.searchParams.get("confirm") !== "SEND TEST") return json({ error: "confirm=SEND TEST required" }, 400);
    work = runDeliver(ctx, upcomingWindow(new Date()), { isTest: true, trigger: "manual" });
  }
  else return json({ error: "unknown task" }, 400);

  if (url.searchParams.get("wait") === "1") {
    try { return json(await work); } catch (e) { return json({ error: String(e) }, 500); }
  }
  background(work.then(async (r) => {
    console.log(`[radar-cron:${task}]`, JSON.stringify(r).slice(0, 2000));
    // Collect used most of this invocation's wall-clock → continue delivery in a fresh invocation (idempotent).
    if ((task === "weekly" || task === "adhoc") && (r as { status?: string })?.status === "deferred") {
      const qs = new URLSearchParams(url.searchParams); qs.delete("wait"); // keep task + flags (e.g. now=1)
      await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/radar-cron?${qs}`, {
        method: "POST", headers: { "x-cron-secret": secret, "content-type": "application/json" }, body: "{}",
        signal: AbortSignal.timeout(5000),
      }).catch(() => { /* the 18:45 IST retry cron covers this */ });
    }
  }), `radar-cron:${task}`);
  return json({ accepted: true, task }, 202);
});
