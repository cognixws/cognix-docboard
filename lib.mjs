// Pure functions behind Docboard's process: corpus parsing, search and the
// command contract. No network, no spawn here; process.mjs runs them.
import fs from "node:fs";
import path from "node:path";

export const ROOT_FILES = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "Makefile"];

export const COLLECTIONS = [
  { id: "decisions", name: "Decisions", blurb: "o porquê de cada escolha" },
  { id: "plans", name: "Plans", blurb: "specs em curso e históricos" },
  { id: "architecture", name: "Architecture", blurb: "um por subsistema" },
  { id: "benchmarks", name: "Benchmarks", blurb: "as barras que seguimos" },
  { id: "books", name: "Books", blurb: "runbooks, playbooks, SOPs" },
  { id: "handoff", name: "Handoff", blurb: "notas de sessão e tópicos" },
  { id: "changelog", name: "Changelog", blurb: "fragmentos não dobrados" },
  { id: "docsroot", name: "Docs — raiz", blurb: "índice, guias, desenvolvimento" },
  { id: "root", name: "Raiz do repo", blurb: "AGENTS, README, CHANGELOG, Makefile" },
];

export function collOf(rel) {
  if (!rel.startsWith("docs/")) return "root";
  const rest = rel.slice(5);
  if (rest.startsWith("decisions/")) return "decisions";
  if (rest.startsWith("plans/")) return "plans";
  if (rest.startsWith("architecture/")) return "architecture";
  if (rest.startsWith("benchmarks/") || rest === "benchmarks.md") return "benchmarks";
  if (rest.startsWith("books/")) return "books";
  if (rest.startsWith("handoff/") || rest === "handoff.md" || rest === "handoff-archive.md") return "handoff";
  if (rest.startsWith("changelog.d/")) return "changelog";
  return "docsroot";
}

