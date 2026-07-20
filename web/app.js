"use strict";
/* GITDATA // SIGINT TERMINAL
 *
 * Ein Fetch, alles danach im Client: /api/intel liefert Repos, Personen und die
 * Person->Repo-Kanten. Die Repo<->Repo-Kanten (gemeinsame Contributors) werden
 * hier aus den Person-Kanten abgeleitet — deshalb wirken Filter sofort auf den
 * Graphen, ohne Roundtrip.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n ?? 0).toLocaleString("de-DE");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const yr = (s) => (s ? +s.slice(0, 4) : null);
const isBot = (l) => l.endsWith("[bot]") || l.endsWith("-bot");

// An Linguist angelehnt, aber fuer Schwarz aufgehellt: Ruby (#701516) stellt
// hier ~57 % der Knoten und waere im Original auf dem Hintergrund unsichtbar.
const LANG_COLORS = {
  Ruby: "#ff4d5e", Python: "#4b9fe1", JavaScript: "#f1e05a", C: "#9aa5ab",
  "C++": "#f34b7d", Java: "#d89b3f", PHP: "#8b9ae8", Perl: "#22b8e6",
  "Objective-C": "#5aa0ff", Shell: "#89e051", Lua: "#6a6aff", Erlang: "#d95bb8",
  "Emacs Lisp": "#c065db", "Common Lisp": "#3fb68b", "Vim Script": "#3fbf6b",
  Haskell: "#9184c9", Scala: "#e05a6f", Go: "#00ADD8", Rust: "#dea584",
  HTML: "#e8703a", CSS: "#9a72d8", TypeScript: "#4b8fe1", Clojure: "#db5855",
  Cython: "#fedf5b", Fortran: "#7a6fe0", TeX: "#7ba85a", R: "#198CE7",
  Assembly: "#b58a3c", "C#": "#3fb84f", Smalltalk: "#a8bf3f", OCaml: "#3be133",
};
const CLUSTER_COLORS = ["#00f0d0", "#ffb340", "#ff3d8b", "#46f08a", "#7d7dff",
  "#ff7a45", "#41d4ff", "#d4ff41", "#ff41d4", "#41ffb0", "#b041ff", "#ffd041"];
// Canvas-Farben aus denselben CSS-Variablen wie die Panels ziehen — sonst
// driften Terminal und Zeichenflaeche bei jeder Palettenaenderung auseinander.
const CSSV = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const CY = CSSV("--cyan") || "#28f5d8", AM = CSSV("--amber") || "#ffc061",
      MG = CSSV("--magenta") || "#ff5c9d", DIM = CSSV("--dim") || "#8fb3c0",
      TXT = CSSV("--text") || "#c3dfe9", BRIGHT = CSSV("--bright") || "#e8f8ff",
      BGC = CSSV("--bg") || "#070c11", LINEC = CSSV("--line") || "#1b2b34";
// Canvas-Schriftgroessen zentral: 7-9px war auf dem Schirm nicht lesbar.
const FONT = (px) => `${px}px ui-monospace, Menlo, monospace`;
const F_NODE = FONT(12), F_AXIS = FONT(11), F_MATRIX = FONT(10), F_MINI = FONT(10);

const langColor = (l) => LANG_COLORS[l] || "#93a7b0";
const ramp = (t) => { // cyan -> amber -> magenta
  t = clamp(t, 0, 1);
  const s = t < .5
    ? [[0, 240, 208], [255, 179, 64], t * 2]
    : [[255, 179, 64], [255, 61, 139], (t - .5) * 2];
  const [a, b, u] = s;
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * u)).join(",")})`;
};

/* ===================== STATE ===================== */
const S = {
  raw: null,
  repos: [], repoById: new Map(),
  people: new Map(),          // login -> {login,type,repos,total}
  linksByRepo: new Map(),     // repoId -> [{login,n}]
  linksByPerson: new Map(),   // login -> [{repo_id,n}]
  langsByRepo: new Map(),     // repoId -> [{language,bytes}]
  topicsByRepo: new Map(),
  relByRepo: new Map(), depByRepo: new Map(),
  nodes: [], edges: [], adj: new Map(),
  years: [], maxStars: 1, maxForks: 1, maxIssues: 1, maxSize: 1,
  mode: "network", colorBy: "lang", showLabels: true,
  sel: null, hover: null, trace: { a: null, b: null, path: null },
  view: { x: 0, y: 0, k: 1 },
  alpha: 0, dragging: null, clusters: new Map(),
};

const F = {
  q: "", langs: new Set(), shared: 1, weight: 1, degree: 1,
  // Default an: 539 der 1543 Repos haengen an keiner Kante und wuerden den
  // Netzblick zumuellen. Zahl steht in der Topologie-Kachel, Toggle daneben.
  isolates: true, nobots: true, stars: 0, forks: 0, issues: 0, contrib: 0,
  size: 0, pushFrom: 0, pushTo: 0, types: new Set(["User", "Organization"]),
  noarch: false, nofork: false, rel: false, dep: false,
  license: "", topic: "", cluster: "",
};

/* ===================== BOOT ===================== */
const BOOT_LINES = [
  "GITDATA TERMINAL v2 — OSINT COLLABORATION GRAPH",
  "",
  "[  ok  ] link  /api/intel",
];
async function boot() {
  const log = $("bootlog");
  const put = (s) => { log.textContent += s + "\n"; };
  BOOT_LINES.forEach(put);
  const t0 = performance.now();
  let d;
  try {
    d = await fetch("/api/intel").then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  } catch (e) {
    put("[ FAIL ] " + e.message);
    put("");
    put("Läuft der Server?   python -m gitdata serve");
    return;
  }
  const ms = Math.round(performance.now() - t0);
  // Bewusst setTimeout statt requestAnimationFrame: rAF steht in einem
  // Hintergrund-Tab still — der Boot wuerde dort nie fertig werden.
  const frame = () => new Promise((r) => setTimeout(r, 16));
  put(`[  ok  ] payload ${(1.46).toFixed(2)} MB in ${ms} ms`);
  put(`[  ok  ] repos ${fmt(d.repos.length)} · owners ${fmt(d.people.length)}`);
  put(`[  ok  ] person→repo edges ${fmt(d.links.length)}`);
  put(`[  ok  ] universe ${fmt(d.universe.repos)} repos indexed`);
  put("[ .... ] building indices");
  ingest(d);
  await frame();
  put("[ .... ] folding co-contribution links · force layout");
  // #app sichtbar schalten, damit das Canvas messbar ist — das Boot-Overlay
  // liegt drueber und verdeckt den Aufbau.
  $("app").hidden = false;
  await frame();
  start();
  put(`[  ok  ] ${fmt(S.edges.length)} links · ${fmt(S.nodes.length)} nodes · layout converged`);
  put("[  ok  ] terminal ready");
  await new Promise((r) => setTimeout(r, 300));
  $("boot").classList.add("gone");
}

/* ===================== INGEST ===================== */
function ingest(d) {
  S.raw = d;
  S.repos = d.repos;
  for (const r of d.repos) {
    r.stars ??= 0; r.forks ??= 0; r.open_issues ??= 0; r.size ??= 0;
    r.pyear = yr(r.pushed_at);
    r.short = r.full_name.split("/")[1] || r.full_name;
    S.repoById.set(r.id, r);
  }
  for (const p of d.people) S.people.set(p.login, p);
  for (const l of d.links) {
    if (!S.linksByRepo.has(l.repo_id)) S.linksByRepo.set(l.repo_id, []);
    S.linksByRepo.get(l.repo_id).push(l);
    if (!S.linksByPerson.has(l.login)) S.linksByPerson.set(l.login, []);
    S.linksByPerson.get(l.login).push(l);
  }
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  for (const l of d.langs) push(S.langsByRepo, l.repo_id, l);
  for (const t of d.topics) push(S.topicsByRepo, t.repo_id, t.topic);
  for (const r of d.releases) push(S.relByRepo, r.repo_id, r);
  for (const x of d.deps) push(S.depByRepo, x.repo_id, x);

  for (const r of S.repos) {
    r.contribs = (S.linksByRepo.get(r.id) || []).length;
    r.topics = S.topicsByRepo.get(r.id) || [];
    S.maxStars = Math.max(S.maxStars, r.stars);
    S.maxForks = Math.max(S.maxForks, r.forks);
    S.maxIssues = Math.max(S.maxIssues, r.open_issues);
    S.maxSize = Math.max(S.maxSize, r.size);
  }
  S.years = [...new Set(S.repos.map((r) => r.pyear).filter(Boolean))].sort();
  F.pushFrom = S.years[0]; F.pushTo = S.years[S.years.length - 1];
}

