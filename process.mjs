// Docboard's background process (ADR-0230 E1a). It serves the dock page over
// PiCode's relay and owns the fixed command catalog. Stdlib only.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { buildCorpus, sortedFor, searchCorpus, catalog, findCommand, commandPlan, COLLECTIONS } from "./lib.mjs";

const PORT = Number(process.env.PICODE_EXT_PORT || 8799);
const EXT_DIR = process.env.PICODE_EXT_DIR || process.cwd();
const DATA = process.env.PICODE_EXT_DATA || path.join(os.tmpdir(), "docboard-data");
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
let repo = "";
let corpus = null;
let lastError = "";

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

async function loadSettings() {
  try { settings = await hostGet("/api/ext/v1/settings"); } catch { /* defaults */ }
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

function health(c) {
  const gates = ["docs-check", "vale", "books-check"].map((id) => {
    const last = [...runs.values()].filter((r) => r.cmd === id).sort((a, b) => b.started - a.started)[0];
    return { id, label: id, status: last ? last.status : "unknown", verdict: last ? (last.verdict || "") : "" };
  });
  const today = new Date().toISOString().slice(0, 10);
  let handoffToday = false;
  let handoffFile = "";
  try {
    const f = fs.readdirSync(path.join(repo, "docs/handoff")).find((n) => n.startsWith(today) && n.endsWith(".md"));
    if (f) { handoffToday = true; handoffFile = f; }
  } catch { /* absent */ }
  return {
    gates,
    handoffToday,
    handoffFile,
    counts: {
      docs: c.stats.docs, debts: c.stats.debts, questions: c.stats.questions,
      ownerQuestions: c.stats.ownerQuestions, changelog: c.stats.changelog,
      guides: c.stats.guides, atlas: c.stats.atlas, books: c.stats.books,
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
  const child = spawn("make", plan.argv, {
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
      return json(res, 200, found);
    }

    if (p === "/doc") {
      const d = docOf(c, String(q.get("path") || ""));
      if (!d) return json(res, 404, { error: "esse documento não está no índice" });
      return json(res, 200, d);
    }

    if (p === "/open") {
      return json(res, 200, openPage(c, String(q.get("tab") || "all"), q.get("q") || "", q.get("offset"), q.get("limit")));
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
