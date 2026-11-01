# Docboard

A COGNIX[WS] extension: the repository's `docs/` in the bottom dock. It reads
the docs, searches them, lists the open questions and debts, shows the health
of the documentation, and runs the ordinary make targets of the development
environment with the guardrails it declares.

Person-only: the extension declares no agent tool, no MCP server and no
command that changes a file on an agent's behalf.

## Install

In COGNIX[WS]: Extensions → Install, with the repository URL:

```
https://github.com/cognixws/picode-docboard
```

It adds the **Docs** tab to the bottom dock and the Docs tile to Apps. The
dock is absent below 768px; the tile opens the same page on the phone.

## What it reads

- `docs/**/*.md`: decisions, plans, architecture, benchmarks, books, handoff
  (session notes and open topics), changelog fragments, and the docs root.
- The repository root: `AGENTS.md`, `README.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, `Makefile`.
- Open work: the `## Open questions` sections of `docs/plans/` and the
  `- [ ]` lines of `docs/handoff/open/`.

The index is built in memory by the extension's own process and refreshed on
demand or after five minutes. No database, no backup promise: the repository
is the source of truth.

## Ask the docs

The Search view has two modes: **Buscar** (words and PT/EN synonyms, instant)
and **Perguntar** (meaning). Perguntar uses the embedding model and
llama-server build the Recall already keeps on this computer (EmbeddingGemma,
found under the PiCode data folder), started by this extension's process at
low priority. The first question splits the living docs (decisions, plans,
architecture, benchmarks, books and the docs root) into passages and embeds
them; later questions reuse a cache in the extension's own data folder
(`ask-index.json` and `ask-index.bin`), rebuilt when those docs change.

Nothing leaves the computer: the model, the index and the question are local.
If the model cannot start, the view says so and offers **Buscar**. The settings
`embedding_model` (a `.gguf`) and `llama_server` (a binary) override the
discovery; both are optional.

## Who cares (Quem cuida)

Every document shows its last commit's author, date and short hash in the
reader. Each semantic passage and the top word-search results show the author
and date under the text, and the History dialog lists the last five commits
with their authors. The extension reads git in the repository: no new
permission, nothing written. When the folder is not a git checkout, or the file
has no commit, the line says "sem histórico de commit" and the result simply
has no byline.

## Since the last visit

The page keeps a small marker in the host's key-value (the head, the time and
the open counts). On the Pulse it shows the commits, changed docs, new and
resolved debts and the plans that changed since then; "Mark as seen" updates
the marker. Files are never written; the host owns the state.

## Fix queue

A single view gathers what the extension revealed: broken links with a
suggestion, the open obligations of the worktree, uncovered code areas and
stale docs. Choose up to twelve and send one structured message to an agent;
the extension prepares the list, the agent edits and runs the gates.

## Message an agent

A person can list the agents (`agents:read`) and send one of them a message
(`messages:send`) from the docs panel: pick the agent, edit the prefilled
context (a broken link, an obligation, an uncovered area, a stale doc or the
open document), and send. The agent receives it from `ext:docboard`; the
extension never writes, declares no agent tool and sends nothing on its own.
A stopped agent is refused by the host.

## Reader

The document reader has "Nesta página" (a sticky outline of headings), the
last commit and a History dialog with the last five commits, and references
(backlinks and outbound links) at the end. The body is sans 15/1.65; the chrome
is mono. No writes.

## Path

Pick two documents (path or title) and see the shortest chain of references
between them, forward and backward. The chain lists each step and its kind;
the graph highlights the path. Disconnected documents report their components
and the closest pair in a shared collection. Read-only.

## Health

The Health view diagnoses the environment (process, index age, repo, settings,
permissions, node/git/make/flock) and runs the safe checks: docs-check, vale,
books-check (a script), hooks-check, keys-drift, flakes and desktop-test. It
runs them one at a time, keeps the receipts in Operar, and never deploys,
restarts or writes.

## Repair links

The 170 broken links become a queue: each one is classified, and up to three
indexed destinations are suggested by file name and edit distance, with the
corrected relative link ready to copy. It also lists origin and suggestion;
it never edits a file.

## Coverage

Which code area has an architecture doc, and which does not: `internal/*`
packages, `web/*`, `desktop-shell`, `cmd/*` and `packages/*` are mapped to
`docs/architecture/` by exact name, a path mention or a title mention. It
lists uncovered areas, architecture docs no area cites, and docs untouched
for 60+ days. A heuristic map: it opens and copies paths, never writes.

## Pulse

A health view of the docs: broken links, documents with no link, living docs
untouched for 120+ days and the latest commits under `docs/`. It reads `git
log` and the index the process already keeps; no extra state.

## The graph

The process resolves the links between documents: markdown links, bare
`docs/…md` paths and `ADR-NNNN` references, ignoring code blocks. It exposes
the hubs (the most linked docs), the flow between collections, and a
document's ego graph with its backlinks, outbound links and broken targets.
The page draws it with the D3 that PiCode serves (`../_picode/lib/d3.js`):
no new dependency, no network, and the same data offline.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Repository | empty | Absolute path to map. Empty uses the first workspace where Docboard is on. |
| Operate commands | on | Off hides Operar, the fixed make targets and their runner. |

The process asks PiCode for its workspaces (`workspaces:read`, shown at
install). Nothing leaves the computer.

## Operar

The commands are a fixed catalog, executed as argv (never a shell string) in
the repository root or a chosen worktree:

- **Sessão**: worktree status, new worktree, `ci-scoped`, close, close
  summary, land (queued in the Deliveries panel; not duplicated here).
- **Documentação**: handoff, changelog, ADR, book, books, docs-check, vale,
  archive old notes.
- **Build e UI**: web, build, dev, ui, atlas, atlas-shot, cover, xray.
- **Ambiente**: scratch, hooks-check, keys-drift, flakes, desktop-test.
- **Deploy e restart**: deploy and the desktop restart (Windows only).
  Owner-grade: one at a time, never forced; `make deploy` refuses while an
  agent is mid-turn, and the receipt says so.
- **Manutenção**: worktree GC and the tool A/B (cost stated before it runs).

Never `--force`, never `pkill`, never `tmux kill-server`. A stopped process
answers 503 and the page says why. The dock page never holds PiCode's
session; it talks only to this extension's process.

The page carries its version and reloads itself when the process reports a
different one; a running page also reloads when the extension process restarts
(the `extension.process` event), so an update shows up without a manual reload.

## Development

```
PICODE_EXT_PORT=8799 PICODE_EXT_DATA=/tmp/docboard-data \
DOCBOARD_REPO=/path/to/repo node process.mjs
```

Ask needs the local model; for development point it at the recall copy:

```
DOCBOARD_MODEL=~/.picode/recall-semantic/models/embeddinggemma-300M-Q8_0.gguf \
DOCBOARD_LLAMA=~/.picode/recall-semantic/llama/<release>/llama-server \
node process.mjs
```

`node --test` runs the parser and command tests. The page is plain HTML,
CSS and JavaScript; it links `../__picode/tokens.css` for PiCode's tokens.

## License

MIT.