/* ===================== FILTER → NODES ===================== */
function activePeople() {
  // Personen, die als Verbindungsträger zählen: Bot-Filter, Mindest-Reichweite,
  // Mindest-Commitgewicht. Wer hier rausfällt, erzeugt auch keine Kante.
  const out = new Map();
  for (const [login, ls] of S.linksByPerson) {
    if (F.nobots && isBot(login)) continue;
    const strong = ls.filter((l) => (l.n || 0) >= F.weight);
    if (strong.length < F.degree) continue;
    out.set(login, strong);
  }
  return out;
}

function passRepo(r) {
  if (F.q) {
    const q = F.q.toLowerCase();
    if (!r.full_name.toLowerCase().includes(q)) {
      const hit = (S.linksByRepo.get(r.id) || []).some((l) => l.login.toLowerCase().includes(q));
      if (!hit) return false;
    }
  }
  if (F.langs.size && !F.langs.has(r.lang || "—")) return false;
  if (r.stars < F.stars || r.forks < F.forks) return false;
  if (r.open_issues < F.issues || r.size < F.size) return false;
  if (r.contribs < F.contrib) return false;
  if (F.noarch && r.archived) return false;
  if (F.nofork && r.is_fork) return false;
  if (F.rel && !S.relByRepo.has(r.id)) return false;
  if (F.dep && !S.depByRepo.has(r.id)) return false;
  if (F.license && r.license !== F.license) return false;
  if (F.topic && !r.topics.includes(F.topic)) return false;
  if (F.types.size && !F.types.has(r.owner_type || "User")) return false;
  if (r.pyear != null && (r.pyear < F.pushFrom || r.pyear > F.pushTo)) return false;
  return true;
}

function rebuild() {
  const keep = S.repos.filter(passRepo);
  const keepIds = new Set(keep.map((r) => r.id));
  const ppl = activePeople();

  // Repo<->Repo-Kanten aus den Person-Kanten falten.
  const em = new Map();
  for (const [login, ls] of ppl) {
    const ids = ls.map((l) => l.repo_id).filter((i) => keepIds.has(i));
    if (ids.length < 2 || ids.length > 400) continue; // ponytail: O(k²) je Person, ok bei k≤52
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = Math.min(ids[i], ids[j]), b = Math.max(ids[i], ids[j]);
        const k = a + ":" + b;
        let e = em.get(k);
        if (!e) em.set(k, e = { src: a, dst: b, shared: 0, who: [] });
        e.shared++; if (e.who.length < 12) e.who.push(login);
      }
    }
  }
  S.edges = [...em.values()].filter((e) => e.shared >= F.shared);

  S.adj = new Map();
  for (const e of S.edges) {
    if (!S.adj.has(e.src)) S.adj.set(e.src, []);
    if (!S.adj.has(e.dst)) S.adj.set(e.dst, []);
    S.adj.get(e.src).push({ id: e.dst, w: e.shared });
    S.adj.get(e.dst).push({ id: e.src, w: e.shared });
  }

  let nodes = keep;
  if (F.isolates) nodes = nodes.filter((r) => S.adj.has(r.id));

  cluster(nodes);
  if (F.cluster !== "") nodes = nodes.filter((r) => String(S.clusters.get(r.id)) === F.cluster);

  const alive = new Set(nodes.map((n) => n.id));
  S.edges = S.edges.filter((e) => alive.has(e.src) && alive.has(e.dst));

  // Positionen über Rebuilds hinweg halten — Filter sollen den Graph verformen,
  // nicht neu würfeln. Neue Knoten setzen sich auf eine Phyllotaxis-Spirale:
  // gleichmäßig, ohne Ueberlappung — zufaellige Startpunkte erzeugen Kollisionen,
  // und 1/d² schleudert die Knoten dann ins Nirgendwo.
  const prev = new Map(S.nodes.map((n) => [n.id, n]));
  S.nodes = nodes.map((r, i) => {
    const p = prev.get(r.id);
    const a = i * 2.399, rad = 15 * Math.sqrt(i);
    return Object.assign(r, {
      x: p ? p.x : Math.cos(a) * rad,
      y: p ? p.y : Math.sin(a) * rad,
      vx: 0, vy: 0,
      deg: (S.adj.get(r.id) || []).length,
    });
  });
  S.alpha = 1;
  S.trace.path = null;
  paintAll();
}

/* --- Label-Propagation: billige Community-Erkennung --- */
function cluster(nodes) {
  const lab = new Map(nodes.map((n) => [n.id, n.id]));
  const ids = nodes.map((n) => n.id);
  for (let it = 0; it < 9; it++) {
    let moved = 0;
    for (const id of ids) {
      const nb = S.adj.get(id); if (!nb || !nb.length) continue;
      const tally = new Map();
      for (const { id: o, w } of nb) {
        const l = lab.get(o); if (l === undefined) continue;
        tally.set(l, (tally.get(l) || 0) + w);
      }
      let best = lab.get(id), bw = -1;
      for (const [l, w] of tally) if (w > bw) { bw = w; best = l; }
      if (best !== lab.get(id)) { lab.set(id, best); moved++; }
    }
    if (!moved) break;
  }
  // Große Cluster zuerst nummerieren → stabile Farbzuordnung.
  const size = new Map();
  for (const l of lab.values()) size.set(l, (size.get(l) || 0) + 1);
  const order = [...size.entries()].filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const rank = new Map(order.map((l, i) => [l, i]));
  S.clusters = new Map();
  for (const [id, l] of lab) S.clusters.set(id, rank.has(l) ? rank.get(l) : -1);
  S.clusterSizes = order.map((l) => size.get(l));
}

