# Slice 001: Foundation

Status: approved at gate G1, 2026-10-14; implemented and verified at gate G4, 2026-10-14.

## 1. Problem

Affinity's native endpoint is hard to use directly. It speaks the legacy SSE transport, refuses scripts until the `preamble` topic has been read in the same session, returns console text only, reports script errors as ordinary text, and fails without explanation when the MCP server is disabled. Under Wine it listens on IPv4 only and serves its documentation unreliably (research R-01 to R-05, R-16).

Slice 001 delivers the connection layer and the four tools every later slice builds on: `get_status`, `run_script`, `sdk_docs` and `render`.

## 2. User stories

### US-1 Check readiness (P1)

As a user of an AI client, I want to ask whether Affinity is ready and get the fix when it is not.

1. Given Affinity runs with MCP enabled, when `get_status` is called, then it reports `connected: true`, Affinity 3.3.1.4940, the SDK version, the permissions and the open documents.
2. Given Affinity is closed or MCP is disabled, when `get_status` is called, then within 3 s it reports `connected: false` with the setting path and the restart requirement, and the call itself succeeds.

### US-2 Run a script (P1)

As an agent, I want to run SDK JavaScript and receive its return value as JSON, separate from its log output.

1. Given a connection, when `run_script` runs `console.log('hi'); return { a: 1 }`, then `result` is `{ "a": 1 }` and `logs` is `["hi"]`.
2. Given code that throws, when `run_script` runs it, then the call returns `isError: true` with the message, the stack and the logs printed before the throw.
3. Given code with a syntax error, when `run_script` runs it, then the call returns `isError: true` with the syntax error text.

### US-3 Look up the SDK (P2)

As an agent writing a raw script, I want to search the SDK and read part of a topic without loading 300 KB.

1. Given any connection state where Affinity is installed, when `sdk_docs` searches `createSetTagValueForKey`, then it returns matches with topic, line and context, and names the source (native or local).
2. When `sdk_docs` reads `nodes.js` lines 390 to 420, then exactly those lines return, numbered.

### US-4 See the canvas (P1)

As an agent, I want an image of the current spread or selection to verify my work.

1. Given an open document, when `render` is called without arguments, then the image of the current spread returns as MCP image content.
2. Given a selection, when `render` is called with `target: "selection"`, then the image of the selection returns.

### US-5 Survive restarts (P1)

As a user, I want the server to keep working after Affinity restarts, without restarting my AI client.

1. Given a working session, when Affinity restarts and `get_status` is called, then the server reconnects and answers.
2. Given the session dies during a mutating `run_script`, then the server does not repeat the script and says so.

## 3. Functional requirements

### 3.1 Connection and session

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-101 | P1 | When a tool that needs Affinity is called and no live session exists, the server shall open an SSE session, complete MCP initialization and read the `preamble` topic before forwarding the call. | R-02, R-03 |
| FR-102 | P1 | If no endpoint accepts a connection, then the server shall fail the call within 3 s with a message that names "Settings > Model Context Protocol > Enable MCP server", states that Affinity must restart after the change, and lists every URL tried. | R-01 |
| FR-103 | P1 | While `AFFINITY_MCP_URL` is unset, the server shall try `http://127.0.0.1:6767/sse` and then `http://[::1]:6767/sse`. Where `AFFINITY_MCP_URL` is set, the server shall try only that URL. | R-01 |
| FR-104 | P1 | If a connection attempt fails, then the server shall close that attempt's transport. | R-18 |
| FR-105 | P1 | If a call fails because the session ended, then the server shall open a new session once. It shall repeat the call when the request never reached Affinity (the message POST failed) or when the tool is read-only; otherwise it shall report that the script may have run. | R-11 |
| FR-106 | P1 | If a call that may mutate exceeds its timeout, then the server shall return an error stating that the script may have run or may still be running, and that the document should be inspected before a retry. | R-05 |
| FR-107 | P2 | The server shall treat a failed preamble read as non-fatal. | R-03, R-16 |
| FR-130 | P1 | If the endpoint answers a call with the preamble-gate message, then the server shall read the preamble and repeat the call once. | R-03 |

### 3.2 Script envelope

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-108 | P1 | The server shall wrap every script it sends in an envelope that captures console output, runs the code as a function body and prints exactly one result line marked with a per-call nonce. | R-04, R-05 |
| FR-109 | P1 | When the code returns, the result line shall carry the returned value as JSON; BigInt values and SDK objects become strings, cycles become the string `[Circular]`, and `undefined` becomes `null`. | R-05 |
| FR-110 | P1 | If the code throws, then the tool shall return `isError: true` with the error message, the stack and the console output captured before the throw. | R-05 |
| FR-111 | P1 | If the output contains no result line, then the tool shall return `isError: true` with the raw output. | R-05 |
| FR-112 | P1 | If the serialized result exceeds 262,144 characters, then the envelope shall print a size error instead of the result, and the tool shall ask for a narrower request. | R-04 |
| FR-113 | P2 | The envelope shall keep at most 500 console lines and 65,536 characters of console output, and shall report the number of dropped lines. | R-04 |
| FR-114 | P2 | If the code throws after changing the current document, then the error shall state how many undo steps the script added. | R-06, R-07 |

