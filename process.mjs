// Docboard's background process (ADR-0230 E1a). It serves the dock page over
// PiCode's relay and owns the fixed command catalog. Stdlib only.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createAsk } from "./ask.mjs";
import { buildCorpus, sortedFor, searchCorpus, catalog, findCommand, commandPlan, COLLECTIONS, egoGraph, hubGraph, collectionGraph, pulseOf, changeObligations, coverageOf, repairLinks, shortestPath, backlinksOf } from "./lib.mjs";

const PORT = Number(process.env.PICODE_EXT_PORT || 8799);
const EXT_DIR = process.env.PICODE_EXT_DIR || process.cwd();
const DATA = process.env.PICODE_EXT_DATA || path.join(os.tmpdir(), "docboard-data");
const DATA_ROOT = DATA.replace(/[\\/]extensions[\\/][^\\/]+[\\/]data$/, "");
const SECRET = process.env.PICODE_EXT_PROXY_SECRET || "";
const HOST = process.env.PICODE_URL || "";
const TOKEN = process.env.PICODE_EXT_TOKEN || "";
const CA = process.env.PICODE_CA_FILE || "";
const PLATFORM = process.platform;
const MAX_DOC = 700 * 1024;
const REFRESH_MS = 5 * 60 * 1000;
const OWNER = new Set(["deploy", "desktop-restart", "land"]);

fs.mkdirSync(path.join(DATA, "runs"), { recursive: true });

let VERSION = "0.1.0";
try { VERSION = JSON.parse(fs.readFileSync(path.join(EXT_DIR, "picode-extension.json"), "utf8")).version; } catch { /* keep */ }

let settings = { values: {}, secrets: [] };
let me = null;
let toolsCache = null;
let lastError = "";
const STARTED = Date.now();
let repo = "";
let corpus = null;
let ask = null;

/* ---------------- Host API (repo discovery) ---------------- */