/* ===================== FORCE LAYOUT ===================== */
function tick() {
  if (S.alpha < .004) return false;
  const N = S.nodes;
  if (!N.length) return false;
  // Exakte Abstossung ueber alle Paare. Ein Nachbarschaftsgitter waere O(n),
  // hat aber nur lokale Reichweite — dann faellt der ganze Graph zu einer Kugel
  // zusammen, weil nichts entfernte Cluster auseinanderdrueckt. Bei n≈1.5k sind
  // die ~1.2M Paare billiger als der Strukturverlust.
  // ponytail: O(n²) je Tick; ab ~4k Knoten Barnes-Hut nachruesten.
  for (let i = 0; i < N.length; i++) {
    const a = N[i];
    for (let j = i + 1; j < N.length; j++) {
      const b = N[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 > 360000) continue;                       // >600px: vernachlaessigbar
      if (d2 < .01) { a.x += Math.random() - .5; a.y += Math.random() - .5; continue; }
      // Deckel auf 1/d²: sonst wird die Kraft bei fast deckungsgleichen Knoten
      // unendlich und schiesst sie aus dem Bild.
      const d = Math.sqrt(d2), f = Math.min(2.5, 2400 / d2) * S.alpha;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  const maxS = Math.max(1, ...S.edges.map((e) => e.shared));
  for (const e of S.edges) {
    const a = S.repoById.get(e.src), b = S.repoById.get(e.dst);
    if (!a || !b || a.x === undefined || b.x === undefined) continue;
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || .01;
    const target = 40 + 90 * (1 - e.shared / maxS);
    const f = (d - target) * .012 * S.alpha * Math.min(1, e.shared / 3);
    a.vx += (dx / d) * f; a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
  }
  for (const n of N) {
    if (n === S.dragging) { n.vx = n.vy = 0; continue; }
    // Isolierte Knoten haengen an keiner Feder — ohne straffere Gravitation
    // driften sie unbegrenzt nach aussen.
    const g = n.deg ? .0045 : .02;
    n.vx -= n.x * g * S.alpha; n.vy -= n.y * g * S.alpha;
    n.vx *= .82; n.vy *= .82;
    const sp = Math.hypot(n.vx, n.vy);
    if (sp > 12) { n.vx = n.vx / sp * 12; n.vy = n.vy / sp * 12; }  // Geschwindigkeitsdeckel
    n.x += n.vx; n.y += n.vy;
  }
  S.alpha *= .985;
  return true;
}

/* ===================== CANVAS ===================== */
const cv = $("view"); const ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  W = r.width; H = r.height;
  cv.width = W * DPR; cv.height = H * DPR;
}
const T = (p) => ({ x: (p.x + S.view.x) * S.view.k + W / 2, y: (p.y + S.view.y) * S.view.k + H / 2 });
const invT = (sx, sy) => ({ x: (sx - W / 2) / S.view.k - S.view.x, y: (sy - H / 2) / S.view.k - S.view.y });

function nodeColor(n) {
  switch (S.colorBy) {
    case "cluster": { const c = S.clusters.get(n.id); return c < 0 ? "#5c7784" : CLUSTER_COLORS[c % CLUSTER_COLORS.length]; }
    case "stars": return ramp(Math.log10(n.stars + 1) / Math.log10(S.maxStars + 1));
    case "age": { if (!n.pyear) return "#5c7784"; const t = (n.pyear - S.years[0]) / Math.max(1, S.years.at(-1) - S.years[0]); return ramp(1 - t); }
    case "type": return n.owner_type === "Organization" ? AM : n.owner_type === "Bot" ? MG : CY;
    case "degree": { const m = Math.max(1, ...S.nodes.map((x) => x.deg)); return ramp(n.deg / m); }
    default: return langColor(n.lang);
  }
}
const nodeR = (n) => 2.2 + Math.sqrt(n.stars) / 9 + Math.min(6, n.deg * .16);
// Label-Prioritaet: Hubs und Stars zuerst — der Platz reicht nur fuer ~70.
const rank = (n) => n.deg * 2 + Math.sqrt(n.stars);

function egoSet() {
  const id = S.sel?.kind === "repo" ? S.sel.id : null;
  if (id == null) return null;
  const s = new Set([id]);
  for (const nb of S.adj.get(id) || []) s.add(nb.id);
  return s;
}
function personRepos() {
  if (S.sel?.kind !== "person") return null;
  return new Set((S.linksByPerson.get(S.sel.login) || []).map((l) => l.repo_id));
}

function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  grid();
  if (S.mode === "network") drawNetwork();
  else if (S.mode === "matrix") drawMatrix();
  else if (S.mode === "scatter") drawScatter();
  else drawOrbit();
  readout();
}

function grid() {
  ctx.strokeStyle = LINEC; ctx.lineWidth = 1;
  const step = 40 * S.view.k;
  if (step > 6) {
    const ox = ((S.view.x * S.view.k + W / 2) % step + step) % step;
    const oy = ((S.view.y * S.view.k + H / 2) % step + step) % step;
    ctx.beginPath();
    for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }
}

function drawNetwork() {
  const ego = egoSet(), pr = personRepos();
  const focus = ego || pr;
  const maxS = Math.max(1, ...S.edges.map((e) => e.shared));
  const path = S.trace.path ? new Set(S.trace.path) : null;

  for (const e of S.edges) {
    const a = S.repoById.get(e.src), b = S.repoById.get(e.dst);
    if (!a || !b) continue;
    const p = T(a), q = T(b);
    if (Math.max(p.x, q.x) < 0 || Math.min(p.x, q.x) > W) continue;
    if (Math.max(p.y, q.y) < 0 || Math.min(p.y, q.y) > H) continue;
    const inFocus = !focus || (focus.has(e.src) && focus.has(e.dst));
    const t = e.shared / maxS;
    ctx.strokeStyle = inFocus ? `rgba(0,240,208,${.06 + t * .5})` : "rgba(30,70,84,.13)";
    ctx.lineWidth = Math.max(.4, t * 2.4) * Math.min(1.6, S.view.k);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }

  if (path) { // Trace-Pfad über alles legen
    ctx.strokeStyle = AM; ctx.lineWidth = 2.2; ctx.shadowColor = AM; ctx.shadowBlur = 14;
    ctx.beginPath();
    S.trace.path.forEach((id, i) => {
      const p = T(S.repoById.get(id));
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.stroke(); ctx.shadowBlur = 0;
  }

  const labels = [];
  for (const n of S.nodes) {
    const p = T(n), r = nodeR(n) * Math.min(1.9, Math.max(.55, S.view.k));
    if (p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30) continue;
    const on = !focus || focus.has(n.id);
    const inPath = path?.has(n.id);
    ctx.globalAlpha = on ? 1 : .16;
    ctx.fillStyle = nodeColor(n);
    if (inPath || n === S.hover) { ctx.shadowColor = inPath ? AM : "#fff"; ctx.shadowBlur = 12; }
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (S.sel?.kind === "repo" && S.sel.id === n.id) {
      ctx.strokeStyle = AM; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, 7); ctx.stroke();
      ring(p, r + 11);
    }
    ctx.globalAlpha = 1;
    if (S.showLabels && on) labels.push([n, p, r]);
  }
  ctx.font = F_NODE; ctx.textAlign = "center";
  // Wichtigste zuerst, Ueberlappungen verwerfen: ohne das ist der dichte Kern
  // eine Buchstabensuppe, in der kein einziger Name lesbar ist.
  labels.sort((a, b) => rank(b[0]) - rank(a[0]));
  const placed = [];
  for (const [n, p, r] of labels) {
    const force = n === S.hover || path?.has(n.id) ||
      (S.sel?.kind === "repo" && S.sel.id === n.id);
    if (placed.length > 70 && !force) break;
    const w = ctx.measureText(n.short).width + 6;
    const box = [p.x - w / 2, p.y + r + 2, w, 14];
    if (!force && placed.some((q) => box[0] < q[0] + q[2] && box[0] + box[2] > q[0]
      && box[1] < q[1] + q[3] && box[1] + box[3] > q[1])) continue;
    placed.push(box);
    ctx.fillStyle = BGC + "e6";
    ctx.fillRect(box[0], box[1], box[2], box[3]);
    ctx.fillStyle = force ? "#fff" : TXT;
    ctx.fillText(n.short, p.x, p.y + r + 12);
  }
  ctx.textAlign = "left";
}
function ring(p, r) {
  ctx.strokeStyle = "#ffb34066"; ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, i * Math.PI / 2 + .3, i * Math.PI / 2 + 1.2);
    ctx.stroke();
  }
}

/* --- MATRIX: Adjazenz der Top-Hubs, nach Cluster sortiert --- */
function drawMatrix() {
  const N = [...S.nodes].filter((n) => n.deg > 0)
    .sort((a, b) => (S.clusters.get(a.id) - S.clusters.get(b.id)) || b.deg - a.deg)
    .slice(0, 70);
  if (!N.length) return empty("KEINE KANTEN IM FILTER");
  const idx = new Map(N.map((n, i) => [n.id, i]));
  const pad = 160, size = Math.min(W - pad - 30, H - pad - 30);
  const cs = size / N.length, x0 = pad, y0 = 22;
  const m = new Map();
  for (const e of S.edges) {
    if (!idx.has(e.src) || !idx.has(e.dst)) continue;
    m.set(idx.get(e.src) + ":" + idx.get(e.dst), e.shared);
    m.set(idx.get(e.dst) + ":" + idx.get(e.src), e.shared);
  }
  const maxS = Math.max(1, ...m.values());
  ctx.font = F_MATRIX;
  for (let i = 0; i < N.length; i++) {
    for (let j = 0; j < N.length; j++) {
      const v = m.get(i + ":" + j);
      if (i === j) { ctx.fillStyle = "#25404c"; ctx.fillRect(x0 + j * cs, y0 + i * cs, cs - .5, cs - .5); continue; }
      if (!v) continue;
      ctx.fillStyle = ramp(v / maxS);
      ctx.globalAlpha = .25 + .75 * (v / maxS);
      ctx.fillRect(x0 + j * cs, y0 + i * cs, cs - .5, cs - .5);
      ctx.globalAlpha = 1;
    }
    const n = N[i];
    const hot = S.hover === n || (S.sel?.kind === "repo" && S.sel.id === n.id);
    ctx.fillStyle = hot ? AM : TXT;
    ctx.textAlign = "right";
    ctx.fillText(n.short.slice(0, 22), x0 - 6, y0 + i * cs + cs * .78);
  }
  ctx.textAlign = "left";
  ctx.fillStyle = DIM;
  ctx.fillText(`ADJAZENZ ${N.length}×${N.length} · TOP-HUBS NACH CLUSTER · HELL = VIELE GEMEINSAME CONTRIBUTORS`, x0, y0 + size + 14);
}

