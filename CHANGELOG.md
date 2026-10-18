# Changelog

All notable changes to this project are recorded in this file. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-18

First release.

### Added

1. 14 tools over Affinity's native MCP endpoint:
   1. Status and scripts: `get_status`, `run_script`, `sdk_docs`, `render`.
   2. Reading: `get_document`, `get_nodes`, `list_fonts`.
   3. Writing, each call all or nothing with its undo steps reported: `create_nodes`, `update_nodes`, `delete_nodes`, `undo`.
   4. Files: `manage_document`, `export`.
   5. Visual check: `compare_to_reference`.
2. Stable node IDs stored as tags, geometry in document pixels, and files anywhere on the computer through a staging folder in Affinity's Desktop.
3. Support for Affinity by Canva 3.2 or later and Node.js 20 or later. Live-verified on Affinity 3.3.1.4940 under Wine on Linux; Windows and macOS are not live-verified.

### Known limits

1. The tools act on the current document only; scripts cannot switch documents.
2. There is no SVG import; vector shapes come from SVG path data.
3. Without file access, renders are JPEG of at most 1,024 px, and only spreads can be compared.
4. Under Wine, Affinity offers only the fonts that Wine finds.

[0.1.0]: https://github.com/Alkaness/talk-to-affinity-mcp/releases/tag/v0.1.0
