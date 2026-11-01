// Ask the docs: local passage retrieval with the same EmbeddingGemma model
// and llama-server build Recall runs, started by this process at low
// priority. The index is a rebuildable cache in the extension's data dir.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { askChunks } from "./lib.mjs";

const QUERY_PREFIX = "task: search result | query: ";
const IDLE_MS = 10 * 60 * 1000;
const BATCH = 4;
const INDEX_VERSION = 2;

export function createAsk({ dataDir, dataRoot, getCorpus, getSettings }) {
  let status = { state: "idle", done: 0, total: 0, error: "", model: "", builtAt: 0 };
  let index = null;
  let building = null;
  let server = null;
  let idleTimer = null;

  function settingsValues() { try { return (getSettings()?.values) || {}; } catch { return {}; } }

  function findFiles() {
    const v = settingsValues();
    const models = [process.env.DOCBOARD_MODEL, v.embedding_model, path.join(dataRoot, "recall-semantic", "models"), path.join(os.homedir(), ".picode", "recall-semantic", "models")].filter(Boolean);
    let model = "";
    for (const r of models) {
      try {
        const st = fs.statSync(r);
        if (st.isFile() && r.endsWith(".gguf")) { model = r; break; }
        if (st.isDirectory()) { const f = fs.readdirSync(r).find((n) => n.endsWith(".gguf")); if (f) { model = path.join(r, f); break; } }
      } catch { /* next */ }
    }
    const servers = [process.env.DOCBOARD_LLAMA, v.llama_server, path.join(dataRoot, "recall-semantic", "llama"), path.join(os.homedir(), ".picode", "recall-semantic", "llama")].filter(Boolean);
    let llama = "";
    for (const r of servers) {
      try {
        const st = fs.statSync(r);
        if (st.isFile()) { llama = r; break; }
        if (st.isDirectory()) {
          const direct = path.join(r, "llama-server");
          if (fs.existsSync(direct)) { llama = direct; break; }
          for (const d of fs.readdirSync(r)) { const p = path.join(r, d, "llama-server"); if (fs.existsSync(p)) { llama = p; break; } }
          if (llama) break;
        }
      } catch { /* next */ }
    }
    return { model, llama };
  }

  function freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
      s.on("error", reject);
    });
  }

  function healthy(url) {
    return new Promise((resolve) => {
      const req = http.get(url + "/health", (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on("error", () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopServer, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  function stopServer() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (server && server.child && server.child.exitCode === null) {
      try { server.child.kill("SIGKILL"); } catch { /* gone */ }
    }
    server = null;
  }

  async function startServer(model, llama) {
    if (server && server.child && server.child.exitCode === null) { touch(); return server; }
    const port = await freePort();
    const key = crypto.randomBytes(24).toString("hex");
    const dir = path.dirname(llama);
    const threads = Math.max(1, Math.floor(os.cpus().length / 2));
    const args = ["-m", model, "--host", "127.0.0.1", "--port", String(port), "--embedding", "-t", String(threads), "-c", "8192", "-b", "2048", "-ub", "2048", "-np", "1", "--no-webui", "--api-key", key];
    const useNice = fs.existsSync("/usr/bin/nice");
    const child = useNice
      ? spawn("/usr/bin/nice", ["-n", "19", llama, ...args], { cwd: dir, env: { ...process.env, LD_LIBRARY_PATH: dir, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"] })
      : spawn(llama, args, { cwd: dir, env: { ...process.env, LD_LIBRARY_PATH: dir, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore"] });
    const url = "http://127.0.0.1:" + port;
    const deadline = Date.now() + 120000;
    for (;;) {
      if (child.exitCode !== null) throw new Error("o servidor de embeddings saiu");
      if (await healthy(url)) break;
      if (Date.now() > deadline) { try { child.kill("SIGKILL"); } catch { /* gone */ } throw new Error("o servidor de embeddings não subiu"); }
      await new Promise((r) => setTimeout(r, 300));
    }
    server = { child, url, key };
    touch();
    return server;
  }

  function embed(s, texts, prefix) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ input: texts.map((t) => prefix + t) });
      const req = http.request(s.url + "/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.key, "Content-Length": Buffer.byteLength(body) },
      }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { b += d; });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("embeddings respondeu " + res.statusCode));
          try {
            const out = JSON.parse(b);
            const vecs = (out.data || []).map((d) => normalize(d.embedding || []));
            if (vecs.length !== texts.length) return reject(new Error("vetores incompletos"));
            resolve(vecs);
          } catch (e) { reject(e); }
        });
      });
      req.on("error", reject);
      req.setTimeout(120000, () => req.destroy(new Error("embeddings: tempo esgotado")));
      req.write(body);
      req.end();
    });
  }

  function normalize(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Float32Array.from(v, (x) => x / n);
  }

  function fingerprint(corpus) {
    const h = crypto.createHash("sha1");
    for (const f of [...corpus.files].sort((a, b) => a.p.localeCompare(b.p))) h.update(f.p + "\0" + f.d + "\0" + f.s + "\n");
    return h.digest("hex");
  }

  function metaPath() { return path.join(dataDir, "ask-index.json"); }
  function binPath() { return path.join(dataDir, "ask-index.bin"); }

  function loadIndex(corpus, model) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
      if (!meta || meta.v !== INDEX_VERSION || !Array.isArray(meta.chunks) || meta.model !== model || meta.fingerprint !== fingerprint(corpus)) return false;
      const buf = fs.readFileSync(binPath());
      const vecs = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      index = { chunks: meta.chunks, vecs, dims: meta.dims, model: meta.model };
      status = { state: "ready", done: meta.chunks.length, total: meta.chunks.length, error: "", model: meta.model, builtAt: meta.builtAt || 0 };
      return true;
    } catch { return false; }
  }

  async function build(corpus, files) {
    status = { state: "building", done: 0, total: 0, error: "", model: files.model, builtAt: 0 };
    const chunks = askChunks(corpus);
    status.total = chunks.length;
    if (!chunks.length) { status.state = "unavailable"; status.error = "nenhum trecho para indexar"; return; }
    let s;
    try { s = await startServer(files.model, files.llama); } catch (e) { status.state = "unavailable"; status.error = e.message; return; }
    let dims = 0;
    const vecs = [];
    try {
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vs = await embed(s, batch.map((c) => `title: ${c.t} | text: ${c.x}`), "");
        if (!dims) dims = vs[0].length;
        vecs.push(...vs);
        status.done += batch.length;
      }
    } catch (e) {
      status.state = "unavailable";
      status.error = e.message;
      return;
    }
    const meta = { v: INDEX_VERSION, model: files.model, dims, fingerprint: fingerprint(corpus), builtAt: Date.now(), chunks };
    const flat = new Float32Array(vecs.length * dims);
    vecs.forEach((v, j) => flat.set(v, j * dims));
    try {
      fs.writeFileSync(binPath(), Buffer.from(flat.buffer));
      fs.writeFileSync(metaPath(), JSON.stringify(meta));
    } catch (e) {
      status.state = "unavailable";
      status.error = "não consegui guardar o índice: " + e.message;
      return;
    }
    index = { chunks, vecs: flat, dims, model: files.model };
    status = { state: "ready", done: chunks.length, total: chunks.length, error: "", model: files.model, builtAt: meta.builtAt };
    touch();
  }

  function ensure(corpus) {
    if (index) return;
    if (building) return;
    const files = findFiles();
    if (!files.model || !files.llama) {
      status = { state: "unavailable", done: 0, total: 0, error: "O modelo de embeddings do Recall não foi encontrado; a busca por palavra continua.", model: "", builtAt: 0 };
      return;
    }
    if (loadIndex(corpus, files.model)) return;
    building = build(corpus, files).finally(() => { building = null; });
  }

  async function ask(q, coll) {
    const corpus = await getCorpus();
    if (!index) {
      ensure(corpus);
      if (!index) return { state: status.state === "unavailable" ? "unavailable" : "building", done: status.done, total: status.total, error: status.error };
    }
    if (building && !index) return { state: "building", done: status.done, total: status.total, error: "" };
    const files = findFiles();
    let s;
    try { s = await startServer(files.model, files.llama); } catch (e) { return { state: "unavailable", error: e.message }; }
    let qv;
    try { qv = (await embed(s, [q], QUERY_PREFIX))[0]; } catch (e) { return { state: "unavailable", error: e.message }; }
    const scored = [];
    for (let i = 0; i < index.chunks.length; i++) {
      const c = index.chunks[i];
      if (coll && coll !== "all" && c.c !== coll) continue;
      const off = i * index.dims;
      let d = 0;
      for (let k = 0; k < index.dims; k++) d += qv[k] * index.vecs[off + k];
      scored.push({ ...c, score: d });
    }
    scored.sort((a, b) => b.score - a.score);
    return { state: "ready", results: scored.slice(0, 8), total: index.chunks.length };
  }

  function statusOf() { return status; }

  process.on("exit", stopServer);
  process.on("SIGTERM", () => { stopServer(); process.exit(0); });

  return { ensure, ask, status: statusOf, stop: stopServer };
}
