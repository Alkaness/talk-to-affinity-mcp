# Constitution

Version 1.0, ratified 2026-10-14. This document changes only by an explicit decision recorded in section 7.

## 1. Principles

1. Single integration surface. The server talks to Affinity only through Affinity's native local MCP endpoint. No UI automation, no file-format parsing, no in-app plugin.
2. Spec first. No code without a requirement ID. No requirement without an acceptance test.
3. Measured facts. Every statement about SDK or endpoint behavior in a spec cites a research entry (`R-nn` in `specs/000-spike/research.md`) or a live test.
4. Token economy. Tool outputs are compact by default (depth limits, node caps, truncation markers). Detail is available on request. The server exposes at most 15 tools.
5. Read tools never mutate. After a read tool runs, the document's dirty flag and undo history are unchanged.
6. One tool call, at most one undo step, where the SDK allows it. Where it does not, the spec states the measured step count.
7. Safety. No discard, close or overwrite happens without an explicit parameter. Live tests operate only on documents they create.
8. Privacy. The server never calls `add_sdk_hint` or `report_sdk_issue`. No data leaves the machine except an explicit `sdk_docs` hints query, whose tool description says so.
9. Actionable errors. Every error states what failed, why, and how to fix it. A mutating call that times out reports that the script may have executed.
10. Minimal. Runtime dependencies are `@modelcontextprotocol/sdk` and `zod`, plus `pngjs` and `jpeg-js` from slice 005. Any other dependency is justified in a `plan.md`. Fewest files that keep the code readable.
11. Formal documentation. Numbered sections, exact figures, no emojis.
12. Platforms. Linux under Wine is live-verified in v1. Windows and macOS are supported by design, because the endpoint is identical, and the README marks them "not live-verified" until the live suite runs there.

## 2. Development process

### 2.1 Slice loop

Each slice in `specs/roadmap.md` section 6 runs this loop:

1. Specify: write `spec.md`. Gate G1: no `[NEEDS CLARIFICATION]` marker remains and the owner approves the spec. Work stops until approval.
2. Plan: write `plan.md`. Gate G2: every FR maps to a design element; every SDK claim cites `R-nn` or a live test.
3. Tasks: write `tasks.md`. Gate G3: every FR maps to at least one task and at least one test.
4. Implement: task by task, each starting with a failing test.
5. Verify: unit and live suites pass; the status table in `spec.md` is current. Gate G4: every P1 requirement passes live on Affinity 3.3.1 under Wine.
6. Analyze: compare spec, tasks and code. A deviation becomes a spec edit, never silent drift. The slice is then committed in one commit on the owner's go-ahead.

### 2.2 Identifiers

| Kind | Pattern | Example |
|---|---|---|
| Research fact | `R-nn` | `R-06` |
| Functional requirement | `FR-snn` (s = slice digit) | `FR-301` |
| Non-functional requirement | `NFR-snn` | `NFR-102` |
| Task | `T-snn` | `T-305` |

### 2.3 Requirement form (EARS)

| Pattern | Template |
|---|---|
| Ubiquitous | The server shall <response>. |
| Event-driven | When <trigger>, the server shall <response>. |
| State-driven | While <state>, the server shall <response>. |
| Unwanted behavior | If <condition>, then the server shall <response>. |
| Optional feature | Where <feature is enabled>, the server shall <response>. |

Each requirement has a priority: P1 (slice fails without it), P2 (expected), P3 (nice to have).

### 2.4 Traceability

1. Test names start with the requirement ID: `test('FR-301 create_nodes is one undo step', ...)`.
2. Coverage check, run at G4 from the repository root with the slice's folder; it prints nothing when every requirement of that slice has a test:
   `comm -23 <(grep -hoE '\b(N?FR)-[0-9]+' specs/<slice>/spec.md | sort -u) <(grep -rhoE '\b(N?FR)-[0-9]+' test | sort -u)`
3. A behavior change edits the spec in the same commit.

### 2.5 Artifact skeletons

`spec.md`:
1. Problem
2. User stories (priority, Given/When/Then scenarios)
3. Functional requirements
4. Non-functional requirements
5. Out of scope
6. Open questions (`[NEEDS CLARIFICATION]`)
7. Status (FR, test, unit, live)

`plan.md`:
1. Design summary
2. Tool contracts (parameter tables that mirror the zod schemas)
3. SDK script outline per tool, with `R-nn` references
4. Files touched
5. Risks

`tasks.md`: ordered checklist; each line is `- [ ] T-snn (FR-snn, ...) description`, test-first.

## 3. Definition of done (slice)

1. Every FR and NFR has a test; the coverage check prints nothing.
2. `npm test` passes.
3. `npm run test:live` passes for every P1 requirement.
4. The status table in `spec.md` is current.
5. `specs/roadmap.md` and the README reflect any change to the tool surface.
6. The owner has given the go-ahead for the commit.

## 4. Testing rules

1. Unit tests run without Affinity, against a fake upstream that emulates the native endpoint.
2. Live tests run only when `AFFINITY_LIVE=1` and skip otherwise.
3. Live tests create their own documents and close them without saving. They never open, edit or close a document they did not create.

## 5. Coding rules

1. TypeScript in strict mode, ES modules, Node 20 or later at runtime.
2. SDK calls appear only in `src/sdk.js` and in the script builders of the tools.
3. Generated scripts are self-contained top-level code (no `module.exports`).

## 6. Ownership

The owner approves every `spec.md` (gate G1) and every commit. Plans, tasks, code and tests within an approved spec proceed without further approval.

## 7. Amendments

1. 2026-10-14: the coverage check in section 2.4 is scoped to one slice's `spec.md`. Reason: the roadmap names requirements of future slices, which have no tests yet.
