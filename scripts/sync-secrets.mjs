// Push Edge Function secrets from local .env to Supabase without printing values.
// Usage: node scripts/sync-secrets.mjs   (requires `supabase login` + `supabase link`)
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.loadEnvFile(".env");
const E = process.env;

if (!E.CRON_SECRET) {
  const s = randomBytes(32).toString("hex");
  appendFileSync(".env", `\nCRON_SECRET=${s}\n`);
  E.CRON_SECRET = s;
  console.log("Generated CRON_SECRET and saved it to .env");
}

// Supabase reserves the SUPABASE_ prefix for function secrets → the sb_secret key is exposed as RADAR_SECRET_KEY.
const map = {
  TMDB_READ_TOKEN: E.TMDB_READ_TOKEN,
  RAPIDAPI_KEY: E.RAPIDAPI_KEY,
  GEMINI_API_KEY: E.GEMINI_API_KEY,
  GEMINI_API_KEY_FALLBACK: E.GEMINI_API_KEY_FALLBACK,
  GEMINI_MODEL: E.GEMINI_MODEL || "gemini-3.1-flash-lite",
  TELEGRAM_BOT_TOKEN: E.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: E.TELEGRAM_CHAT_ID,
  CRON_SECRET: E.CRON_SECRET,
  RADAR_SECRET_KEY: E.SUPABASE_SECRET_KEY,
  // Owner-controlled flag: only pushed when explicitly present in .env, so a sync never silently changes it.
  LIVE_SEND_ENABLED: E.LIVE_SEND_ENABLED,
  DASHBOARD_URL: E.DASHBOARD_URL,
  OWNER_CODE: E.OWNER_CODE,
};
const lines = Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
const dir = mkdtempSync(join(tmpdir(), "radar-secrets-"));
const file = join(dir, "secrets.env");
try {
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["supabase", "secrets", "set", "--env-file", file], { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  console.log(`Set ${lines.length} secrets: ${Object.keys(map).filter((k) => map[k]).join(", ")}`);
  console.log(map.LIVE_SEND_ENABLED ? `LIVE_SEND_ENABLED=${map.LIVE_SEND_ENABLED}` : "LIVE_SEND_ENABLED not in .env — left unchanged on Supabase");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
void readFileSync;