/* --- STREUUNG: Stars vs. Contributors, log/log --- */
function drawScatter() {
  const pad = { l: 58, r: 20, t: 20, b: 38 };
  const w = W - pad.l - pad.r, h = H - pad.t - pad.b;
  const mx = Math.log10(S.maxStars + 1), my = Math.log10(Math.max(2, ...S.nodes.map((n) => n.contribs + 1)));
  ctx.strokeStyle = LINEC; ctx.fillStyle = DIM;
  ctx.font = F_AXIS;
  for (let i = 0; i <= mx; i++) {
    const x = pad.l + (i / mx) * w;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + h); ctx.stroke();
    ctx.textAlign = "center"; ctx.fillText("10^" + i, x, H - 18);
  }
  for (let i = 0; i <= my; i++) {
    const y = pad.t + h - (i / my) * h;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + w, y); ctx.stroke();
    ctx.textAlign = "right"; ctx.fillText("10^" + i, pad.l - 5, y + 3);
  }
  ctx.textAlign = "center";
  ctx.fillText("STARS →", pad.l + w / 2, H - 5);
  ctx.save(); ctx.translate(14, pad.t + h / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("CONTRIBUTORS →", 0, 0); ctx.restore();
  const pr = personRepos();
  for (const n of S.nodes) {
    const x = pad.l + (Math.log10(n.stars + 1) / mx) * w;
    const y = pad.t + h - (Math.log10(n.contribs + 1) / my) * h;
    n._sx = x; n._sy = y;
    const on = !pr || pr.has(n.id);
    ctx.globalAlpha = on ? .85 : .1;
    ctx.fillStyle = nodeColor(n);
    ctx.beginPath(); ctx.arc(x, y, n === S.hover ? 5 : 2.4, 0, 7); ctx.fill();
    if (S.sel?.kind === "repo" && S.sel.id === n.id) {
      ctx.globalAlpha = 1; ctx.strokeStyle = AM; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
}

/* --- ORBIT: Ego-Netz in BFS-Ringen um die Selektion --- */
function drawOrbit() {
  const center = S.sel?.kind === "repo" ? S.sel.id
    : [...S.nodes].sort((a, b) => b.deg - a.deg)[0]?.id;
  if (center == null) return empty("KEINE DATEN");
  const hop = new Map([[center, 0]]);
  let front = [center];
  for (let d = 1; d <= 3 && front.length; d++) {
    const nx = [];
    for (const id of front) for (const nb of S.adj.get(id) || [])
      if (!hop.has(nb.id)) { hop.set(nb.id, d); nx.push(nb.id); }
    front = nx;
  }
  const rings = [[], [], [], []];
  for (const [id, d] of hop) if (S.repoById.get(id)) rings[d].push(id);
  const cx = W / 2, cy = H / 2, step = Math.min(W, H) / 8.4;
  ctx.strokeStyle = "#25404c";
  for (let d = 1; d <= 3; d++) {
    ctx.beginPath(); ctx.arc(cx, cy, d * step, 0, 7); ctx.stroke();
    ctx.fillStyle = DIM; ctx.font = F_MATRIX;
    ctx.fillText(d + " HOP", cx + d * step + 4, cy - 2);
  }
  const pos = new Map([[center, { x: cx, y: cy }]]);
  for (let d = 1; d <= 3; d++) {
    const ids = rings[d].sort((a, b) => (S.clusters.get(a) ?? 9) - (S.clusters.get(b) ?? 9));
    ids.forEach((id, i) => {
      const a = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      pos.set(id, { x: cx + Math.cos(a) * d * step, y: cy + Math.sin(a) * d * step });
    });
  }
  for (const e of S.edges) {
    const p = pos.get(e.src), q = pos.get(e.dst);
    if (!p || !q) continue;
    const near = hop.get(e.src) === 0 || hop.get(e.dst) === 0;
    ctx.strokeStyle = near ? "rgba(0,240,208,.5)" : "rgba(40,90,105,.22)";
    ctx.lineWidth = near ? 1.2 : .5;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  ctx.font = F_NODE; ctx.textAlign = "center";
  for (const [id, p] of pos) {
    const n = S.repoById.get(id); if (!n) continue;
    n._sx = p.x; n._sy = p.y;
    const d = hop.get(id), r = d === 0 ? 9 : Math.max(2.5, 6 - d);
    ctx.fillStyle = nodeColor(n);
    if (d === 0) { ctx.shadowColor = AM; ctx.shadowBlur = 18; }
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    if (d === 0 || rings[d].length < 34 || n === S.hover) {
      ctx.fillStyle = d === 0 ? "#fff" : TXT;
      ctx.fillText(n.short.slice(0, 18), p.x, p.y - r - 4);
    }
  }
  ctx.textAlign = "left";
  const c = S.repoById.get(center);
  ctx.fillStyle = DIM;
  ctx.fillText(`ORBIT · ZENTRUM ${c.full_name} · ${hop.size - 1} ERREICHBAR IN ≤3 HOPS`, 14, H - 10);
}

function empty(msg) {
  ctx.fillStyle = DIM; ctx.font = FONT(14);
  ctx.textAlign = "center"; ctx.fillText(msg, W / 2, H / 2); ctx.textAlign = "left";
}
function readout() {
  const parts = [
    `MODE <b>${S.mode.toUpperCase()}</b>`,
    `NODES <b>${fmt(S.nodes.length)}</b> / ${fmt(S.repos.length)}`,
    `LINKS <b>${fmt(S.edges.length)}</b>`,
    `ZOOM <b>${S.view.k.toFixed(2)}×</b>`,
  ];
  $("readout").innerHTML = parts.join("<br>");
}

/* ===================== LOOP ===================== */
let need = true;
const paint = () => { need = true; };
let wasMoving = null;
function loop() {
  const moving = S.mode === "network" ? tick() : false;
  if (moving || need) { draw(); need = false; }
  if (moving !== wasMoving) {
    wasMoving = moving;
    $("simstate").textContent = moving ? "SIM ACTIVE" : "LOCKED";
    $("simstate").classList.toggle("live", moving);
  }
  requestAnimationFrame(loop);
}

/* ===================== INTERAKTION ===================== */
function hitTest(sx, sy) {
  if (S.mode === "matrix") return null;
  if (S.mode === "scatter" || S.mode === "orbit") {
    let best = null, bd = 100;
    for (const n of S.nodes) {
      if (n._sx == null) continue;
      const d = (n._sx - sx) ** 2 + (n._sy - sy) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  const p = invT(sx, sy);
  let best = null, bd = Infinity;
  for (const n of S.nodes) {
    const r = nodeR(n) + 6 / S.view.k;
    const d = (n.x - p.x) ** 2 + (n.y - p.y) ** 2;
    if (d < r * r && d < bd) { bd = d; best = n; }
  }
  return best;
}

function wireCanvas() {
  let pan = null;
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (pan) {
      if (S.dragging) {
        const p = invT(sx, sy);
        S.dragging.x = p.x; S.dragging.y = p.y; S.alpha = Math.max(S.alpha, .3);
      } else if (S.mode === "network") {
        S.view.x += (sx - pan.x) / S.view.k; S.view.y += (sy - pan.y) / S.view.k;
        pan = { x: sx, y: sy };
      }
      paint(); return;
    }
    const h = hitTest(sx, sy);
    if (h !== S.hover) { S.hover = h; paint(); }
    const tip = $("tooltip");
    if (h) {
      const who = (S.linksByRepo.get(h.id) || []).length;
      const cl = S.clusters.get(h.id);
      tip.innerHTML = `<b>${h.full_name}</b><br>
        <s>LANG</s> ${h.lang || "—"} &nbsp; <s>LIC</s> ${h.license || "—"}<br>
        <s>★</s> ${fmt(h.stars)} &nbsp; <s>FORKS</s> ${fmt(h.forks)} &nbsp; <s>ISSUES</s> ${fmt(h.open_issues)}<br>
        <s>CONTRIB</s> ${who} &nbsp; <s>LINKS</s> ${h.deg} &nbsp; <s>CLUSTER</s> ${cl < 0 ? "—" : "C" + cl}<br>
        <s>PUSH</s> ${h.pushed_at?.slice(0, 10) || "—"}${h.archived ? " · ARCHIVIERT" : ""}${h.is_fork ? " · FORK" : ""}`;
      tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 310) + "px";
      tip.style.top = (e.clientY + 14) + "px";
      cv.style.cursor = "pointer";
    } else { tip.style.opacity = 0; cv.style.cursor = "crosshair"; }
  });
  cv.addEventListener("mousedown", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const h = hitTest(sx, sy);
    pan = { x: sx, y: sy };
    if (h && S.mode === "network") S.dragging = h;
  });
  window.addEventListener("mouseup", (e) => {
    if (pan && S.dragging === null) {
      const r = cv.getBoundingClientRect();
      const moved = Math.hypot(e.clientX - r.left - pan.x, e.clientY - r.top - pan.y);
      if (moved < 4) {
        const h = hitTest(e.clientX - r.left, e.clientY - r.top);
        select(h ? { kind: "repo", id: h.id } : null);
      }
    }
    pan = null; S.dragging = null;
  });
  cv.addEventListener("mouseleave", () => { $("tooltip").style.opacity = 0; });
  cv.addEventListener("wheel", (e) => {
    if (S.mode !== "network") return;
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const before = invT(e.clientX - r.left, e.clientY - r.top);
    S.view.k = clamp(S.view.k * (e.deltaY < 0 ? 1.12 : .89), .08, 9);
    const after = invT(e.clientX - r.left, e.clientY - r.top);
    S.view.x += after.x - before.x; S.view.y += after.y - before.y;
    paint();
  }, { passive: false });
}

function fit() {
  if (!S.nodes.length) return;
  const xs = S.nodes.map((n) => n.x), ys = S.nodes.map((n) => n.y);
  const w = Math.max(...xs) - Math.min(...xs) || 1, h = Math.max(...ys) - Math.min(...ys) || 1;
  S.view.k = clamp(Math.min(W / (w + 90), H / (h + 90)), .08, 3);
  S.view.x = -(Math.max(...xs) + Math.min(...xs)) / 2;
  S.view.y = -(Math.max(...ys) + Math.min(...ys)) / 2;
  paint();
}

/* ===================== SELEKTION + INSPEKTOR ===================== */
function select(sel) {
  S.sel = sel;
  paintInspector();
  paint();
}

function paintInspector() {
  const box = $("inspector");
  if (!S.sel) {
    box.className = "empty";
    box.innerHTML = `Kein Objekt selektiert.<br><br><span class="dim">Klick auf einen Knoten — oder ein Ziel aus den Ranglisten.</span>`;
    $("intelhead").textContent = "INSPEKTOR";
    paintLists(); return;
  }
  box.className = "";
  if (S.sel.kind === "repo") inspectRepo(S.repoById.get(S.sel.id));
  else inspectPerson(S.sel.login);
  paintLists();
}

function inspectRepo(r) {
  if (!r) return;
  $("intelhead").textContent = "INSPEKTOR // REPO";
  const cl = S.clusters.get(r.id);
  const contribs = (S.linksByRepo.get(r.id) || []).slice().sort((a, b) => b.n - a.n);
  const langs = (S.langsByRepo.get(r.id) || []).slice().sort((a, b) => b.bytes - a.bytes);
  const tot = langs.reduce((s, l) => s + l.bytes, 0) || 1;
  const nb = (S.adj.get(r.id) || []).slice().sort((a, b) => b.w - a.w).slice(0, 10);
  const rel = S.relByRepo.get(r.id) || [], dep = S.depByRepo.get(r.id) || [];
  const flags = [r.archived && "ARCHIVIERT", r.is_fork && "FORK", cl >= 0 && "CLUSTER C" + cl].filter(Boolean);

  $("inspector").innerHTML = `
    <div class="insp-title">${r.full_name}</div>
    <div class="insp-sub">${r.lang || "—"} · ${r.license || "KEINE LIZENZ"} · ${r.owner_type || "User"}${flags.length ? " · " + flags.join(" · ") : ""}</div>
    <div class="insp-grid">
      <div><u>STARS</u><b>${fmt(r.stars)}</b></div>
      <div><u>FORKS</u><b>${fmt(r.forks)}</b></div>
      <div><u>OPEN ISSUES</u><b>${fmt(r.open_issues)}</b></div>
      <div><u>GRÖSSE</u><b>${fmt(Math.round(r.size / 1024))} MB</b></div>
      <div><u>CONTRIBUTORS</u><b>${contribs.length}</b></div>
      <div><u>LINKS IM NETZ</u><b>${r.deg ?? 0}</b></div>
    </div>
    <div class="insp-actions">
      <button class="mini" data-act="a">SET A</button>
      <button class="mini" data-act="b">SET B</button>
      <button class="mini" data-act="orbit">ORBIT</button>
      <button class="mini" data-act="gh">GH ↗</button>
    </div>
    ${r.topics.length ? `<div class="fgroup"><h4>TOPICS</h4><div class="chips">${r.topics.map((t) => `<span class="chip">${t}</span>`).join("")}</div></div>` : ""}
    ${langs.length ? `<div class="fgroup"><h4>SPRACHMIX</h4>${langs.slice(0, 6).map((l) => `
      <div class="barline"><span>${l.language}</span><span>${(l.bytes / tot * 100).toFixed(1)}%</span>
      <div class="track"><div class="fill" style="width:${l.bytes / tot * 100}%;background:${langColor(l.language)}"></div></div></div>`).join("")}</div>` : ""}
    <div class="fgroup"><h4>TOP CONTRIBUTORS <i>${contribs.length}</i></h4><div class="list">
      ${contribs.slice(0, 12).map((c) => `<div class="row" data-person="${c.login}"><span>@${c.login}</span><b>${fmt(c.n)}</b></div>`).join("") || '<div class="hint">keine</div>'}
    </div></div>
    <div class="fgroup"><h4>VERBUNDEN MIT <i>gemeinsame Contributors</i></h4><div class="list">
      ${nb.map((x) => `<div class="row" data-repo="${x.id}"><span>${S.repoById.get(x.id)?.full_name || x.id}</span><b>${x.w}</b></div>`).join("") || '<div class="hint">isoliert im aktuellen Filter</div>'}
    </div></div>
    ${rel.length ? `<div class="fgroup"><h4>RELEASES <i>${rel.length}</i></h4><div class="list">
      ${rel.slice(0, 6).map((x) => `<div class="row"><span>${x.tag}</span><em>${x.published_at?.slice(0, 10) || ""}</em></div>`).join("")}</div></div>` : ""}
    ${dep.length ? `<div class="fgroup"><h4>DEPENDENCIES <i>${dep.length}</i></h4><div class="chips">
      ${dep.slice(0, 14).map((x) => `<span class="chip">${x.package}<u>${x.ecosystem}</u></span>`).join("")}</div></div>` : ""}
  `;
  $("inspector").querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
    const a = b.dataset.act;
    if (a === "gh") window.open("https://github.com/" + r.full_name, "_blank");
    else if (a === "orbit") setMode("orbit");
    else { S.trace[a] = r.id; paintTrace(); }
  });
  wireRows();
}

