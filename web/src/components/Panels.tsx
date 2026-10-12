import { useState } from "react";
import { callApi, supabase } from "../lib/supabase";
import { LANG, PROVIDER_LABEL, RELEASE_LABEL, ago, fmtIst, langName, posterUrl, safeTelegramHtml } from "../lib/format";
import type { DigestRun, MediaType, PipelineRun, Preferences, Provider, Release, ReleaseType, Source } from "../lib/types";

// ---------------------------------------------------------------- filters
export interface Filters { provider: Provider | "all"; genre: string; language: string; media: MediaType | "all"; rtype: ReleaseType | "all"; mine: boolean }
export const EMPTY_FILTERS: Filters = { provider: "all", genre: "", language: "", media: "all", rtype: "all", mine: true };

export function FiltersBar({ f, set, genres, languages, total, shown, myLanguages }: {
  f: Filters; set: (f: Filters) => void; genres: string[]; languages: string[]; total: number; shown: number; myLanguages: string[];
}) {
  const seg = <T extends string>(key: keyof Filters, opts: [T, string][]) => (
    <div className="seg" role="group" aria-label={String(key)}>
      {opts.map(([v, label]) => (
        <button key={v} data-p={v} aria-pressed={f[key] === v} onClick={() => set({ ...f, [key]: v })}>{label}</button>
      ))}
    </div>
  );
  const dirty = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS);
  return (
    <div className="filters" aria-label="Filters">
      <label className="check" title="Only titles whose TMDB original or spoken language is in your saved languages">
        <input type="checkbox" checked={f.mine} onChange={(e) => set({ ...f, mine: e.target.checked })} />
        {myLanguages.map((l) => LANG[l] ?? l).join(" · ")} only
      </label>
      {seg<Provider | "all">("provider", [["all", "All"], ["netflix", "Netflix"], ["prime", "Prime Video"], ["jiohotstar", "JioHotstar"]])}
      {seg<MediaType | "all">("media", [["all", "All"], ["movie", "Movies"], ["tv", "Series"]])}
      <label className="sr-only" htmlFor="f-genre">Genre</label>
      <select id="f-genre" className="select" value={f.genre} onChange={(e) => set({ ...f, genre: e.target.value })}>
        <option value="">All genres</option>
        {genres.map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <label className="sr-only" htmlFor="f-lang">Language</label>
      <select id="f-lang" className="select" value={f.language} onChange={(e) => set({ ...f, language: e.target.value })}>
        <option value="">All languages</option>
        {languages.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
      </select>
      <label className="sr-only" htmlFor="f-rtype">Release type</label>
      <select id="f-rtype" className="select" value={f.rtype} onChange={(e) => set({ ...f, rtype: e.target.value as Filters["rtype"] })}>
        <option value="all">All release types</option>
        {(Object.keys(RELEASE_LABEL) as ReleaseType[]).map((t) => <option key={t} value={t}>{RELEASE_LABEL[t]}</option>)}
      </select>
      <span className="grow" />
      <span className="hint" style={{ color: "var(--faint)", fontSize: 13 }} aria-live="polite">{shown} of {total}</span>
      {dirty && <button className="clear" onClick={() => set(EMPTY_FILTERS)}>Clear</button>}
    </div>
  );
}

// ---------------------------------------------------------------- auth
export function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");
  if (!supabase) return null;
  return (
    <div className="panel">
      <h3>Sign in</h3>
      <p className="hint">This dashboard is private to Naman. Enter your allow-listed email and we'll send a one-time sign-in link.</p>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault(); setState("sending");
        const { error } = await supabase!.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        if (error) { setErr(error.message); setState("error"); } else setState("sent");
      }}>
        <label className="sr-only" htmlFor="email">Email</label>
        <input id="email" className="input" style={{ maxWidth: 320 }} type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" disabled={state === "sending"}>{state === "sending" ? "Sending…" : "Email me a sign-in link"}</button>
      </form>
      {state === "sent" && <p className="banner info">Check your inbox for the magic link.</p>}
      {state === "error" && <p className="banner error">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- review queue (human checkpoint)
export function ReviewQueue({ items, onDone, toast }: { items: Release[]; onDone: () => void; toast: (s: string) => void }) {
  if (!items.length) return <div className="empty"><div className="big">✅</div><h3>Nothing to review</h3><p>Every candidate this week was either verified or excluded automatically.</p></div>;
  return (
    <div className="form-grid">
      <p className="banner info">These came only from news articles (or had conflicting/missing dates). They are <b>not</b> in the dashboard or digest until you confirm them with a source you checked yourself.</p>
      {items.map((r) => <ReviewItem key={r.id} r={r} onDone={onDone} toast={toast} />)}
    </div>
  );
}

function ReviewItem({ r, onDone, toast }: { r: Release; onDone: () => void; toast: (s: string) => void }) {
  const hint = r.release_evidence.find((e) => e.evidence_type === "tmdb_digital_note")?.stated_date
    ?? r.release_evidence.find((e) => e.evidence_type === "news_article" && e.stated_date)?.stated_date ?? r.available_date ?? "";
  const [date, setDate] = useState(hint);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (decision: "confirm" | "exclude") => {
    setBusy(true);
    try { await callApi("review", { release_id: r.id, decision, available_date: date || null, note }); toast(decision === "confirm" ? "Confirmed" : "Excluded"); onDone(); }
    catch (e) { toast(String((e as Error).message)); }
    finally { setBusy(false); }
  };
  return (
    <div className="panel review">
      {posterUrl(r.poster_path, "w154") ? <img src={posterUrl(r.poster_path, "w154")!} alt="" loading="lazy" /> : <div />}
      <div>
        <div className="badges"><span className={`pbadge ${r.provider}`}>{PROVIDER_LABEL[r.provider]}</span><span className="tag">{RELEASE_LABEL[r.release_type]}</span></div>
        <h3 style={{ margin: "6px 0 2px" }}>{r.title} {r.year ? <span style={{ color: "var(--faint)" }}>({r.year})</span> : null}</h3>
        <div className="notes">{r.verification_notes}</div>
        <ul style={{ margin: "4px 0 10px", paddingLeft: 18, fontSize: 13 }}>
          {r.release_evidence.filter((e) => e.evidence_type !== "availability_current").map((e, i) => (
            <li key={i}>{e.url ? <a href={e.url} target="_blank" rel="noreferrer">{e.evidence_type.replace(/_/g, " ")}</a> : e.evidence_type.replace(/_/g, " ")}
              {e.stated_date ? ` — states ${e.stated_date}` : ""}{e.stated_platform ? ` · ${e.stated_platform}` : ""}{e.quote ? ` — “${e.quote}”` : ""}</li>
          ))}
        </ul>
        <div className="row">
          <label className="sr-only" htmlFor={`d-${r.id}`}>India availability date</label>
          <input id={`d-${r.id}`} className="input" style={{ maxWidth: 170 }} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label className="sr-only" htmlFor={`n-${r.id}`}>Source you checked</label>
          <input id={`n-${r.id}`} className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Source you checked (e.g. title page on the app)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary sm" disabled={busy || !date || note.length < 5} onClick={() => act("confirm")}>Confirm</button>
          <button className="btn danger sm" disabled={busy} onClick={() => act("exclude")}>Exclude</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- digest preview / test send / manual runs
export function DigestPanel({ liveSend, toast }: { liveSend: boolean | null; toast: (s: string) => void }) {
  const [chunks, setChunks] = useState<string[] | null>(null);
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState("");
  const run = async (what: string, f: () => Promise<void>) => { setBusy(what); try { await f(); } catch (e) { toast((e as Error).message); } finally { setBusy(""); } };
  return (
    <>
      <div className="panel">
        <h3>Digest preview</h3>
        <p className="hint">Builds the next Friday digest from confirmed releases only. Nothing is sent.</p>
        <button className="btn primary" disabled={!!busy} onClick={() => run("preview", async () => { const r = await callApi<{ chunks: string[] }>("preview"); setChunks(r.chunks); })}>
          {busy === "preview" ? "Building…" : "Preview next digest"}
        </button>
        {chunks && (
          <div style={{ marginTop: 16 }}>
            {chunks.map((c, i) => (
              <div key={i} className="telegram">
                <div dangerouslySetInnerHTML={{ __html: safeTelegramHtml(c) }} />
                <div className="meta">message {i + 1}/{chunks.length} · {c.length} chars</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="panel">
        <h3>Test send</h3>
        <p className="hint">Posts a message labelled <b>TEST</b> to the real Telegram channel. Type <code>SEND TEST</code> to enable.
          Scheduled sends are currently <b>{liveSend == null ? "unknown" : liveSend ? "ENABLED" : "DISABLED (LIVE_SEND_ENABLED=false)"}</b>.</p>
        <div className="row">
          <input className="input" style={{ maxWidth: 200 }} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="SEND TEST" aria-label="Type SEND TEST to confirm" />
          <button className="btn danger" disabled={confirm !== "SEND TEST" || !!busy} onClick={() => run("test", async () => {
            const r = await callApi<{ status: string; reason?: string }>("test_send", { confirm: "SEND TEST" });
            toast(`Test send: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`); setConfirm("");
          })}>{busy === "test" ? "Sending…" : "Send test to Telegram"}</button>
        </div>
      </div>
      <div className="panel">
        <h3>Manual runs</h3>
        <p className="hint">Re-collect and re-verify this week's window, or take an India availability snapshot. Neither sends messages; the scheduled digest is protected by a one-per-week lock.</p>
        <div className="row">
          <button className="btn" disabled={!!busy} onClick={() => run("collect", async () => { await callApi("rerun_collect"); toast("Collection started — refresh in ~1 min"); })}>Re-run collection</button>
          <button className="btn" disabled={!!busy} onClick={() => run("snap", async () => { await callApi("snapshot"); toast("Snapshot started"); })}>Take snapshot now</button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- preferences
const GENRE_OPTIONS = ["Thriller", "Science Fiction", "Indie Drama", "Drama", "Crime", "Mystery", "Action", "Comedy", "Romance", "Horror", "Documentary", "Animation", "Fantasy", "Reality"];
const LANG_OPTIONS = ["hi", "en", "ta", "te", "ml", "kn", "bn", "mr", "ko", "ja"];

export function PreferencesPanel({ prefs, onSaved, toast }: { prefs: Preferences; onSaved: () => void; toast: (s: string) => void }) {
  const [p, setP] = useState<Preferences>(prefs);
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const check = <T extends string>(key: keyof Preferences, v: T, label: string) => (
    <label className="check" key={v}>
      <input type="checkbox" checked={(p[key] as T[]).includes(v)} onChange={() => setP({ ...p, [key]: toggle(p[key] as T[], v) })} /> {label}
    </label>
  );
  return (
    <form className="panel form-grid" onSubmit={async (e) => {
      e.preventDefault();
      if (!p.platforms.length || !p.media_types.length) { toast("Pick at least one platform and one content type"); return; }
      setBusy(true);
      const { error } = await supabase!.from("preferences").update({
        genres: p.genres, languages: p.languages, platforms: p.platforms, media_types: p.media_types, release_types: p.release_types,
        include_older_additions: p.include_older_additions, notes: p.notes, digest_enabled: p.digest_enabled,
      }).eq("id", 1);
      setBusy(false);
      toast(error ? error.message : "Preferences saved — new opinions are generated on the next run");
      if (!error) onSaved();
    }}>
      <div><h3>{p.owner_name}'s preferences</h3><p className="hint">Used to filter platforms/types and to personalise AI opinions. Facts are never changed by preferences.</p></div>
      <fieldset><legend>Genres</legend><div className="checks">{GENRE_OPTIONS.map((g) => check("genres", g, g))}</div></fieldset>
      <fieldset><legend>Languages</legend><div className="checks">{LANG_OPTIONS.map((l) => check("languages", l, LANG[l] ?? l))}</div></fieldset>
      <fieldset><legend>Platforms</legend><div className="checks">{(["netflix", "prime", "jiohotstar"] as Provider[]).map((v) => check("platforms", v, PROVIDER_LABEL[v]))}</div></fieldset>
      <fieldset><legend>Content</legend><div className="checks">
        {check("media_types", "movie", "Movies")}{check("media_types", "tv", "Series")}
        {check("release_types", "new_title", "New titles")}{check("release_types", "new_season", "New seasons")}{check("release_types", "new_episode", "New episodes")}
        <label className="check"><input type="checkbox" checked={p.include_older_additions} onChange={(e) => setP({ ...p, include_older_additions: e.target.checked })} /> Older titles newly added</label>
      </div></fieldset>
      <fieldset><legend>Notes for the AI (optional)</legend>
        <textarea className="input" rows={2} maxLength={500} value={p.notes ?? ""} onChange={(e) => setP({ ...p, notes: e.target.value || null })} placeholder="e.g. prefer limited series; no reality TV" />
      </fieldset>
      <label className="check" style={{ width: "fit-content" }}><input type="checkbox" checked={p.digest_enabled} onChange={(e) => setP({ ...p, digest_enabled: e.target.checked })} /> Friday Telegram digest enabled</label>
      <div><button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Save preferences"}</button></div>
    </form>
  );
}

// ---------------------------------------------------------------- runs & sources
export function RunsPanel({ runs, digests }: { runs: PipelineRun[]; digests: DigestRun[] }) {
  return (
    <>
      <div className="panel">
        <h3>Pipeline runs</h3>
        <div className="table-wrap">
          <table className="runs">
            <thead><tr><th>Started (IST)</th><th>Task</th><th>Status</th><th>Window</th><th>Result</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>{fmtIst(r.started_at)}<div style={{ color: "var(--faint)" }}>{ago(r.started_at)} · {r.trigger}</div></td>
                  <td>{r.task}</td>
                  <td><span className={`status ${r.status}`}>{r.status}</span></td>
                  <td>{r.window_key ?? "—"}</td>
                  <td>
                    {r.error && <div style={{ color: "#fecaca" }}>{r.error.slice(0, 160)}</div>}
                    {"confirmed" in r.stats && <div>{String(r.stats.confirmed)} confirmed · {String(r.stats.needs_review ?? 0)} review · {String(r.stats.excluded ?? 0)} excluded</div>}
                    {"titles_seen" in r.stats && <div>{String(r.stats.titles_seen)} titles seen · {String(r.stats.new_titles)} new{r.stats.baseline ? " (baseline)" : ""}</div>}
                    {"reason" in r.stats && <div>{String(r.stats.reason)}</div>}
                    <div className="health">
                      {Object.entries(r.source_health ?? {}).filter(([k]) => !k.startsWith("title:")).slice(0, 8).map(([k, v]) => (
                        <span key={k} className={/^(ok|last)/.test(v) ? "" : "bad"} title={v}>{k.replace(/^google_news:.*/, "google news")}: {v.slice(0, 40)}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <h3>Digests</h3>
        {digests.length === 0 ? <p className="hint">No digest has been built yet. The first scheduled one runs Friday 18:30 IST.</p> : (
          <div className="table-wrap"><table className="runs">
            <thead><tr><th>Window</th><th>Type</th><th>Status</th><th>Items</th><th>Messages</th><th>Sent</th></tr></thead>
            <tbody>{digests.map((d) => (
              <tr key={d.id}><td>{d.window_key}</td><td>{d.is_test ? "test" : "scheduled"}</td><td><span className={`status ${d.status}`}>{d.status}</span>{d.error && <div style={{ color: "#fecaca" }}>{d.error.slice(0, 120)}</div>}</td>
                <td>{d.item_count}</td><td>{d.chunk_count}</td><td>{d.sent_at ? fmtIst(d.sent_at) : "—"}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function SourcesPanel({ sources }: { sources: Source[] }) {
  return (
    <div className="panel">
      <h3>Discovery sources</h3>
      <p className="hint">Articles are used to <b>discover</b> candidates only. Publication date is not a release date; nothing is confirmed from articles alone.</p>
      {sources.length === 0 ? <p className="hint">No articles collected yet.</p> : (
        <div className="table-wrap"><table className="runs">
          <thead><tr><th>Published</th><th>Publisher</th><th>Headline</th></tr></thead>
          <tbody>{sources.map((s) => (
            <tr key={s.id}><td style={{ whiteSpace: "nowrap" }}>{s.published_at ? fmtIst(s.published_at, { day: "numeric", month: "short" }) : "—"}</td><td>{s.publisher ?? "—"}</td>
              <td><a href={s.url} target="_blank" rel="noreferrer">{s.title ?? s.url}</a></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}
