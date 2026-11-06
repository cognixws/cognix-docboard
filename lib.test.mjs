import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askChunks, buildCorpus, searchCorpus, catalog, commandPlan, findCommand, egoGraph, hubGraph, collectionGraph, backlinksOf, pulseOf, changeObligations, coverageOf, repairLinks, shortestPath } from "./lib.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docboard-test-"));
  const write = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  write("docs/decisions/0001-one.md", "# ADR-0001: One\n\n## Boundary\n\nProcess.\n");
  write("docs/plans/panel.md", "# Panel plan\n\nSee the [subsystem](../architecture/one.md). It follows ADR-0001.\n\n## Open questions (owner)\n\n1. **Which panel**: the dock (recommended) or a pane?\n   It is a link's intent.\n2. A second question?\n\n## Next\n\nText.\n");
  write("docs/handoff/open/topic.md", "# Topic\n\n- [ ] First debt\n  continued here.\n- [x] Done debt\n\n- [ ] Second debt\n");
  write("docs/handoff/2026-01-01-a.md", "# A session\n");
  write("docs/architecture/one.md", "# One subsystem\n\nThe land does not restart. See [the plan](../plans/panel.md), docs/decisions/0001-one.md and ADR-0001.\n\nA [missing doc](../plans/missing.md) is broken, and a [typo](../plans/panell.md) too.\n");
  write("docs/changelog.d/x.md", "# Fragment\n");
  write("docs/books/runbooks/build.md", "# Build\n\nRun the Makefile target before shipping.\n");
  write("docs/architecture/widget.md", "# Widget subsystem\n\nThe widget lives in internal/widget/.\n");
  write("docs/architecture/orphan.md", "# Orphan subsystem\n\nNothing here.\n");
  write("internal/widget/widget.go", "package widget\n");
  write("web/browser/src/App.jsx", "export default function App() { return null; }\n");
  write("AGENTS.md", "# Agents\n");
  write("README.md", "# Readme\n");
  write("Makefile", "all:\n\t@true\n");
  write("web/shared/domain/guides.js", "export const g = [{ target: 'a', \"data-tour\": 'x' }];\n");
  write("docs/atlas/surfaces.json", "{ \"surfaces\": [ {\"id\": \"home\"}, {\"id\": \"inbox\"} ] }\n");
  return root;
}

test("buildCorpus maps collections, titles and counts", () => {
  const repo = fixture();
  const c = buildCorpus(repo);
  assert.equal(c.repo, path.resolve(repo));
  const find = (p) => c.files.find((f) => f.p === p);
  assert.equal(find("docs/decisions/0001-one.md").t, "ADR-0001: One");
  assert.equal(find("docs/decisions/0001-one.md").c, "decisions");
  assert.equal(find("docs/plans/panel.md").c, "plans");
  assert.equal(find("AGENTS.md").c, "root");
  assert.equal(c.stats.adrs, 1);
  assert.equal(c.stats.plans, 1);
  assert.equal(c.stats.notes, 1);
  assert.equal(c.stats.openTopics, 1);
  assert.equal(c.stats.guides, 1);
  assert.equal(c.stats.atlas, 2);
});

