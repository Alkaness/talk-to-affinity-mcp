# Slice 001: Tasks

Each task starts with a failing test. Unit tests live in `test/foundation.test.ts`, live tests in `test/live.test.ts`.

- [x] T-101 (NFR-101, NFR-102) Package: build copies `src/sdk.js` into `dist/src/`, `files` ships it, engines Node >= 20. Test: dependencies are exactly the two allowed packages; engines field present.
- [x] T-102 (FR-108, FR-109, FR-110, FR-111, FR-112, FR-113, FR-114) Envelope `src/sdk.js` and its parser in `src/affinity.ts`. Tests run the envelope in a Node `vm` context: return value and logs, `undefined`, BigInt, cycle, SDK-like object, throw of Error and string, syntax error without result line, result over 262,144 characters, log caps, undo steps, `$` sequences in code.
- [x] T-103 (test support) `test/fake-affinity.ts`: SSE MCP server with the 11 native tools and schemas from `native-tools.json`, per-session preamble gate, `restart()`, configurable documentation, delayed scripts, call log.
- [x] T-104 (FR-101, FR-102, FR-103, FR-104, FR-105, FR-106, FR-107, FR-130) `Upstream` in `src/affinity.ts`. Tests against the fake: connect and preamble; unreachable error within 3 s naming the setting, restart and URLs; URL order and `AFFINITY_MCP_URL`; no timers or sockets left after a failed connect; restart then read-only retry; undelivered mutating retry; in-flight close reports "may have run"; timeout messages; failed preamble read tolerated; gate message triggers preamble read and one repeat.
- [x] T-105 (FR-115, FR-116) `run_script` tool. Tests through an in-memory MCP client: parameter limits, result and logs, error text, description content.
- [x] T-106 (FR-117, FR-118, FR-119, FR-120, FR-121, FR-122) `sdk_docs` tool. Tests: native list and read; range read with numbering; default 400 lines with total count; search cap of 20 with context and total; fallback to a local folder when native fails, with source named; one fetch per topic; hints forwarded and description states the online query.
- [x] T-107 (FR-123, FR-124) `render` tool. Tests: image content passed through for spread and selection; no document; empty selection; spread index out of range.
- [x] T-108 (FR-125, FR-126) `get_status` tool. Tests: unreachable returns `connected: false` with fix; connected returns every listed field.
- [x] T-109 (FR-127, FR-128, FR-129, FR-131) Server: instructions of at most 1,500 characters naming the workflow and document pixels; `add_sdk_hint` and `report_sdk_issue` never called during the whole suite; the built executable answers an MCP handshake over stdio with nothing but protocol messages on stdout, and exits after its standard input closes.
- [x] T-110 (NFR-103, NFR-104) Timing against the fake: overhead per call below 50 ms; first call after start below 2 s.
- [x] T-111 (all P1) Live suite against Affinity 3.3.1 under Wine, run with `AFFINITY_LIVE=1`; creates and closes its own documents.
- [x] T-112 Analyze: coverage command, status table in `spec.md`, roadmap status, delete `spike/`.