### 3.3 `run_script`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-115 | P1 | `run_script` shall accept `code` (1 to 1,000,000 characters), `mutates` (boolean, default `true`) and `timeoutMs` (1,000 to 600,000, default 60,000), and shall return `result` and `logs`. | R-15 |
| FR-116 | P2 | The `run_script` description shall state that code runs as a function body, that `return` passes a JSON value back, that SDK modules load with `require('/name.js')`, that `eval` and `new Function` are blocked, that timers come from `/timers.js`, and that file access is limited to the Desktop. | R-05, R-09 |

### 3.4 `sdk_docs`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-117 | P1 | `sdk_docs` with `action: "list"` shall return the topic names and the source that answered (`native` or `local`). | R-16 |
| FR-118 | P1 | `sdk_docs` with `action: "read"` shall return lines `from` to `to` of a topic, numbered; without a range it shall return the first 400 lines and the topic's total line count. | R-15 |
| FR-119 | P1 | `sdk_docs` with `action: "search"` shall return at most 20 case-insensitive matches of `query` across all topics, each with topic, line number and 3 lines of context on each side, plus the total match count. | R-16 |
| FR-120 | P1 | If the native documentation fails, then `sdk_docs` shall answer `list`, `read` and `search` from the local `JSLib` folder, located through `AFFINITY_SDK_DIR` or the known install locations, and shall name that source. | R-16 |
| FR-121 | P2 | The server shall fetch each documentation topic at most once per process. | R-16 |
| FR-122 | P2 | `sdk_docs` with `action: "hints"` shall forward `query` to `search_sdk_hints`; the tool description shall state that the query goes to Affinity's online hint pool. | Constitution 1.8 |

### 3.5 `render`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-123 | P1 | `render` shall accept `target` (`spread`, the default, or `selection`) and `spreadIndex` (default: the current spread), render the current document and return the endpoint's image content unchanged. | R-08 |
| FR-124 | P1 | If no document is open, or `target` is `selection` and nothing is selected, then `render` shall fail with a message naming the missing precondition. | R-08 |

### 3.6 `get_status`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-125 | P1 | `get_status` shall not fail. While no endpoint is reachable, it shall return `connected: false`, the reason and the fix text of FR-102. | R-01 |
| FR-126 | P1 | While connected, `get_status` shall return the endpoint URL, the Affinity version, the SDK version, the platform, the permissions, the file-system roots, the open documents (title, path, dirty flag, current flag, spread count) and the server's own name and version. | R-09, R-13 |

### 3.7 Server

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-127 | P1 | The server shall publish MCP instructions of at most 1,500 characters that describe the workflow (status, read, write, render, compare, raw script as last resort) and the unit rule (document pixels). | R-14 |
| FR-128 | P1 | The server shall never call `add_sdk_hint` or `report_sdk_issue`. | Constitution 1.8 |
| FR-129 | P1 | The server shall speak MCP over stdio and write diagnostics to stderr only. | |
| FR-131 | P1 | When standard input closes, the server shall close its Affinity session and exit. | |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-101 | Runtime dependencies are exactly `@modelcontextprotocol/sdk` and `zod`. |
| NFR-102 | The package runs on Node 20 or later. |
| NFR-103 | With a live session, the server adds at most 50 ms to a call beyond Affinity's execution time. |
| NFR-104 | The first call after server start completes within 2 s when Affinity is ready. |

## 5. Out of scope

1. Node IDs and the `nodes` target of `render` (slice 002).
2. Typed read and write tools (slices 002 and 003).
3. Staging, export and renders above 1,024 px (slice 004).
4. Visual comparison (slice 005).
5. Targeting a document other than the current one (R-13: scripts cannot switch documents).
6. Asynchronous scripts with timers, script-library tools and Canva AI operations.

## 6. Open questions

None.

## 7. Status

Measured 2026-10-14: `npm test` 38 of 38 pass; `npm run test:live` 52 of 52 pass (38 unit plus 14 live) against Affinity 3.3.1.4940 under Wine. Tests are found by requirement ID in `test/foundation.test.ts` (unit) and `test/live.test.ts` (live).

| ID | Unit | Live |
|---|---|---|
| FR-101, FR-102, FR-103, FR-105, FR-106 | pass | pass |
| FR-104 | pass | not applicable: client-side transport cleanup |
| FR-107 | pass | covered: Affinity under Wine fails the preamble read in most sessions (R-16) |
| FR-108 to FR-115 | pass | pass |
| FR-116 | pass | not applicable: tool description text |
| FR-117 to FR-120 | pass | pass |
| FR-121 | pass | not run live |
| FR-122 | pass | not run live: the query would be sent to Affinity's online service |
| FR-123 to FR-126 | pass | pass |
| FR-127, FR-128 | pass | not applicable: client-side |
| FR-129, FR-130, FR-131 | pass | pass |
| NFR-101, NFR-102 | pass | not applicable |
| NFR-103 | pass | not measured live |
| NFR-104 | pass | pass |

## 8. Changes after approval

1. 2026-10-14, planning: FR-105 now also repeats a mutating call whose request never reached Affinity, and FR-130 was added. Reason: when the event stream drops, the SDK's EventSource reconnects by itself and switches to a new endpoint session that has not read the preamble; a call on that session is refused by the gate and has not run. Without these rules a restart of Affinity would make the next write fail with a false "may have run" message.
2. 2026-10-14, planning: FR-131 added. Reason: the SDK's `StdioServerTransport` does not react to the end of standard input, and the open SSE session to Affinity would keep the process alive after the AI client exits, holding an Affinity session.
3. 2026-10-18, slice 004: FR-126 reports document paths as host paths (FR-423) and adds `files` (FR-424).