function inspectPerson(login) {
  $("intelhead").textContent = "INSPEKTOR // PERSON";
  const p = S.people.get(login) || { repos: 0, total: 0 };
  const ls = (S.linksByPerson.get(login) || []).slice().sort((a, b) => b.n - a.n);
  const visible = ls.filter((l) => S.nodes.some((n) => n.id === l.repo_id)).length;
  const langs = new Map();
  for (const l of ls) {
    const r = S.repoById.get(l.repo_id); if (!r?.lang) continue;
    langs.set(r.lang, (langs.get(r.lang) || 0) + 1);
  }
  const top = [...langs.entries()].sort((a, b) => b[1] - a[1]);
  $("inspector").innerHTML = `
    <div class="insp-title">@${login}</div>
    <div class="insp-sub">${p.type || "User"} · ${isBot(login) ? "BOT" : "MENSCH"} · CROSS-PROJECT-AKTEUR</div>
    <div class="insp-grid">
      <div><u>PROJEKTE</u><b>${p.repos}</b></div>
      <div><u>COMMITS</u><b>${fmt(p.total)}</b></div>
      <div><u>IM FILTER</u><b>${visible}</b></div>
      <div><u>SPRACHEN</u><b>${top.length}</b></div>
    </div>
    <div class="insp-actions">
      <button class="mini" data-act="gh">GH ↗</button>
      <button class="mini" data-act="q">ALS QUERY</button>
    </div>
    ${top.length ? `<div class="fgroup"><h4>SPRACHPROFIL</h4><div class="chips">
      ${top.map(([l, n]) => `<span class="chip" style="border-color:${langColor(l)}55;color:${langColor(l)}">${l}<u>${n}</u></span>`).join("")}</div></div>` : ""}
    <div class="fgroup"><h4>PROJEKTE <i>nach Commits</i></h4><div class="list">
      ${ls.slice(0, 40).map((l) => `<div class="row" data-repo="${l.repo_id}">
        <span>${S.repoById.get(l.repo_id)?.full_name || l.repo_id}</span><b>${fmt(l.n)}</b></div>`).join("")}
    </div></div>`;
  $("inspector").querySelectorAll("[data-act]").forEach((b) => b.onclick = () => {
    if (b.dataset.act === "gh") window.open("https://github.com/" + login, "_blank");
    else { $("q").value = login; F.q = login; rebuild(); }
  });
  wireRows();
}

