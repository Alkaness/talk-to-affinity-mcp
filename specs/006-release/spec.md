# Slice 006: Release

Status: approved at gate G1, 2026-10-18.

## 1. Problem

Slices 001 to 005 deliver 14 tools, verified by 109 unit tests and 52 live tests against Affinity 3.3.1 under Wine. Nobody but the developer can use them yet:

1. The package is at version 0.0.0 and has no README and no CHANGELOG. A user cannot learn how to enable Affinity's endpoint, how to add the server to an AI client, or what the tools do.
2. `npm pack --dry-run` today lists 9 files (41.4 kB packed, 135.7 kB unpacked): `LICENSE`, `package.json` and the 7 modules in `dist/src`. Packing does not build, so the tarball holds whatever `dist/src` contains at that moment, including the output of a deleted source file or no build at all.
3. The package name is scoped (`@alkaness/talk-to-affinity-mcp`). npm publishes a scoped package as restricted unless the publish is marked public, and a restricted publish fails on a free npm account.

Slice 006 makes version 0.1.0 ready for the owner to publish: a fresh build in every tarball, exact contents, a README and a CHANGELOG, and tests that keep the README in step with the tools. The tools themselves do not change.

## 2. User stories

### US-1 Install (P1)

As a user with Affinity 3.2 or later and Node 20 or later, I want to add the server to my AI client by following the README.

1. Given Affinity with its MCP server enabled and restarted, when the user runs the README's command for Claude Code and asks for the status, then `get_status` reports `connected: true`.
2. Given Claude Desktop or Cursor, when the user copies the README's configuration block into the client's configuration file, then the client starts the server through `npx`.
3. Given a clone of the repository, when the user builds it, then the README tells how to start the server from that folder instead of from npm.

### US-2 Set up Linux under Wine (P1)

1. Given Affinity under Wine, when the user reads the Linux section, then it names the steps verified on Affinity 3.3.1.4940: the endpoint address, the Desktop mapping and its override, the local SDK documentation and the font count.

### US-3 Know the tools (P1)

1. Given the README, when a user or an agent reads the tool table, then it lists all 14 tools with their main inputs and outputs, in the order the server registers them.

### US-4 Fix a failure (P2)

1. Given `get_status` reports `connected: false`, or `files` reports access off or the Desktop not found, when the user reads the troubleshooting section, then it gives the cause and the fix.

### US-5 Publish (P1)

1. Given the slice commit, when the owner runs `npm publish`, then npm rebuilds `dist`, packs exactly the files of FR-603 and publishes the package as public.

### US-6 Follow changes (P2)

1. Given the CHANGELOG, when a user reads it, then the entry for 0.1.0 lists the 14 tools, the supported Affinity versions and the known limits.

## 3. Functional requirements

### 3.1 Version and package

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-601 | P1 | The version shall be 0.1.0 in `package.json`, in both version fields of `package-lock.json`, in the first versioned entry of `CHANGELOG.md`, in the server version that MCP initialization reports, and in `get_status` (FR-126). | |
| FR-602 | P1 | When `npm pack` or `npm publish` runs, the package shall first remove `dist` and build, so that the tarball holds only the output of the current sources. | |
| FR-603 | P1 | The tarball shall hold exactly 11 files: `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `affinity.js`, `compare.js`, `index.js`, `sdk.js`, `staging.js`, `svgpath.js` and `tools.js` in `dist/src`. It shall hold no tests, specs, TypeScript sources or SDK documentation (`.cache/`, R-16). | R-16 |
| FR-604 | P1 | The `bin` entry `talk-to-affinity-mcp` shall be `dist/src/index.js`, whose first line is `#!/usr/bin/env node`. When the tarball is unpacked beside its runtime dependencies and started through that file, the server shall answer `get_status` over stdio with its name and version, and shall run a tool that loads the SDK prelude (`src/sdk.js`). Against Affinity, `get_status` shall report `connected: true`. | |
| FR-605 | P1 | `package.json` shall set `publishConfig.access` to `public`, and shall give `keywords`, `homepage` and `bugs`, the last two pointing to the GitHub repository. | |

