// Generates docs/component-map.svg (+ .png): horizontal swimlanes × TRIGGER | INPUT | CONTEXT | PROCESSING | OUTPUT.
// Every box names a real component in this repo; edges use explicit orthogonal waypoints through routing channels.
// Usage: node scripts/render-diagram.mjs
import { writeFileSync } from "node:fs";

const W = 2060;
const LABEL_W = 210, COL_X0 = 244, COL_W = 320, COL_GAP = 46;
const COLS = [
  { name: "TRIGGER", fill: "#e6e0ff", stroke: "#7c5cff" },
  { name: "INPUT", fill: "#d9f3ea", stroke: "#2f9e7a" },
  { name: "CONTEXT", fill: "#fbefc4", stroke: "#c9a227" },
  { name: "PROCESSING", fill: "#fde0e3", stroke: "#d4566a" },
  { name: "OUTPUT", fill: "#dbeafb", stroke: "#3b82c4" },
];
const LANES = [
  { name: "SCHEDULER", sub: "Supabase Cron", h: 150 },
  { name: "DATA SOURCES", sub: "TMDB · Streaming Avail. · News", h: 330 },
  { name: "VALIDATION", sub: "extract · match · verify", h: 450 },
  { name: "SUPABASE", sub: "Postgres + RLS", h: 160 },
  { name: "GEMINI AI", sub: "opinions only", h: 190 },
  { name: "DASHBOARD", sub: "Vercel · React", h: 150 },
  { name: "TELEGRAM", sub: "Bot API delivery", h: 200 },
];
const TOP = 170;
const laneTop = []; { let y = TOP; for (const l of LANES) { laneTop.push(y); y += l.h; } }
const H = laneTop.at(-1) + LANES.at(-1).h + 130;
const colX = (c) => COL_X0 + c * (COL_W + COL_GAP);
const ch = (i) => colX(i) - COL_GAP / 2; // routing channel left of column i

// [id, lane, col, dy, kind, lines]  kind: trigger|input|context|processing|output|warn|fail|human|decision
const B = [
  ["s1", 0, 0, 22, "trigger", ["pg_cron (UTC schedules)", "Fri 13:00 UTC = 18:30 IST → weekly", "retries 18:45 · 19:00 · 19:30 IST", "daily 06:00 snapshot · 06:15 collect"]],
  ["s3", 0, 1, 30, "input", ["pg_net POST /radar-cron?task=…", "x-cron-secret read from Vault", "(Edge Function, shared-secret auth)"]],
  ["s4", 0, 3, 22, "processing", ["runWeekly()", "window [prev Fri 18:30, Fri 18:30) IST", "idempotent per window_key", "defers delivery if < 45 s budget left"]],

  ["d1", 1, 1, 14, "input", ["TMDB API (free)", "metadata · posters · episode air dates", "IN watch providers (data by JustWatch)"]],
  ["d2", 1, 1, 122, "input", ["Streaming Availability /changes", "country=in · netflix, prime, hotstar", "free plan · newest-first · daily"]],
  ["d3", 1, 1, 232, "input", ["News discovery (evidence only)", "Google News RSS (503 from cloud IPs)", "+ 7 publisher RSS feeds"]],
  ["d4", 1, 2, 66, "context", ["Daily India snapshot", "TMDB discover × provider (365 days)", "first-seen diff vs last complete run"]],
  ["d5", 1, 2, 172, "context", ["Platform originals airing", "networks Netflix 213 · Prime 1024", "JioHotstar 8036 · Hotstar 3919"]],

  ["v1", 2, 3, 14, "processing", ["Gemini extraction (flash-lite)", "grounding: verbatim quote + title", "ungrounded date/platform stripped"]],
  ["v2", 2, 3, 118, "processing", ["TMDB match (search + pickMatch)", "ambiguous → not matched"]],
  ["v3", 2, 3, 205, "processing", ["verifyTitle(): SA change 0.95 ·", "original air date 0.85 · snapshot 0.75", "capped at now · articles never confirm"]],
  ["v4", 2, 3, 312, "decision", ["Confirmed in", "7-day IST window", "& confidence ≥ 0.7?"]],
  ["v5", 2, 2, 331, "fail", ["needs_review / excluded", "missing · conflicting · future ·", "stale · provider mismatch"]],
  ["v6", 2, 2, 170, "human", ["HUMAN REVIEW", "Naman (dashboard Review tab)", "confirms date + names source"]],

  ["b1", 3, 2, 22, "context", ["preferences (hi · en · ta hard filter)", "app_admins · RLS: admin-only (private)"]],
  ["b2", 3, 3, 22, "processing", ["saveReleases(): dedupe_key", "+ ±3-day merge · release_evidence", "candidates · sources (last_checked)"]],
  ["b3", 3, 4, 22, "output", ["pipeline_runs · digest_runs", "(UNIQUE per window) · delivery_logs"]],

  ["g1", 4, 2, 30, "context", ["Verified facts + preferences", "TMDB overview = only plot source"]],
  ["g2", 4, 3, 22, "processing", ["recommend(): 1 call per show", "Watch/Maybe/Skip · 0–100 · reason", "validate: score band · no dates ·", "synopsis numbers ⊆ overview"]],
  ["g4", 4, 4, 14, "output", ["recommendations", "(AI opinion, stored apart from facts)"]],
  ["g3", 4, 4, 104, "fail", ["Rule-based fallback", "labelled “AI unavailable”"]],

  ["w1", 5, 0, 30, "trigger", ["Naman (or anyone with the link)", "opens the dashboard · no sign-in"]],
  ["w2", 5, 1, 30, "input", ["publishable key · read-only RLS", "edits via radar-api + owner code"]],
  ["w3", 5, 4, 22, "output", ["React dashboard on Vercel", "New This Week · top matches · filters", "review · preview · test send · runs"]],

  ["t1", 6, 3, 22, "processing", ["buildDigest(): group episodes ·", "sections · HTML-escape ·", "≤ 3 900-char chunks"]],
  ["t2", 6, 4, 14, "output", ["sendChunks() → Telegram channel", "per-chunk lock · 429 retry_after", "gate: LIVE_SEND_ENABLED"]],
  ["t3", 6, 4, 116, "fail", ["timeout → ‘unknown’, never resent", "HTTP error → retried by next cron"]],
];

