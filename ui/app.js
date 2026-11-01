/* Docboard's dock page. It reads the repository through the extension's own
   process (picode.use("process")); it has no network and no PiCode session. */
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = new Intl.NumberFormat("pt-BR");
const ROOT = new Set(["AGENTS.md", "README.md", "CONTRIBUTING.md", "CHANGELOG.md", "Makefile"]);

let api = null;
async function getApi() {
  if (api) return api;
  if (typeof picode === "undefined" || !picode.use) throw new Error("O host da extensão não está disponível.");
  api = await picode.use("process");
  if (!api) throw new Error("O processo da extensão não está rodando.");
  return api;
}

async function call(p, opts) {
  const r = await (await getApi()).request(p, opts || {});
  let body = {};
  try { body = JSON.parse(r.body || "{}"); } catch { /* empty */ }
  if (r.status < 200 || r.status >= 300) throw new Error((body && body.error) || ("HTTP " + r.status));
  return body;
}

async function post(p, data) {
  return call(p, { method: "POST", body: JSON.stringify(data || {}), contentType: "application/json" });
}

/* ---------------- state ---------------- */

const S = {
  ready: false,
  error: "",
  view: "read",
  overview: null,
  collections: [],
  stats: {},
  commandsEnabled: false,
  platform: "",
  recents: [],
  scroll: {},
  lastKey: "",
  focusOpen: false,
  read: { coll: null, doc: null, line: null, files: [], total: 0, loading: false, around: null, docMeta: null, docHtml: "", docLoading: false, docError: "" },
  search: { q: "", f: "all", busy: false, ran: false, files: [], open: [], err: "" },
  open: { tab: "all", q: "", offset: 0, questions: [], debts: [], counts: {}, loading: false },
  operar: { groups: [], enabled: false, filter: "", group: "all", runs: [], loading: false, timer: null, worktrees: null },
  health: { gates: [], counts: {}, handoffToday: false, loading: false },
  graph: { scope: "hubs", path: "", data: null, loading: false, error: "" },
  dialog: null,
};

/* ---------------- markdown ---------------- */

function normPath(p) {
  const out = [];
  for (const s of String(p).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

function resolveDocHref(href, fromPath) {
  const clean = String(href).split("#")[0].trim();
  if (!clean || /^(https?:|mailto:)/i.test(clean)) return null;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  let rel;
  if (clean.startsWith("/")) rel = clean.slice(1);
  else if (clean.startsWith("./") || clean.startsWith("../")) rel = normPath(dir + "/" + clean);
  else if (clean.startsWith("docs/") || ROOT.has(clean)) rel = clean;
  else rel = normPath(dir + "/" + clean);
  if (!rel.endsWith(".md") && !ROOT.has(rel)) return null;
  return rel.startsWith("docs/") || ROOT.has(rel) ? rel : null;
}

function linkHtml(label, href, fromPath) {
  if (/^https?:/i.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  if (href.startsWith("#")) return `<a href="${esc(href)}">${esc(label)}</a>`;
  const doc = resolveDocHref(href, fromPath);
  if (doc) return `<a href="#" data-act="doc" data-doc="${esc(doc)}">${esc(label)}</a>`;
  return esc(label);
}

function inlineMd(s, fromPath) {
  let t = esc(s);
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (m, alt) => "[imagem" + (alt ? ": " + alt : "") + "]");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, "$1<i>$2</i>");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => linkHtml(label, href, fromPath));
  return t;
}

function mdToHtml(md, fromPath) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  if (lines[0] === "---") { i = 1; while (i < lines.length && lines[i] !== "---") i++; i++; }
  const out = [];
  let para = [];
  let skippedTitle = false;
  const flush = () => {
    if (!para.length) return;
    out.push(`<p data-l="${para[0].n}">${inlineMd(para.map((x) => x.s).join(" "), fromPath)}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      const start = i;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre data-l="${start}"><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      if (h[1].length === 1 && !skippedTitle) { skippedTitle = true; i++; continue; }
      if (h[1].length === 1) skippedTitle = true;
      const lvl = Math.min(5, h[1].length + 1);
      const id = "h-" + h[2].toLowerCase().replace(/[^a-z0-9à-ú]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      out.push(`<h${lvl} id="${id}" data-l="${n}">${inlineMd(h[2], fromPath)}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      const rows = [];
      const start = n;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push({ s: lines[i], n: i + 1 }); i++; }
      out.push(tableHtml(rows, start, fromPath));
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        if (/^\s*[-*+]\s+/.test(lines[i])) { items.push({ t: lines[i].replace(/^\s*[-*+]\s+/, ""), n: i + 1 }); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].t += " " + lines[i].trim(); i++; continue; }
        if (/^\s*$/.test(lines[i]) && /^\s*[-*+]\s+/.test(lines[i + 1] || "")) { i++; continue; }
        break;
      }
      out.push(`<ul>${items.map((it) => `<li data-l="${it.n}">${inlineMd(it.t, fromPath)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        if (/^\s*\d+[.)]\s+/.test(lines[i])) { items.push({ t: lines[i].replace(/^\s*\d+[.)]\s+/, ""), n: i + 1 }); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].t += " " + lines[i].trim(); i++; continue; }
        if (/^\s*$/.test(lines[i]) && /^\s*\d+[.)]\s+/.test(lines[i + 1] || "")) { i++; continue; }
        break;
      }
      out.push(`<ol>${items.map((it) => `<li data-l="${it.n}">${inlineMd(it.t, fromPath)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      const start = n;
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote data-l="${start}">${inlineMd(buf.join(" "), fromPath)}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push(`<hr data-l="${n}">`); i++; continue; }
    para.push({ s: line, n });
    i++;
  }
  flush();
  return out.join("\n");
}

function tableHtml(rows, start, fromPath) {
  const isSep = (s) => /^\s*\|?[\s:|-]+\|?\s*$/.test(s);
  let head = null;
  let body = rows;
  if (rows.length > 1 && isSep(rows[1].s)) { head = rows[0]; body = rows.slice(2); }
  const cell = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const headHtml = head ? `<thead><tr data-l="${head.n}">${cell(head.s).map((c) => `<th>${inlineMd(c, fromPath)}</th>`).join("")}</tr></thead>` : "";
  const bodyHtml = body.map((r) => `<tr data-l="${r.n}">${cell(r.s).map((c) => `<td>${inlineMd(c, fromPath)}</td>`).join("")}</tr>`).join("");
  return `<table data-l="${start}">${headHtml}<tbody>${bodyHtml}</tbody></table>`;
}

/* ---------------- helpers ---------------- */

function keyOf() {
  if (S.view === "read") return `read|${S.read.coll || ""}|${S.read.doc || ""}`;
  if (S.view === "open") return `open|${S.open.tab}|${S.open.q}|${S.open.offset}`;
  return S.view;
}

