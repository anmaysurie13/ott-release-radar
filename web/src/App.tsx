import { useCallback, useEffect, useMemo, useState } from "react";
import { callApi, getOwnerCode, setOwnerCode, supabase } from "./lib/supabase";
import { ago, countdown, fmtIst, inRolling7, istDate, latestRec, nextDigest } from "./lib/format";
import type { DigestRun, PipelineRun, Preferences, Release, Source } from "./lib/types";
import { FIXTURE_DIGESTS, FIXTURE_PREFS, FIXTURE_RELEASES, FIXTURE_RUNS, FIXTURE_SOURCES } from "./lib/fixtures";
import { type CardRelease, ReleaseCard, SkeletonGrid } from "./components/ReleaseCard";
import { DigestPanel, EMPTY_FILTERS, type Filters, FiltersBar, OwnerUnlock, PreferencesPanel, ReviewQueue, RunsPanel, SourcesPanel } from "./components/Panels";

const FIXTURES = !supabase || new URLSearchParams(location.search).has("fixtures");
/** Naman's saved defaults (Hindi, English, Tamil); replaced by the stored preferences when signed in as an admin. */
const DEFAULT_LANGUAGES = ["hi", "en", "ta"];
const REL_SELECT = "*, recommendations(*), release_evidence(evidence_type, stance, url, stated_date, stated_platform, quote, detail)";

type Tab = "week" | "review" | "digest" | "prefs" | "runs";

interface Data {
  releases: Release[];
  review: Release[];
  runs: PipelineRun[];
  digests: DigestRun[];
  sources: Source[];
  prefs: Preferences | null;
}

/** One card per show/season for daily-episode rows. */
function groupForDisplay(rows: Release[]): CardRelease[] {
  const out: CardRelease[] = [];
  const g = new Map<string, Release[]>();
  for (const r of rows) {
    if (r.release_type !== "new_episode") { out.push(r); continue; }
    const k = `${r.tmdb_id}:${r.provider}:${r.season_number}`;
    g.set(k, [...(g.get(k) ?? []), r]);
  }
  for (const list of g.values()) {
    list.sort((a, b) => (b.available_date ?? "").localeCompare(a.available_date ?? ""));
    const n = list.reduce((s, x) => s + (x.episode_count ?? 1), 0);
    out.push({ ...list[0], grouped_count: list.length > 1 ? n : undefined,
      release_evidence: list.flatMap((x) => x.release_evidence).slice(0, 8) });
  }
  return out;
}