### 3.2 README

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-606 | P1 | `README.md` shall have these numbered sections, in this order: 1 Overview (what the server is and what it adds to Affinity's native endpoint); 2 Requirements; 3 Setup by operating system; 4 Client configuration; 5 Tools; 6 Configuration; 7 Conventions (units, node IDs, undo steps, staging, current document only); 8 Privacy and safety; 9 Troubleshooting and known limits; 10 Development (build, unit tests, live tests, specs); 11 License. | |
| FR-607 | P1 | The tool table of section 5 shall list every tool the server registers exactly once, in registration order, each with its main inputs and outputs. The section shall state the tool count as a figure equal to the number of registered tools (14). | |
| FR-608 | P1 | Section 4 shall give: for Claude Code, a `claude mcp add` command, with the `cmd /c` wrapper that native Windows needs for `npx`; for Claude Desktop (macOS and Windows) and Cursor, a JSON `mcpServers` block and the path of the configuration file on each operating system. Each starts the package with `npx -y @alkaness/talk-to-affinity-mcp`. The section shall also show how to start a built clone with `node <clone>/dist/src/index.js`. Every JSON block shall parse. | |
| FR-609 | P1 | Section 6 shall name every environment variable the server reads (`AFFINITY_MCP_URL`, `AFFINITY_DESKTOP_DIR`, `AFFINITY_SDK_DIR`, `WINEPREFIX`, `XDG_DESKTOP_DIR`), each with its default and purpose. | FR-103, FR-120, FR-403 |
| FR-610 | P1 | Section 3 shall state, for every operating system, how to enable the endpoint (Settings > Model Context Protocol > Enable MCP server, then restart Affinity) and the file access setting (Settings > Model Context Protocol > Access files on your Desktop). The Linux part shall name the verified setup: Affinity 3.3.1.4940 under Wine, Node 22.19.0, the endpoint on `127.0.0.1` only, the Desktop folders searched and `AFFINITY_DESKTOP_DIR`, the unreliable native documentation and `AFFINITY_SDK_DIR`, and the font count `list_fonts` reports. The Windows and macOS parts shall be marked "not live-verified". | R-01, R-10, R-16, R-55; constitution 12 |
| FR-611 | P2 | Section 8 shall state: that the server never calls `add_sdk_hint` or `report_sdk_issue`; that no data leaves the computer except an `sdk_docs` hints query; that no discard, close or overwrite happens without an explicit parameter; that the endpoint has no authentication and listens on the loopback address only; and that `run_script` runs any code with Affinity's script permissions. | R-01; constitution 7, 8 |
| FR-612 | P2 | Section 9 shall give the cause and the fix for: the endpoint unreachable (FR-102); file access off (FR-402); Affinity's Desktop not found (FR-403); SDK documentation unavailable (FR-120); a missing font (FR-312); and Affinity exiting during a script (restart it; R-46, R-60). It shall list the known limits of version 0.1.0: tools act on the current document only; no SVG import; without file access, renders are JPEG of at most 1,024 px and nodes cannot be compared; few fonts under Wine. | R-13, R-46, R-57, R-60 |

### 3.3 CHANGELOG

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-613 | P1 | `CHANGELOG.md` shall follow the form of Keep a Changelog 1.1.0. Its entry `## [0.1.0] - 2026-10-18` shall list the 14 tools under "Added", the supported Affinity versions (3.2 or later; live-verified on 3.3.1.4940 under Wine) and the known limits of FR-612. | |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-601 | The tarball is at most 100 kB packed and at most 300 kB unpacked, as `npm pack --dry-run --json` reports. |
| NFR-602 | `README.md` and `CHANGELOG.md` contain no emoji, and every section heading of `README.md` below the title is numbered (constitution item 11). |

## 5. Out of scope

1. Publishing to npm, merging the slice branches into `main`, tagging `v0.1.0`, pushing to GitHub and a GitHub release. The owner does these after the slice commit; the final report lists the commands.
2. Listings and bundles for other channels: the MCP Registry (`server.json`), Claude Desktop extensions (`.mcpb`), Smithery.
3. Live verification on Windows and macOS (constitution item 12).
4. Continuous integration.
5. Screenshots or a demo video in the README.
6. Changes to the tools, their descriptions or the MCP instructions.

## 6. Open questions

None.

## 7. Status

Measured 2026-10-18: `npm test` 123 of 123 pass (38, 19, 20, 23, 9 and 14 for slices 001 to 006); `npm run test:live` 176 of 176 pass (123 unit plus 53 live) against Affinity 3.3.1 under Wine, in 184 s. `npm pack --dry-run` in the repository rebuilt `dist` and listed the 11 files of FR-603: 46.6 kB packed, 151.0 kB unpacked (NFR-601). Tests are found by requirement ID in `test/release.test.ts`, which holds the unit tests and the live test of FR-604.

| ID | Unit | Live |
|---|---|---|
| FR-601, FR-602, FR-603, FR-605 | pass | not applicable: package files |
| FR-604 | pass | pass |
| FR-606 to FR-613 | pass | not applicable: document text |
| NFR-601, NFR-602 | pass | not applicable |