const STYLE = {
  trigger: COLS[0], input: COLS[1], context: COLS[2], processing: COLS[3], output: COLS[4],
  warn: { fill: "#fff4d6", stroke: "#d97706" }, fail: { fill: "#fee2e2", stroke: "#dc2626" },
  human: { fill: "#fde68a", stroke: "#b45309" }, decision: { fill: "#fef3c7", stroke: "#c9a227" },
};
const LINE_H = 19, PAD = 12, BOX_W = COL_W - 30;
const boxes = new Map();
for (const [id, lane, col, dy, kind, lines] of B) {
  const diamond = kind === "decision" || kind === "human";
  const w = kind === "decision" ? 224 : diamond ? 260 : BOX_W;
  const h = diamond ? 120 : lines.length * LINE_H + PAD * 2;
  boxes.set(id, { id, x: colX(col) + (COL_W - w) / 2, y: laneTop[lane] + dy, w, h, kind, lines });
}
const P = (id, side, off = 0) => {
  const b = boxes.get(id);
  return { r: [b.x + b.w, b.y + b.h / 2 + off], l: [b.x, b.y + b.h / 2 + off], t: [b.x + b.w / 2 + off, b.y], b: [b.x + b.w / 2 + off, b.y + b.h] }[side];
};

// [style, label, labelSegment, ...points]   style: solid | dashed | fail | human
const E = [
  ["solid", "", 0, P("s1", "r"), P("s3", "l")],
  ["solid", "", 0, P("s3", "r"), P("s4", "l")],
  ["solid", "fetch in parallel", 1, P("s4", "b"), [P("s4", "b")[0], laneTop[1] - 14], [P("d1", "t")[0], laneTop[1] - 14], P("d1", "t")],
  ["solid", "facts · IN providers · air dates", 0, P("d1", "r"), [ch(3) - 12, P("d1", "r")[1]], [ch(3) - 12, P("v3", "l", -14)[1]], P("v3", "l", -14)],
  ["fail", "on 401/403 → snapshot fallback", 2, P("d2", "r"), [ch(2) + 6, P("d2", "r")[1]], [ch(2) + 6, laneTop[2] + 10], [ch(3) + 12, laneTop[2] + 10], [ch(3) + 12, P("v3", "l", 14)[1]], P("v3", "l", 14)],
  ["dashed", "articles (claims)", 0, P("d3", "r"), [ch(3) - 4, P("d3", "r")[1]], [ch(3) - 4, P("v1", "l")[1]], P("v1", "l")],
  ["solid", "first-seen dates", 0, P("d4", "r"), [ch(3) + 4, P("d4", "r")[1]], [ch(3) + 4, P("v3", "l")[1]], P("v3", "l")],
  ["solid", "originals", 0, P("d5", "r"), [ch(3) + 4, P("d5", "r")[1]]],
  ["solid", "", 0, P("v1", "b"), P("v2", "t")],
  ["dashed", "matched claims", 0, P("v2", "b"), P("v3", "t")],
  ["solid", "", 0, P("v3", "b"), P("v4", "t")],
  ["solid", "Yes", 0, P("v4", "b"), P("b2", "t")],
  ["fail", "No / unsure", 0, P("v4", "l"), [P("v5", "r")[0], P("v4", "l")[1]]],
  ["human", "unresolved date", 0, P("v5", "t"), P("v6", "b")],
  ["human", "confirm (human_review)", 2, P("v6", "l"), [ch(2) + 12, P("v6", "l")[1]], [ch(2) + 12, laneTop[3] - 14], [ch(3), laneTop[3] - 14], [ch(3), P("b2", "l")[1]], P("b2", "l")],
  ["solid", "", 0, P("b2", "r", 12), P("b3", "l", 12)],
  ["solid", "", 0, P("b1", "b"), P("g1", "t")],
  ["solid", "", 0, P("g1", "r"), P("g2", "l")],
  ["solid", "confirmed · language-filtered", 0, P("b2", "b"), P("g2", "t")],
  ["solid", "", 0, P("g2", "r", -16), [ch(4) - 4, P("g2", "r", -16)[1]], [ch(4) - 4, P("g4", "l")[1]], P("g4", "l")],
  ["fail", "", 2, P("g2", "r", 16), [ch(4) + 8, P("g2", "r", 16)[1]], [ch(4) + 8, P("g3", "l")[1]], P("g3", "l")],
  ["solid", { text: "facts + opinions", t: 0.18 }, 0, P("g2", "b"), P("t1", "t")],
  ["solid", "", 0, P("t1", "r"), P("t2", "l")],
  ["fail", "", 0, P("t2", "b"), P("t3", "t")],
  ["solid", "", 0, P("w1", "r"), P("w2", "l")],
  ["solid", "", 0, P("w2", "r"), [ch(3) - 20, P("w2", "r")[1]], [ch(3) - 20, P("w3", "l")[1]], P("w3", "l")],
  ["solid", { text: "RLS reads", t: 0.8 }, 1, P("b3", "r"), [W - 44, P("b3", "r")[1]], [W - 44, P("w3", "r")[1]], P("w3", "r")],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const font = `font-family="Segoe UI, Inter, Arial, sans-serif"`;
const ES = {
  solid: { stroke: "#334155", dash: "", m: "a-solid" }, dashed: { stroke: "#64748b", dash: "7 6", m: "a-dashed" },
  fail: { stroke: "#dc2626", dash: "6 5", m: "a-fail" }, human: { stroke: "#b45309", dash: "3 4", m: "a-human" },
};

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${Object.entries(ES).map(([, s]) => `  <marker id="${s.m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${s.stroke}"/></marker>`).join("\n")}
</defs>
<rect width="${W}" height="${H}" fill="#f8fafc"/>
<text x="${W / 2}" y="58" text-anchor="middle" ${font} font-size="34" font-weight="800" fill="#0f172a">OTT Release Radar — Weekly Release Digest Workflow</text>
<text x="${W / 2}" y="92" text-anchor="middle" ${font} font-size="17" fill="#475569">Component map of the implemented system · India-specific OTT verification · AI opinions kept separate from verified facts</text>
`;
COLS.forEach((c, i) => {
  svg += `<rect x="${colX(i)}" y="112" width="${COL_W}" height="44" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.5"/>
<text x="${colX(i) + COL_W / 2}" y="140" text-anchor="middle" ${font} font-size="17" font-weight="700" fill="#1e293b">${c.name}</text>\n`;
});
LANES.forEach((l, i) => {
  const y = laneTop[i];
  svg += `<rect x="24" y="${y}" width="${W - 48}" height="${l.h}" fill="${i % 2 ? "#ffffff" : "#f1f5f9"}" stroke="#cbd5e1"/>
<rect x="24" y="${y}" width="${LABEL_W}" height="${l.h}" fill="#e2e8f0" stroke="#cbd5e1"/>
<text x="40" y="${y + 34}" ${font} font-size="16" font-weight="800" fill="#0f172a">${i + 1}. ${esc(l.name)}</text>
<text x="40" y="${y + 56}" ${font} font-size="13" fill="#475569">${esc(l.sub)}</text>\n`;
});

const labels = [];
for (const [style, label, at, ...pts] of E) {
  const s = ES[style];
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const joinsBus = label === "originals"; // merges into an existing channel line → no arrowhead
  svg += `<path d="${d}" fill="none" stroke="${s.stroke}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} ${joinsBus ? "" : `marker-end="url(#${s.m})"`}/>\n`;
  if (label && !joinsBus) {
    const spec = typeof label === "string" ? { text: label, t: 0.5 } : label;
    const lw = spec.text.length * 6.7 + 10;
    const [x1, y1] = pts[at], [x2, y2] = pts[Math.min(at + 1, pts.length - 1)];
    const horiz = Math.abs(y1 - y2) < 2;
    let lx = horiz ? Math.min(x1, x2) + 8 : x1 + 8;
    const ly = horiz ? y1 - 7 : y1 + (y2 - y1) * spec.t + 4;
    if (!horiz && lx + lw > W - 30) lx = x1 - lw - 4; // keep labels inside the canvas
    labels.push(`<rect x="${lx - 4}" y="${ly - 13}" width="${lw}" height="18" rx="4" fill="#ffffff" fill-opacity=".95"/><text x="${lx + 1}" y="${ly}" ${font} font-size="12" font-weight="600" fill="${s.stroke}">${esc(spec.text)}</text>\n`);
  }
}

for (const b of boxes.values()) {
  const st = STYLE[b.kind];
  if (b.kind === "decision" || b.kind === "human") {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    svg += `<polygon points="${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"/>\n`;
    b.lines.forEach((ln, i) => {
      svg += `<text x="${cx}" y="${cy - (b.lines.length - 1) * 8 + i * 17 + 5}" text-anchor="middle" ${font} font-size="${i === 0 ? 13.5 : 11.5}" font-weight="${i === 0 ? 800 : 600}" fill="#1e293b">${esc(ln)}</text>\n`;
    });
    continue;
  }
  svg += `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1.6"/>\n`;
  b.lines.forEach((ln, i) => {
    svg += `<text x="${b.x + b.w / 2}" y="${b.y + PAD + 14 + i * LINE_H}" text-anchor="middle" ${font} font-size="${i === 0 ? 14 : 12.5}" font-weight="${i === 0 ? 700 : 500}" fill="#0f172a">${esc(ln)}</text>\n`;
  });
}
svg += labels.join("");

// legend
const ly0 = laneTop.at(-1) + LANES.at(-1).h + 26;
svg += `<rect x="24" y="${ly0}" width="${W - 48}" height="84" rx="12" fill="#ffffff" stroke="#cbd5e1"/>\n`;
const leg = [
  ["line", "solid", "Primary flow"], ["line", "dashed", "Supporting evidence (never proof)"], ["line", "fail", "Failure / degraded path"],
  ["line", "human", "Human-review path"], ["diamond", "human", "Human review = unresolved release dates"], ["diamond", "decision", "Automatic confirm / exclude"],
];
let lx = 48;
for (const [t, k, label] of leg) {
  if (t === "line") {
    const s = ES[k];
    svg += `<line x1="${lx}" y1="${ly0 + 30}" x2="${lx + 46}" y2="${ly0 + 30}" stroke="${s.stroke}" stroke-width="2.4" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} marker-end="url(#${s.m})"/>`;
  } else {
    const st = STYLE[k];
    svg += `<polygon points="${lx + 22},${ly0 + 16} ${lx + 40},${ly0 + 30} ${lx + 22},${ly0 + 44} ${lx + 4},${ly0 + 30}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"/>`;
  }
  svg += `<text x="${lx + 56}" y="${ly0 + 35}" ${font} font-size="14" fill="#1e293b">${esc(label)}</text>\n`;
  lx += 56 + label.length * 7.3 + 30;
}
let cx = 48;
for (const [k, label] of [["trigger", "Trigger"], ["input", "Input"], ["context", "Context"], ["processing", "Processing"], ["output", "Output"], ["warn", "Live limitation"], ["fail", "Failure state"]]) {
  const st = STYLE[k];
  svg += `<rect x="${cx}" y="${ly0 + 54}" width="22" height="16" rx="4" fill="${st.fill}" stroke="${st.stroke}"/><text x="${cx + 30}" y="${ly0 + 67}" ${font} font-size="13" fill="#334155">${label}</text>\n`;
  cx += 30 + label.length * 7.2 + 26;
}
svg += `<text x="${W - 40}" y="${ly0 + 67}" text-anchor="end" ${font} font-size="12" fill="#64748b">Generated by scripts/render-diagram.mjs from the implemented components</text>\n`;
svg += "</svg>\n";

writeFileSync("docs/component-map.svg", svg);
console.log(`wrote docs/component-map.svg (${W}×${H})`);
try {
  const { Resvg } = await import("@resvg/resvg-js");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render().asPng();
  writeFileSync("docs/component-map.png", png);
  console.log("wrote docs/component-map.png");
} catch (e) {
  console.log("PNG skipped (install @resvg/resvg-js):", String(e).slice(0, 120));
}