test("open questions keep continuations and the owner flag", () => {
  const repo = fixture();
  const c = buildCorpus(repo);
  assert.equal(c.questions.length, 2);
  assert.equal(c.questions[0].owner, true);
  assert.match(c.questions[0].text, /link's intent/);
  assert.equal(c.questions[1].owner, true); // both live under "(owner)"
});

test("debts are the unchecked boxes only, with continuations", () => {
  const repo = fixture();
  const c = buildCorpus(repo);
  assert.equal(c.debts.length, 2);
  assert.match(c.debts[0].text, /continued here/);
  assert.equal(c.debts[1].text, "Second debt");
});

test("search ranks a title over body text and offers open matches", () => {
  const repo = fixture();
  const c = buildCorpus(repo);
  const r = searchCorpus(c, "panel link", {});
  assert.ok(r.files.length >= 1);
  assert.equal(r.files[0].p, "docs/plans/panel.md");
  assert.ok(r.files[0].x.includes("…"));
  const d = searchCorpus(c, "debt", {});
  assert.ok(d.open.some((x) => x.kind === "d"));
});

test("catalog hides desktop-restart off Windows", () => {
  const linux = catalog("linux").flatMap((g) => g.items.map((c) => c.id));
  assert.ok(!linux.includes("desktop-restart"));
  assert.ok(linux.includes("deploy"));
  const win = catalog("win32").flatMap((g) => g.items.map((c) => c.id));
  assert.ok(win.includes("desktop-restart"));
});

test("commandPlan validates parameters and chooses the cwd", () => {
  const ctx = { repo: "/repo", platform: "linux", hasMakefile: true, worktrees: ["/repo/.worktrees/a"] };
  // The flow's verbs live in the Dev flow now (owner, 2026-11-06).
  for (const id of ["worktree", "worktree-status", "ci-scoped", "close", "close-summary", "land", "handoff", "adr"]) {
    assert.match(commandPlan(id, {}, ctx).error, /catálogo/, id);
  }
  assert.deepEqual(commandPlan("book", { name: "run", type: "runbook" }, ctx).argv, ["book", "NAME=run", "TYPE=runbook"]);
  assert.match(commandPlan("book", { name: "run", type: "nope" }, ctx).error, /tipo/);
  assert.equal(commandPlan("deploy", {}, { ...ctx, main: "/main" }).cwd, "/main");
  const bc = commandPlan("books-check", {}, ctx);
  assert.equal(bc.command, "node");
  assert.deepEqual(bc.argv, ["scripts/books-check.mjs"]);
  assert.match(commandPlan("nope", {}, ctx).error, /catálogo/);
  assert.match(commandPlan("deploy", {}, { ...ctx, hasMakefile: false }).error, /Makefile/);
});

test("the link graph resolves links, docs paths and ADR references", () => {
  const c = buildCorpus(fixture());
  const one = "docs/architecture/one.md";
  assert.ok(c.graph.edges.some((e) => e.s === one && e.t === "docs/plans/panel.md" && e.kind === "link"));
  assert.ok(c.graph.edges.some((e) => e.s === one && e.t === "docs/decisions/0001-one.md"));
  assert.ok(c.graph.edges.some((e) => e.s === "docs/plans/panel.md" && e.t === "docs/decisions/0001-one.md" && e.kind === "adr"));
  assert.ok(c.graph.broken.some((b) => b.target.includes("missing.md")));
  assert.equal(c.graph.orphans, c.files.filter((f) => !c.graph.nodes.get(f.p).degree).length);
});

test("ego, hubs and collection graphs stay inside the index", () => {
  const c = buildCorpus(fixture());
  const ego = egoGraph(c.graph, "docs/plans/panel.md", 1);
  assert.ok(ego.nodes.some((n) => n.id === "docs/architecture/one.md"));
  assert.ok(ego.nodes.some((n) => n.id === "docs/plans/panel.md" && n.current));
  const hubs = hubGraph(c.graph, 10);
  assert.ok(hubs.nodes.length > 0 && hubs.nodes.length <= 90);
  const cols = collectionGraph(c, c.graph);
  assert.equal(cols.nodes.length, 9);
  assert.ok(cols.edges.some((e) => e.s === "architecture" && e.t === "plans"));
  const back = backlinksOf(c.graph, "docs/decisions/0001-one.md");
  assert.ok(back.backlinks.length >= 1);
});

test("pulse reports stale living docs and broken links", () => {
  const repo = fixture();
  const old = new Date(Date.now() - 400 * 86400000);
  fs.utimesSync(path.join(repo, "docs/plans/panel.md"), old, old);
  const c = buildCorpus(repo);
  const p = pulseOf(c);
  assert.equal(p.stats.broken, c.graph.broken.length);
  assert.ok(p.broken.some((b) => b.target.includes("missing.md")));
  assert.ok(p.stale.some((s) => s.p === "docs/plans/panel.md" && s.age >= 120));
  assert.equal(p.stats.fragments, 1);
});

test("change obligations read the diff against the ADR-0086 table", () => {
  const c = buildCorpus(fixture());
  const obs = changeObligations([
    { path: "internal/store/migrations/001_x.sql", status: "M" },
    { path: "web/browser/src/App.jsx", status: "M" },
    { path: "Makefile", status: "M" },
    { path: "docs/plans/panel.md", status: "M" },
  ], c, { branch: "feat/docs-board" });
  const kinds = new Set(obs.map((o) => o.kind));
  for (const k of ["backup", "adr", "arch", "changelog", "interface", "books", "docs", "gates"]) assert.ok(kinds.has(k), k);
  assert.ok(obs.find((o) => o.kind === "books").targets.some((t) => t.path === "docs/books/runbooks/build.md"));
  assert.equal(obs.find((o) => o.kind === "changelog").status, "todo");
  const found = changeObligations([{ path: "web/browser/src/App.jsx", status: "M" }], c, { branch: "feat/x" });
  assert.equal(found.find((o) => o.kind === "changelog").status, "note");
});

test("coverage maps code areas to architecture docs and finds orphans", () => {
  const repo = fixture();
  const c = buildCorpus(repo);
  const cov = coverageOf(repo, c, { lastDate: {} });
  const widget = cov.areas.find((a) => a.id === "internal/widget");
  assert.ok(widget && widget.covered);
  assert.ok(widget.docs.some((d) => d.path === "docs/architecture/widget.md" && d.exact));
  const browser = cov.areas.find((a) => a.id === "web/browser");
  assert.ok(browser && !browser.covered);
  assert.ok(cov.missing.some((a) => a.id === "web/browser"));
  assert.ok(cov.orphans.some((o) => o.path === "docs/architecture/orphan.md"));
  assert.ok(!cov.orphans.some((o) => o.path === "docs/architecture/widget.md"));
  assert.equal(cov.stats.missing, cov.missing.length);
});

test("repair links suggests the closest indexed path and a relative link", () => {
  const c = buildCorpus(fixture());
  const r = repairLinks(c);
  const one = r.origins.find((o) => o.from === "docs/architecture/one.md");
  assert.ok(one);
  const typo = one.links.find((l) => l.normalized === "docs/plans/panell.md");
  assert.ok(typo && typo.suggestions.some((s) => s.path === "docs/plans/panel.md" && s.link === "../plans/panel.md"));
  const missing = one.links.find((l) => l.normalized === "docs/plans/missing.md");
  assert.ok(missing && missing.suggestions.length === 0);
  assert.ok(r.stats.suggested >= 1);
});

test("health checks are safe catalog commands", () => {
  for (const id of ["docs-check", "vale", "books-check", "hooks-check", "keys-drift", "flakes", "desktop-test"]) {
    const c = findCommand(id);
    assert.ok(c, id);
    assert.notEqual(c.tier, "owner", id);
  }
});

test("ask chunks split living docs by heading with anchors", () => {
  const c = buildCorpus(fixture());
  const chunks = askChunks(c);
  assert.ok(chunks.length >= 4);
  const panel = chunks.filter((x) => x.p === "docs/plans/panel.md");
  assert.ok(panel.length >= 2);
  assert.ok(panel.every((x) => x.x.length <= 1500 && x.l >= 1 && x.t === "Panel plan"));
  const arch = chunks.find((x) => x.p === "docs/architecture/one.md");
  assert.ok(arch && arch.c === "architecture" && arch.t === "One subsystem");
  assert.ok(!chunks.some((x) => x.c === "handoff" || x.c === "changelog"));
});
test("shortest path follows references and reports a bridge when disconnected", () => {
  const c = buildCorpus(fixture());
  const one = shortestPath(c.graph, "docs/architecture/one.md", "docs/plans/panel.md");
  assert.equal(one.connected, true);
  assert.equal(one.length, 1);
  assert.equal(one.steps[0].dir, "out");
  assert.equal(one.edges[0].s, "docs/architecture/one.md");
  const back = shortestPath(c.graph, "docs/plans/panel.md", "docs/architecture/one.md");
  assert.equal(back.connected, true);
  assert.equal(back.length, 1);
  const same = shortestPath(c.graph, "docs/plans/panel.md", "docs/plans/panel.md");
  assert.equal(same.length, 0);
  const off = shortestPath(c.graph, "docs/architecture/one.md", "docs/architecture/orphan.md");
  assert.equal(off.connected, false);
  assert.ok(off.bridge);
  assert.equal(off.bridge.collection, "architecture");
});
