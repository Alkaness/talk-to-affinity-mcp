# Slice 006: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. `package.json`: version 0.1.0 through `npm version 0.1.0 --no-git-tag-version`, which also sets both fields of `package-lock.json` (FR-601). `build` first removes `dist`, and a new `prepack` script runs `build`, so that `npm pack` and `npm publish` always pack a clean build (FR-602). `files` adds `CHANGELOG.md`; npm adds `package.json`, `README.md` and `LICENSE` by itself (FR-603). `publishConfig`, `keywords`, `homepage` and `bugs` are added (FR-605).
2. New `README.md` and `CHANGELOG.md` at the repository root (FR-606 to FR-613). The tools, their descriptions and the MCP instructions do not change.
3. New `test/release.test.ts` checks the package and both documents. It packs a copy of the repository instead of the repository itself, because `prepack` removes `dist`, which holds the running test files.
4. The server already reads its version from `package.json` at run time (`VERSION` in `src/affinity.ts`, FR-126), so no source file changes.

## 2. Package contract

| Field | Value |
|---|---|
| `version` | `0.1.0` |
| `files` | `dist/src`, `CHANGELOG.md` |
| `scripts.build` | removes `dist` with `fs.rmSync`, then `tsc`, then copies `src/sdk.js` |
| `scripts.prepack` | `npm run build` |
| `publishConfig` | `{access: "public"}` |
| `keywords` | `mcp`, `model-context-protocol`, `affinity`, `affinity-by-canva`, `canva`, `design` |
| `homepage` | `https://github.com/Alkaness/talk-to-affinity-mcp#readme` |
| `bugs` | `{url: "https://github.com/Alkaness/talk-to-affinity-mcp/issues"}` |

`bin`, `engines`, `type`, `license`, `repository` and the dependencies stay as they are.

## 3. Design details

### 3.1 Packing a copy (FR-602, FR-603, NFR-601)

1. Measured with npm 10.9.3: `npm pack` and `npm pack --dry-run` both run `prepack`. The lifecycle banner goes to standard error; the script's own output goes to standard output before the JSON, so the test parses standard output from its first line that starts with `[`. The build prints nothing when it succeeds.
2. The test copies `package.json`, `tsconfig.json`, `README.md`, `CHANGELOG.md`, `LICENSE` and `src` into a temporary folder and links `node_modules` to the repository's. It writes a stray `dist/src/stale.js` and runs `npm pack --json` there. The tarball's file list must be the 11 files of FR-603 without `stale.js`; `size` and `unpackedSize` give NFR-601. `tsconfig.json` includes `test`, which the copy lacks; `tsc` then compiles `src` only, which yields the same `dist/src`.
3. One pack serves all tests of the file (a module-level promise), because the build takes several seconds.

### 3.2 Starting the tarball (FR-604)

1. The test unpacks the tarball with `tar -xzf` into the temporary folder, links `package/node_modules` to the repository's, and starts `package/dist/src/index.js` with `StdioClientTransport` and `AFFINITY_MCP_URL` set to the fake upstream.
2. Unit: the client's server version is `0.1.0`; `get_status` reports `connected: true` and `server` `talk-to-affinity-mcp 0.1.0`; `run_script` returns the value of `return 1 + 1`, which needs the SDK prelude `dist/src/sdk.js` (`PRELUDE` in `src/affinity.ts` is the envelope of every script, FR-108).
3. Live (`AFFINITY_LIVE=1`): the same start without `AFFINITY_MCP_URL` (FR-103 order) reports `connected: true` and an Affinity version. The live test lives in `test/release.test.ts` beside the unit tests, so that it reuses the packed copy; it skips without `AFFINITY_LIVE=1`, as the tests in `test/live.test.ts` do.

### 3.3 README checks (FR-606 to FR-612, NFR-602)

1. Sections are found by their `## n. Title` headings; subsections by `### n.m Title`.
2. FR-607: the first column of the table in section 5 holds tool names in backticks; their list must equal the names of `tools/list` in that order, and the section must contain the figure `14 tools` built from the list's length.
3. FR-608: every fenced `json` block of section 4 must parse and name `npx` with `-y` and `@alkaness/talk-to-affinity-mcp`, or `node` with a path ending in `dist/src/index.js`. The section must contain `claude mcp add`, `cmd /c`, `claude_desktop_config.json` and `.cursor/mcp.json`.
4. FR-609: the names matched by `env\.([A-Z][A-Z0-9_]+)` in `src/*.ts` and `src/sdk.js` must each appear in section 6.
5. FR-610 to FR-612: each section must contain the facts its requirement names, as fixed strings.
6. NFR-602: no character of `README.md` or `CHANGELOG.md` matches `\p{Extended_Pictographic}`, and every heading of `README.md` from level 2 down matches `^#{2,} \d+(\.\d+)*\.? `.

### 3.4 README content

| Section | Content | Source |
|---|---|---|
| 1 Overview | what the server is; the 7 additions of roadmap 1 | roadmap 1 |
| 2 Requirements | Affinity 3.2 or later; Node 20 or later; the two settings | roadmap 2; R-55 |
| 3 Setup | 3.1 Linux under Wine (verified), 3.2 Windows, 3.3 macOS (not live-verified) | R-01, R-09, R-10, R-16 |
| 4 Clients | 4.1 Claude Code, 4.2 Claude Desktop, 4.3 Cursor, 4.4 from a clone; first-start note on `npx` | |
| 5 Tools | 14 rows from roadmap 4, shortened | roadmap 4 |
| 6 Configuration | 5 variables with defaults | FR-103, FR-120, FR-403 |
| 7 Conventions | document pixels, font sizes in points, IDs, undo steps (FR-303), all or nothing (FR-302), staging, copies of opened files, current document only | R-13, FR-302, FR-303 |
| 8 Privacy and safety | FR-611 | constitution 7, 8 |
| 9 Troubleshooting | 9.1 messages and fixes, 9.2 known limits | FR-612 |
| 10 Development | build, `npm test`, `npm run test:live`, specs and constitution | constitution 2, 4 |
| 11 License | MIT | `LICENSE` |

The CHANGELOG follows Keep a Changelog 1.1.0: an introduction, `## [0.1.0] - 2026-10-18` with `### Added` (the 14 tools, then supported versions and platforms) and `### Known limits`, and a link line for `[0.1.0]` to the tag `v0.1.0`.

## 4. Files touched

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | version, scripts, `files`, metadata |
| `README.md` | new |
| `CHANGELOG.md` | new |
| `test/release.test.ts` | new: unit tests and the live test of FR-604 |
| `specs/roadmap.md` | slice 006 status |

## 5. Risks

1. `npx -y` installs the package and its 97 runtime packages (`npm ls --omit=dev --all --parseable`, 2026-10-18) on first start, which can take longer than a client's start timeout on a slow connection. Section 4 says so and names a global install (`npm install -g`) as the alternative.
2. The README links to the GitHub repository, which has no pushed commits yet; the links work once the owner pushes.
3. Prose beyond the fixed strings of section 3.3 is not tested and can drift from the code. The checks pin the parts that change with the code: the tool list, the variables and the version.
4. The `cmd /c` wrapper for native Windows and the configuration file paths of Claude Desktop and Cursor come from the clients' documentation, not from a run on this machine. Section 3.2 and 3.3 of the README are marked "not live-verified".