export default function App() {
  /** owner tools unlocked with the owner code (verified server-side on every call) */
  const [isAdmin, setIsAdmin] = useState(() => !!getOwnerCode());
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("week");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [liveSend, setLiveSend] = useState<boolean | null>(null);
  const [now, setNow] = useState(new Date());

  const toast = useCallback((s: string) => { setToastMsg(s); setTimeout(() => setToastMsg(null), 4000); }, []);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (!isAdmin) return;
    callApi<{ live_send_enabled: boolean }>("status").then((s) => setLiveSend(s.live_send_enabled))
      .catch(() => { setOwnerCode(null); setIsAdmin(false); setLiveSend(null); });
  }, [isAdmin]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      if (FIXTURES) {
        setData({ releases: FIXTURE_RELEASES, review: [], runs: FIXTURE_RUNS, digests: FIXTURE_DIGESTS, sources: FIXTURE_SOURCES, prefs: FIXTURE_PREFS });
        return;
      }
      const db = supabase!;
      const since = istDate(new Date(Date.now() - 8 * 86400e3));
      const [rel, runs, digests, sources] = await Promise.all([
        db.from("releases").select(REL_SELECT).eq("verification_status", "confirmed").gte("available_date", since).order("available_date", { ascending: false }).limit(400),
        db.from("pipeline_runs").select("*").order("started_at", { ascending: false }).limit(20),
        db.from("digest_runs").select("id, window_key, is_test, status, chunk_count, item_count, created_at, sent_at, error").order("created_at", { ascending: false }).limit(12),
        db.from("sources").select("id, kind, url, title, publisher, published_at, fetched_at").order("published_at", { ascending: false, nullsFirst: false }).limit(40),
      ]);
      for (const r of [rel, runs, digests, sources]) if (r.error) throw new Error(r.error.message);
      let review: Release[] = [], prefs: Preferences | null = null;
      {
        const [rv, pf] = await Promise.all([
          db.from("releases").select(REL_SELECT).eq("verification_status", "needs_review").order("last_checked_at", { ascending: false }).limit(60),
          db.from("preferences").select("*").eq("id", 1).single(),
        ]);
        if (rv.error) throw new Error(rv.error.message);
        review = rv.data as Release[];
        prefs = (pf.data as Preferences) ?? null;
      }
      setData({ releases: rel.data as Release[], review, runs: runs.data as PipelineRun[], digests: digests.data as DigestRun[], sources: sources.data as Source[], prefs });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const week = useMemo(() => groupForDisplay((data?.releases ?? []).filter((r) => inRolling7(r, now))), [data, now]);
  const genres = useMemo(() => [...new Set(week.flatMap((r) => r.genres))].sort(), [week]);
  const languages = useMemo(() => [...new Set(week.map((r) => r.original_language).filter(Boolean) as string[])].sort(), [week]);
  const sortByScore = (a: Release, b: Release) => (latestRec(b)?.score ?? -1) - (latestRec(a)?.score ?? -1);
  const myLanguages = data?.prefs?.languages?.length ? data.prefs.languages : DEFAULT_LANGUAGES;
  const langOk = (r: Release) => !!r.original_language && myLanguages.includes(r.original_language);
  const filtered = useMemo(() => week.filter((r) =>
    (!filters.mine || langOk(r)) &&
    (filters.older || filters.rtype === "older_addition" || r.release_type !== "older_addition") &&
    (filters.provider === "all" || r.provider === filters.provider) &&
    (filters.media === "all" || r.media_type === filters.media) &&
    (filters.rtype === "all" || r.release_type === filters.rtype) &&
    (!filters.genre || r.genres.includes(filters.genre)) &&
    (!filters.language || r.original_language === filters.language),
  ).sort(sortByScore), [week, filters, myLanguages]);
  const top = useMemo(() => week.filter((r) => langOk(r) && r.release_type !== "older_addition" && latestRec(r)?.verdict === "watch").sort(sortByScore).slice(0, 10), [week, myLanguages]);
  const lastCollect = data?.runs.find((r) => /collect|weekly/.test(r.task));
  const next = nextDigest(now);
  // Only real outages warrant a banner (a single auto-corrected AI item does not).
  const degraded = lastCollect ? Object.entries(lastCollect.source_health ?? {}).filter(([k, v]) =>
    (/^streaming_availability|^snapshot_stale/.test(k) && !/^ok/.test(v)) || (/^gemini/.test(k) && /^(failed|skipped)/.test(v))) : [];

  const feedback = isAdmin && !FIXTURES ? async (r: Release, decision: string) => {
    try { await callApi("feedback", { release_id: r.id, decision }); toast("Saved — thanks!"); }
    catch (e) { toast((e as Error).message); }
  } : undefined;

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <a className="brand" href="/" aria-label="Release Radar home">
            <img src="/radar.svg" alt="" />
            <div><b>Release Radar</b><small>India OTT · verified weekly</small></div>
          </a>
          <span className="spacer" />
          <div className="chip-next" title={`Next digest: ${fmtIst(next)} IST`}>
            <span className="pulse" aria-hidden />
            <span className="long">Next digest</span>
            <strong>{fmtIst(next, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</strong>
            <span className="cd">· in {countdown(next, now)}</span>
          </div>
          {isAdmin && <button className="btn sm ghost" onClick={() => { setOwnerCode(null); setIsAdmin(false); }}>Lock</button>}
        </div>
      </header>

      <main className="wrap">
        {FIXTURES && <div className="banner fixture" role="alert">⚠ DEVELOPMENT FIXTURES — fictional titles, not real data. {supabase ? <a href="/">Show live data</a> : "Supabase is not configured."}</div>}
        {!FIXTURES && degraded.length > 0 && (
          <div className="banner warn">Limited sources on the last run: {degraded.map(([k, v]) => `${k.replace(/_/g, " ")} — ${v.replace(/\.+$/, "")}`).join("; ")}. Only releases confirmed by the remaining sources are shown.</div>
        )}

        <section className="hero">
          <h1>New this week <span className="grad">in India</span></h1>
          <p className="sub">Verified Netflix, Prime Video and JioHotstar releases from the last 7 days ({fmtIst(new Date(now.getTime() - 7 * 86400e3), { day: "numeric", month: "short" })} – {fmtIst(now, { day: "numeric", month: "short" })} IST), matched to {data?.prefs?.owner_name ?? "Naman"}'s taste.</p>
          <div className="stats">
            <div className="stat"><div className="k">Confirmed new</div><div className="v">{loading ? "…" : week.filter((r) => r.release_type !== "older_addition").length}</div><div className="s">+ {week.filter((r) => r.release_type === "older_addition").length} older titles newly added</div></div>
            <div className="stat"><div className="k">Top matches</div><div className="v">{loading ? "…" : top.length}</div><div className="s">AI verdict: Watch</div></div>
            <div className="stat"><div className="k">Needs review</div><div className="v">{loading ? "…" : data?.review.length ?? 0}</div><div className="s">unverified · not in the digest</div></div>
            <div className="stat"><div className="k">Last check</div><div className="v" style={{ fontSize: 20, marginTop: 10 }}>{lastCollect ? ago(lastCollect.started_at, now) : "—"}</div>
              <div className="s">{lastCollect ? <span className={`status ${lastCollect.status}`}>{lastCollect.status}</span> : "no runs yet"}</div></div>
          </div>
        </section>

        <nav className="tabs" role="tablist" aria-label="Sections">
          {([["week", "This week", week.filter((r) => r.release_type !== "older_addition").length], ["review", "Review", data?.review.length], ["digest", "Digest", undefined], ["prefs", "Preferences", undefined], ["runs", "Runs & sources", undefined]] as [Tab, string, number | undefined][])
            .map(([id, label, n]) => (
              <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}{n != null && n > 0 ? <span className="count">{n}</span> : null}
              </button>
            ))}
        </nav>

        {error && <div className="banner error" role="alert">Couldn't load data: {error} <button className="btn sm" onClick={load}>Retry</button></div>}

        {tab === "week" && (
          <>
            {top.length > 0 && (
              <>
                <div className="section-h"><h2>⭐ Top matches</h2><span className="hint">AI opinion — your call</span></div>
                <div className="rail">{top.map((r, i) => <ReleaseCard key={r.id} r={r} index={i} onFeedback={feedback} />)}</div>
              </>
            )}
            <div className="section-h"><h2>All verified releases</h2><span className="hint">Facts from TMDB/JustWatch &amp; verification sources</span></div>
            <FiltersBar f={filters} set={setFilters} genres={genres} languages={languages} total={week.length} shown={filtered.length} myLanguages={myLanguages} olderCount={week.filter((r) => r.release_type === "older_addition" && (!filters.mine || langOk(r))).length} />
            {loading ? <SkeletonGrid /> : filtered.length ? (
              <div className="grid">{filtered.map((r, i) => <ReleaseCard key={r.id} r={r} index={i} onFeedback={feedback} />)}</div>
            ) : (
              <div className="empty" style={{ marginTop: 16 }}>
                <div className="big">📭</div>
                <h3>{week.length ? "Nothing matches these filters" : "No verified releases yet this week"}</h3>
                <p>{week.length ? "Try clearing a filter." : "Releases appear here once a source confirms they are available in India. Unverified items wait in the review queue."}</p>
                {week.length > 0 && <button className="btn" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>}
              </div>
            )}
          </>
        )}

        {tab === "review" && (<>
          {!isAdmin && !FIXTURES && <OwnerUnlock compact onUnlocked={() => setIsAdmin(true)} />}
          <div style={{ marginTop: 16 }}><ReviewQueue items={data?.review ?? []} onDone={load} toast={toast} canEdit={isAdmin && !FIXTURES} /></div>
        </>)}
        {tab === "digest" && (FIXTURES ? <p className="banner info">Digest tools are unavailable in fixture mode.</p> : isAdmin ? <DigestPanel liveSend={liveSend} toast={toast} /> : <OwnerUnlock onUnlocked={() => setIsAdmin(true)} />)}
        {tab === "prefs" && (<>
          {!isAdmin && !FIXTURES && <OwnerUnlock compact onUnlocked={() => setIsAdmin(true)} />}
          {data?.prefs && <div style={{ marginTop: 16 }}><PreferencesPanel key={String(isAdmin)} prefs={data.prefs} onSaved={load} toast={toast} canEdit={isAdmin && !FIXTURES} /></div>}
        </>)}
        {tab === "runs" && <><RunsPanel runs={data?.runs ?? []} digests={data?.digests ?? []} /><SourcesPanel sources={data?.sources ?? []} /></>}

        <footer className="foot">
          <div>Facts: metadata &amp; posters from TMDB; India watch-provider data by JustWatch (via TMDB); availability changes from Streaming Availability when enabled; news used for discovery only. AI opinions by Google Gemini are labelled and never change facts.</div>
          <div>This product uses the TMDB API but is not endorsed or certified by TMDB. Release Radar is an independent project, not affiliated with Netflix, Amazon or JioStar.</div>
        </footer>
      </main>
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </>
  );
}