function wireRows() {
  document.querySelectorAll("[data-repo]").forEach((el) => el.onclick = () => {
    select({ kind: "repo", id: +el.dataset.repo });
    const n = S.repoById.get(+el.dataset.repo);
    if (n && S.mode === "network") { S.view.x = -n.x; S.view.y = -n.y; S.view.k = Math.max(S.view.k, 1.2); paint(); }
  });
  document.querySelectorAll("[data-person]").forEach((el) => el.onclick = () =>
    select({ kind: "person", login: el.dataset.person }));
}

/* ===================== RANGLISTEN ===================== */
function paintLists() {
  const ppl = activePeople();
  const conn = [...ppl.entries()]
    .map(([login, ls]) => ({ login, repos: ls.length, total: ls.reduce((s, l) => s + l.n, 0) }))
    .filter((p) => p.repos > 1).sort((a, b) => b.repos - a.repos || b.total - a.total).slice(0, 24);
  $("topconn").innerHTML = conn.map((p) => `
    <div class="row ${S.sel?.login === p.login ? "on" : ""}" data-person="${p.login}">
      <span>@${p.login}</span><b>${p.repos}</b></div>`).join("") || '<div class="hint">keine</div>';

  const edges = [...S.edges].sort((a, b) => b.shared - a.shared).slice(0, 16);
  $("topedges").innerHTML = edges.map((e) => {
    const a = S.repoById.get(e.src), b = S.repoById.get(e.dst);
    // Owner statt short: bei Fork-Schwaermen heissen beide Seiten gleich
    // ("merb-core ⇄ merb-core") und die Zeile wird wertlos.
    return `<div class="row" data-repo="${e.src}" title="${a?.full_name} ⇄ ${b?.full_name}">
      <span>${a?.owner_login}/${a?.short} ⇄ ${b?.owner_login}</span><b>${e.shared}</b></div>`;
  }).join("") || '<div class="hint">keine Kanten</div>';

  const hubs = [...S.nodes].sort((a, b) => b.deg - a.deg).slice(0, 16);
  $("tophubs").innerHTML = hubs.map((n) => `
    <div class="row ${S.sel?.id === n.id ? "on" : ""}" data-repo="${n.id}">
      <span>${n.full_name}</span><b>${n.deg}</b></div>`).join("") || '<div class="hint">leer</div>';
  wireRows();
}

/* ===================== TRACE / PFAD ===================== */
function paintTrace() {
  const nm = (id) => id == null ? "— nicht gesetzt —" : (S.repoById.get(id)?.full_name || id);
  $("tr_a").textContent = nm(S.trace.a);
  $("tr_b").textContent = nm(S.trace.b);
}
function runTrace() {
  const { a, b } = S.trace;
  const out = $("tr_out");
  if (a == null || b == null) { out.textContent = "A und B setzen (Inspektor → SET A / SET B)."; return; }
  if (a === b) { out.textContent = "A und B sind identisch."; return; }
  const prev = new Map([[a, null]]);
  const q = [a];
  while (q.length) {
    const cur = q.shift();
    if (cur === b) break;
    for (const nb of S.adj.get(cur) || [])
      if (!prev.has(nb.id)) { prev.set(nb.id, cur); q.push(nb.id); }
  }
  if (!prev.has(b)) {
    S.trace.path = null; out.innerHTML = `<span style="color:var(--red)">KEIN PFAD im aktuellen Filter.</span>`;
    paint(); return;
  }
  const path = []; for (let c = b; c != null; c = prev.get(c)) path.push(c);
  path.reverse(); S.trace.path = path;
  const hops = path.length - 1;
  const via = [];
  for (let i = 0; i < path.length - 1; i++) {
    const e = S.edges.find((x) => (x.src === path[i] && x.dst === path[i + 1]) || (x.dst === path[i] && x.src === path[i + 1]));
    if (e) via.push(e.who[0]);
  }
  out.innerHTML = `<span style="color:var(--amber)">${hops} HOP${hops > 1 ? "S" : ""}</span> · ${path.map((id) => S.repoById.get(id).short).join(" → ")}<br>
    <span class="dim">über @${[...new Set(via)].join(", @")}</span>`;
  setMode("network"); paint();
}

/* ===================== DASHBOARD ===================== */
function paintAll() { paintDash(); refreshClusterSelect(); paintInspector(); paintLegend(); paint(); }

