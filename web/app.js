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

// Obergrenze gezeichneter Kanten je Frame (die schwaechsten fallen zuerst weg).
const EDGE_BUDGET = 15000;
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
  S.geoByLogin = new Map();
  S.isoByCountry = new Map();       // Land -> ISO2, Bruecke zu den Globus-Polygonen
  for (const g of d.geo || []) {
    S.geoByLogin.set(g.login, g);
    if (g.iso) S.isoByCountry.set(g.country, g.iso);
  }

  S.years = [...new Set(S.repos.map((r) => r.pyear).filter(Boolean))].sort();
  F.pushFrom = S.years[0]; F.pushTo = S.years[S.years.length - 1];
}
// Geo eines Repos = Standort seines Owners (Herkunft des Repos).
const repoGeo = (r) => S.geoByLogin.get(r.owner_login);
const personGeo = (login) => S.geoByLogin.get(login);

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
  S.maxShared = Math.max(1, ...S.edges.map((e) => e.shared));
  // Knotenreferenzen einmal aufloesen (spart 2 Map-Lookups je Kante und Frame)
  // und nach Gewicht sortiert auf ein Zeichenbudget kuerzen.
  for (const e of S.edges) { e.a = S.repoById.get(e.src); e.b = S.repoById.get(e.dst); }
  S.drawEdges = S.edges.length > EDGE_BUDGET
    ? [...S.edges].sort((x, y) => y.shared - x.shared).slice(0, EDGE_BUDGET)
    : S.edges;

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
/* --- Barnes-Hut: Quadtree + genaeherte Fernkraft ---
 * THETA2 = (Zellbreite/Abstand)²-Schwelle. Ist eine Zelle weit genug weg, zaehlt
 * sie als ein Koerper mit ihrer Masse statt als n einzelne Knoten. */
const THETA2 = 0.64;          // theta = 0.8
const REACH2 = 360000;        // Reichweite der Abstossung (600px), wie bisher

function buildQuad(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
  }
  const w = Math.max(maxX - minX, maxY - minY) || 1;
  const root = { x: minX, y: minY, w, n: 0, sx: 0, sy: 0, kids: null, node: null };
  for (const p of nodes) quadInsert(root, p, 0);
  return root;
}
function quadInsert(cell, p, depth) {
  cell.n++; cell.sx += p.x; cell.sy += p.y;
  if (cell.n === 1) { cell.node = p; return; }
  if (depth > 20) return;              // deckungsgleiche Punkte nicht endlos teilen
  if (!cell.kids) {
    cell.kids = [];
    const old = cell.node; cell.node = null;
    if (old) quadPush(cell, old, depth);
  }
  quadPush(cell, p, depth);
}
function quadPush(cell, p, depth) {
  const half = cell.w / 2;
  const i = (p.x >= cell.x + half ? 1 : 0) + (p.y >= cell.y + half ? 2 : 0);
  let k = cell.kids[i];
  if (!k) k = cell.kids[i] = { x: cell.x + (i & 1 ? half : 0),
    y: cell.y + (i & 2 ? half : 0), w: half, n: 0, sx: 0, sy: 0, kids: null, node: null };
  quadInsert(k, p, depth + 1);
}
function bhRepel(p, dx, dy, d2, mass, alpha) {
  if (d2 > REACH2) return;
  if (d2 < .01) { p.x += Math.random() - .5; p.y += Math.random() - .5; return; }
  // Deckel auf 1/d²: sonst wird die Kraft bei fast deckungsgleichen Knoten
  // unendlich und schiesst sie aus dem Bild.
  const d = Math.sqrt(d2), f = Math.min(2.5 * mass, 2400 * mass / d2) * alpha;
  p.vx += (dx / d) * f; p.vy += (dy / d) * f;
}
function bhForce(cell, p, alpha) {
  if (!cell || !cell.n) return;
  // Ganzer Ast ausserhalb der Reichweite? Kasten-Abstand pruefen und abschneiden.
  const ox = Math.max(cell.x - p.x, 0, p.x - (cell.x + cell.w));
  const oy = Math.max(cell.y - p.y, 0, p.y - (cell.y + cell.w));
  if (ox * ox + oy * oy > REACH2) return;
  if (cell.node) {                                   // Blatt mit einem Knoten
    if (cell.node === p) return;
    const dx = p.x - cell.node.x, dy = p.y - cell.node.y;
    bhRepel(p, dx, dy, dx * dx + dy * dy, 1, alpha);
    return;
  }
  const cx = cell.sx / cell.n, cy = cell.sy / cell.n;
  const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
  if (cell.w * cell.w < d2 * THETA2) {               // weit genug -> ein Koerper
    bhRepel(p, dx, dy, d2, cell.n, alpha);
    return;
  }
  if (cell.kids) for (const k of cell.kids) bhForce(k, p, alpha);
}