function hostGet(p) {
  return new Promise((resolve, reject) => {
    if (!HOST || !TOKEN) return reject(new Error("Host API indisponível"));
    const u = new URL(p, HOST);
    const isTls = u.protocol === "https:";
    const mod = isTls ? https : http;
    const opts = { method: "GET", headers: { "X-PiCode-Extension-Token": TOKEN } };
    if (isTls && CA) { try { opts.ca = fs.readFileSync(CA); } catch { /* default store */ } }
    const req = mod.request(u, opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("Host API " + res.statusCode));
        try { resolve(JSON.parse(body || "{}")); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Host API timeout")));
    req.end();
  });
}

function hostPost(p, body) {
  return new Promise((resolve, reject) => {
    if (!HOST || !TOKEN) return reject(new Error("Host API indisponível"));
    const u = new URL(p, HOST);
    const isTls = u.protocol === "https:";
    const mod = isTls ? https : http;
    const data = JSON.stringify(body || {});
    const opts = {
      method: "POST",
      headers: {
        "X-PiCode-Extension-Token": TOKEN,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };
    if (isTls && CA) { try { opts.ca = fs.readFileSync(CA); } catch { /* default store */ } }
    const req = mod.request(u, opts, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { b += d; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(b || "{}"); } catch { /* text */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(parsed.error || ("Host API " + res.statusCode));
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Host API timeout")));
    req.write(data);
    req.end();
  });
}

async function loadSettings() {
  try { settings = await hostGet("/api/ext/v1/settings"); } catch { /* defaults */ }
}

async function loadIdentity() {
  try { me = await hostGet("/api/ext/v1/me"); } catch { /* unnamed */ }
}

function toolVersions() {
  if (toolsCache) return toolsCache;
  const out = { node: process.version };
  for (const [name, args] of [["git", ["--version"]], ["make", ["--version"]], ["flock", ["--version"]]]) {
    try {
      out[name] = execFileSync(name, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
    } catch { out[name] = ""; }
  }
  toolsCache = out;
  return out;
}

let treesCache = { at: 0, data: null };
function worktreesCached() {
  if (Date.now() - treesCache.at < 10000) return treesCache.data;
  const data = listWorktrees();
  treesCache = { at: Date.now(), data };
  return data;
}

async function resolveRepo() {
  const override = settings?.values?.repo_path;
  if (typeof override === "string" && path.isAbsolute(override.trim())) return override.trim();
  try {
    const ws = await hostGet("/api/ext/v1/workspaces");
    const list = Array.isArray(ws) ? ws : (ws.workspaces || ws.items || []);
    const on = list.find((w) => w.extensionOn) || list[0];
    if (on && on.path) return on.path;
  } catch { /* local fallback */ }
  return process.env.DOCBOARD_REPO || process.cwd();
}

async function ensure(force = false) {
  if (!repo) repo = await resolveRepo();
  if (!ask) ask = createAsk({ dataDir: DATA, dataRoot: DATA_ROOT, getCorpus: () => ensure(), getSettings: () => settings });
  if (!corpus || force || Date.now() - corpus.builtAt > REFRESH_MS) {
    try {
      corpus = buildCorpus(repo);
      lastError = "";
    } catch (e) {
      lastError = "Não consegui ler o repositório " + repo + ": " + e.message;
      throw new Error(lastError);
    }
  }
  return corpus;
}

function commandsEnabled() {
  return settings?.values?.allow_commands !== false && process.env.DOCBOARD_ALLOW_COMMANDS !== "0";
}

/* ---------------- worktrees, lock, health ---------------- */

function git(args, cwd, timeout = 3000) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });
}

function listWorktrees() {
  let out = "";
  try { out = git(["worktree", "list", "--porcelain"], repo); } catch { return { main: repo, worktrees: [] }; }
  const blocks = out.split("\n\n").filter(Boolean);
  const list = [];
  blocks.forEach((b, i) => {
    const p = /^worktree (.+)$/m.exec(b);
    if (!p) return;
    const br = /^branch refs\/heads\/(.+)$/m.exec(b);
    let dirty = 0;
    try { dirty = git(["status", "--porcelain"], p[1], 2500).split("\n").filter(Boolean).length; } catch { dirty = -1; }
    list.push({ path: p[1], branch: br ? br[1] : "(detached)", dirty, main: i === 0 });
  });
  return { main: (list[0] && list[0].path) || repo, worktrees: list };
}

function lockHeld() {
  try {
    execFileSync("flock", ["-n", "/tmp/picode-mutate.lock", "true"], { timeout: 2000, stdio: "ignore" });
    return false;
  } catch (e) {
    return e.status === 1 ? true : null;
  }
}

function changedFiles(wt) {
  const out = new Map();
  try {
    const s = git(["status", "--porcelain=v1"], wt, 5000);
    for (const line of s.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2).trim() || "M";
      let p = line.slice(3).trim();
      const arrow = p.indexOf(" -> ");
      if (arrow >= 0) p = p.slice(arrow + 4);
      out.set(p, status);
    }
  } catch { /* no status */ }
  try {
    const base = git(["merge-base", "HEAD", "main"], wt, 4000).trim();
    if (base) {
      const diff = git(["diff", "--name-only", base + "...HEAD"], wt, 5000);
      for (const p of diff.split("\n").map((x) => x.trim()).filter(Boolean)) {
        if (!out.has(p)) out.set(p, "committed");
      }
    }
  } catch { /* no main */ }
  return [...out.entries()].map(([path, status]) => ({ path, status }));
}

function docsHistory(limit = 500) {
  let out = "";
  try {
    out = git(["log", "-" + limit, "--date=short", "--pretty=format:@@%h\t%ad\t%s", "--name-only", "--", "docs"], repo, 6000);
  } catch { return { commits: [], lastDate: {} }; }
  const commits = [];
  const lastDate = {};
  let cur = null;
  for (const line of out.split("\n")) {
    const m = /^@@([^\t]+)\t([^\t]+)\t(.*)$/.exec(line);
    if (m) { cur = { hash: m[1], date: m[2], subject: m[3], files: [] }; commits.push(cur); continue; }
    if (cur && line.trim() && !line.startsWith("@@") && line.startsWith("docs/")) {
      cur.files.push(line.trim());
      if (!lastDate[line.trim()]) lastDate[line.trim()] = cur.date;
    }
  }
  return { commits: commits.filter((c) => c.files.length), lastDate };
}

function health(c) {
  const gates = ["docs-check", "vale", "books-check"].map((id) => {
    const last = [...runs.values()].filter((r) => r.cmd === id).sort((a, b) => b.started - a.started)[0];
    return { id, label: id, status: last ? last.status : "unknown", verdict: last ? (last.verdict || "") : "" };
  });
  const checkIds = ["docs-check", "vale", "books-check", "hooks-check", "keys-drift", "flakes", "desktop-test"];
  const checks = checkIds.map((id) => {
    const cmd = findCommand(id);
    const last = [...runs.values()].filter((r) => r.cmd === id).sort((a, b) => b.started - a.started)[0];
    return {
      id, label: cmd ? cmd.label : id, when: cmd ? cmd.when : "",
      status: last ? last.status : "idle",
      verdict: last ? (last.verdict || "") : "",
      runId: last ? last.id : "",
      dur: last && last.ended ? Math.round((last.ended - last.started) / 1000) : null,
    };
  });
  const trees = worktreesCached();
  const today = new Date().toISOString().slice(0, 10);
  let handoffToday = false;
  let handoffFile = "";
  try {
    const f = fs.readdirSync(path.join(repo, "docs/handoff")).find((n) => n.startsWith(today) && n.endsWith(".md"));
    if (f) { handoffToday = true; handoffFile = f; }
  } catch { /* absent */ }
  return {
    gates,
    checks,
    handoffToday,
    handoffFile,
    counts: {
      docs: c.stats.docs, debts: c.stats.debts, questions: c.stats.questions,
      ownerQuestions: c.stats.ownerQuestions, changelog: c.stats.changelog,
      guides: c.stats.guides, atlas: c.stats.atlas, books: c.stats.books,
    },
    repo: {
      main: trees.main,
      worktrees: (trees.worktrees || []).length,
      dirty: (trees.worktrees || []).filter((w) => w.dirty > 0).length,
      broken: c.graph.broken.length,
      orphans: c.graph.orphans,
      fragments: c.stats.changelog,
    },
    env: {
      platform: PLATFORM,
      repo,
      version: VERSION,
      startedAt: STARTED,
      uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
      indexAgeSeconds: Math.round((Date.now() - c.builtAt) / 1000),
      tools: toolVersions(),
      settings: {
        repo_path: settings?.values?.repo_path || "",
        allow_commands: settings?.values?.allow_commands !== false,
      },
      permissions: (me && me.permissions) || [],
      workspaces: (me && me.workspaces) || [],
      dataDir: DATA,
    },
  };
}

/* ---------------- commands ---------------- */

const runs = new Map();
let seq = 0;

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("PICODE_")) delete env[k];
  return env;
}

