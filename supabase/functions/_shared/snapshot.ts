// Snapshot diff (approved fallback): a title that was absent from every earlier India snapshot and is present now was
// "first observed" now; if a previous COMPLETE snapshot exists, it was added in (previousComplete.started_at, now].
// Without a previous complete snapshot (baseline / cold start) nothing can be dated.
import type { MediaType, Provider } from "./types.ts";

export interface SeenTitle { provider: Provider; media_type: MediaType; tmdb_id: number }
export interface AvailabilityInsert extends SeenTitle {
  region: "IN";
  first_seen_at: string;
  added_after: string | null;
  last_seen_at: string;
  first_seen_run: string;
}

export const availabilityKey = (t: SeenTitle) => `${t.provider}:${t.media_type}:${t.tmdb_id}`;

export function planSnapshotInserts(o: {
  seen: SeenTitle[];
  existingKeys: Set<string>;
  previousCompleteStartedAt: string | null;
  now: Date;
  runId: string;
}): AvailabilityInsert[] {
  const nowIso = o.now.toISOString();
  const out = new Map<string, AvailabilityInsert>();
  for (const t of o.seen) {
    const k = availabilityKey(t);
    if (o.existingKeys.has(k) || out.has(k)) continue;
    out.set(k, {
      ...t, region: "IN", first_seen_at: nowIso, last_seen_at: nowIso, first_seen_run: o.runId,
      added_after: o.previousCompleteStartedAt,
    });
  }
  return [...out.values()];
}
