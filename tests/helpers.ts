// Test helpers. Everything here is a MOCK (fixture data, fake fetch) — never evidence of live behaviour.
import type { TitleFacts } from "../supabase/functions/_shared/types.ts";

export function facts(p: Partial<TitleFacts> = {}): TitleFacts {
  return {
    media_type: "movie", tmdb_id: 1001, title: "Fixture Movie", original_title: null, original_language: "hi",
    spoken_languages: ["hi"], genres: ["Thriller"], overview: "A fixture overview. Second sentence here.",
    poster_path: null, backdrop_path: null, release_date: "2026-10-01", runtime_min: 120, networks: [],
    available_in: ["netflix"], watch_link: "https://www.themoviedb.org/movie/1001/watch?locale=IN", in_digital_notes: [],
    ...p,
  };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** Scripted fetch: each call consumes the next handler (or the last one repeatedly). Records calls. */
export function scriptedFetch(...handlers: Handler[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    return h(url, init);
  };
  return Object.assign(f, { calls });
}

export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const noSleep = async () => {};