function tick() {
  if (S.alpha < .004) return false;
  const N = S.nodes;
  if (!N.length) return false;
  // Abstossung ueber einen Quadtree (Barnes-Hut): entfernte Knotenwolken wirken
  // als EIN Koerper in ihrem Schwerpunkt. Ein Nachbarschaftsgitter half hier
  // nicht — der Graph pendelt sich auf ~2.000 px ein, das sind bei 600-px-Zellen
  // nur 4x4 Felder, also faktisch wieder alle Paare. Mit dem Baum faellt der Tick
  // von ~140 ms auf wenige Millisekunden.
  const root = buildQuad(N);
  for (const a of N) bhForce(root, a, S.alpha);
  // Vorberechnet in rebuild(): ein Spread ueber 110k Kanten je Tick waere teuer
  // und sprengt jenseits ~65k Argumenten den Aufrufstapel.
  const maxS = S.maxShared || 1;
  for (const e of S.edges) {
    const a = e.a, b = e.b;
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
  const maxS = S.maxShared || 1;
  const path = S.trace.path ? new Set(S.trace.path) : null;

  // Zeichenbudget: bei 110k Kanten kostet allein das Malen ~100 ms je Frame.
  // Die schwaechsten Kanten liegen bei alpha .06 ohnehin an der Sichtgrenze —
  // sie wegzulassen kostet praktisch kein Bild, bringt aber den Faktor 7.
  for (const e of S.drawEdges) {
    const a = e.a, b = e.b;
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
  // Im Bildschirmraum treffen, nicht im Weltraum: gezeichnet wird mit
  // nodeR()*zoomfaktor, ein Welt-Radius driftet dadurch bei jedem Zoom von der
  // sichtbaren Scheibe weg (weit rein = zu klein, weit raus = zu gross).
  // Mindestens 10 px Fangradius, damit auch 2-px-Knoten klickbar bleiben.
  let best = null, bd = Infinity;
  for (const n of S.nodes) {
    const p = T(n);
    const r = Math.max(nodeR(n) * Math.min(1.9, Math.max(.55, S.view.k)) + 5, 10);
    const d = (p.x - sx) ** 2 + (p.y - sy) ** 2;
    if (d < r * r && d < bd) { bd = d; best = n; }
  }
  return best;
}

function wireCanvas() {
  let pan = null, press = null;
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    // Erst ab 4 px gilt es als Ziehen — Handzittern soll die Auswahl nicht fressen.
    if (press && !press.moved &&
        Math.hypot(sx - press.x, sy - press.y) >= 4) press.moved = true;
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
  // Der beim Druecken getroffene Knoten wird gemerkt und beim Loslassen selektiert.
  // Vorher: mousedown setzte S.dragging, und mouseup verlangte dragging===null —
  // ein Klick GENAU auf einen Knoten hat deshalb nie selektiert. Ausserdem lief
  // der Hit-Test beim Loslassen erneut, obwohl die Simulation den Knoten
  // zwischenzeitlich wegbewegt hatte. Beides faellt mit `press` weg.
  cv.addEventListener("mousedown", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const h = hitTest(sx, sy);
    pan = { x: sx, y: sy };
    press = { x: sx, y: sy, node: h, moved: false };
    if (h && S.mode === "network") S.dragging = h;
  });
  window.addEventListener("mouseup", () => {
    if (press && !press.moved) {
      select(press.node ? { kind: "repo", id: press.node.id } : null);
    }
    press = null; pan = null; S.dragging = null;
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
  paintSteckbrief();
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
function paintAll() {
  paintDash(); refreshClusterSelect(); paintInspector(); paintLegend(); paint();
  refreshPatterns(); paintSteckbrief(); paintWorld();
}

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

/* ===================== SEKTIONS-NAV ===================== */
function goto(id) {
  const el = $(id); if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
function wireSectionNav() {
  document.querySelectorAll(".navbtn[data-goto]").forEach((b) =>
    b.onclick = () => goto(b.dataset.goto));
  const secs = ["terminal", "patterns", "world"].map($);
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) if (e.isIntersecting) {
      document.querySelectorAll(".navbtn").forEach((b) =>
        b.classList.toggle("on", b.dataset.goto === e.target.id));
    }
  }, { rootMargin: "-45% 0px -45% 0px" });
  secs.forEach((s) => s && io.observe(s));
}

// Aus Muster/Welt zurueck in den Graphen springen.
function focusRepo(id) {
  const n = S.repoById.get(id); if (!n) return;
  select({ kind: "repo", id });
  if (S.mode !== "network") setMode("network");
  if (n.x != null) { S.view.x = -n.x; S.view.y = -n.y; S.view.k = Math.max(S.view.k, 1.3); }
  goto("terminal"); paint();
}
function focusPerson(login) { select({ kind: "person", login }); goto("terminal"); }

/* ===================== RELATION PATTERNS ===================== */
/* Jedes Muster ist eine reine Funktion ueber den aktuell gefilterten Berg
 * (S.nodes + aktive Personen). Rueckgabe: Schlussfolgerung + Kennzahl + Belege.
 * Kein Backend — die Vorlage rechnet auf den schon geladenen Daten. */
function pile() {
  const repos = S.nodes;
  const ids = new Set(repos.map((r) => r.id));
  const ppl = new Map();               // login -> [{repo_id,n}] beschraenkt auf Pile
  for (const [login, ls] of activePeople()) {
    const in_ = ls.filter((l) => ids.has(l.repo_id));
    if (in_.length) ppl.set(login, in_);
  }
  return { repos, ids, ppl };
}
const short = (id) => S.repoById.get(id)?.short || id;

const PATTERNS = [
  {
    id: "busfactor", name: "Klumpenrisiko (Bus-Faktor 1)", tag: "FRAGILITÄT",
    desc: "Repos, deren Top-Contributor ≥70 % aller erfassten Commits hält — ein Weggang legt das Projekt lahm.",
    run(p) {
      const hits = [];
      for (const r of p.repos) {
        const ls = S.linksByRepo.get(r.id) || [];
        if (ls.length < 2) continue;
        const s = [...ls].sort((a, b) => b.n - a.n);
        const total = s.reduce((x, l) => x + l.n, 0) || 1;
        const share = s[0].n / total;
        if (share >= 0.7) hits.push({ r, top: s[0], share, total, k: ls.length });
      }
      hits.sort((a, b) => b.share - a.share);
      return {
        verdict: hits.length ? `${hits.length} Repos hängen an einer einzigen Person`
          : "Kein Klumpenrisiko im aktuellen Filter",
        stat: hits.length ? "Bus-Faktor 1 · Top-Contributor ≥ 70 % der erfassten Commits" : "",
        note: "Schlüsselpersonen / Single Point of Failure: ginge diese eine Person, verwaiste das Projekt praktisch.",
        findings: hits.slice(0, 40).map((h) => ({
          title: h.r.full_name, badge: `${Math.round(h.share * 100)} %`,
          sub: `<b>@${h.top.login}</b> · ${fmt(h.top.n)}/${fmt(h.total)} Commits · ${h.k} Mitwirkende`,
          act: () => focusRepo(h.r.id),
        })),
      };
    },
  },
  {
    id: "cartel", name: "Ko-Maintainer-Kartell", tag: "KOORDINATION",
    desc: "Personen-Paare, die an ≥3 gemeinsamen Repos zusammen auftauchen — geteilte Kontrolle oder verknüpfte Identitäten.",
    run(p) {
      const pm = new Map();
      for (const r of p.repos) {
        const u = [...new Set((S.linksByRepo.get(r.id) || []).map((l) => l.login)
          .filter((l) => !isBot(l)))].sort();
        if (u.length < 2 || u.length > 60) continue;  // ponytail: O(k²), Fork-Schwaerme deckeln
        for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
          const k = u[i] + "|" + u[j];
          let e = pm.get(k); if (!e) pm.set(k, e = { a: u[i], b: u[j], repos: [] });
          e.repos.push(r.id);
        }
      }
      const hits = [...pm.values()].filter((e) => e.repos.length >= 3)
        .sort((a, b) => b.repos.length - a.repos.length);
      return {
        verdict: hits.length ? `${hits.length} fest gekoppelte Personen-Paare`
          : "Keine wiederkehrenden Ko-Maintainer-Paare",
        stat: hits.length ? "Dieselben zwei Konten an ≥3 gemeinsamen Repos" : "",
        note: "Wiederkehrende Paare deuten auf ein koordiniertes Team, geteilte Kontrolle oder Sockenpuppen hin.",
        findings: hits.slice(0, 40).map((h) => ({
          title: `@${h.a} ⋈ @${h.b}`, badge: `${h.repos.length} Repos`,
          sub: h.repos.slice(0, 7).map(short).join(", ") + (h.repos.length > 7 ? " …" : ""),
          act: () => focusPerson(h.a),
        })),
      };
    },
  },
  {
    id: "broker", name: "Brücken-Akteure (Broker)", tag: "ZENTRALITÄT",
    desc: "Personen, deren Repos ≥2 verschiedene Cluster überspannen — sie verbinden sonst getrennte Communities.",
    run(p) {
      const hits = [];
      for (const [login, ls] of p.ppl) {
        const cs = new Set(); let repos = 0;
        for (const l of ls) { const c = S.clusters.get(l.repo_id); if (c >= 0) cs.add(c); repos++; }
        if (cs.size >= 2) hits.push({ login, cs: cs.size, repos });
      }
      hits.sort((a, b) => b.cs - a.cs || b.repos - a.repos);
      return {
        verdict: hits.length ? `${hits.length} Broker verbinden getrennte Cluster`
          : "Keine Cluster-übergreifenden Akteure",
        stat: hits.length ? "Färbung auf ‚Cluster‘ stellen, um die Brücken zu sehen" : "",
        note: "Broker sind Informationsschleusen und Schlüsselkontakte — und mögliche Sockenpuppen zwischen Lagern.",
        findings: hits.slice(0, 40).map((h) => ({
          title: `@${h.login}`, badge: `${h.cs} Cluster`,
          sub: `${h.repos} Repos im Filter überspannt`,
          act: () => focusPerson(h.login),
        })),
      };
    },
  },
  {
    id: "forker", name: "Serien-Forker", tag: "HOARDING",
    desc: "Owner mit ≥3 Fork-Repos im Filter — Mirroring, Hoarding oder aufgeblähte Präsenz statt eigener Arbeit.",
    run(p) {
      const m = new Map();
      for (const r of p.repos) if (r.is_fork) {
        if (!m.has(r.owner_login)) m.set(r.owner_login, []); m.get(r.owner_login).push(r);
      }
      const hits = [...m.entries()].filter(([, rs]) => rs.length >= 3)
        .sort((a, b) => b[1].length - a[1].length);
      return {
        verdict: hits.length ? `${hits.length} Owner sammeln Forks`
          : "Keine Fork-Sammler (evtl. Forks ausgeblendet)",
        stat: hits.length ? "≥3 geforkte Repos je Owner im Filter" : "",
        note: "Viele Forks statt eigener Repos: Spiegelung, Nachziehen fremder Arbeit oder künstliche Aktivität.",
        findings: hits.slice(0, 40).map(([owner, rs]) => ({
          title: `@${owner}`, badge: `${rs.length} Forks`,
          sub: rs.slice(0, 7).map((r) => r.short).join(", ") + (rs.length > 7 ? " …" : ""),
          act: () => focusRepo(rs[0].id),
        })),
      };
    },
  },
  {
    id: "bots", name: "Bot-betriebene Repos", tag: "AUTOMATION",
    desc: "Repos, deren Top-Contributor ein Bot ist oder bei denen Bots ≥50 % der Mitwirkenden stellen.",
    run(p) {
      const hits = [];
      for (const r of p.repos) {
        const ls = S.linksByRepo.get(r.id) || []; if (!ls.length) continue;
        const bots = ls.filter((l) => isBot(l.login));
        const top = [...ls].sort((a, b) => b.n - a.n)[0];
        const ratio = bots.length / ls.length;
        if (isBot(top.login) || ratio >= 0.5)
          hits.push({ r, topBot: isBot(top.login), ratio, names: bots.map((b) => b.login) });
      }
      hits.sort((a, b) => b.ratio - a.ratio);
      return {
        verdict: hits.length ? `${hits.length} Repos werden von Bots getragen`
          : "Keine bot-dominierten Repos im Filter",
        stat: hits.length ? "Top-Contributor = Bot, oder ≥50 % Bot-Anteil" : "",
        note: "Automatisierung statt menschlicher Pflege — Release-Bots, Mirrors, generierte Aktivität.",
        findings: hits.slice(0, 40).map((h) => ({
          title: h.r.full_name, badge: `${Math.round(h.ratio * 100)} % Bot`,
          sub: (h.topBot ? "Top-Contributor ist Bot · " : "") + h.names.slice(0, 4).join(", "),
          act: () => focusRepo(h.r.id),
        })),
      };
    },
  },
  {
    id: "abandoned", name: "Verwaist, aber einflussreich", tag: "LIEFERKETTE",
    desc: "Viel-beachtete Repos (oberes Viertel nach Stars) ohne Push seit ≥5 Jahren — Altlasten mit Reichweite.",
    run(p) {
      const stars = p.repos.map((r) => r.stars).sort((a, b) => a - b);
      const thr = Math.max(stars.length ? stars[Math.floor(stars.length * 0.75)] : 0, 50);
      const cutoff = (S.years.at(-1) || new Date().getFullYear()) - 5;
      const hits = p.repos.filter((r) => r.stars >= thr && r.pyear != null && r.pyear <= cutoff)
        .sort((a, b) => b.stars - a.stars);
      return {
        verdict: hits.length ? `${hits.length} einflussreiche Repos liegen brach`
          : "Keine verwaisten Hochwert-Repos im Filter",
        stat: hits.length ? `≥${fmt(thr)}★ und letzter Push ≤ ${cutoff}` : "",
        note: "Hohe Sichtbarkeit, keine Pflege: Lieferketten-Risiko und potenziell übernehmbare Namen/Pakete.",
        findings: hits.slice(0, 40).map((r) => ({
          title: r.full_name, badge: `${fmt(r.stars)}★`,
          sub: `letzter Push ${r.pushed_at?.slice(0, 7) || r.pyear} · ${r.lang || "—"}`,
          act: () => focusRepo(r.id),
        })),
      };
    },
  },
  {
    id: "monoculture", name: "Sprach-Monokultur", tag: "HOMOGENITÄT",
    desc: "Cluster, in denen ≥80 % der Repos dieselbe Sprache nutzen — technisch homogene Communities.",
    run(p) {
      const byC = new Map();
      for (const r of p.repos) { const c = S.clusters.get(r.id); if (c < 0 || c == null) continue;
        if (!byC.has(c)) byC.set(c, []); byC.get(c).push(r); }
      const hits = [];
      for (const [c, rs] of byC) {
        if (rs.length < 3) continue;
        const lc = new Map(); for (const r of rs) { const l = r.lang || "—"; lc.set(l, (lc.get(l) || 0) + 1); }
        const [lang, n] = [...lc.entries()].sort((a, b) => b[1] - a[1])[0];
        if (n / rs.length >= 0.8 && lang !== "—") hits.push({ c, lang, share: n / rs.length, size: rs.length });
      }
      hits.sort((a, b) => b.size - a.size);
      return {
        verdict: hits.length ? `${hits.length} Cluster sind Sprach-Monokulturen`
          : "Keine monokulturellen Cluster im Filter",
        stat: hits.length ? "≥80 % der Cluster-Repos in einer Sprache" : "",
        note: "Homogene Tech-Stacks: gemeinsame Werkzeugkultur, austauschbare Leute, geteilte Abhängigkeiten.",
        findings: hits.slice(0, 30).map((h) => ({
          title: `Cluster C${h.c}`, badge: `${h.lang} ${Math.round(h.share * 100)} %`,
          sub: `${h.size} Repos · dominante Sprache ${h.lang}`,
          act: () => { F.cluster = String(h.c); $("f_cluster").value = String(h.c); rebuild(); goto("terminal"); },
        })),
      };
    },
  },
  {
    id: "colocation", name: "Ko-Lokation", tag: "GEO", geo: true,
    desc: "Städte, in denen ≥2 Mitwirkende aus dem Filter sitzen — mögliche physische Nähe oder gemeinsames Team.",
    run(p) {
      if (!S.geoByLogin.size) return { verdict: "Noch keine Standortdaten geladen",
        stat: "", note: "Owner-Profile anreichern:  python -m gitdata enrich  — dann neu laden.", findings: [] };
      const byCity = new Map();
      for (const [login] of p.ppl) {
        const g = personGeo(login); if (!g || !g.city) continue;
        const k = g.city + " · " + g.country;
        if (!byCity.has(k)) byCity.set(k, { g, people: [] }); byCity.get(k).people.push(login);
      }
      const hits = [...byCity.entries()].filter(([, v]) => v.people.length >= 2)
        .sort((a, b) => b[1].people.length - a[1].people.length);
      return {
        verdict: hits.length ? `${hits.length} Städte bündeln mehrere Akteure`
          : "Keine Ko-Lokation im Filter (oder zu wenig Geo-Daten)",
        stat: hits.length ? "≥2 verortete Mitwirkende je Stadt" : "",
        note: "Gemeinsamer Standort: physische Nähe, gemeinsames Team oder lokale Szene.",
        findings: hits.slice(0, 40).map(([city, v]) => ({
          title: city, badge: `${v.people.length} Akteure`,
          sub: v.people.slice(0, 8).map((l) => "@" + l).join(", ") + (v.people.length > 8 ? " …" : ""),
          act: () => focusPerson(v.people[0]),
        })),
      };
    },
  },
  {
    id: "deps", name: "Abhängigkeits-Konvergenz", tag: "LIEFERKETTE",
    desc: "Pakete, von denen ≥3 Repos im Filter abhängen — geteilte Engpässe und gemeinsame Angriffsfläche.",
    run(p) {
      const m = new Map();
      for (const r of p.repos) for (const d of S.depByRepo.get(r.id) || []) {
        let e = m.get(d.package); if (!e) m.set(d.package, e = { pkg: d.package, eco: d.ecosystem, repos: new Set() });
        e.repos.add(r.id);
      }
      const hits = [...m.values()].filter((e) => e.repos.size >= 3).sort((a, b) => b.repos.size - a.repos.size);
      return {
        verdict: hits.length ? `${hits.length} geteilte Abhängigkeiten`
          : "Keine konvergenten Abhängigkeiten (evtl. kaum SBOM-Daten gecrawlt)",
        stat: hits.length ? "≥3 abhängige Repos je Paket" : "",
        note: "Ein kompromittiertes dieser Pakete träfe alle abhängigen Repos zugleich — Lieferketten-Engpass.",
        findings: hits.slice(0, 40).map((h) => ({
          title: h.pkg, badge: `${h.repos.size} Repos`,
          sub: `${h.eco || "—"} · ` + [...h.repos].slice(0, 6).map(short).join(", "),
          act: () => focusRepo([...h.repos][0]),
        })),
      };
    },
  },
];

let _findings = [];
function buildPatterns() {
  $("pat-cards").innerHTML = PATTERNS.map((pt) => `
    <div class="pat-card" data-pat="${pt.id}">
      <h6>${pt.name}<span class="tag">${pt.tag}</span></h6>
      <p>${pt.desc}</p>
    </div>`).join("");
  $("pat-cards").querySelectorAll("[data-pat]").forEach((el) =>
    el.onclick = () => runPattern(el.dataset.pat));
  $("pat-clear").onclick = clearPattern;
}
function clearPattern() {
  S.lastPattern = null; _findings = [];
  $("pat-result").hidden = true; $("pat-result").innerHTML = "";
  $("pat-clear").hidden = true;
  document.querySelectorAll(".pat-card").forEach((c) => c.classList.remove("on"));
}
function refreshPatterns() {
  if (!$("pat-scope")) return;
  $("pat-scope").textContent =
    `läuft über ${fmt(S.nodes.length)} Repos · ${fmt(pile().ppl.size)} Personen im Filter`;
  if (S.lastPattern) runPattern(S.lastPattern, true);
}
function runPattern(id, keepScroll) {
  const pt = PATTERNS.find((x) => x.id === id); if (!pt) return;
  S.lastPattern = id;
  document.querySelectorAll(".pat-card").forEach((c) => c.classList.toggle("on", c.dataset.pat === id));
  const res = pt.run(pile());
  _findings = res.findings || [];
  const rows = _findings.length
    ? `<div class="pat-findings">${_findings.map((f, i) => `
        <div class="finding" data-f="${i}">
          <span class="f-title">${f.title}</span><span class="f-badge">${f.badge || ""}</span>
          <span class="f-sub">${f.sub || ""}</span>
        </div>`).join("")}</div>`
    : `<div class="pat-empty">Keine Treffer — Filter oben lockern oder ein anderes Muster wählen.</div>`;
  $("pat-result").hidden = false;
  $("pat-clear").hidden = false;
  $("pat-result").innerHTML = `
    <div class="pat-verdict">
      <h3>${res.verdict}</h3>
      ${res.stat ? `<div class="stat">${res.stat}</div>` : ""}
      <div class="note">${res.note}</div>
    </div>${rows}`;
  $("pat-result").querySelectorAll("[data-f]").forEach((el) =>
    el.onclick = () => _findings[+el.dataset.f]?.act?.());
  if (!keepScroll) goto("patterns");
}

/* ===================== STECKBRIEF (Auswahl in Saetzen) ===================== */
/* Aus den Rohwerten der Auswahl werden ganze deutsche Saetze gebaut — die
 * Tabellen im Inspektor sagen WAS, der Steckbrief sagt WAS DAS HEISST. */
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
  "August", "September", "Oktober", "November", "Dezember"];
