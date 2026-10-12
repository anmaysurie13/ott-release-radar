// Operator helper (reads .env, never prints secrets).
//   node scripts/ops.mjs configure-scheduler      store functions URL + CRON_SECRET in Supabase Vault (via service-role RPC)
//   node scripts/ops.mjs call <task> [--wait]     POST radar-cron?task=<snapshot|collect|preview|weekly>
//   node scripts/ops.mjs add-admin <email> [owner|operator]
//   node scripts/ops.mjs status                   recent runs / counts
// Note: `call weekly` can send Telegram only if LIVE_SEND_ENABLED=true AND it is within 3h after Fri 18:30 IST.
process.loadEnvFile(".env");
const E = process.env;
const [cmd, arg, arg2] = process.argv.slice(2);
const rest = (path, init = {}) => fetch(`${E.SUPABASE_URL}/rest/v1${path}`, {
  ...init, headers: { apikey: E.SUPABASE_SECRET_KEY, Authorization: `Bearer ${E.SUPABASE_SECRET_KEY}`, "content-type": "application/json", ...(init.headers ?? {}) },
});

if (cmd === "configure-scheduler") {
  const r = await rest("/rpc/admin_configure_scheduler", { method: "POST",
    body: JSON.stringify({ functions_url: `${E.SUPABASE_URL}/functions/v1`, cron_secret: E.CRON_SECRET }) });
  console.log("configure-scheduler:", r.status, r.ok ? "ok" : await r.text());
} else if (cmd === "call") {
  const wait = process.argv.includes("--wait");
  const t0 = Date.now();
  const r = await fetch(`${E.SUPABASE_URL}/functions/v1/radar-cron?task=${encodeURIComponent(arg)}${wait ? "&wait=1" : ""}`, {
    method: "POST", headers: { "x-cron-secret": E.CRON_SECRET, "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(170000),
  });
  console.log(`HTTP ${r.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log((await r.text()).slice(0, 6000));
} else if (cmd === "add-admin") {
  const r = await rest("/app_admins", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ email: String(arg).toLowerCase(), role: arg2 ?? "owner" }) });
  console.log("add-admin:", r.status, r.ok ? "ok" : await r.text());
} else if (cmd === "status") {
  const runs = await (await rest("/pipeline_runs?select=task,trigger,status,window_key,started_at,finished_at,error,stats,source_health&order=started_at.desc&limit=6")).json();
  console.log(JSON.stringify(runs, null, 1).slice(0, 8000));
  for (const t of ["releases", "provider_availability", "sources", "candidates", "recommendations", "digest_runs", "delivery_logs"]) {
    const r = await rest(`/${t}?select=*&limit=1`, { headers: { Prefer: "count=exact", Range: "0-0" } });
    console.log(t.padEnd(22), r.headers.get("content-range"));
  }
} else {
  console.log("usage: node scripts/ops.mjs configure-scheduler | call <task> [--wait] | add-admin <email> [role] | status");
}
