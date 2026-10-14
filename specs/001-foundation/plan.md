# Slice 001: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. `src/index.ts` is the executable: it creates the server and connects it to stdio (FR-129).
2. `src/tools.ts` exports `createServer(upstream)`, which builds an `McpServer` with the MCP instructions (FR-127) and registers the four tools with zod schemas.
3. `src/affinity.ts` exports class `Upstream`: one SSE session to Affinity at a time, connection with URL fallback and a time budget, preamble read, error classification and retry, and `runScript()` with the envelope.
4. `src/sdk.js` is the SDK-side envelope that runs inside Affinity. It is plain JavaScript with two placeholders, `__NONCE__` and `__BODY__`. The build copies it next to the compiled files; `Upstream` reads it once.
5. `test/fake-affinity.ts` is an SSE MCP server that emulates the 11 native tools (schemas from `native-tools.json`), the preamble gate, restarts and failing documentation. Its `execute_script` runs the received script in a Node `vm` context with stub SDK modules, so the real envelope code is exercised without Affinity.

The upstream is passed into `createServer`, so each test gets an isolated session state. There is one implementation; no interface is declared.

## 2. Tool contracts

### 2.1 `get_status`

| Parameter | Type | Default |
|---|---|---|
| none | | |

Read-only. Output: JSON text `{connected, url, server, affinity, sdk, platform, permissions, roots, documents[{title, path, dirty, current, spreads}]}`, or `{connected: false, reason, fix}`.

### 2.2 `run_script`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `code` | string | 1 to 1,000,000 characters | required |
| `mutates` | boolean | | `true` |
| `timeoutMs` | integer | 1,000 to 600,000 | 60,000 |

Read-only when `mutates` is false. Output: JSON text `{result, logs, dropped?}`. Errors: `isError: true`, text with message, stack, logs and, when known, the undo steps added.

### 2.3 `sdk_docs`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `action` | enum `list`, `read`, `search`, `hints` | | required |
| `topic` | string | required for `read` | |
| `query` | string | required for `search` and `hints` | |
| `from`, `to` | integer | 1-based, inclusive, `read` only | first 400 lines |

Read-only. Output: plain text that starts with `source: native` or `source: local (<folder>)`.

### 2.4 `render`

| Parameter | Type | Default |
|---|---|---|
| `target` | enum `spread`, `selection` | `spread` |
| `spreadIndex` | integer, 0 or more | current spread |

Read-only. Output: the endpoint's image content.

## 3. Mechanisms

### 3.1 Connection (FR-101 to FR-104, FR-107)

1. URLs: `[AFFINITY_MCP_URL]` when set, else `http://127.0.0.1:6767/sse`, `http://[::1]:6767/sse` (R-01).
2. Budget: 3,000 ms shared equally by the URLs; each attempt races `client.connect()` against its share. A refused port fails immediately (R-01: connect normally takes 510 to 536 ms).
3. A failed or timed-out attempt closes its transport, which stops the EventSource retry loop (R-18).
4. After connecting, the session reads `preamble` and ignores the result (R-03, R-16).
5. Concurrent callers share one pending connection promise.
6. The client's `onerror` closes the session. Reason: on a dropped stream the SDK's EventSource reconnects by itself and silently switches to a new endpoint session that has not read the preamble (SDK `client/sse.js`, `endpoint` listener). Closing first turns this into a clean reconnect on the next call.

### 3.2 Call and retry (FR-105, FR-106, FR-130)

| Failure | Detection | Action |
|---|---|---|
| Preamble gate | result text contains `has not yet been read` | read preamble, repeat once (the call did not run) |
| Not delivered | error from `send()` (`Error POSTing to endpoint`, fetch failure, `Not connected`) | close session, reconnect, repeat once |
| Closed in flight | `McpError` code -32000 `ConnectionClosed` | close session, reconnect; repeat once only if read-only, else report "may have run" |
| Timeout | `McpError` code -32001 `RequestTimeout` | mutating: report "may have run or may still run; inspect before retrying"; read-only: report timeout |
| Server error | other `McpError` codes | return as error, session kept |
| Unreachable | connect fails for every URL | FR-102 message |