const monthYear = (s) => s ? `${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : null;
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const B = (s) => `<b>${s}</b>`;
const rlink = (id, label) => `<u data-repo="${id}">${label}</u>`;
const plink = (login) => `<u data-person="${login}">@${login}</u>`;

function pctRank(val, arr) {           // Anteil der Menge, der kleiner ist
  if (!arr.length) return 0;
  let below = 0;
  for (const v of arr) if (v < val) below++;
  return below / arr.length;
}

function sbRepo(r) {
  if (!r) return "";
  const g = repoGeo(r);
  const contribs = (S.linksByRepo.get(r.id) || []).slice().sort((a, b) => b.n - a.n);
  const totalC = contribs.reduce((s, c) => s + c.n, 0);
  const nb = (S.adj.get(r.id) || []).slice().sort((a, b) => b.w - a.w);
  const cl = S.clusters.get(r.id);
  const owner = S.people.get(r.owner_login);
  const kind = r.owner_type === "Organization" ? "der Organisation" : "des Nutzers";
  const S_ = [];

  // 1 — Identität, Herkunft, Lizenz
  let s1 = `${B(r.full_name)} ist ein ${r.lang ? B(r.lang) + "-Projekt" : "Projekt"} ` +
    `${kind} ${plink(r.owner_login)}`;
  s1 += g ? `, ${g.city ? `ansässig in ${B(g.city)}, ${B(g.country)}` : `aus ${B(g.country)}`}` : "";
  s1 += r.license ? `, veröffentlicht unter ${B(r.license)}.` : ", ohne hinterlegte Lizenz.";
  S_.push(s1);

  // 2 — Reichweite mit Perzentil
  const p = Math.round(pctRank(r.stars, S.nodes.map((n) => n.stars)) * 100);
  S_.push(`Es sammelt ${B(fmt(r.stars) + " Stars")} und ${B(fmt(r.forks) + " Forks")} ` +
    `und liegt damit über ${B(p + " %")} der ${fmt(S.nodes.length)} gefilterten Repos.`);

  // 3 — Aktivität
  const py = r.pyear, now = S.years.at(-1) || new Date().getFullYear();
  const age = py ? now - py : null;
  if (monthYear(r.pushed_at)) {
    S_.push(age >= 5
      ? `Der letzte Push liegt im ${B(monthYear(r.pushed_at))} — seit rund ${B(age + " Jahren")} ` +
        `bewegt sich nichts mehr, das Projekt gilt als <em>verwaist</em>.`
      : `Zuletzt bewegt wurde es im ${B(monthYear(r.pushed_at))}` +
        (monthYear(r.created_at) ? `, angelegt im ${B(monthYear(r.created_at))}.` : "."));
  }

  // 4 — Menschen + Klumpenrisiko
  if (contribs.length) {
    const top = contribs[0], share = totalC ? top.n / totalC : 0;
    let s = `Erfasst sind ${B(plural(contribs.length, "mitwirkende Person", "mitwirkende Personen"))}; ` +
      `${plink(top.login)} stellt davon ${B(Math.round(share * 100) + " %")} der Commits`;
    s += share >= .7 && contribs.length > 1
      ? ` — ein <em>Klumpenrisiko</em>: fällt diese Person aus, verwaist das Projekt faktisch.`
      : `.`;
    S_.push(s);
  } else {
    S_.push(`Zu diesem Repo sind ${B("keine Contributor-Daten")} gecrawlt.`);
  }

  // 5 — Netz
  S_.push(nb.length
    ? `Über gemeinsame Mitwirkende hängt es an ${B(plural(nb.length, "weiteren Projekt", "weiteren Projekten"))}, ` +
      `am engsten an ${rlink(nb[0].id, S.repoById.get(nb[0].id)?.full_name || nb[0].id)} ` +
      `(${plural(nb[0].w, "gemeinsame Person", "gemeinsame Personen")}).`
    : `Im aktuellen Filter teilt es mit ${B("keinem")} anderen Projekt Mitwirkende — es steht isoliert.`);

  // 6 — Cluster + Flags
  if (cl >= 0) S_.push(`Zugeordnet ist es Cluster ${B("C" + cl)}, der ` +
    `${plural(S.clusterSizes?.[cl] || 0, "Repo", "Repos")} umfasst.`);
  const flags = [r.archived && "archiviert", r.is_fork && "ein Fork"].filter(Boolean);
  if (flags.length) S_.push(`Das Repo ist ${B(flags.join(" und "))}.`);

  const facts = [
    ["SPRACHE", r.lang || "—"], ["STARS", fmt(r.stars)], ["FORKS", fmt(r.forks)],
    ["ISSUES", fmt(r.open_issues)], ["CONTRIB", contribs.length], ["LINKS", r.deg ?? 0],
    g && ["ORT", (g.city ? g.city + ", " : "") + g.country],
    r.topics?.length && ["TOPICS", r.topics.slice(0, 3).join(", ")],
  ].filter(Boolean);

  return `
    <div class="sb-head"><span class="sb-kind">STECKBRIEF · REPO</span>
      <span class="sb-name">${r.full_name}</span></div>
    <div class="sb-text">${S_.join(" ")}</div>
    <div class="sb-facts">${facts.map(([k, v]) => `<span><i>${k}</i>${v}</span>`).join("")}</div>`;
}

function sbPerson(login) {
  const p = S.people.get(login) || { repos: 0, total: 0 };
  const g = personGeo(login);
  const ls = (S.linksByPerson.get(login) || []).slice().sort((a, b) => b.n - a.n);
  const inFilter = ls.filter((l) => S.repoById.get(l.repo_id) && S.nodes.some((n) => n.id === l.repo_id));
  const langs = new Map(), clusters = new Set(), mates = new Map();
  for (const l of ls) {
    const r = S.repoById.get(l.repo_id); if (!r) continue;
    if (r.lang) langs.set(r.lang, (langs.get(r.lang) || 0) + 1);
    const c = S.clusters.get(r.id); if (c >= 0) clusters.add(c);
    for (const o of S.linksByRepo.get(r.id) || [])
      if (o.login !== login && !isBot(o.login)) mates.set(o.login, (mates.get(o.login) || 0) + 1);
  }
  const topLang = [...langs.entries()].sort((a, b) => b[1] - a[1])[0];
  const topMates = [...mates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const S_ = [];

  let s1 = `${B("@" + login)} ist ${isBot(login) ? "ein " + B("Bot-Konto")
    : p.type === "Organization" ? "eine " + B("Organisation") : "ein " + B("Nutzerkonto")}`;
  s1 += g ? `, ${g.city ? `ansässig in ${B(g.city)}, ${B(g.country)}` : `aus ${B(g.country)}`}.` : ".";
  S_.push(s1);

  S_.push(`Erfasst ist die Mitarbeit an ${B(plural(p.repos, "Projekt", "Projekten"))} ` +
    `mit zusammen ${B(plural(p.total, "Commit", "Commits"))}` +
    (inFilter.length !== p.repos ? `, davon ${B(inFilter.length)} im aktuellen Filter.` : `.`));

  if (topLang) S_.push(`Der Schwerpunkt liegt auf ${B(topLang[0])} ` +
    `(${topLang[1]} von ${ls.length} Projekten).`);

  if (ls.length) {
    const t = S.repoById.get(ls[0].repo_id);
    if (t) S_.push(`Am stärksten engagiert ist das Konto in ` +
      `${rlink(t.id, t.full_name)} mit ${B(plural(ls[0].n, "Commit", "Commits"))}.`);
  }

  S_.push(clusters.size >= 2
    ? `Die Arbeit verteilt sich über ${B(plural(clusters.size, "Cluster", "Cluster"))} — ` +
      `das Konto wirkt als <em>Brücke</em> zwischen sonst getrennten Gruppen.`
    : clusters.size === 1
      ? `Die Arbeit bleibt innerhalb eines einzigen Clusters.`
      : `Im aktuellen Filter lässt sich kein Cluster zuordnen.`);

  if (topMates.length) S_.push(`Häufigste Mitstreiter: ` +
    topMates.map(([m, n]) => `${plink(m)} (${n})`).join(", ") + `.`);

  const facts = [
    ["TYP", p.type || "User"], ["PROJEKTE", fmt(p.repos)], ["COMMITS", fmt(p.total)],
    ["SPRACHEN", langs.size], ["CLUSTER", clusters.size],
    g && ["ORT", (g.city ? g.city + ", " : "") + g.country],
  ].filter(Boolean);

  return `
    <div class="sb-head"><span class="sb-kind">STECKBRIEF · PERSON</span>
      <span class="sb-name">@${login}</span></div>
    <div class="sb-text">${S_.join(" ")}</div>
    <div class="sb-facts">${facts.map(([k, v]) => `<span><i>${k}</i>${v}</span>`).join("")}</div>`;
}

function paintSteckbrief() {
  const el = $("steckbrief"); if (!el) return;
  if (!S.sel) {
    el.className = "sb empty";
    el.innerHTML = `<div class="sb-hint">Nichts ausgewählt — klick einen Knoten im Graphen, ` +
      `eine Person in den Ranglisten oder einen Beleg unten. Hier erscheint dann ein ` +
      `Steckbrief in ganzen Sätzen.</div>`;
    return;
  }
  el.className = "sb";
  el.innerHTML = S.sel.kind === "repo" ? sbRepo(S.repoById.get(S.sel.id)) : sbPerson(S.sel.login);
  el.querySelectorAll("[data-repo]").forEach((a) =>
    a.onclick = () => focusRepo(+a.dataset.repo));
  el.querySelectorAll("[data-person]").forEach((a) =>
    a.onclick = () => select({ kind: "person", login: a.dataset.person }));
}

/* ===================== WORLD VIEW · GLOBUS ===================== */
/* Echte Ländergrenzen (web/world-110m.json, Natural Earth 110m, lokal — kein
 * CDN, keine Bibliothek). Zwei Projektionen teilen sich Zeichnung und Treffer-
 * tests: orthographisch (drehbarer Globus) und äquirektangular (flache Karte).
 *
 * Perf: sin/cos je Stützpunkt werden EINMAL beim Laden vorgerechnet. Die
 * Projektion pro Frame ist danach reine Multiplikation — sonst kosten ~30k
 * Grad→Bogenmaß-Umrechnungen je Frame mehr als das ganze Force-Layout.
 */
const RAD = Math.PI / 180;
const W3 = {
  mode: "repos", proj: "globe", cv: null, ctx: null, W: 0, H: 0, DPR: 1,
  rot: { lam: -30, phi: 15 },     // Zentrum der Ansicht in Grad
  zoom: 1, spin: true, lastUser: 0,
  world: null, cities: [], countries: [], located: 0, total: 0,
  sel: null,                       // {iso, country} | null
  selCity: null,
  hitMarkers: [],
  anim: null, dirty: true, loaded: false,
};
const wrapLon = (d) => ((d + 180) % 360 + 360) % 360 - 180;
const R_of = () => Math.min(W3.W, W3.H) * 0.44 * W3.zoom;

/* --- Geometrie laden + Trigonometrie vorrechnen --- */
async function loadWorldGeometry() {
  try {
    const raw = await fetch("world-110m.json").then((r) => r.json());
    for (const f of raw.features) {
      f.rings = [];
      for (const poly of f.p) for (const ring of poly) {
        const n = ring.length, a = new Float64Array(n * 6);
        for (let i = 0; i < n; i++) {
          const lon = ring[i][0], lat = ring[i][1];
          const λ = lon * RAD, φ = lat * RAD, o = i * 6;
          a[o] = lon; a[o + 1] = lat;
          a[o + 2] = Math.sin(λ); a[o + 3] = Math.cos(λ);
          a[o + 4] = Math.sin(φ); a[o + 5] = Math.cos(φ);
        }
        f.rings.push(a);
      }
    }
    W3.world = raw.features;
    W3.loaded = true;
  } catch (e) {
    W3.loaded = false;            // Karte fehlt -> nur Gitter + Marker
  }
  W3.dirty = true;
}

/* --- Projektion: (lat,lon) -> Bildschirm, null = abgewandte Seite --- */
function wproj(lat, lon) {
  const cx = W3.W / 2, cy = W3.H / 2;
  if (W3.proj === "flat") {
    const kx = (W3.W / 360) * W3.zoom, ky = (W3.H / 180) * W3.zoom;
    return { x: cx + wrapLon(lon - W3.rot.lam) * kx, y: cy - (lat - W3.rot.phi) * ky };
  }
  const λ = (lon - W3.rot.lam) * RAD, φ = lat * RAD, φ0 = W3.rot.phi * RAD;
  const sinφ = Math.sin(φ), cosφ = Math.cos(φ);
  const sinφ0 = Math.sin(φ0), cosφ0 = Math.cos(φ0);
  const cosλ = Math.cos(λ), sinλ = Math.sin(λ);
  if (sinφ0 * sinφ + cosφ0 * cosφ * cosλ < 0) return null;   // Rückseite
  const R = R_of();
  return { x: cx + R * cosφ * sinλ, y: cy - R * (cosφ0 * sinφ - sinφ0 * cosφ * cosλ) };
}

/* --- Umkehrung: Bildschirm -> (lat,lon), null = daneben --- */
function wunproj(sx, sy) {
  const cx = W3.W / 2, cy = W3.H / 2;
  if (W3.proj === "flat") {
    const kx = (W3.W / 360) * W3.zoom, ky = (W3.H / 180) * W3.zoom;
    return { lat: W3.rot.phi - (sy - cy) / ky, lon: wrapLon(W3.rot.lam + (sx - cx) / kx) };
  }
  const R = R_of(), dx = sx - cx, dy = cy - sy;
  const rho = Math.hypot(dx, dy);
  if (rho > R) return null;
  const c = Math.asin(Math.min(1, rho / R));
  const sinc = Math.sin(c), cosc = Math.cos(c), φ0 = W3.rot.phi * RAD;
  const lat = Math.asin(cosc * Math.sin(φ0) + (rho ? dy * sinc * Math.cos(φ0) / rho : 0)) / RAD;
  const lon = W3.rot.lam + Math.atan2(dx * sinc,
    rho * cosc * Math.cos(φ0) - dy * sinc * Math.sin(φ0)) / RAD;
  return { lat, lon: wrapLon(lon) };
}

/* --- Daten: Pile -> Länder + Städte --- */
function worldData() {
  const byCountry = new Map(), byCity = new Map();
  let located = 0, total = 0;
  const add = (g, item) => {
    let c = byCountry.get(g.country);
    if (!c) byCountry.set(g.country, c = { country: g.country, n: 0, noCity: 0,
      items: [], cities: new Map() });
    c.n++; c.items.push(item);
    if (!g.city) { c.noCity++; return; }   // nur Land bekannt -> kein Ortsmarker
    const ck = g.city + "|" + g.country;
    let k = byCity.get(ck);
    if (!k) byCity.set(ck, k = { key: ck, city: g.city, country: g.country,
      lat: g.lat, lon: g.lon, n: 0, items: [] });
    k.n++; k.items.push(item);
    c.cities.set(ck, k);
  };
  if (W3.mode === "repos") {
    for (const r of S.nodes) { total++; const g = repoGeo(r); if (g) { add(g, r.id); located++; } }
  } else {
    for (const [login] of pile().ppl) { total++; const g = personGeo(login); if (g) { add(g, login); located++; } }
  }
  W3.countries = [...byCountry.values()].sort((a, b) => b.n - a.n);
  W3.cities = [...byCity.values()].sort((a, b) => b.n - a.n);
  W3.located = located; W3.total = total;
  W3.noCity = W3.countries.reduce((s, c) => s + c.noCity, 0);
}

/* --- Zeichnen --- */
function drawWorld() {
  const { ctx, W, H, DPR } = W3;
  if (!ctx || !W) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = R_of(), globe = W3.proj === "globe";

  if (globe) {                       // Ozean + Terminator-Glow
    const grd = ctx.createRadialGradient(cx - R * .3, cy - R * .3, R * .1, cx, cy, R);
    grd.addColorStop(0, "#0d2733"); grd.addColorStop(1, "#061119");
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fillStyle = grd; ctx.fill();
    ctx.strokeStyle = "#2ee6cf55"; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.save();
  if (globe) { ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip(); }

  // Gradnetz
  ctx.strokeStyle = "#1b3a46"; ctx.lineWidth = .6;
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) {
    let up = false;
    for (let lat = -90; lat <= 90; lat += 3) {
      const p = wproj(lat, lon);
      if (!p) { up = false; continue; }
      up ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); up = true;
    }
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    let up = false;
    for (let lon = -180; lon <= 180; lon += 3) {
      const p = wproj(lat, lon);
      if (!p) { up = false; continue; }
      up ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); up = true;
    }
  }
  ctx.stroke();

  // Länder
  if (W3.world) {
    const λ0 = W3.rot.lam * RAD, φ0 = W3.rot.phi * RAD;
    const sinλ0 = Math.sin(λ0), cosλ0 = Math.cos(λ0);
    const sinφ0 = Math.sin(φ0), cosφ0 = Math.cos(φ0);
    const kx = (W / 360) * W3.zoom, ky = (H / 180) * W3.zoom;
    for (const f of W3.world) {
      const on = W3.sel && W3.sel.iso && f.iso === W3.sel.iso;
      const hasData = W3.countryByIso?.get(f.iso);
      ctx.beginPath();
      let any = false;
      for (const a of f.rings) {
        let started = false;
        for (let i = 0; i < a.length; i += 6) {
          let x, y;
          if (globe) {
            const sinλ = a[i + 2] * cosλ0 - a[i + 3] * sinλ0;   // sin(λ-λ0)
            const cosλ = a[i + 3] * cosλ0 + a[i + 2] * sinλ0;   // cos(λ-λ0)
            const sinφ = a[i + 4], cosφ = a[i + 5];
            if (sinφ0 * sinφ + cosφ0 * cosφ * cosλ < 0) { started = false; continue; }
            x = cx + R * cosφ * sinλ;
            y = cy - R * (cosφ0 * sinφ - sinφ0 * cosφ * cosλ);
          } else {
            x = cx + wrapLon(a[i] - W3.rot.lam) * kx;
            y = cy - (a[i + 1] - W3.rot.phi) * ky;
          }
          started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          started = true; any = true;
        }
        ctx.closePath();
      }
      if (!any) continue;
      ctx.fillStyle = on ? "#ffc06126" : hasData ? "#14323d" : "#0e222b";
      ctx.fill();
      ctx.strokeStyle = on ? AM : hasData ? "#3d7d90" : "#25454f";
      ctx.lineWidth = on ? 1.6 : .7;
      ctx.stroke();
    }
  }
  ctx.restore();

  // Marker: Städte
  W3.hitMarkers = [];
  const max = Math.max(1, ...W3.cities.map((c) => c.n));
  for (const c of W3.cities) {
    const p = wproj(c.lat, c.lon);
    if (!p || p.x < -40 || p.x > W + 40 || p.y < -40 || p.y > H + 40) continue;
    const r = 2.5 + 11 * Math.sqrt(c.n / max);
    const on = W3.selCity === c.key;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7);
    ctx.fillStyle = on ? "#ffc06188" : "#28f5d855";
    ctx.strokeStyle = on ? AM : CY; ctx.lineWidth = on ? 2 : 1;
    ctx.fill(); ctx.stroke();
    if (on || r > 9) {
      ctx.fillStyle = on ? "#fff" : BRIGHT; ctx.font = F_MATRIX; ctx.textAlign = "center";
      ctx.fillText(fmt(c.n), p.x, p.y + 3.5);
    }
    if (on && c.city) {
      ctx.fillStyle = AM; ctx.font = F_AXIS; ctx.textAlign = "center";
      ctx.fillText(c.city, p.x, p.y - r - 6);
    }
    W3.hitMarkers.push({ c, x: p.x, y: p.y, r: Math.max(r, 7) });
  }
  ctx.textAlign = "left";

  $("world-readout").textContent =
    `${W3.mode === "repos" ? "REPOS" : "AKTEURE"} · ${fmt(W3.located)}/${fmt(W3.total)} verortet · ` +
    `${W3.countries.length} Länder · ${W3.proj === "globe" ? "Ziehen dreht, Rad zoomt" : "Ziehen verschiebt"}`;
}

/* --- Flug zu einem Ort --- */
const ease = (t) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function flyTo(lat, lon, zoom) {
  W3.anim = {
    t0: performance.now(), dur: 850,
    from: { lam: W3.rot.lam, phi: W3.rot.phi, z: W3.zoom },
    d: { lam: wrapLon(lon - W3.rot.lam), phi: lat - W3.rot.phi, z: (zoom ?? W3.zoom) - W3.zoom },
  };
  W3.lastUser = performance.now();   // Auto-Spin nicht sofort dazwischenfunken
}

/* --- Seitenlisten --- */
function paintWorldSide() {
  const pct = W3.total ? Math.round(W3.located / W3.total * 100) : 0;
  $("world-cov").innerHTML = `
    <div class="covrow"><span>verortet</span><b>${fmt(W3.located)} / ${fmt(W3.total)}</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="covrow"><span>Länder</span><b>${W3.countries.length}</b></div>
    <div class="covrow"><span>Städte</span><b>${W3.cities.length}</b></div>
    <div class="covrow"><span>nur Land, ohne Stadt</span><b>${fmt(W3.noCity || 0)}</b></div>
    <div class="covrow"><span>Owner mit Geo</span><b>${fmt(S.geoByLogin.size)}</b></div>`;

  const cmax = Math.max(1, ...W3.countries.map((c) => c.n));
  $("world-countries").innerHTML = W3.countries.slice(0, 40).map((c) => `
    <div class="wc-row ${W3.sel?.country === c.country ? "on" : ""}" data-country="${c.country}">
      <i class="dot" style="background:${ramp(c.n / cmax)}"></i>
      <span class="nm">${c.country}</span><span class="ct">${fmt(c.n)}</span>
    </div>`).join("") || '<div class="hint">keine Geo-Daten — python -m gitdata enrich</div>';
  $("world-countries").querySelectorAll("[data-country]").forEach((el) =>
    el.onclick = () => selectCountry(el.dataset.country));

  let list = W3.cities;
  if (W3.sel) list = list.filter((c) => c.country === W3.sel.country);
  const kmax = Math.max(1, ...list.map((c) => c.n));
  $("world-cities").innerHTML = list.slice(0, 40).map((c) => `
    <div class="wc-row ${W3.selCity === c.key ? "on" : ""}" data-city="${c.key}">
      <i class="dot" style="background:${ramp(c.n / kmax)}"></i>
      <span class="nm">${c.city}<span class="dim"> · ${c.country}</span></span>
      <span class="ct">${fmt(c.n)}</span>
    </div>`).join("") || '<div class="hint">keine Stadtdaten</div>';
  $("world-cities").querySelectorAll("[data-city]").forEach((el) =>
    el.onclick = () => selectCity(el.dataset.city));

  paintWorldDrill();
}

/* Drill-Down: WER/WAS sitzt konkret an dem gewaehlten Ort. Die Karte zeigt nur
 * Zahlen — hier stehen die tatsaechlichen Repos bzw. Personen, anklickbar. */
function paintWorldDrill() {
  const head = $("world-drill-h"), box = $("world-drill");
  let items = [], label = null;
  if (W3.selCity) {
    const c = W3.cities.find((x) => x.key === W3.selCity);
    if (c) { items = c.items; label = `${c.city || "unbekannter Ort"} · ${c.country}`; }
  } else if (W3.sel) {
    const c = W3.countries.find((x) => x.country === W3.sel.country);
    if (c) { items = c.items; label = c.country; }
  }
  if (!label) {
    head.innerHTML = `VON HIER <i>Ort wählen</i>`;
    box.innerHTML = `<div class="hint">Land oder Stadt anklicken (Karte oder Liste) — hier
      erscheinen dann die ${W3.mode === "repos" ? "Repos" : "Personen"} von dort.</div>`;
    return;
  }
  head.innerHTML = `VON HIER <i>${label} · ${fmt(items.length)}</i>`;

  if (W3.mode === "repos") {
    const rows = items.map((id) => S.repoById.get(id)).filter(Boolean)
      .sort((a, b) => b.stars - a.stars);
    box.innerHTML = rows.slice(0, 60).map((r) => `
      <div class="drill-row" data-drepo="${r.id}">
        <span class="nm">${r.full_name}</span><span class="mt">${fmt(r.stars)}★</span>
        <span class="sub">${r.lang || "—"} · @${r.owner_login}${r.deg ? ` · ${r.deg} Links` : ""}</span>
      </div>`).join("") + (rows.length > 60 ? `<div class="hint">… ${rows.length - 60} weitere</div>` : "");
    box.querySelectorAll("[data-drepo]").forEach((el) =>
      el.onclick = () => focusRepo(+el.dataset.drepo));
  } else {
    const rows = items.map((login) => ({ login, p: S.people.get(login) || { repos: 0, total: 0 } }))
      .sort((a, b) => b.p.total - a.p.total);
    box.innerHTML = rows.slice(0, 60).map(({ login, p }) => `
      <div class="drill-row" data-dperson="${login}">
        <span class="nm">@${login}</span><span class="mt">${fmt(p.total)}</span>
        <span class="sub">${p.repos} Projekte${p.type && p.type !== "User" ? " · " + p.type : ""}</span>
      </div>`).join("") + (rows.length > 60 ? `<div class="hint">… ${rows.length - 60} weitere</div>` : "");
    box.querySelectorAll("[data-dperson]").forEach((el) =>
      el.onclick = () => select({ kind: "person", login: el.dataset.dperson }));
  }
}

function selectCountry(country) {
  if (W3.sel?.country === country) { W3.sel = null; W3.selCity = null; }
  else {
    const iso = S.isoByCountry?.get(country) || null;
    W3.sel = { country, iso }; W3.selCity = null;
    const c = W3.countries.find((x) => x.country === country);
    const big = c && [...c.cities.values()].sort((a, b) => b.n - a.n)[0];
    if (big) flyTo(big.lat, big.lon, W3.proj === "globe" ? 1.9 : 2.4);
  }
  W3.dirty = true; paintWorldSide();
}
function selectCity(key) {
  const c = W3.cities.find((x) => x.key === key); if (!c) return;
  W3.selCity = W3.selCity === key ? null : key;
  if (W3.selCity) {
    W3.sel = { country: c.country, iso: S.isoByCountry?.get(c.country) || null };
    flyTo(c.lat, c.lon, W3.proj === "globe" ? 2.6 : 3.4);
  }
  W3.dirty = true; paintWorldSide();
}

/* --- Öffentliche Auffrischung (aus paintAll) --- */
function paintWorld() {
  if (!W3.ctx) return;
  worldData();
  W3.countryByIso = new Map();
  for (const c of W3.countries) {
    const iso = S.isoByCountry?.get(c.country); if (iso) W3.countryByIso.set(iso, c);
  }
  paintWorldSide();
  W3.dirty = true;
}

/* --- Aufbau + Interaktion --- */
function buildWorld() {
  W3.cv = $("worldmap"); W3.ctx = W3.cv.getContext("2d");
  document.querySelectorAll("[data-wproj]").forEach((b) => b.onclick = () => {
    W3.proj = b.dataset.wproj;
    document.querySelectorAll("[data-wproj]").forEach((x) => x.classList.toggle("on", x === b));
    W3.zoom = 1; W3.rot = { lam: W3.rot.lam, phi: W3.proj === "flat" ? 0 : 15 };
    W3.dirty = true;
  });
  document.querySelectorAll("[data-wmode]").forEach((b) => b.onclick = () => {
    W3.mode = b.dataset.wmode; W3.selCity = null;
    document.querySelectorAll("[data-wmode]").forEach((x) => x.classList.toggle("on", x === b));
    paintWorld();
  });
  $("w_spin").onclick = () => {
    W3.spin = !W3.spin; $("w_spin").classList.toggle("on", W3.spin);
  };
  $("w_reset").onclick = () => {
    W3.sel = null; W3.selCity = null; W3.zoom = 1;
    flyTo(15, -30, 1); paintWorldSide();
  };
  wireWorld();
  worldResize();
  loadWorldGeometry();
  requestAnimationFrame(worldLoop);
}

function worldResize() {
  if (!W3.cv) return;
  W3.DPR = Math.min(2, window.devicePixelRatio || 1);
  const r = W3.cv.getBoundingClientRect();
  W3.W = r.width; W3.H = r.height;
  W3.cv.width = W3.W * W3.DPR; W3.cv.height = W3.H * W3.DPR;
  W3.dirty = true;
}

function worldVisible() {
  const r = $("world").getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
}

function worldLoop() {
  const t = performance.now();
  if (W3.anim) {
    const k = Math.min(1, (t - W3.anim.t0) / W3.anim.dur), e = ease(k);
    W3.rot.lam = wrapLon(W3.anim.from.lam + W3.anim.d.lam * e);
    W3.rot.phi = clamp(W3.anim.from.phi + W3.anim.d.phi * e, -85, 85);
    W3.zoom = W3.anim.from.z + W3.anim.d.z * e;
    if (k >= 1) W3.anim = null;
    W3.dirty = true;
  } else if (W3.spin && W3.proj === "globe" && t - W3.lastUser > 2200) {
    W3.rot.lam = wrapLon(W3.rot.lam + .09);
    W3.dirty = true;
  }
  if (W3.dirty && worldVisible()) { drawWorld(); W3.dirty = false; }
  requestAnimationFrame(worldLoop);
}

function wireWorld() {
  const cv = W3.cv;
  let drag = null;
  cv.addEventListener("mousedown", (e) => {
    const r = cv.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top, moved: false };
    W3.lastUser = performance.now();
  });
  cv.addEventListener("mousemove", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (drag) {
      const dx = sx - drag.x, dy = sy - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      const k = W3.proj === "globe" ? 0.28 / W3.zoom : 360 / (W3.W * W3.zoom);
      W3.rot.lam = wrapLon(W3.rot.lam - dx * k);
      W3.rot.phi = clamp(W3.rot.phi + dy * (W3.proj === "globe" ? 0.28 / W3.zoom
        : 180 / (W3.H * W3.zoom)), -85, 85);
      drag.x = sx; drag.y = sy;
      W3.lastUser = performance.now(); W3.anim = null; W3.dirty = true;
      cv.style.cursor = "grabbing";
      return;
    }
    // Hover: Stadt-Marker, sonst Land
    let hit = null;
    for (const m of W3.hitMarkers)
      if ((m.x - sx) ** 2 + (m.y - sy) ** 2 <= m.r * m.r) { hit = m; break; }
    const tip = $("worldtip");
    if (hit) {
      const c = hit.c;
      tip.innerHTML = `<b>${c.city || "unbekannter Ort"}</b> · ${c.country}<br>
        <s>${W3.mode === "repos" ? "REPOS" : "AKTEURE"}</s> ${fmt(c.n)}<br>
        <s>KLICK</s> hinfliegen &amp; filtern`;
      tip.style.opacity = 1;
      tip.style.left = Math.min(e.clientX + 14, innerWidth - 250) + "px";
      tip.style.top = (e.clientY + 14) + "px";
      cv.style.cursor = "pointer";
    } else {
      const geo = wunproj(sx, sy);
      const f = geo && W3.world && featureAt(geo.lat, geo.lon);
      const rec = f && W3.countryByIso?.get(f.iso);
      if (f) {
        tip.innerHTML = `<b>${f.n}</b><br><s>${W3.mode === "repos" ? "REPOS" : "AKTEURE"}</s> ` +
          `${rec ? fmt(rec.n) : "0"}`;
        tip.style.opacity = 1;
        tip.style.left = Math.min(e.clientX + 14, innerWidth - 250) + "px";
        tip.style.top = (e.clientY + 14) + "px";
        cv.style.cursor = rec ? "pointer" : "grab";
      } else { tip.style.opacity = 0; cv.style.cursor = "grab"; }
    }
  });
  window.addEventListener("mouseup", () => {
    if (drag && !drag.moved) { /* Klick: unten behandelt */ }
    if (drag) cv.style.cursor = "grab";
    drag = null;
  });
  cv.addEventListener("click", (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    for (const m of W3.hitMarkers)
      if ((m.x - sx) ** 2 + (m.y - sy) ** 2 <= m.r * m.r) { selectCity(m.c.key); return; }
    const geo = wunproj(sx, sy);
    const f = geo && W3.world && featureAt(geo.lat, geo.lon);
    if (f && W3.countryByIso?.get(f.iso)) selectCountry(W3.countryByIso.get(f.iso).country);
  });
  cv.addEventListener("dblclick", (e) => {
    const r = cv.getBoundingClientRect();
    const g = wunproj(e.clientX - r.left, e.clientY - r.top);
    if (g) flyTo(g.lat, g.lon, Math.min(6, W3.zoom * 1.9));
  });
  cv.addEventListener("mouseleave", () => { $("worldtip").style.opacity = 0; drag = null; });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    W3.zoom = clamp(W3.zoom * (e.deltaY < 0 ? 1.15 : .87), .6, 8);
    W3.lastUser = performance.now(); W3.anim = null; W3.dirty = true;
  }, { passive: false });
}

/* Punkt-in-Polygon über alle Länder (Ray-Casting auf den Rohkoordinaten). */
function featureAt(lat, lon) {
  for (const f of W3.world) {
    for (const a of f.rings) {
      let inside = false;
      for (let i = 0, j = a.length - 6; i < a.length; j = i, i += 6) {
        const xi = a[i], yi = a[i + 1], xj = a[j], yj = a[j + 1];
        if ((yi > lat) !== (yj > lat) &&
            lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return f;
    }
  }
  return null;
}

/* ===================== OPS · AGENTS & DURCHSATZ ===================== */
/* Pollt /api/ops. Der Durchsatz wird NICHT vom Server geliefert, sondern hier
 * aus den Differenzen zweier Messungen geschaetzt und exponentiell geglaettet —
 * so bleibt die Restzeit-Schaetzung ruhig, statt bei jedem Poll zu springen. */
const OPS = { last: null, rates: {}, timer: null, fails: 0 };
const EMA = 0.25;

function humanDur(sec) {
  if (!isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600);
  const m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  if (d) return `${d} T ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s} s`;
  return `${s} s`;
}
const humanAge = (sec) => humanDur(sec) === "—" ? "0 s" : humanDur(sec);

function opsRate(key, value, ts) {
  // Elemente pro Sekunde, exponentiell geglaettet.
  const prev = OPS.last;
  if (!prev || !(key in prev.vals)) return OPS.rates[key] ?? 0;
  const dt = ts - prev.ts, dv = value - prev.vals[key];
  if (dt <= 0) return OPS.rates[key] ?? 0;
  const inst = Math.max(0, dv / dt);
  const old = OPS.rates[key];
  OPS.rates[key] = old == null ? inst : old + EMA * (inst - old);
  return OPS.rates[key];
}

function workRow(label, done, total, rate, unit) {
  const pct = total ? Math.min(100, done / total * 100) : 0;
  const left = Math.max(0, total - done);
  const eta = rate > 0 ? humanDur(left / rate) : (left ? "steht still" : "fertig");
  const perMin = rate * 60;
  return `<div class="work">
    <div class="work-t"><span>${label}</span><b>${fmt(done)} / ${fmt(total)}</b></div>
    <div class="work-bar"><i class="${pct >= 100 ? "am" : ""}" style="width:${pct}%"></i></div>
    <div class="work-sub">
      <span>${pct.toFixed(pct < 10 ? 2 : 1)} % · ${fmt(left)} offen</span>
      <span>${perMin >= 1 ? Math.round(perMin) + " " + unit + "/min" : perMin > 0
        ? perMin.toFixed(1) + " " + unit + "/min" : "—"} · ETA <em>${eta}</em></span>
    </div></div>`;
}

const AGENT_DESC = { run: "Enumeration + Detail-Crawl", enrich: "Owner-Profile + Geocoding",
  serve: "Dashboard-Server", detail: "Detail-Crawl", discover: "Enumeration",
  monitor: "Konsolen-Monitor", analyze: "Report" };

async function agentAction(action, payload) {
  const msg = $("ops-msg");
  try {
    const r = await fetch("/api/agent", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }) }).then((x) => x.json());
    msg.className = "ops-msg " + (r.ok ? "ok" : "bad");
    msg.textContent = r.ok
      ? `${action === "start" ? "gestartet" : "gestoppt"}: ${r.cmd} (pid ${r.pid})`
      : "Fehler: " + r.err;
    // Nach dem Start direkt aufs Log des Kommandos schalten — sonst sieht man
    // bei Ein-Schuss-Befehlen wie `status` nie ein Ergebnis.
    if (r.ok && r.cmd && $("ops-logsel")) {
      $("ops-logsel").value = r.cmd;
      setTimeout(() => pollLog(true), 900);
    }
  } catch (e) {
    msg.className = "ops-msg bad"; msg.textContent = "Fehler: " + e.message;
  }
  setTimeout(pollOps, 700);
}

function paintOps(d) {
  const ts = d.ts;
  // Agents
  const ag = d.agents || [];
  const crawlers = ag.filter((a) => a.cmd !== "serve");
  $("ops-agentcount").textContent = crawlers.length ? `${crawlers.length} Crawler aktiv` : "kein Crawler";
  $("ops-agents").innerHTML = ag.length ? ag.map((a) => `
    <div class="agent${a.cmd === "serve" ? " idle" : ""}">
      <i class="led"></i>
      <span class="an">${a.cmd}<s>${AGENT_DESC[a.cmd] || ""} · pid ${a.pid}</s></span>
      <span class="au">${humanAge(a.uptime)}
        ${a.cmd !== "serve" ? `<button class="kill" data-stop="${a.pid}">STOP</button>` : ""}</span>
    </div>`).join("")
    : `<div class="ops-none">Kein Agent läuft.</div>`;
  // Startknöpfe aus dem Server-Katalog (alle steuerbaren Kommandos).
  const running = new Set(ag.map((a) => a.cmd));
  const cat = d.startable || [];
  $("ops-controls").innerHTML = cat.map((s) =>
    `<button data-start="${s.cmd}" ${running.has(s.cmd) ? "disabled" : ""}
       title="${s.desc}${s.dauer ? " · Dauerbetrieb" : " · läuft einmal durch"}">
       ${s.dauer ? "▶" : "⏵"} ${s.cmd.toUpperCase()}</button>`).join("") +
    `<div class="ops-msg" id="ops-msg"></div>`;
  if (!OPS.logCmds) {   // Log-Auswahl einmal befüllen
    OPS.logCmds = cat.map((s) => s.cmd);
    $("ops-logsel").innerHTML = OPS.logCmds
      .map((c) => `<option value="${c}">${c}</option>`).join("");
    $("ops-logsel").onchange = () => pollLog(true);
    pollLog(true);
  }
  $("ops-controls").querySelectorAll("[data-start]").forEach((b) =>
    b.onclick = () => agentAction("start", { cmd: b.dataset.start }));
  $("ops-agents").querySelectorAll("[data-stop]").forEach((b) =>
    b.onclick = () => agentAction("stop", { pid: +b.dataset.stop }));
  $("ops-stamp").textContent = "Stand " + new Date(ts * 1000).toLocaleTimeString("de-DE");

  // Arbeit + ETA
  const r = d.repos, o = d.owners, en = d.enum;
  const rDet = opsRate("detailed", r.detailed, ts);
  const rEnr = opsRate("enriched", o.enriched, ts);
  const rChunk = opsRate("chunks", en.done, ts);
  const rCache = opsRate("cache", d.http_cache, ts);
  // Stillstand ehrlich benennen: laufender Agent + 0 Requests hat genau zwei
  // Gruende — Budget leer (dann wartet er zu Recht) oder er haengt.
  const bx = d.budget || {};
  const stalled = crawlers.length && rCache === 0 && OPS.last;
  const why = bx.exhausted
    ? `<div class="ops-warn warn"><b>Wartet auf Rate-Limit-Reset.</b>
        Kein Fortschritt möglich, bis das Budget zurückgesetzt ist.</div>`
    : stalled
      ? `<div class="ops-warn"><b>Läuft, aber ohne Durchsatz.</b>
          Budget ist da, es kommen trotzdem keine Requests durch — Log prüfen
          (<span class="dim">data/crawler.log</span>), notfalls STOP und neu starten.</div>`
      : "";
  $("ops-work").innerHTML = why +
    workRow("Detail-Crawl <span class=dim>(Repos angereichert)</span>", r.detailed, r.total, rDet, "Repos") +
    workRow("Enumeration <span class=dim>(ID-Chunks)</span>", en.done, en.total, rChunk, "Chunks") +
    workRow("Owner-Anreicherung <span class=dim>(Profile+Geo)</span>", o.enriched, o.core, rEnr, "Owner") +
    `<div class="work-sub" style="margin-top:10px">
       <span>in Arbeit: <em>${fmt(r.inprogress)}</em> Repos · verortet: <em>${fmt(o.located)}</em></span>
       <span>${Math.round(rCache * 60)} Requests/min</span></div>`;

  // Token-Budget — gemessen an einem echten Request, nicht an /rate_limit.
  const b = d.budget || {}, acc = d.accounts || {};
  const pct = b.limit ? b.remaining / b.limit * 100 : 0;
  const resetIn = b.reset ? Math.max(0, b.reset - ts) : 0;
  $("ops-tokhead").textContent = acc.tokens
    ? `${acc.tokens} Token · ${acc.accounts} Account${acc.accounts === 1 ? "" : "s"}` : "";
  const warn = [];
  if (b.exhausted) warn.push(`<div class="ops-warn"><b>Budget aufgebraucht.</b>
    GitHub lehnt jeden Request mit 403 ab. Die Crawler warten bis zum Reset
    in <b>${humanDur(resetIn)}</b> — das ist kein Fehler, sondern das Limit.</div>`);
  if (acc.shared) warn.push(`<div class="ops-warn warn"><b>${acc.tokens} Tokens, 1 Account.</b>
    GitHub rechnet das Limit pro <em>Account</em> ab, nicht pro Token — die Tokens teilen
    sich also <b>${fmt(b.limit || 5000)}/h</b> statt sie zu addieren. Mehr Durchsatz gibt es
    nur mit Tokens aus verschiedenen Accounts.</div>`);
  if (b.err) warn.push(`<div class="ops-warn"><b>Budget nicht messbar:</b> ${b.err}</div>`);
  $("ops-budget").innerHTML = warn.join("") + `
    <div class="budget-big"><b class="${b.exhausted ? "dead" : ""}">${fmt(b.remaining || 0)}</b>
      <span>von ${fmt(b.limit || 0)} Requests frei</span></div>
    <div class="work-bar"><i class="${b.exhausted ? "am" : ""}" style="width:${pct}%"></i></div>
    <div class="work-sub"><span>${pct.toFixed(0)} % Budget · ${fmt(b.used || 0)} verbraucht</span>
      <span>Reset in <em>${humanDur(resetIn)}</em></span></div>`;
  $("ops-tokens").innerHTML = "";

  OPS.last = { ts, vals: { detailed: r.detailed, enriched: o.enriched,
    chunks: en.done, cache: d.http_cache } };
}

async function pollOps() {
  try {
    const d = await fetch("/api/ops").then((r) => r.json());
    OPS.fails = 0;
    paintOps(d);
  } catch (e) {
    if (++OPS.fails === 1) $("ops-agents").innerHTML =
      `<div class="ops-none">Ops-Endpunkt nicht erreichbar (Server neu starten für /api/ops).</div>`;
  }
}

/* Agent-Log nachladen. Ein-Schuss-Kommandos (analyze/status/selfcheck) zeigen
 * ihr Ergebnis sonst nirgends — hier steht ihre Ausgabe. */
async function pollLog(force) {
  const sel = $("ops-logsel"); if (!sel || !sel.value) return;
  if (!force && !$("ops-logfollow").checked) return;
  try {
    const d = await fetch(`/api/agent/log?cmd=${encodeURIComponent(sel.value)}&lines=150`)
      .then((r) => r.json());
    const box = $("ops-logtext");
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent = d.ok ? (d.text || "(leer)") : "Fehler: " + d.err;
    if (atEnd || force) box.scrollTop = box.scrollHeight;   // mitlaufen, aber Scrollen respektieren
    $("ops-logstate").textContent = d.running ? "läuft" : "nicht aktiv";
  } catch (e) { /* Log ist Beiwerk — Fehler nicht ins UI schreien */ }
}

function startOps() {
  pollOps();
  // 4 s: der Server cached ohnehin ~4 s, schneller pollen bringt nur Last.
  OPS.timer = setInterval(() => { pollOps(); pollLog(false); }, 4000);
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
  buildPatterns();
  buildWorld();
  wireSectionNav();
  startOps();
  resize();
  wireCanvas();
  rebuild();
  prewarm();
  fit();
  window.addEventListener("resize", () => { resize(); paint(); paintDash(); worldResize(); paintWorld(); });
  loop();
}

boot();
