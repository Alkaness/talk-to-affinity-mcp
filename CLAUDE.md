# Talk to Affinity MCP

1. Specs are the source of truth: read `specs/constitution.md`, then `specs/roadmap.md`.
2. Work from the current slice in `specs/NNN-<slice>/tasks.md`; no code without an FR ID.
3. Test names start with their requirement ID, for example `test('FR-301 ...')`.
4. SDK facts come from `specs/000-spike/research.md` or a live test, never from memory.
5. SDK reference: `.cache/sdk-docs/`, a copy of Affinity's `Resources/JSLib` plus the cached preamble (not committed; see research R-16).