### 3.3 Envelope (FR-108 to FR-114)

`src/sdk.js`, run by `execute_script`:

1. Replace `console.log/info/warn/error/debug` with a collector (R-05: console methods are writable); keep at most 500 lines and 65,536 characters; count dropped lines.
2. Record the current document's `sessionUuid` and `history.position`, if a document is open.
3. Run `__BODY__` inside `(function () { ... })()`, so a top-level `return` works (R-05).
4. On return: serialize the value with a replacer that turns BigInt into a string, an ancestor cycle into `[Circular]`, and an object with a non-plain prototype and no own enumerable keys (an SDK handle) into `String(value)`; `undefined` becomes `null`. Over 262,144 characters, emit a size error instead.
5. On throw: emit message, name, stack, logs and, if the same document is still current, `undoSteps` = position after minus position before.
6. Restore the console methods and print one line: nonce + JSON.

Server side: the nonce is `ttam:<12 hex>:`. The body is inserted with a replacer function, so `$` sequences in user code stay intact. The output line that starts with the nonce is parsed; if none exists, the raw output becomes the error (FR-111). No `eval` or `new Function` is used anywhere (R-05).

### 3.4 Documentation (FR-117 to FR-122)

1. Native first: `list_sdk_documentation` (comma-separated names), `read_sdk_documentation_topic`. Any `isError`, `ERROR:` prefix, `File not found` or `Listing failed.` counts as failure (R-03, R-16).
2. Local fallback folder: `AFFINITY_SDK_DIR`, then `$WINEPREFIX/drive_c/Program Files/Affinity/Affinity/Resources/JSLib`, `~/.local/share/affinity-infinity/prefix/drive_c/Program Files/Affinity/Affinity/Resources/JSLib`, `~/.wine/drive_c/Program Files/Affinity/Affinity/Resources/JSLib`, `C:\Program Files\Affinity\Affinity\Resources\JSLib`, `/Applications/Affinity.app/Contents/Resources/JSLib` (the last one unverified). Topics are files relative to that folder, `examples/` and `tests/` included.
3. Cache: one `Map` of topic name to text per process; a topic is fetched at most once (FR-121).
4. `search`: case-insensitive substring over every topic, first 20 hits with 3 lines of context on each side, plus the total count.
5. `hints`: `search_sdk_hints {prompt: query}`.

### 3.5 Status and render scripts

1. `get_status` runs one read-only script returning `app.version`, `Environment.sdkVersionStr`, `app.platformName`, `Environment.permissions`, `Environment.fileSystemRoots` and the document list (R-09, R-13).
2. `render` runs one read-only script returning the current document's `sessionUuid`, the current spread index (position of `currentSpread` in `doc.spreads`, matched with `isSameNode`), the spread count and the selection length, then calls `render_spread` or `render_selection` (R-08). Failed preconditions return FR-124 messages.

## 4. Files touched

| File | Purpose |
|---|---|
| `src/index.ts` | executable entry |
| `src/tools.ts` | `createServer`, instructions, 4 tools |
| `src/affinity.ts` | `Upstream`, envelope parsing, documentation access |
| `src/sdk.js` | envelope run inside Affinity |
| `test/fake-affinity.ts` | emulated endpoint for unit tests |
| `test/foundation.test.ts` | unit tests FR-101 to FR-130, NFR-101 to NFR-104 |
| `test/live.test.ts` | live tests, run only with `AFFINITY_LIVE=1` |
| `package.json` | build copies `src/sdk.js`; `files` ships it |

## 5. Risks

1. Session death was never reproduced (R-11); the retry paths are verified with the fake endpoint and one manual Affinity restart during the live run.
2. The vm-based fake runs the envelope in Node, not in Affinity's engine; the live suite repeats the envelope cases (return value, throw, syntax error, BigInt, logs cap) against Affinity.
3. The macOS documentation path is unverified; the README will say so.
