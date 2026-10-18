# Slice 006: Tasks

Each task starts with a failing test. Unit tests and the live test live in `test/release.test.ts`.

- [x] T-601 (FR-601, FR-602, FR-603, FR-605, NFR-601) Package. Unit tests: the version is 0.1.0 in `package.json`, both fields of `package-lock.json`, the first CHANGELOG entry, MCP initialization and `get_status`; a copy packed with a stray `dist/src/stale.js` yields exactly the 11 files; `publishConfig.access` is `public` and `keywords`, `homepage` and `bugs` are set; the tarball is at most 100 kB packed and 300 kB unpacked. Then `npm version 0.1.0 --no-git-tag-version`, `build` with clean, `prepack`, `files`, metadata.
- [x] T-602 (FR-604) Unit test: the unpacked tarball started through `dist/src/index.js` reports version 0.1.0 and answers `get_status` and `run_script` against the fake. Live test: it reports `connected: true` against Affinity.
- [x] T-603 (FR-606 to FR-612, NFR-602) README. Unit tests: the 11 numbered sections in order; the tool table equals `tools/list` in order with the figure 14; client blocks parse and name the package or the built file; every environment variable read in `src` appears in section 6; the setup, privacy and troubleshooting facts; no emoji and numbered headings. Then `README.md`.
- [x] T-604 (FR-613, NFR-602) CHANGELOG. Unit test: the entry `## [0.1.0] - 2026-10-18` lists the 14 tools under "Added", the Affinity versions and the known limits; no emoji. Then `CHANGELOG.md`.
- [x] T-605 Analyze: coverage command, full unit and live runs, status table, roadmap slice status, `npm pack --dry-run` in the repository.
