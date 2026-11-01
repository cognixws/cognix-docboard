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

`node --test` runs the parser and command tests. The page is plain HTML,
CSS and JavaScript; it links `../__picode/tokens.css` for PiCode's tokens.

## License

MIT.