function paintDash() {
  const N = S.nodes;
  const stars = N.reduce((s, r) => s + r.stars, 0);
  const ppl = activePeople();
  const cross = [...ppl.values()].filter((l) => l.length > 1).length;
  const u = S.raw.universe;
  $("tiles").innerHTML = `
    <div class="tile key"><u>REPOS / FILTER</u><b>${fmt(N.length)}</b></div>
    <div class="tile"><u>STARS ∑</u><b>${fmt(stars)}</b></div>
    <div class="tile hot"><u>LINKS</u><b>${fmt(S.edges.length)}</b></div>
    <div class="tile"><u>CONTRIBUTORS</u><b>${fmt(ppl.size)}</b></div>
    <div class="tile hot"><u>CROSS-PROJ.</u><b>${fmt(cross)}</b></div>
    <div class="tile"><u>UNIVERSUM</u><b>${(u.repos / 1e6).toFixed(2)}M</b></div>`;

  const deg = N.map((n) => n.deg);
  const avg = deg.length ? deg.reduce((a, b) => a + b, 0) / deg.length : 0;
  const poss = N.length * (N.length - 1) / 2;
  const comps = components();
  const iso = N.filter((n) => !n.deg).length;
  const sizes = S.clusterSizes || [];
  $("netstats").innerHTML = `
    <div class="nsrow"><span>KNOTEN·KANTEN</span><b>${fmt(N.length)} / ${fmt(S.edges.length)}</b></div>
    <div class="nsrow"><span>DICHTE</span><b>${poss ? (S.edges.length / poss * 100).toFixed(2) : "0.00"} %</b></div>
    <div class="nsrow alt"><span>Ø GRAD</span><b>${avg.toFixed(2)}</b></div>
    <div class="nsrow"><span>MAX GRAD</span><b>${Math.max(0, ...deg)}</b></div>
    <div class="nsrow"><span>KOMPONENTEN</span><b>${comps.count}</b></div>
    <div class="nsrow alt"><span>MAX KOMPONENTE</span><b>${comps.max} (${N.length ? (comps.max / N.length * 100).toFixed(0) : 0}%)</b></div>
    <div class="nsrow"><span>ISOLIERTE</span><b>${iso}</b></div>
    <div class="nsrow alt"><span>CLUSTER ≥2</span><b>${sizes.length} · max ${sizes[0] || 0}</b></div>`;

  // Sprachen: Code-Bytes über die gefilterten Repos
  const lb = new Map();
  for (const n of N) for (const l of S.langsByRepo.get(n.id) || [])
    lb.set(l.language, (lb.get(l.language) || 0) + (l.bytes || 0));
  const top = [...lb.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const tot = top.reduce((s, [, b]) => s + b, 0) || 1;
  $("langbars").innerHTML = top.map(([l, b]) => `
    <div class="barline"><span style="color:${langColor(l)}">${l}</span>
      <span>${(b / tot * 100).toFixed(1)}%</span>
      <div class="track"><div class="fill" style="width:${b / tot * 100}%;background:${langColor(l)}"></div></div>
    </div>`).join("") || '<div class="hint">keine Sprachdaten</div>';

  histogram();
  distribution();
}

function components() {
  const seen = new Set(); let count = 0, max = 0;
  for (const n of S.nodes) {
    if (seen.has(n.id)) continue;
    count++; let size = 0; const q = [n.id]; seen.add(n.id);
    while (q.length) {
      const c = q.pop(); size++;
      for (const nb of S.adj.get(c) || []) if (!seen.has(nb.id)) { seen.add(nb.id); q.push(nb.id); }
    }
    max = Math.max(max, size);
  }
  return { count, max };
}

function miniCanvas(el) {
  const r = el.getBoundingClientRect();
  const d = Math.min(2, devicePixelRatio || 1);
  el.width = r.width * d; el.height = r.height * d;
  const c = el.getContext("2d");
  c.setTransform(d, 0, 0, d, 0, 0);
  c.clearRect(0, 0, r.width, r.height);
  return [c, r.width, r.height];
}

function histogram() {
  const el = $("hist"); if (!el.getBoundingClientRect().width) return;
  const [c, w, h] = miniCanvas(el);
  const bins = new Map(S.years.map((y) => [y, 0]));
  for (const n of S.nodes) if (n.pyear != null) bins.set(n.pyear, (bins.get(n.pyear) || 0) + 1);
  const ys = [...bins.keys()].sort();
  const max = Math.max(1, ...bins.values());
  const bw = w / ys.length;
  c.font = F_MINI;
  ys.forEach((y, i) => {
    const v = bins.get(y), bh = (v / max) * (h - 16);
    const sel = y >= F.pushFrom && y <= F.pushTo;
    c.fillStyle = sel ? ramp(1 - (y - ys[0]) / Math.max(1, ys.at(-1) - ys[0])) : "#1b3d4a";
    c.fillRect(i * bw + 1, h - 12 - bh, bw - 2, bh);
    if (v && bh > 12) { c.fillStyle = BGC; c.fillText(v, i * bw + 2, h - 15); }
    if (i % 3 === 0 || i === ys.length - 1) {
      c.fillStyle = DIM; c.fillText(String(y).slice(2), i * bw + 1, h - 2);
    }
  });
  c.fillStyle = DIM;
  c.fillText(`${fmt(S.nodes.filter((n) => n.pyear <= 2010).length)} dormant ≤2010`, 2, 9);
}

function distribution() {
  const el = $("dist"); if (!el.getBoundingClientRect().width) return;
  const [c, w, h] = miniCanvas(el);
  const B = 12, bins = new Array(B).fill(0);
  const mx = Math.log10(S.maxStars + 1);
  for (const n of S.nodes) bins[Math.min(B - 1, ((Math.log10(n.stars + 1) / mx) * B) | 0)]++;
  const max = Math.max(1, ...bins);
  const bw = w / B;
  c.font = F_MINI;
  bins.forEach((v, i) => {
    const bh = (v / max) * (h - 16);
    c.fillStyle = ramp(i / B);
    c.fillRect(i * bw + 1, h - 12 - bh, bw - 2, bh);
    if (v) { c.fillStyle = TXT; c.textAlign = "center"; c.fillText(v, i * bw + bw / 2, h - 15 - bh); }
  });
  c.textAlign = "left"; c.fillStyle = DIM;
  c.fillText("0", 1, h - 2);
  c.textAlign = "right"; c.fillText(fmt(S.maxStars) + "★", w - 1, h - 2); c.textAlign = "left";
}

function paintLegend() {
  const L = $("legend");
  if (S.colorBy === "lang") {
    const c = new Map();
    for (const n of S.nodes) if (n.lang) c.set(n.lang, (c.get(n.lang) || 0) + 1);
    L.innerHTML = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([l, n]) => `<span><i style="background:${langColor(l)}"></i>${l} ${n}</span>`).join("");
  } else if (S.colorBy === "cluster") {
    L.innerHTML = (S.clusterSizes || []).slice(0, 12)
      .map((n, i) => `<span><i style="background:${CLUSTER_COLORS[i % CLUSTER_COLORS.length]}"></i>C${i} · ${n}</span>`).join("");
  } else if (S.colorBy === "type") {
    L.innerHTML = `<span><i style="background:${CY}"></i>User</span>
      <span><i style="background:${AM}"></i>Organization</span><span><i style="background:${MG}"></i>Bot</span>`;
  } else {
    const lbl = { stars: ["0 ★", fmt(S.maxStars) + " ★"], age: ["aktiv", "dormant"], degree: ["peripher", "Hub"] }[S.colorBy];
    L.innerHTML = `<span>${lbl[0]}</span>` +
      [0, .2, .4, .6, .8, 1].map((t) => `<span><i style="background:${ramp(t)}"></i></span>`).join("") +
      `<span>${lbl[1]}</span>`;
  }
}

