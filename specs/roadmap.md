# Roadmap

Approved 2026-10-14. This file holds the product decision, the architecture, the tool contract and the slice list. Detailed requirements live in each slice's `spec.md`.

## 1. Product

Talk to Affinity MCP is a stdio MCP server that lets AI clients (Claude Code, Claude Desktop, Cursor) read, create, edit, verify and export Affinity by Canva documents. It is itself an MCP client of the native MCP endpoint that Affinity 3.2 and later serve on port 6767. It exposes typed, token-efficient tools that compile to Affinity JavaScript SDK scripts, plus a raw-script escape hatch.

Value over the native endpoint:

1. Common operations need no SDK reading: validated inputs, one call per operation.
2. Stable node IDs (the SDK has none).
3. Structured JSON results (the endpoint returns console output only).
4. Robust session handling: preamble gate, reconnect, IPv6 and IPv4 fallback, honest timeouts.
5. File access beyond the Desktop sandbox through staging.
6. Visual comparison against a reference image.
7. Linux under Wine as a first-class target.

## 2. Ground truth (confirmed by slice 000, see `specs/000-spike/research.md`)

1. Endpoint: port 6767, legacy HTTP+SSE MCP transport, protocol `2025-11-25`, no authentication, loopback only (`127.0.0.1` under Wine). Enabled at Settings > Model Context Protocol > Enable MCP server; Affinity must restart afterwards.
2. Native tools (11): `execute_script {script}`, `render_spread {document_session_uuid, spread_index}`, `render_selection {document_session_uuid}`, `list_library_scripts`, `save_script_to_library {title, description, code}`, `read_library_script {title}`, `list_sdk_documentation`, `read_sdk_documentation_topic {filename}`, `search_sdk_hints {prompt}`, `add_sdk_hint {hint}`, `report_sdk_issue {description, code?}`.
3. `execute_script` fails until the `preamble` topic has been read in the same SSE session. Sessions can die server-side; the POST URL then returns HTTP 404.
4. Scripts return only `console.log` output. Renders are base64 JPEG, at most 1024 px.
5. Script file access is limited to the Desktop. Permissions are readable through `Environment.permissions`; a denied call throws `PERMISSION_DENIED`.
6. The JavaScript SDK has 142 documentation topics (about 1.8 MB). A spread must be current before its nodes are edited, and switching spread clears the selection.
7. Nodes have no persistent ID. They carry key/value tags (`DocumentCommand.createSetTagValueForKey`, `node.tagInterface.getValueForKey`).
8. There is no SVG import or file-place API. Vector paths are built with `CurveBuilder` and `PolyCurve`.
9. Development machine: Affinity 3.3.1.4940 under Wine (AppImage `Affinity-Infinity-x86_64.AppImage`). `localhost` resolves to `127.0.0.1` only there.

## 3. Architecture

```
AI client --stdio MCP--> talk-to-affinity-mcp (Node >= 20, TypeScript, ESM)
                           src/index.ts     server, tool registration, MCP instructions
                           src/affinity.ts  upstream client, preamble gate, reconnect, timeouts, script envelope
                           src/sdk.js       SDK-side prelude injected into scripts (IDs, tree walk, serializers)
                           src/tools.ts     zod schemas and script builders
                           src/staging.ts   host <-> Affinity Desktop file bridge (slice 004)
                           src/compare.ts   image decode, resize, diff, region scoring (slice 005)
                        --HTTP+SSE--> Affinity :6767 native MCP --> JavaScript SDK
```

Mechanisms:

1. Script envelope. Generated code runs as a function body inside `try/catch`. One console line, prefixed with a per-call nonce, carries `{ok, result | error, stack}`. All other console lines return as `logs`.
2. Node IDs. A node's `id` is its `ttam-id` tag when present, otherwise a path `<spread>/<child>/<child>`. Write tools tag every node they create or modify in the same command batch. Read tools never tag. If two nodes carry the same tag, the first in document order keeps the ID and the others report path IDs.
3. Units. Document pixels at the document DPI, origin at the spread's top-left corner. Font sizes in points.
4. Connection. `AFFINITY_MCP_URL` when set; otherwise `http://127.0.0.1:6767/sse`, then `http://[::1]:6767/sse` (R-01). Lazy connect, silent preamble read once per session, one reconnect on session death, automatic retry only for read-only tools.
5. Staging. The host path of Affinity's Desktop is found by a probe file written from a script. Override: `AFFINITY_DESKTOP_DIR`. Working folder: `<Desktop>/talk-to-affinity/`, because the sandbox refuses dot folders (R-09). Staged files are deleted after each call and the folder is removed when empty.

## 4. Tool contract (v1: 14 tools)

| Tool | Slice | Input | Output |
|---|---|---|---|
| `get_status` | 001 | none | connection, versions, permissions, open documents, Desktop mapping; never throws |
| `run_script` | 001 | `code`, `mutates` (default true), `timeoutMs` | `result`, `logs` |
| `sdk_docs` | 001 | `action` list/read/search/hints, `topic`, `query`, `lines` | text snippets |
| `render` | 001, 004 | `target` spread/selection/nodes, `spreadIndex`, `ids`, `maxSize` | image |
| `get_document` | 002 | `depth`, `spreadIndex`, `query`, `limit` | document info, tree or matches, selection, fonts used |
| `get_nodes` | 002 | `ids`, `detail` | geometry, fills, strokes, effects, text runs, image info |
| `list_fonts` | 002 | `query`, `limit` | total count, families with faces |
| `create_nodes` | 003, 004 | `parentId`, `nodes`, `fontFallback` | created IDs mirroring the input tree |
| `update_nodes` | 003 | `updates` | result per node |
| `delete_nodes` | 003 | `ids` | count |
| `undo` | 003 | `steps`, `redo` | history state |
| `manage_document` | 004 | `action` create/open/save/saveAs/close | document info |
| `export` | 004 | `target`, `ids`, `format`, `scale` or `dpi`, `path` | path, bytes |
| `compare_to_reference` | 005 | `reference`, `target`, `ids`, `maxSize`, `threshold`, `fit` | score, diff ratio, worst regions, heatmap image |