function publicRun(r) {
  return {
    id: r.id, cmd: r.cmd, label: r.label, tier: r.tier, cwd: r.cwd,
    status: r.status, started: r.started, ended: r.ended, code: r.code,
    phase: r.phase, verdict: r.verdict || "", tail: (r.tail || "").slice(-4000),
  };
}

function startRun(cmd, params) {
  if (!commandsEnabled()) return { status: 403, error: "os comandos estão desligados nas configurações" };
  if (!fs.existsSync(path.join(repo, "Makefile"))) return { status: 400, error: "este repositório não tem Makefile" };
  const ownerRunning = [...runs.values()].some((r) => r.status === "running" && OWNER.has(r.cmd));
  if (OWNER.has(cmd.id) && ownerRunning) return { status: 409, error: "outra operação owner-grade está rodando; uma por vez" };
  let tree = { main: repo, worktrees: [] };
  if (cmd.id === "close" || OWNER.has(cmd.id)) tree = listWorktrees();
  const worktrees = cmd.id === "close" ? tree.worktrees.map((w) => w.path) : [];
  const plan = commandPlan(cmd.id, params || {}, {
    repo, main: tree.main || repo, platform: PLATFORM, hasMakefile: true, worktrees,
  });
  if (plan.error) return { status: 400, error: plan.error };

  const id = "r" + (++seq) + "-" + Date.now().toString(36);
  const logPath = path.join(DATA, "runs", id + ".log");
  const fd = fs.openSync(logPath, "a");
  const child = spawn(plan.command || "make", plan.argv, {
    cwd: plan.cwd,
    env: childEnv(),
    detached: PLATFORM !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = {
    id, cmd: cmd.id, label: cmd.label, tier: cmd.tier, cwd: plan.cwd,
    status: "running", started: Date.now(), ended: 0, code: null,
    phase: cmd.kind === "service" ? "rodando" : "executando", verdict: "", tail: "", child,
  };
  runs.set(id, run);
  const onData = (d) => {
    try { fs.writeSync(fd, d); } catch { /* closed */ }
    run.tail = (run.tail + d.toString()).slice(-12000);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    run.status = "failed";
    run.verdict = "não iniciou: " + e.message;
    run.ended = Date.now();
    run.tail = (run.tail + "\n" + e.message).slice(-12000);
  });
  child.on("exit", (code, signal) => {
    try { fs.closeSync(fd); } catch { /* closed */ }
    run.code = code;
    run.ended = Date.now();
    if (run.status === "stopped") return;
    run.status = code === 0 ? "ok" : "failed";
    run.phase = code === 0 ? "concluído" : "terminou";
    run.verdict = code === 0 ? "concluído" : "saiu com código " + code + (signal ? " (" + signal + ")" : "");
    run.child = null;
  });
  return { status: 202, run: publicRun(run) };
}

function stopRun(id) {
  const r = runs.get(id);
  if (!r || r.status !== "running") return { status: 404, error: "essa execução não está rodando" };
  if (OWNER.has(r.cmd)) return { status: 409, error: "não interrompe uma operação owner-grade" };
  r.status = "stopped";
  r.verdict = "parado por você";
  try {
    if (PLATFORM === "win32") r.child.kill("SIGTERM");
    else process.kill(-r.child.pid, "SIGTERM");
  } catch { try { r.child.kill("SIGTERM"); } catch { /* gone */ } }
  return { status: 200, run: publicRun(r) };
}

/* ---------------- HTTP ---------------- */

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req, max = 1 << 20) {
  return new Promise((resolve, reject) => {
    let n = 0;
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      n += Buffer.byteLength(d);
      if (n > max) { reject(new Error("corpo grande demais")); req.destroy(); return; }
      b += d;
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

const whoCache = new Map();
function lastCommitOf(rel) {
  if (!rel) return null;
  const key = repo + "\0" + rel;
  const hit = whoCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.last;
  let last = null;
  try {
    const out = git(["log", "-1", "--date=short", "--pretty=format:%h\t%ad\t%an\t%s", "--", rel], repo, 3000).trim();
    if (out) {
      const parts = out.split("\t");
      last = { hash: parts[0] || "", date: parts[1] || "", author: parts[2] || "", subject: parts.slice(3).join("\t") };
    }
  } catch { /* no git, no author */ }
  whoCache.set(key, { at: Date.now(), last });
  if (whoCache.size > 2000) for (const [k, v] of whoCache) if (Date.now() - v.at > 60000) whoCache.delete(k);
  return last;
}

function docOf(c, rel) {
  if (!c.text.has(rel)) return null;
  const f = c.files.find((x) => x.p === rel) || {};
  const raw = c.text.get(rel);
  const truncated = Buffer.byteLength(raw) > MAX_DOC;
  return { path: rel, title: f.t || rel, coll: f.c || "", size: f.s || 0, date: f.d || "", text: truncated ? raw.slice(0, MAX_DOC) : raw, truncated };
}

function openPage(c, tab, q, offset, limit) {
  const query = String(q || "").trim().toLowerCase();
  const qs = c.questions.filter((x) => !query || (x.text + " " + x.where).toLowerCase().includes(query));
  const ds = c.debts.filter((x) => !query || (x.text + " " + x.where).toLowerCase().includes(query));
  if (tab === "all") {
    return {
      questions: qs.slice(0, 24).map((x) => ({ ...x, kind: "q" })),
      debts: ds.slice(0, 40).map((x) => ({ ...x, kind: "d" })),
      counts: { questions: qs.length, debts: ds.length, ownerQuestions: qs.filter((x) => x.owner).length },
    };
  }
  const list = tab === "questions" ? qs : tab === "owner" ? qs.filter((x) => x.owner) : ds;
  const start = Math.max(0, Number(offset) || 0);
  const n = Math.min(120, Math.max(1, Number(limit) || 80));
  return {
    questions: tab === "debts" ? [] : list.slice(start, start + n).map((x) => ({ ...x, kind: "q" })),
    debts: tab === "debts" ? list.slice(start, start + n).map((x) => ({ ...x, kind: "d" })) : [],
    counts: { questions: qs.length, debts: ds.length, ownerQuestions: qs.filter((x) => x.owner).length, total: list.length },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (SECRET && req.headers["x-picode-proxy-secret"] !== SECRET) return json(res, 403, { error: "forbidden" });
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;
    const q = u.searchParams;

    if (p === "/healthz") return json(res, 200, { ok: true, version: VERSION });

    const c = await ensure();

    if (p === "/overview") {
      return json(res, 200, {
        repo: c.repo,
        builtAt: c.builtAt,
        stats: c.stats,
        collections: COLLECTIONS.map((x) => ({ ...x, n: (c.collections.find((y) => y.id === x.id) || {}).n || 0 })),
        platform: PLATFORM,
        commandsEnabled: commandsEnabled() && fs.existsSync(path.join(repo, "Makefile")),
        hasMakefile: fs.existsSync(path.join(repo, "Makefile")),
        graph: {
          nodes: c.files.length,
          edges: c.graph.edges.length,
          orphans: c.graph.orphans,
          broken: c.graph.broken.length,
        },
        version: VERSION,
      });
    }

    if (p === "/files") {
      const around = String(q.get("around") || "");
      let coll = String(q.get("coll") || "");
      if (around) {
        const target = c.files.find((f) => f.p === around);
        if (target) coll = target.c;
      }
      const all = sortedFor(c, coll);
      if (around) {
        const i = all.findIndex((f) => f.p === around);
        const start = Math.max(0, i - 7);
        return json(res, 200, { total: all.length, files: all.slice(start, i + 8) });
      }
      const offset = Math.max(0, Number(q.get("offset")) || 0);
      const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 100));
      return json(res, 200, { total: all.length, files: all.slice(offset, offset + limit) });
    }

    if (p === "/search") {
      const found = searchCorpus(c, String(q.get("q") || ""), { coll: String(q.get("coll") || "all"), limit: 40 });
      for (const f of found.files.slice(0, 8)) f.last = lastCommitOf(f.p);
      return json(res, 200, found);
    }

    if (p === "/doc") {
      const d = docOf(c, String(q.get("path") || ""));
      if (!d) return json(res, 404, { error: "esse documento não está no índice" });
      const refs = backlinksOf(c.graph, d.path);
      return json(res, 200, {
        ...d,
        backlinks: refs.backlinks.slice(0, 40),
        outbound: refs.outbound.slice(0, 40),
        lastCommit: lastCommitOf(d.path),
      });
    }

    if (p === "/history") {
      const rel = String(q.get("path") || "");
      if (!c.text.has(rel)) return json(res, 404, { error: "esse documento não está no índice" });
      let out = "";
      try { out = git(["log", "-5", "--date=short", "--pretty=format:%h\t%ad\t%an\t%s", "--", rel], repo, 4000); } catch { /* none */ }
      const commits = out.split("\n").filter(Boolean).map((line) => {
        const parts = line.split("\t");
        return { hash: parts[0] || "", date: parts[1] || "", author: parts[2] || "", subject: parts.slice(3).join("\t") };
      });
      return json(res, 200, { path: rel, commits });
    }

    if (p === "/open") {
      return json(res, 200, openPage(c, String(q.get("tab") || "all"), q.get("q") || "", q.get("offset"), q.get("limit")));
    }

    if (p === "/ask/status") {
      return json(res, 200, ask ? ask.status() : { state: "idle", done: 0, total: 0, error: "" });
    }

    if (p === "/ask") {
      const query = String(q.get("q") || "").trim();
      if (!query) return json(res, 400, { error: "escreva a pergunta" });
      const out = await ask.ask(query, String(q.get("coll") || "all"));
      if (Array.isArray(out.results)) {
        const by = new Map();
        for (const r of out.results) {
          if (!by.has(r.p)) by.set(r.p, lastCommitOf(r.p));
          r.by = by.get(r.p);
        }
      }
      return json(res, 200, out);
    }

    if (p === "/diff") {
      const base = String(q.get("base") || "").trim();
      const commit = String(q.get("commit") || "").trim();
      const pathParam = String(q.get("path") || "").trim();
      if (!base && !commit) return json(res, 400, { error: "informe base ou commit" });
      if (base) { try { git(["cat-file", "-e", base + "^{commit}"], repo, 3000); } catch { return json(res, 400, { error: "commit base inválido" }); } }
      if (commit) { try { git(["cat-file", "-e", commit + "^{commit}"], repo, 3000); } catch { return json(res, 400, { error: "commit inválido" }); } }
      if (pathParam && !(pathParam.startsWith("docs/") || /^[^/]+\.md$/.test(pathParam))) return json(res, 400, { error: "caminho fora das docs" });
      if (base && !pathParam) return json(res, 400, { error: "o diff desde a visita precisa de um documento" });
      let out = "";
      try {
        out = commit
          ? git(["show", "--format=", "--no-ext-diff", commit, "--", pathParam || "docs"], repo, 8000)
          : git(["diff", base + "..HEAD", "--", pathParam], repo, 8000);
      } catch (e) {
        return json(res, 503, { error: e.message });
      }
      const truncated = out.length > 200000;
      if (truncated) out = out.slice(0, 200000);
      let added = 0, removed = 0;
      for (const l of out.split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++")) added += 1;
        else if (l.startsWith("-") && !l.startsWith("---")) removed += 1;
      }
      return json(res, 200, { path: pathParam, base, commit, diff: out, truncated, added, removed });
    }

    if (p === "/since") {
      const head = git(["rev-parse", "HEAD"], repo, 3000).trim();
      let base = String(q.get("base") || "").trim();
      const at = String(q.get("at") || "").trim();
      if (base) { try { git(["cat-file", "-e", base + "^{commit}"], repo, 3000); } catch { base = ""; } }
      const commits = [];
      const filesFromCommits = new Set();
      if (base || at) {
        const args = base
          ? ["log", "-40", "--date=short", "--pretty=format:@@%h\t%ad\t%s", "--name-only", base + "..HEAD", "--", "docs"]
          : ["log", "-40", "--date=short", "--since=" + at, "--pretty=format:@@%h\t%ad\t%s", "--name-only", "--", "docs"];
        let out = "";
        try { out = git(args, repo, 6000); } catch { /* none */ }
        let cur = null;
        for (const line of out.split("\n")) {
          const m = /^@@([^\t]+)\t([^\t]+)\t(.*)$/.exec(line);
          if (m) { cur = { hash: m[1], date: m[2], subject: m[3], files: [] }; commits.push(cur); continue; }
          if (cur && line.trim() && line.startsWith("docs/")) { cur.files.push(line.trim()); filesFromCommits.add(line.trim()); }
        }
      }
      const commitList = commits.filter((c) => c.files.length).slice(0, 20).map((c) => ({ ...c, count: c.files.length, files: c.files.slice(0, 5) }));
      let changedPaths = [];
      if (base) {
        try { changedPaths = git(["diff", "--name-only", base + "..HEAD", "--", "docs"], repo, 6000).split("\n").map((x) => x.trim()).filter(Boolean); } catch { /* none */ }
      } else {
        changedPaths = [...filesFromCommits];
      }
      const byPath = new Map(c.files.map((f) => [f.p, f]));
      const changed = [...new Set(changedPaths)].map((p) => {
        const f = byPath.get(p);
        return { p, t: f ? f.t : p.split("/").pop(), c: f ? f.c : "" };
      });
      const newDebts = [];
      const resolvedDebts = [];
      if (base) {
        for (const p of changed.map((x) => x.p)) {
          if (!p.startsWith("docs/handoff/open/")) continue;
          let out = "";
          try { out = git(["diff", "-U0", base + "..HEAD", "--", p], repo, 4000); } catch { continue; }
          let line = 0;
          for (const l of out.split("\n")) {
            const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
            if (h) { line = Number(h[1]) - 1; continue; }
            if (l.startsWith("+++") || l.startsWith("---")) continue;
            if (l.startsWith("+")) {
              line += 1;
              const m = /^\+\s*-\s*\[\s\]\s+(.+)$/.exec(l);
              if (m) newDebts.push({ text: m[1].slice(0, 300), where: p.replace(/^docs\//, "") + ":" + line });
            } else if (l.startsWith("-")) {
              const m = /^-\s*-\s*\[\s\]\s+(.+)$/.exec(l);
              if (m) resolvedDebts.push({ text: m[1].slice(0, 300), where: p.replace(/^docs\//, "") });
            } else if (!l.startsWith("\\")) {
              line += 1;
            }
          }
        }
      }
      return json(res, 200, {
        first: !base && !at,
        head,
        base,
        at,
        commits: commitList,
        changed,
        changedPlans: changed.filter((x) => x.p.startsWith("docs/plans/")),
        newDebts: newDebts.slice(0, 40),
        resolvedDebts: resolvedDebts.slice(0, 40),
        counts: { debts: c.stats.debts, questions: c.stats.questions },
      });
    }

    if (p === "/agents") {
      try {
        const r = await hostGet("/api/ext/v1/agents");
        return json(res, 200, { agents: r.agents || [] });
      } catch (e) {
        return json(res, 503, { error: e.message });
      }
    }

    if (p === "/message" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "corpo inválido" }); }
      const to = String(body.to || "").trim();
      const text = String(body.text || "").trim();
      if (!to) return json(res, 400, { error: "escolha um agente" });
      if (!text) return json(res, 400, { error: "escreva a mensagem" });
      if (text.length > 4000) return json(res, 400, { error: "a mensagem passa de 4000 caracteres" });
      try {
        const r = await hostPost("/api/ext/v1/messages", { to, text });
        return json(res, 200, { ok: true, to: r.to || null, messageId: r.message && r.message.id || "" });
      } catch (e) {
        return json(res, e.status === 409 ? 409 : 503, { error: e.message });
      }
    }

    if (p === "/docs") {
      return json(res, 200, { docs: c.files.map((f) => ({ p: f.p, t: f.t, c: f.c })) });
    }

    if (p === "/path") {
      const from = String(q.get("from") || "");
      const to = String(q.get("to") || "");
      const out = shortestPath(c.graph, from, to);
      if (out.error) return json(res, 400, out);
      return json(res, 200, { ...out, repo, builtAt: c.builtAt });
    }

    if (p === "/links") {
      const repair = repairLinks(c);
      return json(res, 200, { ...repair, repo, builtAt: c.builtAt });
    }

    if (p === "/coverage") {
      const history = docsHistory(500);
      const cov = coverageOf(repo, c, { lastDate: history.lastDate });
      return json(res, 200, { ...cov, repo, builtAt: c.builtAt });
    }

    if (p === "/change") {
      const tree = listWorktrees();
      const valid = tree.worktrees.map((w) => w.path);
      const asked = String(q.get("worktree") || "");
      if (asked && !valid.includes(asked)) return json(res, 400, { error: "escolha um worktree da lista" });
      const wt = asked || tree.main || repo;
      let branch = "";
      try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"], wt, 3000).trim(); } catch { /* detached */ }
      const changed = changedFiles(wt);
      const obligations = changeObligations(changed, c, { branch });
      return json(res, 200, {
        worktree: wt,
        branch,
        main: tree.main,
        changed,
        obligations,
        stats: {
          files: changed.length,
          obligations: obligations.length,
          todo: obligations.filter((o) => o.status === "todo").length,
        },
      });
    }

    if (p === "/pulse") {
      const history = docsHistory(500);
      const pulse = pulseOf(c, { lastDate: history.lastDate });
      return json(res, 200, {
        ...pulse,
        recent: history.commits.slice(0, 10).map((x) => ({ ...x, count: x.files.length, files: x.files.slice(0, 5) })),
        builtAt: c.builtAt,
        repo: c.repo,
      });
    }

    if (p === "/graph") {
      const scope = String(q.get("scope") || "hubs");
      const stats = {
        nodes: c.files.length,
        edges: c.graph.edges.length,
        orphans: c.graph.orphans,
        broken: c.graph.broken.length,
      };
      if (scope === "doc") {
        const path = String(q.get("path") || "");
        const g = egoGraph(c.graph, path, Math.min(3, Math.max(1, Number(q.get("depth")) || 2)));
        if (!g) return json(res, 404, { error: "esse documento não está no índice" });
        g.stats = stats;
        g.brokenExamples = c.graph.broken.filter((b) => b.from === path).slice(0, 12);
        return json(res, 200, g);
      }
      if (scope === "collections") {
        const g = collectionGraph(c, c.graph);
        g.stats = stats;
        return json(res, 200, g);
      }
      const g = hubGraph(c.graph, Math.min(40, Math.max(8, Number(q.get("limit")) || 15)));
      g.stats = stats;
      return json(res, 200, g);
    }

    if (p === "/worktrees") {
      return json(res, 200, { repo, ...listWorktrees() });
    }

    if (p === "/preflight") {
      return json(res, 200, {
        kind: String(q.get("kind") || ""),
        repo,
        main: listWorktrees().main,
        lockHeld: lockHeld(),
        hasMakefile: fs.existsSync(path.join(repo, "Makefile")),
        platform: PLATFORM,
      });
    }

    if (p === "/commands") {
      return json(res, 200, {
        enabled: commandsEnabled() && fs.existsSync(path.join(repo, "Makefile")),
        platform: PLATFORM,
        groups: catalog(PLATFORM),
      });
    }

    if (p === "/runs") {
      const list = [...runs.values()].sort((a, b) => b.started - a.started).slice(0, 10).map(publicRun);
      return json(res, 200, { runs: list });
    }

    if (p === "/run" && req.method === "GET") {
      const r = runs.get(String(q.get("id") || ""));
      if (!r) return json(res, 404, { error: "execução não encontrada" });
      return json(res, 200, publicRun(r));
    }

    if (p === "/run" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "corpo inválido" }); }
      const cmd = findCommand(String(body.id || ""));
      if (!cmd) return json(res, 400, { error: "comando fora do catálogo" });
      const out = startRun(cmd, body.params || {});
      if (out.error) return json(res, out.status || 400, { error: out.error });
      return json(res, 202, { run: out.run });
    }

    if (p === "/run/stop" && req.method === "POST") {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 400, { error: "corpo inválido" }); }
      const out = stopRun(String(body.id || ""));
      if (out.error) return json(res, out.status || 400, { error: out.error });
      return json(res, 200, { run: out.run });
    }

    if (p === "/health") {
      return json(res, 200, health(c));
    }

    if (p === "/refresh" && req.method === "POST") {
      await ensure(true);
      return json(res, 200, { repo: corpus.repo, builtAt: corpus.builtAt, stats: corpus.stats });
    }

    return json(res, 404, { error: "rota desconhecida" });
  } catch (e) {
    return json(res, 503, { error: e.message || "indisponível" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("docboard: listening on 127.0.0.1:" + PORT + " (data " + DATA + ")");
});

void loadSettings();
void loadIdentity();
