import { useState } from "react";
import {
  BASIS_LABEL, PROVIDER_LABEL, RELEASE_LABEL, episodes, fmtDay, langName, latestRec, posterUrl, runtime, tmdbUrl,
} from "../lib/format";
import type { Release } from "../lib/types";

const EV_LABEL: Record<string, string> = {
  availability_change: "Streaming Availability: added in India",
  availability_snapshot: "Our India snapshot: first observed",
  availability_current: "TMDB/JustWatch: currently listed in India",
  episode_air_date: "TMDB: episode air date",
  news_article: "News article (discovery only)",
  tmdb_digital_note: "TMDB regional note (context only)",
  human_review: "Manual review",
};

export interface CardRelease extends Release {
  /** set when several daily-episode rows were grouped into one card */
  grouped_count?: number;
}

export function ReleaseCard({ r, onFeedback, index = 0 }: {
  r: CardRelease; index?: number;
  onFeedback?: (r: Release, decision: "watched" | "watchlist" | "not_interested") => void;
}) {
  const rec = latestRec(r);
  const [imgOk, setImgOk] = useState(true);
  const poster = posterUrl(r.poster_path);
  const eps = r.grouped_count && r.grouped_count > 1 ? `S${r.season_number ?? "?"} · ${r.grouped_count} new episodes` : episodes(r);
  const meta = [langName(r.original_language), eps ?? runtime(r.runtime_min)].filter(Boolean).join(" · ");
  const evidence = (r.release_evidence ?? []).filter((e) => e.evidence_type !== "availability_current" || e.url);
  const sourceLink = evidence.find((e) => e.stance === "supports" && e.url && e.evidence_type !== "availability_current")?.url;

  return (
    <article className="card" data-p={r.provider} style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
      aria-label={`${r.title} on ${PROVIDER_LABEL[r.provider]}`}>
      <div className="poster">
        <div className="img">
          {poster && imgOk
            ? <img src={poster} alt={`${r.title} poster`} loading="lazy" onError={() => setImgOk(false)} />
            : <div className="ph" aria-hidden>{r.title.slice(0, 1)}</div>}
        </div>
        <div className="meta">
          <div className="badges">
            <span className={`pbadge ${r.provider}`}>{PROVIDER_LABEL[r.provider]}</span>
            <span className={`tag ${r.release_type === "older_addition" ? "older" : ""}`}>{RELEASE_LABEL[r.release_type]}</span>
          </div>
          <h3>{r.title} {r.year ? <span className="yr">({r.year})</span> : null}</h3>
          <div className="facts">
            <span className="label">Verified facts</span>
            {r.available_date
              ? <span className="when">India: {fmtDay(r.available_date)}</span>
              : <span className="when">India date: unresolved</span>}
            {r.date_basis && <span className="basis">{BASIS_LABEL[r.date_basis]}</span>}
            <span>{meta}</span>
          </div>
        </div>
      </div>

      <div className="card-body">
        {r.genres.length > 0 && <div className="genres">{r.genres.slice(0, 4).map((g) => <span key={g}>{g}</span>)}</div>}

        {rec ? (
          <>
            <div>
              <span className="label">Synopsis · condensed from TMDB</span>
              <p className="synopsis">{rec.synopsis}</p>
            </div>
            <div className="ai" data-v={rec.verdict} aria-label={`AI opinion: ${rec.verdict}, ${rec.score} out of 100`}>
              <div className="ring" style={{ ["--p" as string]: rec.score }}><span>{rec.score}</span></div>
              <div className="verdict">{rec.verdict}<small>{rec.is_fallback ? "Rule-based · AI unavailable" : "AI opinion · Gemini"}</small></div>
              <div className="reason">{rec.reason}</div>
            </div>
          </>
        ) : r.overview ? (
          <div><span className="label">Overview · TMDB</span><p className="synopsis">{r.overview}</p></div>
        ) : null}

        <div className="card-foot">
          <div className="links">
            {r.watch_link && <a href={r.watch_link} target="_blank" rel="noreferrer">Where to watch ↗</a>}
            {sourceLink && sourceLink !== r.watch_link && <a href={sourceLink} target="_blank" rel="noreferrer">Source ↗</a>}
            <a href={tmdbUrl(r)} target="_blank" rel="noreferrer">TMDB ↗</a>
          </div>
          {onFeedback && (
            <div className="fb" role="group" aria-label="Your decision">
              <button className="btn sm ghost" onClick={() => onFeedback(r, "watchlist")} title="Add to my list">＋ List</button>
              <button className="btn sm ghost" onClick={() => onFeedback(r, "watched")} title="I watched it">✓ Watched</button>
              <button className="btn sm ghost" onClick={() => onFeedback(r, "not_interested")} title="Not for me">✕</button>
            </div>
          )}
        </div>

        {evidence.length > 0 && (
          <details className="ev">
            <summary>Evidence ({evidence.length}) · confidence {Math.round(r.confidence * 100)}%</summary>
            <ul>
              {evidence.map((e, i) => (
                <li key={i}>
                  <span className={`st ${e.stance}`}>{e.stance}</span>
                  {e.url ? <a href={e.url} target="_blank" rel="noreferrer">{EV_LABEL[e.evidence_type] ?? e.evidence_type}</a> : (EV_LABEL[e.evidence_type] ?? e.evidence_type)}
                  {e.stated_date ? ` — states ${e.stated_date}` : ""}
                  {e.quote ? <div style={{ color: "var(--faint)", marginTop: 2 }}>“{e.quote}”</div> : null}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}

export function SkeletonGrid({ n = 6 }: { n?: number }) {
  return <div className="grid" aria-busy="true" aria-label="Loading releases">{Array.from({ length: n }, (_, i) => <div key={i} className="skel" />)}</div>;
}