## 5. Slice status

| Slice | Content | Status |
|---|---|---|
| 000 | Environment spike: facts R-01 to R-18 | Done (2026-10-14) |
| 001 | Foundation: connection layer, `get_status`, `run_script`, `sdk_docs`, `render` | In progress (spec approved 2026-10-14) |
| 002 | Read model: `get_document`, `get_nodes`, `list_fonts` | Not started |
| 003 | Write model: `create_nodes`, `update_nodes`, `delete_nodes`, `undo` | Not started |
| 004 | Files and export: `manage_document`, `export`, high-resolution `render`, image nodes | Not started |
| 005 | Visual compare: `compare_to_reference` | Not started |
| 006 | Release: README, CHANGELOG, package dry run, version 0.1.0 | Not started |

## 6. Slices

### 6.1 Slice 000: environment spike

Probes in `spike/` answer the questions below and record the answers in `specs/000-spike/research.md`. The probes are deleted when slice 001 is done. Exit condition: R-01 to R-03 pass; otherwise apply risk 1.

| ID | Question |
|---|---|
| R-01 | Which host answers under Wine: `[::1]`, `127.0.0.1`, or both? |
| R-02 | `tools/list` verbatim and the negotiated protocol version |
| R-03 | Preamble gate: error text before and after the preamble read |
| R-04 | Console output limits: size, line count, Unicode; time to return 1 MB |
| R-05 | Error shapes: syntax error, thrown error, `PERMISSION_DENIED`, long-running script |
| R-06 | Tags: set in the same batch as creation; one undo step; persistence after save and reopen; copy on duplicate |
| R-07 | Atomicity: partial changes after a failing script; rollback of a compound command |
| R-08 | `render_spread` and `render_selection` under Wine: format, size, speed |
| R-09 | `app.userDesktopPath` under Wine and its host mapping; PNG export read from Linux |
| R-10 | Fonts: `FontFamily.all` count under Wine; behavior for a missing font |
| R-11 | Session lifetime: idle death, HTTP 404 behavior, reconnect cost |
| R-12 | Two concurrent SSE sessions |
| R-13 | `Document.create`, `load`, `save`, `close`; switching the current document from a script |
| R-14 | Units: `Rectangle(0, 0, 100, 100)` in a pixel document and in a millimetre document |
| R-15 | Script size limit (50 KB); tree-walk time at 1,000 nodes |

### 6.2 Slices 001 to 006

The key requirements of each slice are listed in the approved plan and become the starting point of the slice's `spec.md`:

1. 001 foundation: FR-101 to FR-109 (connect and preamble, unreachable error within 3 s, host fallback, reconnect and retry rules, timeout honesty, result and logs, docs search cap of 20 snippets, image content, MCP instructions under 1,500 characters).
2. 002 read model: FR-201 to FR-206 (reads never mutate, ID rules, truncation, boxes in document pixels, text runs, font count).
3. 003 write model: FR-301 to FR-307 (one undo step, schema rejection before execution, no partial changes, tagged IDs mirroring input, explicit font failure with 5 suggestions, SVG path data including arcs, automatic spread switch).
4. 004 files and export: FR-401 to FR-405 (export through staging, permission error, copy-on-open outside the sandbox, guarded close, high-resolution render).
5. 005 visual compare: FR-501 to FR-505 (score, diff ratio, 5 worst regions, heatmap; aspect-ratio guard; regions in document pixels; fixture tests; JPEG-aware threshold).
6. 006 release: README with exact tool count and per-OS setup, CHANGELOG, `npm pack --dry-run`, version 0.1.0; the owner publishes to npm.

### 6.3 Backlog

Each item needs its own spec when pulled: swatches and text styles, artboard management, adjustment and filter layers, Canva AI operations, saving scripts to the Scripts panel, `select_nodes`.

## 7. Risks

| No. | Risk | Mitigation |
|---|---|---|
| 1 | The native endpoint does not work under Wine | Resolved: it works (R-01 to R-03). Fallback kept: Windows VM, `ssh -L 6767:127.0.0.1:6767`, `AFFINITY_MCP_URL` |
| 2 | Console output has a size limit | Chunked envelope (R-04) |
| 3 | No single undo step or no tag persistence | Document the measured step count; path IDs as fallback |
| 4 | SDK changes between 3.x releases | Versions in `get_status`; SDK calls confined to `src/sdk.js` and builders; live suite per release |
| 5 | Few fonts under Wine | Font count in `list_fonts`; explicit failure for missing fonts |
| 6 | Desktop mapping fails under Wine | Probe file plus `AFFINITY_DESKTOP_DIR` |
| 7 | JPEG noise skews compare scores | Measured default threshold; PNG path when file access is allowed |
