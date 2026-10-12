export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  retries?: number;        // extra attempts after the first
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`HTTP ${status} from ${redactUrl(url)}: ${body.slice(0, 200)}`);
  }
}

/** Never let tokens embedded in URLs (e.g. Telegram /bot<token>/) reach logs. */
export function redactUrl(url: string): string {
  return url.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot<redacted>")
    .replace(/([?&](api_key|key|token)=)[^&]+/gi, "$1<redacted>");
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * fetch with timeout + retries on network errors, 429 and 5xx (honours Retry-After).
 * Returns the final Response (which may still be non-OK for 4xx) — callers decide.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const { retries = 2, timeoutMs = 15000, baseDelayMs = 500, maxDelayMs = 20000 } = opts;
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Math.min(maxDelayMs, retryAfterMs(res) ?? baseDelayMs * 2 ** attempt);
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)); continue; }
    }
  }
  throw new Error(`Request failed after ${retries + 1} attempts: ${redactUrl(url)} (${String(lastErr)})`);
}

export async function getJson<T>(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, init, opts);
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text, url);
  return JSON.parse(text) as T;
}

/** Run async tasks with bounded concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