function render() {
  const content = $("#content");
  if (!content) return;
  if (S.lastKey) S.scroll[S.lastKey] = content.scrollTop;
  if (!S.ready) {
    content.innerHTML = S.error
      ? `<div class="boot"><div class="box"><div class="plain-h">Docboard</div>
          <div class="empty"><b>Não consegui abrir as docs.</b><p>${esc(S.error)}</p>
          <button class="btn sm" type="button" data-act="retry-boot">Tentar de novo</button></div></div></div>`
      : `<div class="boot"><div class="box"><div class="plain-h">Docboard</div><p class="meta">Lendo o repositório…</p>
          <div class="sk" style="width:70%"></div><div class="sk" style="width:92%"></div><div class="sk" style="width:55%"></div></div></div>`;
    return;
  }
  const map = { read: renderRead, search: renderSearch, open: renderOpen, operar: renderOperar, graph: renderGraph, map: renderMap, health: renderHealth };
  content.innerHTML = (map[S.view] || renderRead)();
  content.scrollTop = S.scroll[keyOf()] || 0;
  S.lastKey = keyOf();
  syncChrome();
  if (S.view === "read" && S.read.doc && S.read.line && content.querySelector("[data-l]")) {
    const line = S.read.line;
    S.read.line = null;
    requestAnimationFrame(() => jumpToLine(content, line));
  }
  if (S.view === "graph" && S.graph.data) requestAnimationFrame(drawGraph);
  if (S.focusOpen) {
    S.focusOpen = false;
    const input = $("#open-filter");
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  syncRunButtons();
}

function setView(v) {
  S.view = v;
  render();
}

function syncChrome() {
  if (!S.ready) return;
  const elTitle = $("#tb-title");
  const elSub = $("#tb-sub");
  let title = "Read";
  let sub = "";
  if (S.view === "read") {
    if (S.read.doc && S.read.docMeta) { title = S.read.docMeta.title; sub = S.read.docMeta.path; }
    else if (S.read.coll) { const c = S.collections.find((x) => x.id === S.read.coll); title = c ? c.name : "Read"; sub = c ? nf.format(c.n) + " arquivos" : ""; }
    else { title = "Documentação"; sub = `${nf.format(S.stats.docs || 0)} arquivos · docs + raiz`; }
  } else if (S.view === "search") {
    title = "Buscar";
    sub = S.search.q ? `resultados para “${S.search.q}”` : "índice local · leitura no repositório";
  } else if (S.view === "open") {
    title = "Aberto";
    sub = `${nf.format(S.stats.questions || 0)} questões em ${S.stats.plansWithQuestions || 0} planos · ${nf.format(S.stats.debts || 0)} pendências em ${S.stats.openTopics || 0} tópicos`;
  } else if (S.view === "operar") {
    title = "Operar";
    sub = S.commandsEnabled ? "comandos do Makefile · pessoa apenas" : "comandos desligados";
  } else if (S.view === "graph") {
    title = "Grafo";
    sub = S.graph.path ? "ligações de " + S.graph.path : "ligações entre docs do repositório";
  } else if (S.view === "map") {
    title = "Map";
    sub = "saúde das coleções";
  } else if (S.view === "health") {
    title = "Health";
    sub = "gates do branch";
  }
  if (elTitle) elTitle.textContent = title;
  if (elSub) elSub.textContent = sub;
  const actions = $("#tb-actions");
  if (actions) actions.innerHTML = "";
  const input = $("#global-search");
  if (input) {
    input.placeholder = `Buscar em ${nf.format(S.stats.docs || 0)} docs…`;
    if (document.activeElement !== input) input.value = S.search.q || "";
  }
  const rail = $("#rail");
  if (rail) rail.querySelectorAll("button[data-view]").forEach((b) => {
    if (b.dataset.view === S.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
}

function jumpToLine(root, line) {
  const els = [...root.querySelectorAll("[data-l]")];
  if (!els.length) return;
  let best = null;
  for (const el of els) {
    const n = Number(el.dataset.l);
    if (n <= line && (!best || n > Number(best.dataset.l))) best = el;
  }
  (best || els[0]).scrollIntoView({ block: "center" });
  if (best) best.classList.add("flash");
}

function toast(text) {
  const box = $("#toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

async function copyText(text, what) {
  try {
    if (typeof picode !== "undefined") {
      const links = await picode.use("links");
      if (links && links.copy) { await links.copy(text); toast(what + " copiado."); return; }
    }
  } catch { /* fall through */ }
  toast("Não consegui copiar.");
}

function pushRecent(meta) {
  if (!meta) return;
  const rec = S.recents.filter((x) => x.p !== meta.path);
  rec.unshift({ p: meta.path, t: meta.title });
  S.recents = rec.slice(0, 5);
}

function branchOf(run) {
  return run.cwd && run.cwd !== S.overview.repo ? run.cwd : "";
}

function elapsedOf(run) {
  if (!run) return "";
  const end = run.ended || Date.now();
  const s = Math.max(0, Math.round((end - run.started) / 1000));
  return s >= 60 ? Math.floor(s / 60) + " min " + (s % 60) + " s" : s + " s";
}

/* ---------------- rail and boot ---------------- */

function buildRail() {
  const item = (view, label, cnt) => `<button class="rail-item" type="button" data-view="${view}"><span>${label}</span>${cnt != null ? `<span class="cnt">${cnt}</span>` : ""}</button>`;
  const el = $("#rail");
  if (!el) return;
  const repo = S.overview ? S.overview.repo : "";
  el.innerHTML = item("read", "Read") + item("search", "Search") + item("graph", "Grafo")
    + `<div class="rail-group">Trabalho</div>` + item("open", "Aberto", nf.format((S.stats.debts || 0) + (S.stats.questions || 0)))
    + (S.commandsEnabled ? item("operar", "Operar") : "")
    + `<div class="rail-group">Saúde</div>` + item("map", "Map") + item("health", "Health")
    + `<div class="rail-foot">${esc(repo.split("/").filter(Boolean).pop() || repo)}
       <br>${nf.format(S.stats.docs || 0)} arquivos · ${esc(S.overview ? S.overview.version : "")}</div>`;
  el.querySelectorAll("button[data-view]").forEach((b) => b.addEventListener("click", () => {
    setView(b.dataset.view);
    if (b.dataset.view === "search") { const gs = $("#global-search"); if (gs) gs.focus(); }
    if (b.dataset.view === "open") void loadOpen(false);
    if (b.dataset.view === "operar") void loadCommands();
    if (b.dataset.view === "health") void loadHealth();
    if (b.dataset.view === "graph") void prepareGraph(S.read.doc ? "doc" : "hubs", S.read.doc || "");
  }));
}

async function boot() {
  S.ready = false;
  S.error = "";
  render();
  try {
    const ov = await call("/overview");
    S.overview = ov;
    S.collections = ov.collections || [];
    S.stats = ov.stats || {};
    S.commandsEnabled = !!ov.commandsEnabled;
    S.platform = ov.platform || "";
    S.ready = true;
    buildRail();
    render();
    void loadRuns();
    void loadHealth();
  } catch (e) {
    S.error = e.message || String(e);
    render();
  }
}

/* ---------------- Read ---------------- */

function renderRead() {
  const r = S.read;
  if (!r.coll) {
    const cards = S.collections.map((c) => `
      <button class="coll" type="button" data-act="coll" data-coll="${esc(c.id)}">
        <b>${esc(c.name)}</b><span class="n">${nf.format(c.n)} · ${esc(c.blurb)}</span>
      </button>`).join("");
    const rec = S.recents.length
      ? `<div class="filelist">${S.recents.map((x) => `
          <button class="file" type="button" data-act="doc" data-doc="${esc(x.p)}">
            <span class="t">${esc(x.t)}</span><span class="d">${esc(x.p)}</span>
          </button>`).join("")}</div>`
      : `<p class="meta">Nenhum documento aberto nesta sessão.</p>`;
    return `<div class="plain-h">Coleções</div><div class="coll-list">${cards}</div>
      <div class="plain-h section-gap">Recentes</div>${rec}`;
  }

  const coll = S.collections.find((c) => c.id === r.coll) || { id: r.coll, name: r.coll, n: r.total };

  if (!r.doc) {
    if (r.loading) return `<div class="crumb"><a href="#" data-act="nav-back">‹ Coleções</a></div>
      <div class="listhead"><b>${esc(coll.name)}</b><span class="meta">…</span></div>
      <div class="sk" style="width:60%"></div><div class="sk" style="width:84%"></div><div class="sk" style="width:72%"></div><div class="sk" style="width:90%"></div>`;
    const files = r.files.map((f) => `
      <button class="file" type="button" data-act="doc" data-doc="${esc(f.p)}">
        <span class="t">${esc(f.t)}</span><span class="d">${esc(f.d)} · ${esc(f.p.slice(f.p.lastIndexOf("/") + 1))}</span>
      </button>`).join("");
    const more = r.total > r.files.length
      ? `<div style="margin-top:10px"><button class="btn sm" type="button" data-act="more-files">Mostrar mais</button>
         <span class="meta">${nf.format(r.files.length)} de ${nf.format(r.total)}</span></div>` : "";
    return `<div class="crumb"><a href="#" data-act="nav-back">‹ Coleções</a></div>
      <div class="listhead"><b>${esc(coll.name)}</b><span class="meta">${nf.format(r.total)} arquivos</span></div>
      <div class="filelist">${files}</div>${more}`;
  }

  const meta = r.docMeta;
  let body;
  if (r.docLoading) {
    body = `<div class="sk" style="width:72%"></div><div class="sk" style="width:94%"></div><div class="sk" style="width:61%"></div><p class="meta">Lendo o documento…</p>`;
  } else if (r.docError) {
    body = `<div class="empty"><b>Não consegui abrir este documento.</b><p>${esc(r.docError)}</p>
      <button class="btn sm" type="button" data-act="retry-doc" data-doc="${esc(r.doc)}">Tentar de novo</button></div>`;
  } else if (meta) {
    body = `<div class="reader">${r.docHtml}</div>`;
  } else {
    body = `<p class="meta">Carregando…</p>`;
  }

  const article = `
    <div class="crumb"><a href="#" data-act="back-doc">‹ ${esc(coll.name)}</a></div>
    <div class="doc-title">${esc(meta ? meta.title : r.doc.split("/").pop())}</div>
    <div class="meta">${esc(r.doc)}${meta ? " · " + nf.format(meta.size) + " bytes · " + esc(meta.date) : ""}${meta && meta.truncated ? " · trecho (arquivo grande)" : ""}</div>
    <div class="actions">
      <button class="btn sm" type="button" data-act="copy" data-what="Caminho" data-copy="${esc(r.doc)}">Copiar caminho</button>
      <button class="btn sm" type="button" data-act="copy" data-what="Referência" data-copy="${esc(r.doc)}:1">Copiar referência</button>
      <button class="btn sm" type="button" data-act="graph-doc" data-doc="${esc(r.doc)}">Grafo</button>
    </div>
    ${body}`;

  const around = r.around || { files: [], total: r.total };
  const aside = `<div class="listhead"><a class="linkbtn" href="#" data-act="nav-back">‹ Coleções</a><span class="meta">${nf.format(around.total || 0)}</span></div>
    <div class="filelist">${(around.files || []).map((x) => `
      <button class="file" type="button" data-act="doc" data-doc="${esc(x.p)}" ${x.p === r.doc ? 'aria-current="true"' : ""}>
        <span class="t">${esc(x.t)}</span></button>`).join("")}</div>
    <button class="linkbtn" type="button" data-act="back-doc" style="margin-top:8px">Ver todos os ${nf.format(around.total || 0)}</button>`;

  return `<div class="readgrid"><aside>${aside}</aside><article>${article}</article></div>`;
}

async function openCollection(coll) {
  S.read.coll = coll;
  S.read.doc = null;
  S.read.files = [];
  S.read.total = 0;
  S.read.loading = true;
  S.read.around = null;
  S.read.docMeta = null;
  S.read.docHtml = "";
  S.read.docError = "";
  S.view = "read";
  render();
  try {
    const r = await call("/files?coll=" + encodeURIComponent(coll) + "&limit=100");
    S.read.files = r.files || [];
    S.read.total = r.total || 0;
  } catch (e) { toast(e.message); }
  S.read.loading = false;
  render();
}

async function moreFiles() {
  const r = S.read;
  if (!r.coll) return;
  try {
    const page = await call("/files?coll=" + encodeURIComponent(r.coll) + "&offset=" + r.files.length + "&limit=200");
    r.files = r.files.concat(page.files || []);
    r.total = page.total || r.total;
    render();
  } catch (e) { toast(e.message); }
}

async function openDoc(p, line) {
  S.read.doc = p;
  S.read.line = line || null;
  S.read.docLoading = true;
  S.read.docError = "";
  S.read.docHtml = "";
  S.read.docMeta = null;
  S.read.around = null;
  S.view = "read";
  render();
  try {
    const [doc, around] = await Promise.all([
      call("/doc?path=" + encodeURIComponent(p)),
      call("/files?around=" + encodeURIComponent(p)),
    ]);
    S.read.coll = doc.coll || S.read.coll;
    S.read.docMeta = doc;
    S.read.docHtml = mdToHtml(doc.text || "", p);
    S.read.around = around;
    pushRecent(doc);
  } catch (e) {
    S.read.docError = e.message;
  }
  S.read.docLoading = false;
  render();
}

function backFromDoc() {
  const coll = S.read.coll;
  S.read.doc = null;
  S.read.line = null;
  S.read.docMeta = null;
  S.read.docHtml = "";
  S.read.docError = "";
  S.read.around = null;
  render();
  if (coll && !S.read.files.length) void openCollection(coll);
}

/* ---------------- Search ---------------- */

let searchTimer = null;

function tokens(q) {
  return String(q).toLowerCase().split(/[^a-z0-9à-ú]+/i).filter((t) => t.length > 1);
}

function highlight(text, q) {
  let out = esc(text || "");
  for (const t of tokens(q)) {
    if (t.length < 3) continue;
    try { out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>"); } catch { /* noop */ }
  }
  return out;
}

function scheduleSearch(delay = 180) {
  clearTimeout(searchTimer);
  S.search.busy = true;
  render();
  searchTimer = setTimeout(doSearch, delay);
}

async function doSearch() {
  const q = S.search.q.trim();
  if (!q) {
    S.search.files = [];
    S.search.open = [];
    S.search.ran = false;
    S.search.busy = false;
    S.search.err = "";
    render();
    return;
  }
  S.search.ran = true;
  S.search.err = "";
  try {
    const r = await call("/search?q=" + encodeURIComponent(q) + "&coll=" + encodeURIComponent(S.search.f));
    S.search.files = r.files || [];
    S.search.open = r.open || [];
  } catch (e) {
    S.search.err = e.message;
    S.search.files = [];
    S.search.open = [];
  }
  S.search.busy = false;
  render();
}

function renderSearch() {
  const s = S.search;
  const filters = [{ id: "all", label: "Tudo" }].concat(S.collections.map((c) => ({ id: c.id, label: c.name })));
  const chips = filters.map((f) => `<button type="button" data-act="sfilter" data-f="${esc(f.id)}" aria-pressed="${s.f === f.id}">${esc(f.label)}</button>`).join("");
  const clear = s.q ? `<button class="linkbtn" type="button" data-act="clear-search">Limpar busca</button>` : "";
  let status = "Digite no campo acima";
  if (s.q) status = s.busy ? "Buscando…" : `${s.files.length} documento(s)`;
  let results = "";
  if (s.busy) {
    results = `<div class="sk" style="width:38%"></div><div class="sk" style="width:76%"></div><div class="sk" style="width:44%;margin-top:14px"></div><div class="sk" style="width:68%"></div>`;
  } else if (!s.ran) {
    const ex = "por que o land não reinicia quando o close termina?";
    results = `<div class="empty"><b>Busque por palavra ou por significado.</b>
      <p>O índice cobre ${nf.format(S.stats.docs || 0)} arquivos do repositório. Os sinônimos PT/EN são locais.</p>
      <button class="btn sm" type="button" data-act="example" data-q="${esc(ex)}">Experimentar: “${esc(ex)}”</button></div>`;
  } else if (s.err) {
    results = `<div class="empty"><b>A busca falhou.</b><p>${esc(s.err)}</p><button class="btn sm" type="button" data-act="retry-search">Tentar de novo</button></div>`;
  } else if (!s.files.length && !s.open.length) {
    results = `<div class="empty"><b>Nenhum resultado para “${esc(s.q)}”.</b>
      <p>Nada no índice com essas palavras ou sinônimos.</p>
      <button class="btn sm" type="button" data-act="search-all">Buscar em todo o repositório</button></div>`;
  } else {
    const rows = s.files.map((f, i) => `
      <button class="result" type="button" data-act="result" data-i="${i}">
        <span class="body"><span class="path">${esc(f.t)}</span>
          <span class="where"> · ${esc((S.collections.find((c) => c.id === f.c) || {}).name || f.c)} · ${esc(f.p)}</span>
          <div class="snip">${highlight(f.x, s.q)}</div></span>
        <span class="go">Abrir</span></button>`).join("");
    const openRows = s.open.length
      ? `<div class="cmdgroup" style="margin-top:14px">Aberto (${s.open.length})</div>` + s.open.map((it, i) => `
        <button class="result" type="button" data-act="open-result" data-i="${i}">
          <span class="body"><span class="path">${esc(it.text.slice(0, 140))}${it.text.length > 140 ? "…" : ""}</span>
            <span class="where"> · ${esc(it.where)}</span>
            <div class="snip">${it.kind === "q" ? "questão em aberto" : "pendência"}${it.owner ? " · owner" : ""}</div></span>
          <span class="go">Abrir na linha</span></button>`).join("")
      : "";
    results = (rows ? `<div class="results">${rows}</div>` : "") + openRows;
  }
  return `<div class="seg" style="margin-bottom:10px">${chips}</div>
    <div class="row" style="margin-bottom:10px"><span class="meta">${status}</span><span class="spacer"></span>${clear}</div>
    <div id="results">${results}</div>`;
}

/* ---------------- Open ---------------- */

let openTimer = null;

async function loadOpen(append = false) {
  const o = S.open;
  o.loading = true;
  if (!append) { o.questions = []; o.debts = []; o.offset = 0; }
  render();
  try {
    const r = await call("/open?tab=" + encodeURIComponent(o.tab) + "&q=" + encodeURIComponent(o.q) + "&offset=" + o.offset + "&limit=80");
    o.counts = r.counts || {};
    o.questions = append ? o.questions.concat(r.questions || []) : (r.questions || []);
    o.debts = append ? o.debts.concat(r.debts || []) : (r.debts || []);
  } catch (e) {
    toast(e.message);
  }
  o.loading = false;
  render();
}

function openRow(it) {
  return `<div class="openrow">
    <div class="grow"><div class="txt" title="${esc(it.text.slice(0, 300))}">${esc(it.text.slice(0, 300))}</div>
      <div class="meta">${esc(it.where)} · ${it.kind === "q" ? "questão" : "pendência"}</div></div>
    ${it.owner ? '<span class="tag owner">owner</span>' : ""}
    <button class="btn sm" type="button" data-act="doc" data-doc="${esc(it.kind === "q" ? it.plan : it.topic)}" data-line="${it.line}">Abrir na linha</button>
  </div>`;
}

function renderOpen() {
  const o = S.open;
  const tabs = [
    ["all", "Tudo"],
    ["questions", `Questões ${nf.format((S.stats.questions || 0))}`],
    ["debts", `Pendências ${nf.format((S.stats.debts || 0))}`],
    ["owner", `Owner ${nf.format((S.stats.ownerQuestions || 0))}`],
  ];
  const seg = tabs.map(([id, label]) => `<button type="button" data-act="otab" data-tab="${id}" aria-pressed="${o.tab === id}">${label}</button>`).join("");
  const filter = `<div class="fieldwrap" style="margin-bottom:12px"><input id="open-filter" type="search" placeholder="Filtrar títulos e caminhos…" value="${esc(o.q)}" aria-label="Filtrar itens abertos" /></div>`;
  const loading = o.loading ? `<div class="sk" style="width:70%"></div><div class="sk" style="width:88%"></div>` : "";
  if (o.tab === "all") {
    const qs = o.questions.map(openRow).join("");
    const ds = o.debts.map(openRow).join("");
    return `<div class="seg" style="margin-bottom:10px">${seg}</div>${filter}${loading}
      <div class="listhead"><b>Questões</b><span class="meta">${nf.format(o.counts.questions || 0)}</span>
        <button class="linkbtn" type="button" data-act="otab" data-tab="questions">Ver todas</button></div>
      ${qs || `<p class="meta">Nenhuma questão corresponde ao filtro.</p>`}
      <div class="listhead section-gap"><b>Pendências</b><span class="meta">${nf.format(o.counts.debts || 0)}</span>
        <button class="linkbtn" type="button" data-act="otab" data-tab="debts">Ver todas</button></div>
      ${ds || `<p class="meta">Nenhuma pendência corresponde ao filtro.</p>`}
      <p class="meta section-gap">O painel não edita: pagar uma dívida é - [ ] → - [x] no arquivo, na sessão que a pagou.</p>`;
  }
  const rows = o.questions.concat(o.debts).map(openRow).join("");
  const total = o.tab === "questions" || o.tab === "owner" ? (o.counts.questions || 0) : (o.counts.debts || 0);
  const shown = o.questions.length + o.debts.length;
  const more = shown < (o.counts.total || total) && !o.loading
    ? `<div style="margin-top:10px"><button class="btn sm" type="button" data-act="more-open">Mostrar mais</button>
       <span class="meta">${nf.format(shown)} de ${nf.format(o.counts.total || total)}</span></div>` : "";
  return `<div class="seg" style="margin-bottom:10px">${seg}</div>${filter}${loading}
    ${rows || (!o.loading ? `<div class="empty"><b>Nada em aberto neste filtro.</b><p>Nenhuma questão ou pendência corresponde.</p><button class="btn sm" type="button" data-act="all-open">Ver tudo</button></div>` : "")}
    ${more}
    <p class="meta section-gap">O painel não edita: pagar uma dívida é - [ ] → - [x] no arquivo, na sessão que a pagou.</p>`;
}

/* ---------------- Operar ---------------- */

const TIER_LABEL = { read: "leitura", write: "escrita local", service: "serviço", owner: "owner", cost: "custo", danger: "destrutivo" };
const TIER_CLASS = { owner: "owner", cost: "cost", danger: "danger", read: "ok" };
const DIALOG_KINDS = new Set(["deploy", "restart", "close", "land", "worktree", "adr", "book", "atlas", "gc", "tooleval", "archive"]);

function tierTag(t) {
  return `<span class="tag ${TIER_CLASS[t] || ""}">${TIER_LABEL[t] || t}</span>`;
}

async function loadCommands() {
  S.operar.loading = true;
  render();
  try {
    const r = await call("/commands");
    S.operar.groups = r.groups || [];
    S.operar.enabled = !!r.enabled;
  } catch (e) { toast(e.message); }
  S.operar.loading = false;
  render();
}

async function loadRuns() {
  try {
    const r = await call("/runs");
    S.operar.runs = r.runs || [];
  } catch { /* keep */ }
  renderRuns();
}

function startPolling() {
  if (S.operar.timer) return;
  S.operar.timer = setInterval(async () => {
    const anyRunning = S.operar.runs.some((r) => r.status === "running");
    if (!anyRunning) {
      clearInterval(S.operar.timer);
      S.operar.timer = null;
      if (S.view === "health") void loadHealth();
      return;
    }
    await loadRuns();
    if (S.view === "health") void loadHealth();
  }, 900);
}

function catalogHtml() {
  const o = S.operar;
  const groups = o.group === "all" ? o.groups : o.groups.filter((g) => g.group === o.group);
  const html = groups.map((g) => {
    const items = g.items.filter((c) => !o.filter || (c.label + " " + c.when + " " + c.id).toLowerCase().includes(o.filter.toLowerCase()));
    if (!items.length) return "";
    return `<div class="cmdgroup">${esc(g.group)}</div>` + items.map((c) => {
      const action = c.kind === "service" ? "Gerenciar" : DIALOG_KINDS.has(c.kind) ? "Abrir…" : "Rodar";
      return `<div class="cmd">
        <div class="grow"><b>${esc(c.label)}</b> <span class="mono meta">make ${esc(c.id)}</span><div class="when">${esc(c.when)}</div></div>
        <div class="right"><span class="pill">${esc(c.cost)}</span>${tierTag(c.tier)}
          <button class="btn sm" type="button" data-act="cmd" data-cmd="${esc(c.id)}">${action}</button></div>
      </div>`;
    }).join("");
  }).join("");
  return html || `<p class="meta">Nenhum comando corresponde ao filtro.</p>`;
}

function renderOperar() {
  const o = S.operar;
  if (!S.commandsEnabled) {
    return `<div class="empty"><b>Os comandos estão desligados.</b>
      <p>Ligue “Operate commands” na página da extensão para executar os alvos deste repositório.</p>
      <button class="btn sm" type="button" data-act="reload">Atualizar</button></div>`;
  }
  if (o.loading) return `<div class="sk" style="width:40%"></div><div class="sk" style="width:70%"></div><div class="sk" style="width:55%"></div>`;
  if (!o.enabled) {
    return `<div class="empty"><b>Este repositório não tem Makefile.</b>
      <p>Os comandos do Docboard rodam os alvos do Makefile; sem ele, a aba fica vazia.</p>
      <button class="btn sm" type="button" data-act="reload">Atualizar</button></div>`;
  }
  const running = o.runs.filter((r) => r.status === "running");
  const receipts = o.runs.filter((r) => r.status !== "running").slice(0, 4);
  const groups = ["all"].concat(o.groups.map((g) => g.group));
  const gchips = groups.map((g) => `<button type="button" data-act="ogroup" data-g="${esc(g)}" aria-pressed="${o.group === g}">${g === "all" ? "Todos" : esc(g)}</button>`).join("");
  return `<div id="runs"><div class="listhead"><b>Execuções</b><span class="meta">reais</span></div>
      ${(running.concat(receipts)).map(runHtml).join("") || `<p class="meta">Nenhuma execução nesta sessão. Tudo o que rodar deixa um recibo.</p>`}</div>
    <div class="seg section-gap" style="margin-bottom:10px">${gchips}</div>
    <div class="fieldwrap" style="margin-bottom:12px"><input id="op-filter" type="search" placeholder="Filtrar comandos…" value="${esc(o.filter)}" aria-label="Filtrar comandos" /></div>
    <div id="cmdlist">${catalogHtml()}</div>`;
}

function runHtml(r) {
  const cls = r.status === "running" ? "running" : r.status === "ok" ? "ok" : "bad";
  const phase = r.status === "running"
    ? `<div class="phase">${esc(r.phase || "executando")} · ${esc(elapsedOf(r))}</div>`
    : `<div class="sub">${esc(r.verdict || r.status)}${r.ended ? " · " + esc(elapsedOf(r)) : ""}${r.cwd ? " · " + esc(r.cwd) : ""}</div>`;
  const tag = r.status === "running" ? `<span class="tag" style="margin-left:6px">rodando</span>`
    : r.status === "ok" ? `<span class="tag ok" style="margin-left:6px">succeeded</span>`
    : r.status === "stopped" ? `<span class="tag danger" style="margin-left:6px">parado</span>`
    : `<span class="tag danger" style="margin-left:6px">failed</span>`;
  return `<div class="run ${cls}">
    <span class="dot ${r.status === "running" ? "run" : r.status === "ok" ? "ok" : "bad"}"></span>
    <div class="grow"><b style="font-size:12.5px">${esc(r.label)}</b> <span class="mono meta">${esc(r.cmd)}</span>${tag}${phase}</div>
    ${r.status === "running" ? `<button class="btn sm" type="button" data-act="stop-run" data-run="${esc(r.id)}">Parar</button>` : ""}
    <button class="btn sm" type="button" data-act="log" data-run="${esc(r.id)}">Ver saída</button>
  </div>`;
}

function renderRuns() {
  const el = $("#runs");
  if (el) {
    const o = S.operar;
    const running = o.runs.filter((r) => r.status === "running");
    const receipts = o.runs.filter((r) => r.status !== "running").slice(0, 4);
    el.innerHTML = `<div class="listhead"><b>Execuções</b><span class="meta">reais</span></div>` +
      ((running.concat(receipts)).map(runHtml).join("") || `<p class="meta">Nenhuma execução nesta sessão.</p>`);
    syncRunButtons();
    return;
  }
  if (S.view === "operar") render();
}

function syncRunButtons() {
  const ownerRunning = S.operar.runs.some((r) => r.status === "running" && r.tier === "owner");
  document.querySelectorAll('[data-act="cmd"]').forEach((b) => {
    const id = b.dataset.cmd;
    const cmd = findCmdInState(id);
    if (cmd && cmd.tier === "owner") {
      b.disabled = ownerRunning;
      b.title = ownerRunning ? "Outra operação owner-grade está rodando; uma por vez." : "";
    }
  });
}

function findCmdInState(id) {
  for (const g of S.operar.groups) for (const c of g.items) if (c.id === id) return c;
  return null;
}

async function startCommand(id, params) {
  try {
    const r = await post("/run", { id, params: params || {} });
    if (r.run) {
      S.operar.runs = [r.run, ...S.operar.runs.filter((x) => x.id !== r.run.id)];
      renderRuns();
      startPolling();
      toast(r.run.label + ": iniciado.");
    }
  } catch (e) {
    toast(e.message);
  }
}

async function stopRun(id) {
  try {
    const r = await post("/run/stop", { id });
    if (r.run) {
      S.operar.runs = S.operar.runs.map((x) => (x.id === r.run.id ? r.run : x));
      renderRuns();
      toast("Execução parada.");
    }
  } catch (e) { toast(e.message); }
}


/* ---------------- Graph ---------------- */

async function prepareGraph(scope, path) {
  const g = S.graph;
  if (scope) g.scope = scope;
  if (path !== undefined) g.path = path;
  if (!g.path && S.read.doc) g.path = S.read.doc;
  if (g.scope === "doc" && !g.path) g.scope = "hubs";
  S.view = "graph";
  g.loading = true;
  g.error = "";
  render();
  try {
    let url = "/graph?scope=" + encodeURIComponent(g.scope);
    if (g.scope === "doc") url += "&path=" + encodeURIComponent(g.path) + "&depth=1";
    if (g.scope === "hubs") url += "&limit=15";
    g.data = await call(url);
  } catch (e) {
    g.error = e.message;
    g.data = null;
  }
  g.loading = false;
  render();
}

function renderGraph() {
  const g = S.graph;
  const scopes = [["hubs", "Hubs"], ["collections", "Coleções"]];
  if (S.read.doc) scopes.push(["doc", "Este documento"]);
  const chips = scopes.map(([id, label]) => `<button type="button" data-act="gscope" data-s="${id}" aria-pressed="${g.scope === id}">${label}</button>`).join("");
  const head = `<div class="seg" style="margin-bottom:10px">${chips}</div>`;
  if (g.loading) return head + `<div class="graphwrap"><div class="boot"><div class="box"><p class="meta">Montando o grafo…</p><div class="sk" style="width:60%"></div><div class="sk" style="width:80%"></div></div></div></div>`;
  if (g.error) return head + `<div class="empty"><b>Não consegui montar o grafo.</b><p>${esc(g.error)}</p><button class="btn sm" type="button" data-act="graph-retry">Tentar de novo</button></div>`;
  const d = g.data;
  if (!d) return head + `<div class="empty"><b>Escolha um escopo.</b><p>Hubs mostra os documentos mais ligados; Coleções mostra o fluxo entre as pastas.</p><button class="btn sm" type="button" data-act="gscope" data-s="hubs">Ver hubs</button></div>`;
  const current = d.focus || "";
  const nodes = (d.nodes || []).slice().sort((a, b) => (b.degree || 0) - (a.degree || 0));
  const top = nodes.slice(0, 8).map((n) => {
    const isColl = d.scope === "collections";
    return `<button type="button" data-act="${isColl ? "coll" : "doc"}" data-${isColl ? "coll" : "doc"}="${esc(n.id)}">
      <span class="t">${esc(n.t)}</span><span class="d">${nf.format(n.degree || 0)}${isColl ? "" : " · " + esc((S.collections.find((c) => c.id === n.c) || {}).name || n.c)}</span></button>`;
  }).join("");
  const back = (d.backlinks || []).slice(0, 8).map((b) => `<button class="file" type="button" data-act="doc" data-doc="${esc(b.p)}"><span class="t">${esc(b.t)}</span><span class="d">${esc(b.p)}</span></button>`).join("");
  const out = (d.outbound || []).slice(0, 8).map((b) => `<button class="file" type="button" data-act="doc" data-doc="${esc(b.p)}"><span class="t">${esc(b.t)}</span><span class="d">${esc(b.p)}</span></button>`).join("");
  const broken = (d.brokenExamples || []).slice(0, 6).map((b) => `<div class="alertrow"><span class="dot bad"></span><span class="grow">${esc(b.from)} → ${esc(b.target)}</span></div>`).join("");
  const extra = d.scope === "doc"
    ? `<div class="plain-h section-gap">Referenciado por</div>${back || `<p class="meta">Nenhum documento aponta para este.</p>`}
       <div class="plain-h section-gap">Aponta para</div>${out || `<p class="meta">Este documento não aponta para outro.</p>`}
       ${broken ? `<div class="plain-h section-gap">Links quebrados</div>${broken}` : ""}`
    : "";
  return `${head}
    <div class="graphwrap" id="graphwrap"><svg id="graph" role="img" aria-label="Grafo de ligações entre documentos"></svg></div>
    <p class="meta" style="margin-top:8px">${nf.format((d.nodes || []).length)} nós · ${nf.format((d.edges || []).length)} ligações${d.stats ? " · repositório: " + nf.format(d.stats.orphans) + " órfãos · " + nf.format(d.stats.broken) + " links quebrados" : ""}</p>
    <div class="plain-h section-gap">Nós principais</div>
    <div class="graphlist">${top || `<p class="meta">Sem nós neste recorte.</p>`}</div>
    ${extra}`;
}

function drawGraph() {
  if (S.view !== "graph") return;
  const wrap = $("#graphwrap");
  const svgEl = $("#graph");
  const d = S.graph.data;
  if (!wrap || !svgEl || !d) return;
  if (typeof d3 === "undefined") {
    wrap.innerHTML = `<div class="boot"><div class="box"><div class="empty"><b>O D3 não carregou.</b><p>A página usa o D3 que o PiCode serve; recarregue a aba.</p></div></div></div>`;
    return;
  }
  const W = Math.max(280, wrap.clientWidth);
  const H = Math.max(220, wrap.clientHeight);
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.innerHTML = "";
  const nodes = (d.nodes || []).map((n) => ({ ...n }));
  const links = (d.edges || []).map((e) => ({ source: e.s, target: e.t, kind: e.kind, w: e.w }));
  const collections = d.scope === "collections";
  const svg = d3.select(svgEl);
  const defs = svg.append("defs");
  defs.append("marker").attr("id", "garrow").attr("viewBox", "0 -4 8 8").attr("refX", 13).attr("refY", 0)
    .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
    .append("path").attr("d", "M0,-4L8,0L0,4").attr("class", "gedge-arrow");
  const root = svg.append("g");
  svg.call(d3.zoom().scaleExtent([0.35, 4]).on("zoom", (ev) => root.attr("transform", ev.transform)));
  const link = root.append("g").selectAll("line").data(links).join("line")
    .attr("class", "gedge")
    .attr("stroke-width", (e) => 1 + Math.min(2, Math.log2((e.w || 1) + 1) * 0.6))
    .attr("stroke-opacity", nodes.length > 40 ? 0.3 : 0.8)
    .attr("marker-end", "url(#garrow)");
  const node = root.append("g").selectAll("circle").data(nodes).join("circle")
    .attr("r", (n) => n.current ? 9 : Math.min(7, 4 + Math.log2((n.degree || 1) + 1)))
    .attr("class", (n) => "gnode" + (n.current ? " current" : "") + (collections ? " collection" : ""))
    .on("click", (ev, n) => {
      ev.stopPropagation();
      if (collections) void openCollection(n.id);
      else void openDoc(n.id, null);
    });
  node.append("title").text((n) => n.t + "\n" + (n.id || "") + " · " + (n.degree || 0) + " ligações");
  const labelled = nodes.length <= 18
    ? nodes
    : nodes.filter((n) => n.current).concat(
        nodes.filter((n) => !n.current).sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 5),
      );
    const label = root.append("g").selectAll("text").data(labelled).join("text")
    .attr("class", (n) => "glabel" + (n.current ? " current" : ""))
    .text((n) => n.t.length > 34 ? n.t.slice(0, 32) + "…" : n.t);
  const maxDeg = Math.max(1, ...nodes.map((n) => n.degree || 1));
  const sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((n) => n.id).distance(collections ? 128 : d.scope === "hubs" ? 108 : 100).strength(0.38))
    .force("charge", d3.forceManyBody().strength(collections ? -420 : d.scope === "hubs" ? -300 : -320))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collide", d3.forceCollide().radius((n) => (n.current ? 32 : d.scope === "doc" ? 28 : 24)));
  if (d.scope === "hubs") {
    sim.force("radial", d3.forceRadial(
      (n) => 84 + 150 * (1 - Math.min(1, Math.log2((n.degree || 1) + 1) / Math.log2(maxDeg + 1))),
      W / 2, H / 2,
    ).strength(0.45));
  }
  sim.on("tick", () => {
      link.attr("x1", (e) => e.source.x).attr("y1", (e) => e.source.y)
        .attr("x2", (e) => e.target.x).attr("y2", (e) => e.target.y);
      for (const n of nodes) {
        n.x = Math.max(16, Math.min(W - 16, n.x));
        n.y = Math.max(16, Math.min(H - 16, n.y));
      }
      node.attr("cx", (n) => n.x).attr("cy", (n) => n.y);
      label.attr("x", (n) => Math.max(14, Math.min(W - 14, n.x > W * 0.6 ? n.x - 10 : n.x + 10)))
        .attr("y", (n) => {
          const dy = n.y - H / 2, len = Math.hypot(n.x - W / 2, dy) || 1;
          return Math.max(16, Math.min(H - 8, n.y + (dy / len) * 16 + 3));
        }).attr("text-anchor", (n) => (n.x > W * 0.6 ? "end" : "start"));
    });
  node.call(d3.drag()
    .on("start", (ev, n) => { if (!ev.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
    .on("drag", (ev, n) => { n.fx = ev.x; n.fy = ev.y; })
    .on("end", (ev, n) => { if (!ev.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));
}

/* ---------------- Map ---------------- */

async function refreshIndex() {
  try {
    await post("/refresh", {});
    const ov = await call("/overview");
    S.overview = ov;
    S.stats = ov.stats || {};
    S.collections = ov.collections || [];
    buildRail();
    render();
    toast("Índice atualizado.");
  } catch (e) { toast(e.message); }
}

function renderMap() {
  const st = S.stats;
  const kpis = [
    { v: nf.format(st.debts || 0), l: "pendências abertas", c: `${st.openTopics || 0} tópicos`, act: "kpi", target: "debts" },
    { v: nf.format(st.questions || 0), l: "questões em aberto", c: `${st.ownerQuestions || 0} de owner`, act: "kpi", target: "questions" },
    { v: nf.format(st.changelog || 0), l: "fragmentos de changelog", c: "não dobrados", act: "kpi", target: "changelog" },
    { v: nf.format(st.docs || 0), l: "arquivos indexados", c: S.overview ? "repositório " + S.overview.repo.split("/").pop() : "", act: "noop" },
  ].map((k) => k.act === "kpi"
    ? `<button class="kpi" type="button" data-act="kpi" data-target="${k.target}"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div><div class="c">${esc(k.c)}</div></button>`
    : `<div class="kpi"><div class="v">${k.v}</div><div class="l">${esc(k.l)}</div><div class="c">${esc(k.c)}</div></div>`).join("");
  const cards = S.collections.map((c) => `<button class="coll" type="button" data-act="coll" data-coll="${esc(c.id)}"><b>${esc(c.name)}</b><span class="n">${nf.format(c.n)}</span></button>`).join("");
  return `<div class="row" style="margin-bottom:10px"><span class="meta">${esc(S.overview ? S.overview.repo : "")}</span><span class="spacer"></span>
      <button class="btn sm" type="button" data-act="refresh">Atualizar índice</button></div>
    <div class="kpis">${kpis}</div>
    <div class="plain-h">Coleções</div><div class="coll-list" style="margin-bottom:16px">${cards}</div>
    <div class="plain-h">Alertas</div>
    <div class="alertrow"><span class="dot warn"></span><span class="grow">${nf.format(st.ownerQuestions || 0)} questões precisam de decisão do owner</span>
      <button class="btn sm" type="button" data-act="kpi" data-target="owner">Abrir</button></div>
    <div class="alertrow"><span class="dot"></span><span class="grow">${S.overview && S.overview.graph ? nf.format(S.overview.graph.edges) + " ligações · " + nf.format(S.overview.graph.broken) + " links quebrados" : "grafo de ligações"}</span>
      <button class="btn sm" type="button" data-act="graph-hubs">Abrir grafo</button></div>
    <div class="alertrow"><span class="dot"></span><span class="grow">${st.guides || 0} alvos de guide · ${st.atlas || 0} superfícies de atlas</span></div>
    <div class="alertrow"><span class="dot"></span><span class="grow">${nf.format(st.books || 0)} books · ${nf.format(st.notes || 0)} notas de handoff</span></div>`;
}

/* ---------------- Health ---------------- */

async function loadHealth() {
  S.health.loading = true;
  try {
    const r = await call("/health");
    S.health.gates = r.gates || [];
    S.health.counts = r.counts || {};
    S.health.handoffToday = !!r.handoffToday;
  } catch { /* keep */ }
  S.health.loading = false;
  if (S.view === "health") render();
}

async function runGate(id) {
  await startCommand(id);
  if (S.view === "health") { S.health.loading = true; render(); }
}

function renderHealth() {
  const h = S.health;
  const gates = (h.gates || []).map((g) => {
    const dot = g.status === "ok" ? "ok" : g.status === "failed" ? "bad" : g.status === "running" ? "run" : "";
    const word = g.status === "ok" ? "ok" : g.status === "failed" ? (g.verdict || "falhou") : g.status === "running" ? "rodando" : "não verificado";
    return `<div class="gate"><span class="dot ${dot}"></span>
      <div class="grow"><div>${esc(g.label)}</div><div class="why">${esc(word)}</div></div>
      ${g.status === "ok" ? "" : `<button class="btn sm" type="button" data-act="gate" data-gate="${esc(g.id)}">Rodar</button>`}</div>`;
  }).join("");
  const c = h.counts || {};
  return `<div class="plain-h">Gates do branch</div>
    ${h.loading && !gates ? `<div class="sk" style="width:50%"></div>` : `<div class="gates">${gates}</div>`}
    <div class="plain-h section-gap">Documentação</div>
    <div class="alertrow"><span class="dot ${h.handoffToday ? "ok" : "warn"}"></span><span class="grow">Nota de handoff de hoje ${h.handoffToday ? "existe" : "não encontrada no checkout raiz"}</span></div>
    <div class="alertrow"><span class="dot"></span><span class="grow">${nf.format(c.changelog || 0)} fragmentos de changelog não dobrados</span></div>
    <div class="alertrow"><span class="dot"></span><span class="grow">${nf.format(c.debts || 0)} pendências · ${nf.format(c.questions || 0)} questões em aberto</span></div>
    <p class="meta section-gap">O gate decide; o painel lê. Rodar aqui executa o alvo real do Makefile e deixa o recibo em Operar.</p>`;
}

/* ---------------- dialogs ---------------- */

function openDialog(kind, opts) {
  S.dialog = { kind, loading: false, error: "", sel: "", fields: {}, data: null, ...(opts || {}) };
  $("#overlay").classList.add("open");
  renderDialog();
  requestAnimationFrame(() => {
    const first = $("#dialog .btn, #dialog input, #dialog select");
    if (first) first.focus();
  });
}

function closeDialog() {
  S.dialog = null;
  $("#overlay").classList.remove("open");
  $("#dialog").innerHTML = "";
}

async function openRunDialog(kind) {
  openDialog(kind, { loading: true });
  try {
    if (kind === "deploy" || kind === "restart") {
      S.dialog.data = await call("/preflight?kind=" + encodeURIComponent(kind));
    } else if (kind === "close") {
      S.dialog.data = await call("/worktrees");
      const list = S.dialog.data.worktrees || [];
      S.dialog.sel = (list.find((w) => !w.main) || list[0] || {}).path || "";
    }
    S.dialog.loading = false;
    renderDialog();
  } catch (e) {
    S.dialog.loading = false;
    S.dialog.error = e.message;
    renderDialog();
  }
}

function dialogHeader(title, sub) {
  return `<h3 id="dlg-title">${esc(title)}</h3><div class="sub">${sub || ""}</div>`;
}

function dialogFoot(label, danger) {
  return `<div class="foot"><button class="btn" type="button" data-act="dlg-cancel">Cancelar</button>
    <button class="btn ${danger ? "danger" : "primary"}" type="button" data-act="dlg-confirm">${esc(label)}</button></div>`;
}

function renderDialog() {
  const d = S.dialog;
  const el = $("#dialog");
  if (!d) return;
  let html = "";
  if (d.loading) html = dialogHeader("Verificando…", "") + `<div class="sk" style="width:70%"></div><div class="sk" style="width:50%"></div>`;
  else if (d.kind === "deploy" || d.kind === "restart") {
    const isDeploy = d.kind === "deploy";
    const p = d.data || {};
    const lock = p.lockHeld === true ? "ocupado — este comando entra na fila" : p.lockHeld === false ? "livre" : "não verificado";
    html = dialogHeader(isDeploy ? "Deploy" : "Restart do shell",
      isDeploy ? "Reconstrói UI + binário e reinicia o serviço. Um por vez; nunca força." : "Recompila e troca os executáveis do desktop. Serializado com o deploy.")
      + `<div class="pre">
        <div><span class="dot ok"></span><span>checkout raiz: ${esc(p.main || p.repo || "")}</span></div>
        <div><span class="dot ${p.lockHeld === true ? "warn" : "ok"}"></span><span>lock /tmp/picode-mutate.lock: ${esc(lock)}</span></div>
        <div><span class="dot"></span><span>agente mid-turn: o próprio make deploy recusa</span></div>
      </div>
      <p class="meta">${isDeploy ? "Se houver agente mid-turn, o alvo recusa e o recibo diz o motivo." : "Só no Windows."} Nunca <code>PICODE_DEPLOY_FORCE</code>.</p>`
      + (d.error ? `<div class="err">${esc(d.error)}</div>` : "")
      + dialogFoot(isDeploy ? "Deployar" : "Reiniciar", false);
  } else if (d.kind === "close") {
    const list = (d.data && d.data.worktrees) || [];
    const rows = list.map((w) => `<label class="radio"><input type="radio" name="wt" value="${esc(w.path)}" ${d.sel === w.path ? "checked" : ""} data-act="wt-pick" />
      <span class="mono">${esc(w.branch)}</span><span class="spacer"></span><span class="meta">${w.dirty < 0 ? "?" : w.dirty + " alterações"}</span></label>`).join("");
    html = dialogHeader("Fechar sessão", "Roda <code>make close</code> no worktree escolhido. O root não é oferecido.")
      + (rows || `<p class="meta">Nenhum worktree encontrado.</p>`)
      + (d.error ? `<div class="err">${esc(d.error)}</div>` : "")
      + dialogFoot("Fechar sessão", false);
  } else if (d.kind === "land") {
    html = dialogHeader("Enfileirar land", "O branch entra na fila; o acompanhamento é na aba Deliveries.")
      + `<label class="meta" for="land-branch">Branch</label><input class="field" id="land-branch" value="${esc(d.fields.branch || "")}" placeholder="feat/docs-board" autocomplete="off" />
         ${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}
         <p class="meta">O ticket só nasce se o branch existir. A fila não é duplicada aqui.</p>`
      + dialogFoot("Enfileirar", false);
  } else if (d.kind === "worktree") {
    html = dialogHeader("Novo worktree", "Uma árvore isolada em <code>feat/NAME</code>.")
      + `<label class="meta" for="wt-name">Nome</label><input class="field" id="wt-name" value="${esc(d.fields.name || "")}" placeholder="docs-board" autocomplete="off" />${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`
      + dialogFoot("Criar", false);
  } else if (d.kind === "adr") {
    html = dialogHeader("Semear ADR", "O próximo registro, com a linha de Boundary no topo.")
      + `<label class="meta" for="adr-name">Título curto</label><input class="field" id="adr-name" value="${esc(d.fields.name || "")}" placeholder="docs-board-panel" autocomplete="off" />${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`
      + dialogFoot("Criar", false);
  } else if (d.kind === "book") {
    html = dialogHeader("Semear book", "Um book a partir do template, com escopo e leitor.")
      + `<label class="meta" for="book-name">Nome</label><input class="field" id="book-name" value="${esc(d.fields.name || "")}" placeholder="panel-maintenance" autocomplete="off" />
         <label class="meta" for="book-type" style="display:block;margin-top:8px">Tipo</label>
         <select class="field" id="book-type">${["runbook", "playbook", "sop", "cheatsheet"].map((t) => `<option ${d.fields.type === t ? "selected" : ""}>${t}</option>`).join("")}</select>${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`
      + dialogFoot("Criar", false);
  } else if (d.kind === "atlas") {
    html = dialogHeader("Fotografar superfícies", "Só as que você indicar; sem ID, as do branch atual.")
      + `<label class="meta" for="atlas-id">ID (opcional)</label><input class="field" id="atlas-id" value="${esc(d.fields.id || "")}" placeholder="docs-panel" autocomplete="off" />${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}`
      + dialogFoot("Fotografar", false);
  } else if (d.kind === "gc") {
    html = dialogHeader("Limpar worktrees", "Remove só árvores merged, limpas e ociosas. O alvo recusa o resto.")
      + `<p class="meta">Uncommitted e branches não mergeadas ficam.</p>` + (d.error ? `<div class="err">${esc(d.error)}</div>` : "")
      + dialogFoot("Limpar", true);
  } else if (d.kind === "tooleval") {
    html = dialogHeader("A/B das ferramentas", "Roda CLIs reais contra o texto de ferramentas do branch e do main.")
      + `<div class="pre"><div><span class="dot warn"></span><span>Custo estimado: ~US$ 5 (Claude Code sozinho)</span></div>
         <div><span class="dot warn"></span><span>Tempo:~10 min · não entra no make ci</span></div></div>`
      + (d.error ? `<div class="err">${esc(d.error)}</div>` : "") + dialogFoot("Rodar mesmo assim", true);
  } else if (d.kind === "archive") {
    html = dialogHeader("Arquivar notas velhas", "Move notas com mais de 30 dias para o arquivo; nada é apagado.")
      + (d.error ? `<div class="err">${esc(d.error)}</div>` : "") + dialogFoot("Arquivar", true);
  } else if (d.kind === "log") {
    html = dialogHeader(d.data && d.data.label ? d.data.label : "Saída", d.data ? `${d.data.cmd} · ${d.data.status}${d.data.verdict ? " · " + d.data.verdict : ""}` : "")
      + `<pre class="log">${esc((d.data && d.data.tail) || "Sem saída ainda.")}</pre>`
      + `<div class="foot"><button class="btn" type="button" data-act="dlg-cancel">Fechar</button></div>`;
  } else {
    html = dialogHeader("Diálogo", "") + dialogFoot("Fechar", false);
  }
  el.innerHTML = html;
  el.setAttribute("aria-labelledby", "dlg-title");
}

async function confirmDialog() {
  const d = S.dialog;
  if (!d) return;
  const id = d.kind === "restart" ? "desktop-restart" : d.kind;
  const read = (sel) => (document.querySelector(sel) || {}).value || "";
  if (d.kind === "deploy" || d.kind === "restart") { closeDialog(); await startCommand(id, {}); return; }
  if (d.kind === "close") {
    if (!d.sel) { d.error = "Escolha um worktree."; renderDialog(); return; }
    closeDialog(); await startCommand("close", { worktree: d.sel }); return;
  }
  if (d.kind === "land") {
    const branch = read("#land-branch").trim();
    if (!/^(feat|fix|docs|chore|refactor|test|perf)\/[a-z0-9][a-z0-9-]*$/.test(branch)) { d.fields.branch = branch; d.error = "Use um branch no formato feat/nome."; renderDialog(); return; }
    closeDialog(); await startCommand("land", { branch }); return;
  }
  if (d.kind === "worktree") {
    const name = read("#wt-name").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(name)) { d.fields.name = name; d.error = "Use só minúsculas, números e hífens."; renderDialog(); return; }
    closeDialog(); await startCommand("worktree", { name }); return;
  }
  if (d.kind === "adr") {
    const name = read("#adr-name").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(name)) { d.fields.name = name; d.error = "Título curto inválido."; renderDialog(); return; }
    closeDialog(); await startCommand("adr", { name }); return;
  }
  if (d.kind === "book") {
    const name = read("#book-name").trim();
    const type = (document.querySelector("#book-type") || {}).value || "runbook";
    if (!/^[a-z0-9][a-z0-9-]{1,50}$/.test(name)) { d.fields = { name, type }; d.error = "Nome inválido."; renderDialog(); return; }
    closeDialog(); await startCommand("book", { name, type }); return;
  }
  if (d.kind === "atlas") {
    const idv = read("#atlas-id").trim();
    if (idv && !/^[a-z0-9][a-z0-9-]*$/.test(idv)) { d.fields.id = idv; d.error = "ID inválido."; renderDialog(); return; }
    closeDialog(); await startCommand("atlas-shot", { id: idv }); return;
  }
  if (d.kind === "gc") { closeDialog(); await startCommand("worktree-gc", {}); return; }
  if (d.kind === "tooleval") { closeDialog(); await startCommand("tool-eval", {}); return; }
  if (d.kind === "archive") { closeDialog(); await startCommand("handoff-archive", {}); return; }
  closeDialog();
}

/* ---------------- events ---------------- */

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;

  if (act === "retry-boot" || act === "reload") { void boot(); return; }
  if (act === "coll") { void openCollection(t.dataset.coll); return; }
  if (act === "doc") { e.preventDefault(); void openDoc(t.dataset.doc, t.dataset.line ? Number(t.dataset.line) : null); return; }
  if (act === "back-doc") { e.preventDefault(); backFromDoc(); return; }
  if (act === "nav-back") {
    e.preventDefault();
    if (S.read.doc) backFromDoc();
    else { S.read.coll = null; S.read.files = []; S.read.total = 0; render(); }
    return;
  }
  if (act === "more-files") { void moreFiles(); return; }
  if (act === "copy") { e.preventDefault(); void copyText(t.dataset.copy || "", t.dataset.what || "Texto"); return; }
  if (act === "retry-doc") { delete S.read.docMeta; void openDoc(t.dataset.doc, null); return; }
  if (act === "example") {
    S.search.q = t.dataset.q;
    const gs = $("#global-search");
    if (gs) gs.value = S.search.q;
    S.search.f = "all";
    if (S.view !== "search") S.view = "search";
    gs.focus();
    scheduleSearch(120);
    return;
  }
  if (act === "clear-search") {
    S.search.q = ""; S.search.ran = false; S.search.files = []; S.search.open = []; S.search.busy = false;
    const gs = $("#global-search");
    if (gs) { gs.value = ""; gs.focus(); }
    render();
    return;
  }
  if (act === "sfilter") {
    S.search.f = t.dataset.f;
    S.view = "search";
    if (S.search.q) void doSearch(); else render();
    return;
  }
  if (act === "retry-search") { void doSearch(); return; }
  if (act === "result") {
    const f = S.search.files[Number(t.dataset.i)];
    if (f) void openDoc(f.p, null);
    return;
  }
  if (act === "open-result") {
    const it = S.search.open[Number(t.dataset.i)];
    if (it) void openDoc(it.kind === "q" ? it.plan : it.topic, it.line);
    return;
  }
  if (act === "search-all") { toast("A busca cobre todo o índice do repositório."); return; }
  if (act === "otab") {
    S.open.tab = t.dataset.tab;
    S.open.offset = 0;
    void loadOpen(false);
    return;
  }
  if (act === "all-open") { S.open.tab = "all"; S.open.q = ""; S.open.offset = 0; void loadOpen(false); return; }
  if (act === "more-open") { S.open.offset += 80; void loadOpen(true); return; }
  if (act === "ogroup") { S.operar.group = t.dataset.g; render(); return; }
  if (act === "cmd") {
    const cmd = findCmdInState(t.dataset.cmd);
    if (!cmd) return;
    if (DIALOG_KINDS.has(cmd.kind)) { void openRunDialog(cmd.kind); return; }
    if (cmd.kind === "service") {
      const running = S.operar.runs.find((r) => r.cmd === cmd.id && r.status === "running");
      if (running) void stopRun(running.id);
      else void startCommand(cmd.id, {});
      return;
    }
    void startCommand(cmd.id, {});
    return;
  }
  if (act === "stop-run") { void stopRun(t.dataset.run); return; }
  if (act === "log") {
    openDialog("log", { loading: true });
    (async () => {
      try {
        const run = await call("/run?id=" + encodeURIComponent(t.dataset.run));
        S.dialog.data = run;
      } catch (e) { S.dialog.data = { label: "Saída", cmd: "", status: "", tail: e.message }; }
      S.dialog.loading = false;
      renderDialog();
    })();
    return;
  }
  if (act === "refresh") { void refreshIndex(); return; }
  if (act === "kpi") {
    const target = t.dataset.target;
    if (target === "debts") { S.open.tab = "debts"; S.view = "open"; S.open.offset = 0; void loadOpen(false); }
    else if (target === "questions") { S.open.tab = "questions"; S.view = "open"; S.open.offset = 0; void loadOpen(false); }
    else if (target === "owner") { S.open.tab = "owner"; S.view = "open"; S.open.offset = 0; void loadOpen(false); }
    else if (target === "changelog") { S.read.coll = "changelog"; S.read.doc = null; S.view = "read"; void openCollection("changelog"); }
    return;
  }
  if (act === "gscope") { void prepareGraph(t.dataset.s, t.dataset.s === "doc" ? (S.read.doc || "") : ""); return; }
  if (act === "graph-doc") { void prepareGraph("doc", t.dataset.doc); return; }
  if (act === "graph-hubs") { void prepareGraph("hubs", ""); return; }
  if (act === "graph-retry") { void prepareGraph(S.graph.scope, S.graph.path); return; }
  if (act === "gate") { void runGate(t.dataset.gate); return; }
  if (act === "dlg-cancel") { closeDialog(); return; }
  if (act === "dlg-confirm") { void confirmDialog(); return; }
  if (act === "wt-pick") { if (S.dialog) S.dialog.sel = t.value; return; }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "op-filter") {
    S.operar.filter = e.target.value;
    const list = $("#cmdlist");
    if (list) list.innerHTML = catalogHtml();
  } else if (e.target.id === "open-filter") {
    S.open.q = e.target.value;
    S.focusOpen = true;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { S.open.offset = 0; void loadOpen(false); }, 220);
  }
});

function onSearchInput() {
  const gs = $("#global-search");
  S.search.q = gs.value;
  if (S.view !== "search") { S.view = "search"; render(); }
  else { const sub = $("#tb-sub"); if (sub) sub.textContent = S.search.q ? `resultados para “${S.search.q}”` : "índice local · leitura no repositório"; }
  scheduleSearch(180);
}

function init() {
  const gs = $("#global-search");
  gs.addEventListener("input", onSearchInput);
  gs.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      S.search.q = ""; S.search.ran = false; S.search.files = []; S.search.open = [];
      gs.value = "";
      render();
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); gs.focus(); gs.select(); return; }
    if (e.key === "Enter" && $("#overlay").classList.contains("open")) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT") { e.preventDefault(); void confirmDialog(); }
      return;
    }
    if (e.key === "Escape") {
      if ($("#overlay").classList.contains("open")) { closeDialog(); return; }
      if (S.view === "search" && S.search.q) {
        S.search.q = ""; S.search.ran = false; S.search.files = []; S.search.open = [];
        if (gs) gs.value = "";
        render();
      }
    }
  });
  $("#overlay").addEventListener("click", (e) => { if (e.target === $("#overlay")) closeDialog(); });
  window.addEventListener("resize", () => { if (S.view === "graph" && S.graph.data) drawGraph(); });
  void boot();
}

init();