export function stripMd(md) {
  return String(md)
    .replace(/^---[\s\S]*?---\s*/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]/g, " ")
    .replace(/\s+([:;,.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleOf(md, rel) {
  const m = /^#\s+(.+)$/m.exec(String(md));
  if (m) return m[1].trim().slice(0, 140);
  return path.basename(rel).replace(/\.md$/, "");
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
}

export function extractQuestions(plans) {
  const out = [];
  for (const { rel, text } of plans) {
    const lines = String(text).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const h = /^(#{2,3})\s+(.*)$/.exec(lines[i]);
      if (!h || !/open questions/i.test(h[2]) || /answered/i.test(h[2])) continue;
      const owner = /\(owner\)|for the owner/i.test(h[2]);
      const level = h[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const nh = /^(#{1,6})\s+/.exec(lines[j]);
        if (nh && nh[1].length <= level) break;
        let t = "";
        if (/^\s*[-*]\s+/.test(lines[j])) t = lines[j].replace(/^\s*[-*]\s+/, "");
        else if (/^\s*\d+[.)]\s+/.test(lines[j])) t = lines[j].replace(/^\s*\d+[.)]\s+/, "");
        else if (/^\s*\|/.test(lines[j]) && !/^\s*\|[\s:|-]+\|?\s*$/.test(lines[j])) {
          const cells = lines[j].split("|").map((c) => c.trim()).filter(Boolean);
          if (cells.length > 1) t = cells.join(" — ");
        }
        if (!t && /^\s{2,}\S/.test(lines[j]) && out.length && out[out.length - 1].plan === rel) {
          out[out.length - 1].text = (out[out.length - 1].text + " " + stripMd(lines[j])).slice(0, 400);
          continue;
        }
        t = stripMd(t).slice(0, 400);
        if (t) out.push({ text: t, line: j + 1, owner, plan: rel, where: rel.replace(/^docs\//, "") + ":" + (j + 1) });
      }
    }
  }
  return out;
}

export function extractDebts(openFiles) {
  const out = [];
  for (const { rel, text } of openFiles) {
    let cur = null;
    String(text).split("\n").forEach((line, i) => {
      const m = /^\s*-\s*\[\s\]\s+(.+)$/.exec(line);
      if (m) {
        cur = { text: stripMd(m[1]).slice(0, 400), line: i + 1, topic: rel, where: rel.replace(/^docs\//, "") + ":" + (i + 1) };
        out.push(cur);
        return;
      }
      if (!line.trim()) { cur = null; return; }
      if (cur && /^\s{2,}\S/.test(line)) { cur.text = (cur.text + " " + stripMd(line)).slice(0, 400); return; }
      if (!/^\s{2,}\S/.test(line)) cur = null;
    });
  }
  return out;
}

export function buildCorpus(repo) {
  const abs = path.resolve(repo);
  const files = [];
  const text = new Map();
  const docsDir = path.join(abs, "docs");
  const rels = [];
  if (fs.existsSync(docsDir)) {
    const found = [];
    walk(docsDir, found);
    rels.push(...found.map((p) => path.relative(abs, p)));
  }
  const roots = new Set(ROOT_FILES);
  try {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith(".")) continue;
      if (e.name.endsWith(".md") || e.name === "Makefile") roots.add(e.name);
    }
  } catch { /* keep the known list */ }
  for (const rel of roots) {
    if (fs.existsSync(path.join(abs, rel))) rels.push(rel);
  }
  for (const rel of rels) {
    let raw;
    try { raw = fs.readFileSync(path.join(abs, rel), "utf8"); } catch { continue; }
    const st = fs.statSync(path.join(abs, rel));
    const c = collOf(rel);
    files.push({
      p: rel,
      c,
      t: rel.endsWith(".md") ? titleOf(raw, rel) : rel,
      x: stripMd(raw).slice(0, 200),
      s: st.size,
      d: st.mtime.toISOString().slice(0, 10),
    });
    text.set(rel, raw);
  }
  files.sort((a, b) => a.p.localeCompare(b.p));

  const count = (c) => files.filter((f) => f.c === c).length;
  const plans = files.filter((f) => f.c === "plans").map((f) => ({ rel: f.p, text: text.get(f.p) || "" }));
  const openFiles = files.filter((f) => f.p.startsWith("docs/handoff/open/")).map((f) => ({ rel: f.p, text: text.get(f.p) || "" }));
  const questions = extractQuestions(plans);
  const debts = extractDebts(openFiles);
  const notes = files.filter((f) => /^docs\/handoff\/\d{4}-\d{2}-\d{2}-/.test(f.p)).length;

  let guides = 0;
  let atlas = 0;
  try { guides = (fs.readFileSync(path.join(abs, "web/shared/domain/guides.js"), "utf8").match(/data-tour/g) || []).length; } catch { /* absent */ }
  try { atlas = (fs.readFileSync(path.join(abs, "docs/atlas/surfaces.json"), "utf8").match(/"id"\s*:/g) || []).length; } catch { /* absent */ }

  const stats = {
    docs: files.filter((f) => f.p.startsWith("docs/")).length,
    adrs: count("decisions"),
    plans: count("plans"),
    architecture: count("architecture"),
    benchmarks: count("benchmarks"),
    books: count("books"),
    notes,
    openTopics: openFiles.length,
    debts: debts.length,
    questions: questions.length,
    ownerQuestions: questions.filter((q) => q.owner).length,
    plansWithQuestions: new Set(questions.map((q) => q.plan)).size,
    changelog: count("changelog"),
    guides,
    atlas,
  };

  const corpus = {
    repo: abs,
    builtAt: Date.now(),
    files,
    text,
    stats,
    questions,
    debts,
    collections: COLLECTIONS.map((c) => ({ ...c, n: count(c.id) })),
  };
  corpus.graph = buildGraph(corpus);
  return corpus;
}


/* ---------------- link graph ---------------- */

function fileSetOf(files) {
  return new Set(files.map((f) => f.p));
}

function adrMapOf(files) {
  const m = new Map();
  for (const f of files) {
    if (f.c !== "decisions") continue;
    const hit = /(?:^|\/)(\d{3,4})-/.exec(f.p);
    if (hit) m.set(hit[1].padStart(4, "0"), f.p);
  }
  return m;
}

// linksOf returns the targets a document points at: markdown links, bare
// docs/ paths and ADR numbers. Code fences and inline code are ignored.
export function linksOf(text, fromPath) {
  let t = String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  const out = new Map();
  const add = (target, kind) => {
    const key = kind + "|" + target;
    if (!out.has(key)) out.set(key, { target, kind });
  };
  for (const m of t.matchAll(/(^|[^!])\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    add(m[3], "link");
  }
  for (const m of t.matchAll(/\bdocs\/[A-Za-z0-9._\/-]+\.md\b/g)) add(m[0], "path");
  for (const m of t.matchAll(/\bADR[- ]?(\d{3,4})\b/g)) add("ADR:" + m[1].padStart(4, "0"), "adr");
  return [...out.values()];
}

export function targetPath(target, fromPath) {
  if (/^(https?:|mailto:|#)/i.test(target)) return "";
  const clean = target.split("#")[0].trim();
  if (!clean) return "";
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  if (clean.startsWith("/")) return clean.slice(1);
  if (clean.startsWith("./") || clean.startsWith("../")) return normPathLocal(dir + "/" + clean);
  if (clean.startsWith("docs/") || ROOT_FILES.includes(clean)) return clean;
  return normPathLocal(dir + "/" + clean);
}

export function resolveTarget(target, fromPath, fileSet) {
  if (/^(https?:|mailto:|#)/i.test(target)) return null;
  if (target.startsWith("ADR:")) return null; // resolved by the caller
  const rel = targetPath(target, fromPath);
  if (!rel) return null;
  if (fileSet.has(rel)) return rel;
  return null;
}

function normPathLocal(p) {
  const out = [];
  for (const s of String(p).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

export function buildGraph(corpus) {
  const set = fileSetOf(corpus.files);
  const adrs = adrMapOf(corpus.files);
  const byPath = new Map(corpus.files.map((f) => [f.p, f]));
  const edges = new Map();
  const broken = new Map();
  for (const f of corpus.files) {
    const text = corpus.text.get(f.p) || "";
    for (const { target, kind } of linksOf(text, f.p)) {
      let dest = null;
      let k = kind;
      if (kind === "adr") {
        const num = target.slice(4);
        dest = adrs.get(num) || null;
      } else {
        dest = resolveTarget(target, f.p, set);
      }
      if (!dest) {
        const rel = targetPath(target, f.p);
        const inDocs = rel.startsWith("docs/") || /^[^/]+\.md$/.test(rel);
        if (kind !== "adr" && inDocs && /\.md(?::\d+)?$/.test(rel)) {
          broken.set(f.p + "->" + target, { from: f.p, target });
        }
        continue;
      }
      if (dest === f.p) continue;
      const key = f.p + "\u0000" + dest;
      const prev = edges.get(key);
      if (prev) {
        prev.w += 1;
        if (k === "link") prev.kind = "link";
        else if (k === "path" && prev.kind === "adr") prev.kind = "path";
      } else {
        edges.set(key, { s: f.p, t: dest, kind: k, w: 1 });
      }
    }
  }
  const list = [...edges.values()];
  const nodes = new Map(corpus.files.map((f) => [f.p, {
    id: f.p, p: f.p, t: f.t, c: f.c, in: 0, out: 0, degree: 0,
  }]));
  for (const e of list) {
    const a = nodes.get(e.s), b = nodes.get(e.t);
    if (a) { a.out += 1; a.degree += 1; }
    if (b) { b.in += 1; b.degree += 1; }
  }
  const hubs = [...nodes.values()].filter((n) => n.degree > 0).sort((a, b) => b.degree - a.degree);
  const orphans = [...nodes.values()].filter((n) => n.degree === 0).length;
  return { edges: list, nodes, hubs, broken: [...broken.values()], byPath, adrs, set, orphans };
}

function publicNode(n, current) {
  return { id: n.id, t: n.t, c: n.c, in: n.in, out: n.out, degree: n.degree, current: n.id === current };
}

function inducedEdges(graph, wanted) {
  return graph.edges.filter((e) => wanted.has(e.s) && wanted.has(e.t)).map((e) => ({ s: e.s, t: e.t, kind: e.kind, w: e.w }));
}

function adjacency(graph) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.s)) adj.set(e.s, []);
    if (!adj.has(e.t)) adj.set(e.t, []);
    adj.get(e.s).push({ to: e.t, dir: "out", w: e.w, kind: e.kind });
    adj.get(e.t).push({ to: e.s, dir: "in", w: e.w, kind: e.kind });
  }
  return adj;
}

export function egoGraph(graph, path, depth = 2, maxNodes = 140) {
  const start = graph.nodes.get(path);
  if (!start) return null;
  const adj = adjacency(graph);
  const seen = new Set([path]);
  let frontier = [path];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const p of frontier) {
      for (const link of adj.get(p) || []) {
        if (seen.has(link.to)) continue;
        if (seen.size >= maxNodes) break;
        seen.add(link.to);
        next.push(link.to);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  const backlinks = [];
  const outbound = [];
  for (const e of graph.edges) {
    if (e.t === path) backlinks.push({ p: e.s, t: (graph.nodes.get(e.s) || {}).t || e.s, c: (graph.nodes.get(e.s) || {}).c || "", kind: e.kind, w: e.w });
    if (e.s === path) outbound.push({ p: e.t, t: (graph.nodes.get(e.t) || {}).t || e.t, c: (graph.nodes.get(e.t) || {}).c || "", kind: e.kind, w: e.w });
  }
  backlinks.sort((a, b) => b.w - a.w);
  outbound.sort((a, b) => b.w - a.w);
  return {
    scope: "doc",
    focus: path,
    nodes: [...seen].map((id) => publicNode(graph.nodes.get(id), path)),
    edges: inducedEdges(graph, seen),
    backlinks: backlinks.slice(0, 40),
    outbound: outbound.slice(0, 40),
  };
}

export function hubGraph(graph, limit = 15, maxNodes = 35, neighbors = 1) {
  const seen = new Set();
  const hubs = graph.hubs.slice(0, limit);
  for (const h of hubs) seen.add(h.id);
  const adj = adjacency(graph);
  for (const h of hubs) {
    const around = (adj.get(h.id) || []).slice().sort((a, b) => b.w - a.w).slice(0, neighbors);
    for (const a of around) {
      if (seen.size >= maxNodes) break;
      seen.add(a.to);
    }
  }
  return {
    scope: "hubs",
    focus: "",
    nodes: [...seen].map((id) => publicNode(graph.nodes.get(id), "")),
    edges: inducedEdges(graph, seen),
  };
}

export function collectionGraph(corpus, graph) {
  const pairs = new Map();
  for (const e of graph.edges) {
    const a = (graph.byPath.get(e.s) || {}).c;
    const b = (graph.byPath.get(e.t) || {}).c;
    if (!a || !b || a === b) continue;
    const key = a + ">" + b;
    pairs.set(key, (pairs.get(key) || 0) + e.w);
  }
  const nodes = COLLECTIONS.map((c) => ({ id: c.id, t: c.name, c: c.id, degree: 0, in: 0, out: 0, n: (corpus.collections.find((x) => x.id === c.id) || {}).n || 0 }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [...pairs.entries()].map(([key, w]) => {
    const [s, t] = key.split(">");
    if (byId.has(s)) byId.get(s).out += w;
    if (byId.has(t)) byId.get(t).in += w;
    return { s, t, kind: "link", w };
  }).sort((a, b) => b.w - a.w);
  for (const n of nodes) n.degree = n.in + n.out;
  return { scope: "collections", focus: "", nodes, edges };
}

export function backlinksOf(graph, path) {
  const back = [];
  const out = [];
  for (const e of graph.edges) {
    if (e.t === path) back.push({ p: e.s, t: (graph.nodes.get(e.s) || {}).t || e.s, c: (graph.nodes.get(e.s) || {}).c || "", kind: e.kind, w: e.w });
    if (e.s === path) out.push({ p: e.t, t: (graph.nodes.get(e.t) || {}).t || e.t, c: (graph.nodes.get(e.t) || {}).c || "", kind: e.kind, w: e.w });
  }
  return { backlinks: back.sort((a, b) => b.w - a.w), outbound: out.sort((a, b) => b.w - a.w) };
}


/* ---------------- pulse ---------------- */

export function pulseOf(corpus, { now = Date.now(), lastDate = {} } = {}) {
  const LIVING = new Set(["plans", "architecture", "books", "docsroot"]);
  const ageOf = (d) => Math.max(0, Math.floor((now - new Date(d + "T00:00:00Z").getTime()) / 86400000));
  const byPath = new Map(corpus.files.map((f) => [f.p, f]));
  const living = corpus.files.filter((f) => LIVING.has(f.c)).map((f) => {
    const seen = lastDate[f.p] || f.d;
    return { p: f.p, t: f.t, c: f.c, d: seen, age: ageOf(seen) };
  });
  const stale = living.filter((f) => f.age >= 60).sort((a, b) => b.age - a.age).slice(0, 12);
  const broken = corpus.graph.broken.map((b) => ({
    from: b.from,
    fromTitle: (byPath.get(b.from) || {}).t || b.from,
    target: b.target,
  })).slice(0, 40);
  const stats = {
    docs: corpus.stats.docs,
    collections: corpus.collections.length,
    edges: corpus.graph.edges.length,
    orphans: corpus.graph.orphans,
    broken: corpus.graph.broken.length,
    stale: living.filter((f) => f.age >= 60).length,
    fragments: corpus.stats.changelog,
    books: corpus.stats.books,
    guides: corpus.stats.guides,
    atlas: corpus.stats.atlas,
  };
  return { stats, stale, broken };
}


/* ---------------- change (ADR-0086 checklist) ---------------- */

export function changeObligations(changed, corpus, opts = {}) {
  const list = (Array.isArray(changed) ? changed : []).map((c) => (typeof c === "string" ? { path: c, status: "M" } : c));
  const paths = list.map((c) => c.path);
  const doc = (p) => corpus.text.has(p);
  const target = (p, label) => ({ path: p, label: label || p, doc: doc(p) });
  const out = new Map();
  const add = (id, o) => {
    const cur = out.get(id);
    if (cur) {
      cur.evidence = [...new Set([...cur.evidence, ...(o.evidence || [])])];
      const seen = new Set(cur.targets.map((t) => t.path));
      for (const t of o.targets || []) if (!seen.has(t.path)) cur.targets.push(t);
      if (o.status === "todo") cur.status = "todo";
      if (o.confidence === "high") cur.confidence = "high";
      return;
    }
    out.set(id, { id, evidence: [], targets: [], confidence: "check", status: "todo", action: "", ...o });
  };

  const code = paths.filter((p) => /^(internal|cmd|web|desktop-shell|packages)\//.test(p));
  const arch = corpus.files.filter((f) => f.c === "architecture");

  const groups = new Map();
  for (const p of code) {
    const m = /^internal\/([^/]+)\//.exec(p);
    const pkg = m ? m[1] : p.split("/")[0];
    if (!groups.has(pkg)) groups.set(pkg, []);
    groups.get(pkg).push(p);
  }
  for (const [pkg, files] of groups) {
    const exact = arch.find((f) => f.p === `docs/architecture/${pkg}.md`);
    const COMMON = new Set(["agents", "agent", "server", "web", "app", "main", "cli", "tool", "tools", "settings", "index", "run", "test", "tests", "store", "client", "config", "model", "models", "delivery"]);
    const bases = files.map((p) => path.basename(p).replace(/\.[^.]+$/, "")).filter((b) => b.length >= 7 && !COMMON.has(b.toLowerCase())).map((b) => b.toLowerCase());
    const scored = arch.map((f) => {
      const body = (corpus.text.get(f.p) || "").toLowerCase();
      return { f, score: bases.filter((b) => body.includes(b)).length };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.f);
    let cands = exact ? [exact] : scored;
    if (!cands.length) cands = corpus.files.filter((f) => f.p === "docs/architecture.md");
    add("arch:" + pkg, {
      kind: "arch",
      title: "Arquitetura — " + pkg,
      why: "O código de " + pkg + " mudou; o arquivo do subsistema acompanha a mudança.",
      confidence: exact ? "high" : "check",
      targets: cands.map((f) => target(f.p, f.t)),
      evidence: files,
      status: "todo",
    });
  }

  const decisions = corpus.files.filter((f) => f.c === "decisions");
  const mentioned = [];
  for (const p of code) {
    const base = path.basename(p).toLowerCase().replace(/\.(go|js|jsx|ts|tsx|rs|sql|md)$/, "");
    if (base.length < 5) continue;
    for (const d of decisions) {
      if ((corpus.text.get(d.p) || "").toLowerCase().includes(base)) { mentioned.push({ d, p }); break; }
    }
  }
  if (mentioned.length) {
    const uniq = [...new Map(mentioned.map((m) => [m.d.p, m])).values()].slice(0, 4);
    add("adr:mentions", {
      kind: "adr",
      title: "Decisões que citam estes arquivos",
      why: "Releia as ADRs que já falaram destes arquivos antes de mudar o contrato.",
      confidence: "check",
      targets: uniq.map((m) => target(m.d.p, m.d.t)),
      evidence: [...new Set(uniq.map((m) => m.p))],
      status: "note",
    });
  }
  const boundary = paths.filter((p) => /\/migrations\/|credential|convarchive|transcript|backup|security/i.test(p));
  if (boundary.length) {
    add("adr:boundary", {
      kind: "adr",
      title: "ADR para o boundary",
      why: "Persistência, credencial, transcript ou backup mudou: a decisão pede um registro novo.",
      confidence: "check",
      targets: [],
      evidence: boundary,
      status: "todo",
      action: "operar",
    });
  }

  const visible = paths.filter((p) => /^(web|internal\/server|desktop-shell|cmd)\//.test(p) && !/_test\./.test(p) && !/\.md$/.test(p));
  if (visible.length) {
    const slug = String(opts.branch || "").replace(/^(feat|fix|docs|chore|refactor|test|perf)\//, "").toLowerCase();
    const frags = corpus.files.filter((f) => f.c === "changelog");
    const found = slug ? frags.find((f) => path.basename(f.p).toLowerCase().includes(slug)) : null;
    add("changelog", {
      kind: "changelog",
      title: found ? "Fragmento de changelog — confira" : "Fragmento de changelog",
      why: found ? "Há um fragmento que parece ser deste branch; confira se cobre a mudança." : "A mudança é visível para a pessoa e falta um fragmento em docs/changelog.d/.",
      confidence: found ? "check" : "high",
      targets: found ? [target(found.p, "Fragmento")] : [],
      evidence: visible,
      status: found ? "note" : "todo",
      action: found ? "" : "operar",
    });
  }

  const ui = paths.filter((p) => /^web\//.test(p));
  if (ui.length) {
    add("interface", {
      kind: "interface",
      title: "Guide e superfície no atlas",
      why: "Uma tela, rota ou diálogo mudou: o guide e a foto do atlas acompanham.",
      confidence: "check",
      targets: [target("web/shared/domain/guides.js", "guides.js"), target("docs/atlas/surfaces.json", "surfaces.json")],
      evidence: ui,
      status: "todo",
    });
  }

  const backup = paths.filter((p) => /internal\/backup|internal\/store\/migrations|\/credentials|convarchive|transcript/i.test(p));
  if (backup.length) {
    add("backup", {
      kind: "backup",
      title: "Inventário e fixture de backup",
      why: "Um banco, credencial ou arquivo de usuário mudou: o inventário e a recuperação acompanham.",
      confidence: "high",
      targets: [target("internal/backup/inventory.json", "inventory.json")],
      evidence: backup,
      status: "todo",
    });
  }

  const touched = paths.filter((p) => p === "Makefile" || p.startsWith("scripts/"));
  for (const p of touched) {
    const base = path.basename(p);
    const books = corpus.files.filter((f) => f.c === "books" && (corpus.text.get(f.p) || "").includes(base));
    if (books.length) {
      add("books:" + base, {
        kind: "books",
        title: "Books que citam " + base,
        why: "O alvo/script mudou; o book e o stamp de execução acompanham.",
        confidence: "high",
        targets: books.map((b) => target(b.p, b.t)),
        evidence: [p],
        status: "todo",
      });
    }
  }
  const bookDocs = paths.filter((p) => p.startsWith("docs/books/"));
  if (bookDocs.length) {
    add("books:docs", {
      kind: "books",
      title: "Catálogo e stamp dos books",
      why: "Um book mudou: regenerar o catálogo e renovar o stamp da execução.",
      confidence: "high",
      targets: corpus.files.filter((f) => f.p === "docs/books/README.md").map((f) => target(f.p, f.t)),
      evidence: bookDocs,
      status: "todo",
    });
  }

  const docsChanged = paths.filter((p) => p.startsWith("docs/"));
  if (docsChanged.length) {
    add("docs", {
      kind: "docs",
      title: "docs-check e vale",
      why: "As docs mudaram: a paridade e a prosa são verificadas.",
      confidence: "high",
      targets: [],
      evidence: docsChanged,
      status: "todo",
      action: "operar",
    });
  }
  if (code.length) {
    add("gates", {
      kind: "gates",
      title: "Gates do diff",
      why: "O código mudou: rodar ci-scoped antes do close.",
      confidence: "high",
      targets: [],
      evidence: code,
      status: "todo",
      action: "operar",
    });
  }

  const order = ["backup", "adr", "arch", "changelog", "interface", "books", "docs", "gates"];
  return [...out.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}


/* ---------------- coverage ---------------- */

const CODE_EXT = new Set([".go", ".js", ".jsx", ".ts", ".tsx", ".rs", ".mjs", ".cjs"]);

function dirsOf(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "testdata" && e.name !== "node_modules")
      .map((e) => e.name)
      .sort();
  } catch { return []; }
}

function countCode(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "testdata") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith("_test.go") || e.name.endsWith(".test.js") || e.name.endsWith(".test.mjs")) continue;
      if (CODE_EXT.has(path.extname(e.name))) n += 1;
    }
  };
  walk(dir);
  return n;
}

function wordRe(name) {
  return new RegExp("(^|[^a-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-z0-9]|$)", "i");
}

export function coverageOf(repo, corpus, { lastDate = {}, now = Date.now() } = {}) {
  const areas = [];
  const add = (id, name, kind, rel) => {
    const files = countCode(path.join(repo, rel));
    if (files > 0) areas.push({ id, name, kind, path: rel, files });
  };
  for (const d of dirsOf(path.join(repo, "internal"))) {
    if (d === "web") continue; // the embedded UI build, not a subsystem
    add("internal/" + d, d, "internal", "internal/" + d);
  }
  for (const d of dirsOf(path.join(repo, "cmd"))) add("cmd/" + d, d, "cmd", "cmd/" + d);
  for (const d of ["web/browser", "web/mobile", "web/shared", "web/desktop"]) add(d, d.split("/")[1], "web", d);
  add("desktop-shell", "desktop-shell", "desktop", "desktop-shell");
  for (const d of dirsOf(path.join(repo, "packages"))) add("packages/" + d, d, "package", "packages/" + d);

  const arch = corpus.files.filter((f) => f.c === "architecture");
  const mapped = new Set();
  for (const a of areas) {
    const exact = arch.find((f) => f.p === `docs/architecture/${a.name}.md`);
    let docs = [];
    if (exact) docs = [{ path: exact.p, title: exact.t, exact: true }];
    else {
      const prefix = a.path + "/";
      const byPrefix = arch.filter((f) => (corpus.text.get(f.p) || "").includes(prefix)).slice(0, 2);
      const byTitle = arch.filter((f) => wordRe(a.name).test(f.t)).slice(0, 2);
      docs = (byPrefix.length ? byPrefix : byTitle).map((f) => ({ path: f.p, title: f.t, exact: false }));
    }
    a.docs = docs;
    a.covered = docs.length > 0;
    for (const d of docs) mapped.add(d.path);
    const dates = docs.map((d) => lastDate[d.path]).filter(Boolean).sort();
    a.last = dates.length ? dates[dates.length - 1] : "";
    a.age = a.last ? Math.max(0, Math.floor((now - new Date(a.last + "T00:00:00Z").getTime()) / 86400000)) : null;
    a.stale = a.covered && a.age !== null && a.age >= 60;
  }
  const orphans = arch
    .filter((f) => f.p !== "docs/architecture.md" && !mapped.has(f.p))
    .map((f) => ({ path: f.p, title: f.t, last: lastDate[f.p] || "" }));
  const missing = areas.filter((a) => !a.covered);
  const stale = areas.filter((a) => a.stale);
  return {
    areas,
    missing,
    orphans,
    stale,
    stats: {
      areas: areas.length,
      covered: areas.length - missing.length,
      missing: missing.length,
      orphans: orphans.length,
      stale: stale.length,
    },
  };
}


/* ---------------- repair links ---------------- */

function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function relativeLink(from, to) {
  const dir = path.dirname(from);
  return path.relative(dir, to).split(path.sep).join("/");
}

function suggestTarget(corpus, rel) {
  const base = path.basename(rel).toLowerCase();
  const exact = corpus.files.filter((f) => f.p !== rel && path.basename(f.p).toLowerCase() === base).slice(0, 3);
  if (exact.length) return exact.map((f) => ({ path: f.p, title: f.t, exact: true, distance: 0 }));
  // A typo is only suggested inside a folder the index already has; a missing
  // folder usually means a docs-site link, not a misspelling.
  const dir = path.dirname(rel) + "/";
  if (!corpus.files.some((f) => f.p.startsWith(dir))) return [];
  return corpus.files
    .filter((f) => f.p.startsWith(dir))
    .map((f) => ({ f, d: editDistance(base, path.basename(f.p).toLowerCase()) }))
    .filter((x) => x.d <= 2)
    .sort((a, b) => a.d - b.d || a.f.p.localeCompare(b.f.p))
    .slice(0, 3)
    .map((x) => ({ path: x.f.p, title: x.f.t, exact: false, distance: x.d }));
}

export function repairLinks(corpus) {
  const byPath = new Map(corpus.files.map((f) => [f.p, f]));
  const cache = new Map();
  const groups = new Map();
  let suggested = 0;
  for (const b of corpus.graph.broken) {
    const rel = targetPath(b.target, b.from) || b.target;
    let sug = cache.get(rel);
    if (!sug) { sug = suggestTarget(corpus, rel); cache.set(rel, sug); }
    if (sug.length) suggested += 1;
    const from = byPath.get(b.from);
    if (!groups.has(b.from)) {
      groups.set(b.from, { from: b.from, fromTitle: from ? from.t : b.from, fromColl: from ? from.c : "", links: [] });
    }
    groups.get(b.from).links.push({
      target: b.target,
      normalized: rel,
      suggestions: sug.map((s) => ({ ...s, link: relativeLink(b.from, s.path) })),
    });
  }
  const origins = [...groups.values()].map((g) => ({ ...g, count: g.links.length }))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
  return {
    origins,
    stats: {
      total: corpus.graph.broken.length,
      origins: origins.length,
      suggested,
      unsuggested: corpus.graph.broken.length - suggested,
    },
  };
}

/* ---------------- search ---------------- */

const STOP = new Set(["por", "que", "o", "a", "os", "as", "de", "do", "da", "dos", "das", "um", "uma", "e", "é", "em", "no", "na", "não", "se", "para", "com", "como", "quando", "the", "of", "to", "and", "in", "is", "on", "for", "with", "an"]);

const SYN = {
  reinicia: "restart restarts restarting stops stop stopped sigterm interrupt", reiniciar: "restart restarting stop", termina: "ends finishes finish end done", terminou: "ends finished",
  fecha: "close closes closing", fechar: "close closing", entrega: "delivery land", entregas: "deliveries delivery", divida: "debt debts owed", dívida: "debt debts owed",
  dividas: "debts owed", dívidas: "debts owed", questao: "question questions", questão: "question questions", perguntas: "questions", comando: "command commands make",
  comandos: "commands make", implantar: "deploy", deployar: "deploy", sessao: "session sessions", sessão: "session sessions", erro: "error errors fail failure",
  teste: "test tests testing", guia: "guide guides", arquitetura: "architecture", decisao: "decision decisions adr", decisão: "decision decisions adr",
  plano: "plan plans", busca: "search recall", documento: "document doc", abrir: "open", nota: "notes handoff", handoff: "handoff notes",
  telefone: "mobile phone", painel: "panel dock", pendencia: "debt open pending", pendência: "debt open pending",
};

const BOOST = [
  { keys: ["land", "close", "interrupt", "sigterm", "reinicia", "termina", "entrega", "delivery"], paths: ["docs/plans/delivery-dock-spec.md", "docs/decisions/0170", "docs/handoff/open/delivery-dock"] },
  { keys: ["deploy", "restart", "reiniciar", "owner"], paths: ["docs/decisions/0105", "docs/books/runbooks/installer-generation.md"] },
  { keys: ["busca", "search", "embedding", "semantic", "recall"], paths: ["docs/architecture/recall.md", "docs/plans/recall.md"] },
  { keys: ["extensao", "extensão", "extension", "dock", "painel"], paths: ["docs/architecture/extensions.md", "docs/plans/delivery-dock-spec.md"] },
];

export function tokens(q) {
  return String(q).toLowerCase().split(/[^a-z0-9à-ú]+/i).filter((t) => t.length > 1 && !STOP.has(t));
}

function boost(f, ts) {
  let b = 0;
  for (const g of BOOST) {
    if (!g.keys.some((k) => ts.includes(k))) continue;
    if (g.paths.some((p) => f.p.startsWith(p))) b += 25;
  }
  if (f.p.includes("/archive/")) b -= 3;
  return b;
}

export function snippetOf(text, ts, size = 200) {
  const source = stripMd(String(text || ""));
  let idx = -1;
  for (const t of ts) { const i = source.toLowerCase().indexOf(t); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  let start = Math.max(0, (idx < 0 ? 0 : idx) - 60);
  if (start > 0) { const sp = source.lastIndexOf(" ", start); if (sp > start - 24) start = sp + 1; }
  return (start > 0 ? "…" : "") + source.slice(start, start + size).trim() + "…";
}

export function searchCorpus(corpus, q, opts = {}) {
  const ts = tokens(q);
  if (!ts.length) return { files: [], open: [] };
  const coll = opts.coll && opts.coll !== "all" ? opts.coll : "";
  const limit = Math.min(60, Math.max(1, opts.limit || 40));
  const files = corpus.files
    .filter((f) => !coll || f.c === coll)
    .map((f) => {
      const body = (corpus.text.get(f.p) || "").toLowerCase();
      const title = f.t.toLowerCase();
      let score = 0;
      ts.forEach((t) => {
        if (title.includes(t)) score += 3;
        if (body.includes(t)) score += 1;
        const syn = SYN[t];
        if (syn) for (const s of syn.split(" ")) if (s.length > 2 && body.includes(s)) { score += 0.5; break; }
      });
      return { f, score: score + boost(f, ts) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ ...x.f, x: snippetOf(corpus.text.get(x.f.p) || x.f.x, ts) }));

  const hits = (it) => {
    const hay = it.text.toLowerCase();
    return ts.some((t) => hay.includes(t) || (SYN[t] && SYN[t].split(" ").some((s) => s.length > 2 && hay.includes(s))));
  };
  const open = [];
  if (coll === "" || coll === "handoff") corpus.debts.filter(hits).slice(0, 6).forEach((d) => open.push({ kind: "d", ...d }));
  if (coll === "" || coll === "plans") corpus.questions.filter(hits).slice(0, 6).forEach((d) => open.push({ kind: "q", ...d }));
  return { files, open: open.slice(0, 8) };
}

export function sortedFor(corpus, coll) {
  const list = corpus.files.filter((f) => f.c === coll);
  if (coll === "handoff") {
    return list.sort((a, b) => {
      const ao = a.p.includes("/open/") ? 0 : 1;
      const bo = b.p.includes("/open/") ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return b.p.localeCompare(a.p);
    });
  }
  return list.sort((a, b) => a.p.localeCompare(b.p));
}

/* ---------------- commands ---------------- */

export const COMMANDS = [
  { group: "Sessão", items: [
    { id: "worktree-status", label: "Status dos worktrees", when: "ver o que está em voo e quem está sujo", tier: "read", cost: "—", kind: "run" },
    { id: "worktree", label: "Novo worktree", when: "abrir uma árvore isolada para uma tarefa nova", tier: "write", cost: "~30 s", kind: "worktree", params: ["name"] },
    { id: "ci-scoped", label: "CI scoped", when: "os gates que este diff pode quebrar, durante a iteração", tier: "write", cost: "1–5 min", kind: "run" },
    { id: "close", label: "Fechar sessão", when: "encerrar a sessão de um worktree (o rito completo)", tier: "write", cost: "2–8 min", kind: "close", params: ["worktree"] },
    { id: "close-summary", label: "Resumo do close", when: "o que a nota de handoff e o fragmento de changelog precisam", tier: "read", cost: "instantâneo", kind: "run" },
    { id: "land", label: "Enfileirar land", when: "enfileirar o branch; a fila e os veredictos ficam na aba Deliveries", tier: "owner", cost: "fila", kind: "land", params: ["branch"] },
  ]},
  { group: "Documentação", items: [
    { id: "handoff", label: "Renderizar o board", when: "regerar docs/handoff.md a partir das notas e tópicos", tier: "read", cost: "instantâneo", kind: "run" },
    { id: "changelog", label: "Dobrar changelog", when: "fundir os fragmentos no CHANGELOG (no main)", tier: "write", cost: "~1 min", kind: "run" },
    { id: "adr", label: "Semear ADR", when: "abrir o próximo registro com a linha de Boundary", tier: "write", cost: "instantâneo", kind: "adr", params: ["name"] },
    { id: "book", label: "Semear book", when: "criar um runbook/playbook/SOP a partir do template", tier: "write", cost: "instantâneo", kind: "book", params: ["name", "type"] },
    { id: "books", label: "Catálogo de books", when: "regerar docs/books/README.md", tier: "write", cost: "instantâneo", kind: "run" },
    { id: "docs-check", label: "docs-check", when: "paridade de imagens e docs gerados (sem captura)", tier: "read", cost: "~10–30 s", kind: "run" },
    { id: "vale", label: "vale", when: "lint de prosa nas docs publicadas", tier: "read", cost: "~10–30 s", kind: "run" },
    { id: "handoff-archive", label: "Arquivar notas velhas", when: "mover notas com mais de 30 dias para o arquivo", tier: "danger", cost: "revisar antes", kind: "archive" },
  ]},
  { group: "Build e UI", items: [
    { id: "web", label: "Build da UI", when: "reconstruir o bundle React em internal/web/public", tier: "write", cost: "20–60 s", kind: "run" },
    { id: "build", label: "Build do binário", when: "UI + bin/picode", tier: "write", cost: "40–90 s", kind: "run" },
    { id: "dev", label: "Servidor Go", when: "rodar o servidor lendo a UI do disco", tier: "service", cost: "até parar", kind: "service" },
    { id: "ui", label: "Vite HMR", when: "UI com recarga quente em :5173", tier: "service", cost: "até parar", kind: "service" },
    { id: "atlas", label: "Fotografar o atlas", when: "todas as superfícies, vazio e populado, claro e escuro", tier: "write", cost: "20–40 min", kind: "run" },
    { id: "atlas-shot", label: "Foto de superfícies", when: "só algumas (ID, AREA, KIND, STATE, THEME)", tier: "write", cost: "minutos", kind: "atlas", params: ["id"] },
    { id: "cover", label: "Cobertura", when: "Go + JS no code X-ray", tier: "write", cost: "longo · prioridade baixa", kind: "run" },
    { id: "xray", label: "X-ray", when: "atualizar o X-ray se main mudou e nenhum CI roda", tier: "write", cost: "longo · prioridade baixa", kind: "run" },
  ]},
  { group: "Ambiente", items: [
    { id: "hooks-check", label: "Provar as guardas", when: "matriz de política em um repositório descartável", tier: "read", cost: "~10 s", kind: "run" },
    { id: "keys-drift", label: "Drift de chaves", when: "comparar o catálogo com as docs do pi instalado", tier: "read", cost: "~5 s", kind: "run" },
    { id: "flakes", label: "Testes flaky", when: "o que o retry-once pegou e candidatos a quarentena", tier: "read", cost: "~5 s", kind: "run" },
    { id: "desktop-test", label: "Testar o shell", when: "a metade pura do shell (sem toolchain Windows)", tier: "read", cost: "~1 min", kind: "run" },
  ]},
  { group: "Deploy e restart", items: [
    { id: "deploy", label: "Deploy", when: "reconstruir UI + binário e reiniciar o serviço (main ao vivo)", tier: "owner", cost: "lock · verifica", kind: "deploy" },
    { id: "desktop-restart", label: "Restart do shell", when: "recompilar e trocar os executáveis do desktop", tier: "owner", cost: "lock · Windows", kind: "restart", platform: "win32" },
  ]},
  { group: "Manutenção", items: [
    { id: "worktree-gc", label: "Limpar worktrees", when: "remover árvores merged, limpas e ociosas", tier: "danger", cost: "confirma", kind: "gc" },
    { id: "tool-eval", label: "A/B das ferramentas", when: "medir qual CLI escolhe a ferramenta certa", tier: "cost", cost: "~US$ 5", kind: "tooleval" },
  ]},
];

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,50}$/;
const BRANCH_RE = /^(feat|fix|docs|chore|refactor|test|perf)\/[a-z0-9][a-z0-9-]*$/;
const BOOK_TYPES = new Set(["runbook", "playbook", "sop", "cheatsheet"]);

export function catalog(platform) {
  return COMMANDS.map((g) => ({
    group: g.group,
    items: g.items.filter((c) => !c.platform || c.platform === platform).map(({ platform: _p, ...c }) => c),
  })).filter((g) => g.items.length);
}

export function findCommand(id) {
  for (const g of COMMANDS) for (const c of g.items) if (c.id === id) return c;
  return null;
}

export function commandPlan(id, params = {}, ctx = {}) {
  const cmd = findCommand(id);
  if (!cmd) return { error: "esse comando não está no catálogo" };
  if (ctx.hasMakefile === false) return { error: "este repositório não tem Makefile" };
  if (cmd.platform && cmd.platform !== ctx.platform) return { error: "esse comando não existe nesta plataforma" };

  const cwdRepo = ctx.repo;
  const argv = [id];
  let cwd = cwdRepo;

  if (id === "worktree") {
    if (!NAME_RE.test(String(params.name || ""))) return { error: "nome do worktree inválido (minúsculas, números, hífens)" };
    argv.push("NAME=" + params.name);
  } else if (id === "close") {
    const wt = String(params.worktree || "");
    if (!ctx.worktrees || !ctx.worktrees.includes(wt)) return { error: "escolha um worktree da lista" };
    cwd = wt;
  } else if (id === "land") {
    if (!BRANCH_RE.test(String(params.branch || ""))) return { error: "branch inválido (feat/nome, minúsculas e hífens)" };
    argv.push("BRANCH=" + params.branch);
  } else if (id === "adr") {
    if (!NAME_RE.test(String(params.name || ""))) return { error: "título curto inválido (minúsculas, números, hífens)" };
    argv.push("NAME=" + params.name);
  } else if (id === "book") {
    if (!NAME_RE.test(String(params.name || ""))) return { error: "nome inválido (minúsculas, números, hífens)" };
    if (!BOOK_TYPES.has(String(params.type || ""))) return { error: "tipo de book inválido" };
    argv.push("NAME=" + params.name, "TYPE=" + params.type);
  } else if (id === "atlas-shot") {
    if (params.id) {
      if (!NAME_RE.test(String(params.id))) return { error: "ID inválido" };
      argv.push("ID=" + params.id);
    }
  } else if (cmd.params && cmd.params.length) {
    return { error: "faltam parâmetros deste comando" };
  }

  // Owner-grade commands rebuild and restart main, never a worktree.
  if (id === "deploy" || id === "desktop-restart" || id === "land") cwd = ctx.main || cwdRepo;

  return { cmd, argv, cwd };
}
