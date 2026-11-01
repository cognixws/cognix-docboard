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
  for (const rel of ROOT_FILES) {
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

  return {
    repo: abs,
    builtAt: Date.now(),
    files,
    text,
    stats,
    questions,
    debts,
    collections: COLLECTIONS.map((c) => ({ ...c, n: count(c.id) })),
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
