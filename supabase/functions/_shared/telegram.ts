// Telegram delivery with idempotency. A chunk is never sent twice:
//  - 'sent'              → skipped
//  - 'sending'/'unknown' → a previous attempt may have reached Telegram (timeout/crash) → NOT resent; needs human attention
//  - 'failed'            → definite non-delivery (HTTP error response) → retried
import { type FetchLike, realSleep, redactUrl } from "./http.ts";

export const TELEGRAM_LIMIT = 4096;
export const CHUNK_TARGET = 3900; // headroom for HTML entities / footer
export const MAX_CHUNK_ATTEMPTS = 5;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Pack blocks into messages ≤ limit, never splitting a block unless it alone is too long. */
export function chunkBlocks(blocks: string[], limit = CHUNK_TARGET): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const b of blocks) {
    if (b.length > limit) {
      push();
      // hard-split on line boundaries, then on characters as a last resort (avoid cutting HTML tags mid-way)
      let piece = "";
      for (const line of b.split("\n")) {
        if (line.length > limit) {
          if (piece.trim()) out.push(piece.trim());
          piece = "";
          // drop markup, split plain text, re-escape — never leaves a half tag/entity
          let acc = "";
          for (const ch of unescapeHtml(stripTags(line))) {
            const esc = escapeHtml(ch);
            if (acc.length + esc.length > limit) { out.push(acc); acc = ""; }
            acc += esc;
          }
          if (acc) out.push(acc);
          continue;
        }
        if (piece && (piece + "\n" + line).length > limit) { out.push(piece.trim()); piece = line; }
        else piece = piece ? piece + "\n" + line : line;
      }
      if (piece.trim()) out.push(piece.trim());
      continue;
    }
    if ((cur + "\n\n" + b).length > limit) push();
    cur = cur ? cur + "\n\n" + b : b;
  }
  push();
  return out;
}

function stripTags(s: string) { return s.replace(/<[^>]+>/g, ""); }
function unescapeHtml(s: string) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export interface ChunkState { status: "sending" | "sent" | "failed" | "unknown"; attempts: number }

export interface DeliveryStore {
  get(chunkIndex: number): Promise<ChunkState | null>;
  /** Atomically mark as 'sending' (attempts+1). Return false if another worker holds it or it is not retryable. */
  begin(chunkIndex: number): Promise<boolean>;
  markSent(chunkIndex: number, messageId: number): Promise<void>;
  markFailed(chunkIndex: number, error: string, httpStatus: number | null): Promise<void>;
  markUnknown(chunkIndex: number, error: string): Promise<void>;
}

export interface SendResult {
  sent: number;
  skipped: number;
  failed: number;
  unknown: number;
  status: "sent" | "partial" | "failed" | "needs_attention";
  errors: string[];
}

export interface SendOptions {
  token: string;
  chatId: string;
  chunks: string[];
  store: DeliveryStore;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  max429Waits?: number;
}

export async function sendChunks(o: SendOptions): Promise<SendResult> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const r: SendResult = { sent: 0, skipped: 0, failed: 0, unknown: 0, status: "sent", errors: [] };
  const url = `https://api.telegram.org/bot${o.token}/sendMessage`;

  for (let i = 0; i < o.chunks.length; i++) {
    const st = await o.store.get(i);
    if (st?.status === "sent") { r.skipped++; continue; }
    if (st?.status === "sending" || st?.status === "unknown") {
      r.unknown++;
      r.errors.push(`chunk ${i}: previous attempt outcome unknown — not resent to avoid a duplicate`);
      break; // keep order; stop rather than send later parts first
    }
    if (st?.status === "failed" && st.attempts >= MAX_CHUNK_ATTEMPTS) {
      r.failed++; r.errors.push(`chunk ${i}: gave up after ${st.attempts} attempts`); break;
    }
    if (!(await o.store.begin(i))) { r.skipped++; continue; }

    let done = false;
    for (let wait429 = 0; !done; wait429++) {
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: o.chatId, text: o.chunks[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 15000),
        });
      } catch (e) {
        // Network error/timeout: Telegram may or may not have delivered → never auto-resend.
        const msg = redactUrl(String(e));
        await o.store.markUnknown(i, msg);
        r.unknown++; r.errors.push(`chunk ${i}: ${msg}`);
        done = true; break;
      }
      const body = await res.json().catch(() => ({})) as { ok?: boolean; result?: { message_id: number }; description?: string; parameters?: { retry_after?: number } };
      if (res.ok && body.ok && body.result) {
        await o.store.markSent(i, body.result.message_id);
        r.sent++; done = true; break;
      }
      if (res.status === 429 && wait429 < (o.max429Waits ?? 3)) {
        await sleep(Math.min(60, body.parameters?.retry_after ?? 5) * 1000);
        continue;
      }
      const err = `HTTP ${res.status}: ${body.description ?? "unknown error"}`;
      await o.store.markFailed(i, err, res.status);
      r.failed++; r.errors.push(`chunk ${i}: ${err}`);
      done = true;
    }
    if (r.failed || r.unknown) break; // preserve message order; retry run resumes from here
  }

  const total = o.chunks.length;
  if (r.unknown) r.status = "needs_attention";
  else if (r.sent + r.skipped === total) r.status = "sent";
  else if (r.sent + r.skipped > 0) r.status = "partial";
  else r.status = "failed";
  return r;
}

/** In-memory store (tests / previews). */
export class MemoryDeliveryStore implements DeliveryStore {
  rows = new Map<number, ChunkState & { messageId?: number; error?: string }>();
  get(i: number) { return Promise.resolve(this.rows.get(i) ?? null); }
  begin(i: number) {
    const s = this.rows.get(i);
    if (s && s.status !== "failed") return Promise.resolve(false);
    this.rows.set(i, { status: "sending", attempts: (s?.attempts ?? 0) + 1 });
    return Promise.resolve(true);
  }
  markSent(i: number, messageId: number) { const s = this.rows.get(i)!; this.rows.set(i, { ...s, status: "sent", messageId }); return Promise.resolve(); }
  markFailed(i: number, error: string) { const s = this.rows.get(i)!; this.rows.set(i, { ...s, status: "failed", error }); return Promise.resolve(); }
  markUnknown(i: number, error: string) { const s = this.rows.get(i)!; this.rows.set(i, { ...s, status: "unknown", error }); return Promise.resolve(); }
}

export async function sha256Prefix(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
