import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCorpus, searchCorpus, catalog, commandPlan, extractDebts, extractQuestions } from "./lib.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docboard-test-"));
  const write = (rel, body) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  write("docs/decisions/0001-one.md", "# ADR-0001: One\n\n## Boundary\n\nProcess.\n");
  write("docs/plans/panel.md", "# Panel plan\n\n## Open questions (owner)\n\n1. **Which panel**: the dock (recommended) or a pane?\n   It is a link's intent.\n2. A second question?\n\n## Next\n\nText.\n");
  write("docs/handoff/open/topic.md", "# Topic\n\n- [ ] First debt\n  continued here.\n- [x] Done debt\n\n- [ ] Second debt\n");
  write("docs/handoff/2026-01-01-a.md", "# A session\n");
  write("docs/architecture/one.md", "# One subsystem\n\nThe land does not restart.\n");
  write("docs/changelog.d/x.md", "# Fragment\n");
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
  assert.deepEqual(commandPlan("worktree", { name: "docs-board" }, ctx).argv, ["worktree", "NAME=docs-board"]);
  assert.equal(commandPlan("close", { worktree: "/repo/.worktrees/a" }, ctx).cwd, "/repo/.worktrees/a");
  assert.match(commandPlan("close", { worktree: "/tmp/no" }, ctx).error, /worktree/);
  assert.deepEqual(commandPlan("land", { branch: "feat/x" }, ctx).argv, ["land", "BRANCH=feat/x"]);
  assert.match(commandPlan("land", { branch: "x" }, ctx).error, /branch/);
  assert.deepEqual(commandPlan("book", { name: "run", type: "runbook" }, ctx).argv, ["book", "NAME=run", "TYPE=runbook"]);
  assert.match(commandPlan("book", { name: "run", type: "nope" }, ctx).error, /tipo/);
  assert.equal(commandPlan("deploy", {}, { ...ctx, main: "/main" }).cwd, "/main");
  assert.match(commandPlan("nope", {}, ctx).error, /catálogo/);
  assert.match(commandPlan("deploy", {}, { ...ctx, hasMakefile: false }).error, /Makefile/);
});