/* ===================== FILTER-UI ===================== */
function setMode(m) {
  S.mode = m;
  document.querySelectorAll(".mode[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  paint();
}

function buildUI() {
  // Sprach-Chips
  const lc = new Map();
  for (const r of S.repos) lc.set(r.lang || "—", (lc.get(r.lang || "—") || 0) + 1);
  const langs = [...lc.entries()].sort((a, b) => b[1] - a[1]);
  $("c_lang").textContent = langs.length + " total";
  $("f_langs").innerHTML = langs.map(([l, n]) =>
    `<span class="chip" data-lang="${l}" style="--c:${langColor(l)}"><i style="color:${langColor(l)}">■</i>${l}<u>${n}</u></span>`).join("");
  $("f_langs").querySelectorAll("[data-lang]").forEach((el) => el.onclick = () => {
    const l = el.dataset.lang;
    F.langs.has(l) ? F.langs.delete(l) : F.langs.add(l);
    el.classList.toggle("on", F.langs.has(l));
    el.style.background = F.langs.has(l) ? langColor(l) : "";
    rebuild();
  });

  // Owner-Typ Segmente
  const types = ["User", "Organization", "Bot"];
  $("f_ownertype").innerHTML = types.map((t) =>
    `<button data-type="${t}" class="${F.types.has(t) ? "on" : ""}">${t.slice(0, 3).toUpperCase()}</button>`).join("");
  $("f_ownertype").querySelectorAll("[data-type]").forEach((b) => b.onclick = () => {
    const t = b.dataset.type;
    F.types.has(t) ? F.types.delete(t) : F.types.add(t);
    b.classList.toggle("on", F.types.has(t));
    rebuild();
  });

  // Selects
  const fill = (id, items, label) => {
    $(id).innerHTML = `<option value="">${label}</option>` +
      items.map(([v, n]) => `<option value="${v}">${v} (${n})</option>`).join("");
  };
  const cnt = (key) => {
    const m = new Map();
    for (const r of S.repos) { const v = r[key]; if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  fill("f_license", cnt("license"), "— alle —");
  const tp = new Map();
  for (const r of S.repos) for (const t of r.topics) tp.set(t, (tp.get(t) || 0) + 1);
  fill("f_topic", [...tp.entries()].sort((a, b) => b[1] - a[1]), "— alle —");
  $("f_license").onchange = (e) => { F.license = e.target.value; rebuild(); };
  $("f_topic").onchange = (e) => { F.topic = e.target.value; rebuild(); };
  $("f_cluster").onchange = (e) => { F.cluster = e.target.value; rebuild(); };

  // Ranges: Max aus den Daten. Stars/Forks/Issues/Size laufen über eine
  // Log-Skala (0..100 %), sonst liegt bei max=66k alles Interessante links.
  $("f_stars").max = 100; $("f_forks").max = 100; $("f_issues").max = 100; $("f_size").max = 100;
  $("f_contrib").max = Math.max(...S.repos.map((r) => r.contribs));
  $("f_weight").max = 100;
  $("f_degree").max = Math.max(2, ...[...S.linksByPerson.values()].map((l) => l.length));
  $("f_shared").max = 12;
  $("f_push").min = $("f_pushmax").min = S.years[0];
  $("f_push").max = $("f_pushmax").max = S.years.at(-1);
  $("f_push").value = S.years[0]; $("f_pushmax").value = S.years.at(-1);

  // Log-Skala für die großen Metriken: 0..100 → 0..max
  const logv = (pct, max) => pct === 0 ? 0 : Math.round((Math.pow(10, (pct / 100) * Math.log10(max + 1)) - 1));
  const bind = (id, vid, key, tf = (v) => +v) => {
    const inp = $(id);
    inp.oninput = () => { F[key] = tf(inp.value); $(vid).textContent = fmt(F[key]); rebuild(); };
  };
  bind("f_shared", "v_shared", "shared");
  bind("f_weight", "v_weight", "weight");
  bind("f_degree", "v_degree", "degree");
  bind("f_contrib", "v_contrib", "contrib");
  $("f_stars").oninput = () => { F.stars = logv(+$("f_stars").value, S.maxStars); $("v_stars").textContent = fmt(F.stars); rebuild(); };
  $("f_forks").oninput = () => { F.forks = logv(+$("f_forks").value, S.maxForks); $("v_forks").textContent = fmt(F.forks); rebuild(); };
  $("f_issues").oninput = () => { F.issues = logv(+$("f_issues").value, S.maxIssues); $("v_issues").textContent = fmt(F.issues); rebuild(); };
  $("f_size").oninput = () => { F.size = logv(+$("f_size").value, S.maxSize); $("v_size").textContent = fmt(F.size); rebuild(); };
  $("f_push").oninput = () => {
    F.pushFrom = +$("f_push").value;
    if (F.pushFrom > F.pushTo) { F.pushTo = F.pushFrom; $("f_pushmax").value = F.pushTo; $("v_pushmax").textContent = F.pushTo; }
    $("v_push").textContent = F.pushFrom; rebuild();
  };
  $("f_pushmax").oninput = () => {
    F.pushTo = +$("f_pushmax").value;
    if (F.pushTo < F.pushFrom) { F.pushFrom = F.pushTo; $("f_push").value = F.pushFrom; $("v_push").textContent = F.pushFrom; }
    $("v_pushmax").textContent = F.pushTo; rebuild();
  };
  $("v_push").textContent = F.pushFrom; $("v_pushmax").textContent = F.pushTo;

  const chk = (id, key) => $(id).onchange = () => { F[key] = $(id).checked; rebuild(); };
  chk("f_isolates", "isolates"); chk("f_nobots", "nobots"); chk("f_noarch", "noarch");
  chk("f_nofork", "nofork"); chk("f_rel", "rel"); chk("f_dep", "dep");

  // Abdeckung an die Toggles schreiben. Releases/Deps hat der Crawler bisher nur
  // fuer eine Handvoll Repos geholt — ohne die Zahl sieht ein leeres Ergebnis
  // wie ein kaputter Filter aus statt wie fehlende Daten.
  const cover = [
    ["f_rel", S.relByRepo.size], ["f_dep", S.depByRepo.size],
    ["f_noarch", S.repos.filter((r) => r.archived).length],
    ["f_nofork", S.repos.filter((r) => r.is_fork).length],
    ["f_isolates", 0],
  ];
  for (const [id, n] of cover) {
    if (id === "f_isolates") continue;
    const lab = $(id).parentElement;
    lab.insertAdjacentHTML("beforeend", ` <i class="cnt">${n}</i>`);
    if (!n) { lab.style.opacity = .45; $(id).disabled = true; lab.title = "keine Daten gecrawlt"; }
  }

  let qt;
  $("q").oninput = () => { clearTimeout(qt); qt = setTimeout(() => { F.q = $("q").value.trim(); rebuild(); }, 160); };

  document.querySelectorAll(".mode[data-mode]").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  $("colorby").onchange = (e) => { S.colorBy = e.target.value; paintLegend(); paint(); };
  $("labels").onclick = () => { S.showLabels = !S.showLabels; $("labels").classList.toggle("on", S.showLabels); paint(); };
  $("refit").onclick = fit;
  $("tr_run").onclick = runTrace;
  $("reset").onclick = () => location.reload();

  const u = S.raw.universe;
  $("hudmetrics").innerHTML = `
    <div><span>UNIVERSE</span> <b>${fmt(u.repos)}</b> repos</div>
    <div><span>OWNERS</span> <b>${fmt(u.owners)}</b></div>
    <div><span>ENRICHED</span> <b>${fmt(u.detailed)}</b></div>
    <div><span>HTTP CACHE</span> <b>${fmt(u.cached)}</b></div>
    <div><span>EDGES</span> <b>${fmt(S.raw.links.length)}</b></div>`;

  setInterval(() => {
    $("clock").textContent = new Date().toISOString().slice(11, 19) + "Z";
  }, 1000);
}

function refreshClusterSelect() {
  const cur = F.cluster;
  const n = (S.clusterSizes || []).length;
  $("f_cluster").innerHTML = `<option value="">— alle —</option>` +
    Array.from({ length: Math.min(n, 14) }, (_, i) =>
      `<option value="${i}"${cur === String(i) ? " selected" : ""}>C${i} · ${S.clusterSizes[i]} Repos</option>`).join("");
}

/* ===================== START ===================== */
/* Layout einmal vorrechnen, solange der Boot-Screen noch steht: sonst sieht der
 * Nutzer die Spirale sekundenlang auseinanderfallen. Zeitbudget statt fester
 * Tick-Zahl — langsame Maschinen brechen frueher ab statt zu haengen.
 * Bei Filter-Rebuilds nicht noetig: Positionen bleiben, rAF fedeert nach. */
function prewarm(budgetMs = 900) {
  const t0 = performance.now();
  while (S.alpha > .05 && performance.now() - t0 < budgetMs) if (!tick()) break;
}

function start() {
  buildUI();
  resize();
  wireCanvas();
  rebuild();
  prewarm();
  fit();
  window.addEventListener("resize", () => { resize(); paint(); paintDash(); });
  loop();
}

boot();
