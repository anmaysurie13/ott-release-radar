import { describe, expect, it } from "vitest";
import { chunkBlocks, escapeHtml, MemoryDeliveryStore, sendChunks, TELEGRAM_LIMIT } from "../supabase/functions/_shared/telegram.ts";
import { jsonRes, noSleep, scriptedFetch } from "./helpers.ts";

const ok = (id = 1) => () => jsonRes({ ok: true, result: { message_id: id } });

describe("chunking (Telegram 4096-char limit)", () => {
  it("keeps blocks whole and every chunk under the limit", () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `<b>Item ${i}</b>\n${"x".repeat(300)}`);
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(chunks.join("\n\n").match(/<b>Item \d+<\/b>/g)).toHaveLength(40);
  });
  it("splits a single oversize block without breaking tags or entities", () => {
    const huge = `<b>Title</b>\n${"word &amp; ".repeat(1200)}`;
    const chunks = chunkBlocks([huge]);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
      expect(c).not.toMatch(/&[a-z]*$/);
    }
  });
  it("escapes HTML in titles", () => {
    expect(escapeHtml(`Tom & Jerry <3 "x"`)).toBe("Tom &amp; Jerry &lt;3 &quot;x&quot;");
  });
});

describe("sendChunks idempotency", () => {
  it("sends all chunks, then a rerun sends nothing (duplicate prevention)", async () => {
    const store = new MemoryDeliveryStore();
    const f = scriptedFetch(ok(1), ok(2));
    const r1 = await sendChunks({ token: "T", chatId: "C", chunks: ["a", "b"], store, fetchImpl: f, sleep: noSleep });
    expect(r1).toMatchObject({ sent: 2, status: "sent" });
    const f2 = scriptedFetch(ok(9));
    const r2 = await sendChunks({ token: "T", chatId: "C", chunks: ["a", "b"], store, fetchImpl: f2, sleep: noSleep });
    expect(r2).toMatchObject({ sent: 0, skipped: 2, status: "sent" });
    expect(f2.calls).toHaveLength(0);
  });
  it("waits on 429 retry_after then succeeds", async () => {
    const waits: number[] = [];
    const f = scriptedFetch(() => jsonRes({ ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }, 429), ok(5));
    const r = await sendChunks({ token: "T", chatId: "C", chunks: ["a"], store: new MemoryDeliveryStore(), fetchImpl: f, sleep: async (ms) => { waits.push(ms); } });
    expect(r.status).toBe("sent");
    expect(waits).toEqual([3000]);
  });
  it("failed chunk (HTTP 400) stops in order; retry resumes without resending earlier chunks", async () => {
    const store = new MemoryDeliveryStore();
    const f = scriptedFetch(ok(1), () => jsonRes({ ok: false, description: "Bad Request: can't parse entities" }, 400));
    const r1 = await sendChunks({ token: "T", chatId: "C", chunks: ["a", "b", "c"], store, fetchImpl: f, sleep: noSleep });
    expect(r1).toMatchObject({ sent: 1, failed: 1, status: "partial" });
    expect(f.calls).toHaveLength(2); // "c" not attempted out of order
    const f2 = scriptedFetch(ok(2), ok(3));
    const r2 = await sendChunks({ token: "T", chatId: "C", chunks: ["a", "b", "c"], store, fetchImpl: f2, sleep: noSleep });
    expect(r2).toMatchObject({ sent: 2, skipped: 1, status: "sent" });
    expect(JSON.parse(String(f2.calls[0].init!.body)).text).toBe("b");
  });
  it("network timeout → outcome unknown → never auto-resent (needs attention)", async () => {
    const store = new MemoryDeliveryStore();
    const f = scriptedFetch(() => { throw new Error("timeout"); });
    const r1 = await sendChunks({ token: "T", chatId: "C", chunks: ["a"], store, fetchImpl: f, sleep: noSleep });
    expect(r1.status).toBe("needs_attention");
    const f2 = scriptedFetch(ok(1));
    const r2 = await sendChunks({ token: "T", chatId: "C", chunks: ["a"], store, fetchImpl: f2, sleep: noSleep });
    expect(r2.status).toBe("needs_attention");
    expect(f2.calls).toHaveLength(0);
  });
  it("redacts the bot token from error messages", async () => {
    const f = scriptedFetch(() => { throw new Error("fetch failed https://api.telegram.org/bot123:ABC-def/sendMessage"); });
    const r = await sendChunks({ token: "123:ABC-def", chatId: "C", chunks: ["a"], store: new MemoryDeliveryStore(), fetchImpl: f, sleep: noSleep });
    expect(r.errors.join()).not.toContain("ABC-def");
  });
  it("gives up after max attempts", async () => {
    const store = new MemoryDeliveryStore();
    store.rows.set(0, { status: "failed", attempts: 5 });
    const f = scriptedFetch(ok(1));
    const r = await sendChunks({ token: "T", chatId: "C", chunks: ["a"], store, fetchImpl: f, sleep: noSleep });
    expect(r.status).toBe("failed");
    expect(f.calls).toHaveLength(0);
  });
});
