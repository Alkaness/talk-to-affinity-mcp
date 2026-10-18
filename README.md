# Talk to Affinity MCP

An MCP server that lets AI clients such as Claude Code, Claude Desktop and Cursor read, create, edit, check and export documents in Affinity by Canva.

## 1. Overview

Affinity 3.2 and later serve their own MCP endpoint on port 6767. That endpoint runs JavaScript SDK scripts and returns their console output. Talk to Affinity MCP is a stdio MCP server that is itself a client of that endpoint. It offers typed tools that compile to SDK scripts, plus `run_script` for anything the typed tools do not cover.

Compared with the native endpoint, it adds:

1. Common operations without reading the SDK: validated inputs, one call per operation.
2. Stable node IDs; the SDK has none.
3. Structured JSON results instead of console text.
4. Robust sessions: the documentation gate handled, reconnection after a restart of Affinity, IPv4 and IPv6 fallback, and honest timeouts.
5. Files anywhere on the computer, passed through a staging folder in Affinity's Desktop sandbox.
6. Comparison of the document with a reference image, with the regions that differ in document pixels.
7. Linux under Wine as a tested platform.

## 2. Requirements

1. Affinity by Canva 3.2 or later, with its MCP server enabled (section 3).
2. For the tools that read or write files (for example `manage_document` with open or saveAs, `export`, image nodes, renders above 1,024 px and lossless comparison): Affinity's setting "Access files on your Desktop" turned on.
3. Node.js 20 or later.
4. An MCP client that starts stdio servers.

## 3. Setup by operating system

On every operating system, enable the endpoint in Affinity under Settings > Model Context Protocol > Enable MCP server, then restart Affinity: the endpoint starts only with the application. For the file tools, also turn on Settings > Model Context Protocol > Access files on your Desktop. Then add the server to a client (section 4) and ask the client to call `get_status`: it reports `connected: true` and the state of file access in `files`.

### 3.1 Linux under Wine

Live-verified with Affinity 3.3.1.4940 under Wine and Node.js 22.19.0.

1. Affinity under Wine listens on `127.0.0.1:6767` only, not on `[::1]`. The server tries `127.0.0.1` first, so nothing needs to be set.
2. Affinity reports its Desktop as a Windows path such as `C:\users\<name>\Desktop`. The server writes a probe file there and looks for it on Linux: in `AFFINITY_DESKTOP_DIR`, in the Wine prefixes `WINEPREFIX`, `~/.wine` and `~/.local/share/affinity-infinity/prefix`, in the XDG desktop folder, and in `~/Desktop`. If `get_status` reports that the Desktop was not found, set `AFFINITY_DESKTOP_DIR` to the Linux folder that Wine maps to that Desktop.
3. Affinity under Wine often fails to serve its SDK documentation: on the test machine, reads failed in 7 of the first 9 sessions and in every session after them. `sdk_docs` then reads the `Resources/JSLib` folder of the installation inside the Wine prefix. If that folder is elsewhere, set `AFFINITY_SDK_DIR` to it.
4. Wine offers Affinity only the fonts it finds. `list_fonts` reports the total count, which was 268 families with 590 faces on the test machine. A text node with a font that is not installed fails and names the 5 closest installed families, unless `fontFallback` is true.

### 3.2 Windows

This setup is not live-verified: the endpoint and the SDK are the same as under Wine, but the live suite has not run on Windows.

1. Affinity's Desktop is the Windows Desktop, so file access needs no further setting.
2. The local SDK documentation is looked for in `C:\Program Files\Affinity\Affinity\Resources\JSLib`; set `AFFINITY_SDK_DIR` if Affinity is installed elsewhere.
3. Claude Code on native Windows starts `npx` through `cmd /c` (section 4.1).

### 3.3 macOS

This setup is not live-verified: the endpoint and the SDK are the same as under Wine, but the live suite has not run on macOS.

1. Affinity on macOS is reported to listen on `[::1]`. The server tries `127.0.0.1` and then `[::1]`; set `AFFINITY_MCP_URL` if neither answers.
2. The local SDK documentation is looked for in `/Applications/Affinity.app/Contents/Resources/JSLib`; set `AFFINITY_SDK_DIR` if that folder does not exist.
3. If `get_status` reports that Affinity's Desktop was not found, set `AFFINITY_DESKTOP_DIR` to the folder that Affinity reports as its Desktop.

## 4. Client configuration

The package starts with `npx -y @alkaness/talk-to-affinity-mcp`. On first start, `npx` downloads the package and its 97 runtime packages, which can take longer than a client waits on a slow connection. A global install avoids that: `npm install -g @alkaness/talk-to-affinity-mcp`, after which the command is `talk-to-affinity-mcp`.

### 4.1 Claude Code

```sh
claude mcp add affinity -- npx -y @alkaness/talk-to-affinity-mcp
```

On native Windows (not WSL):

```sh
claude mcp add affinity -- cmd /c npx -y @alkaness/talk-to-affinity-mcp
```

Add `--scope user` to use the server in every project, and `-e NAME=value` to set a variable of section 6.

### 4.2 Claude Desktop

Claude Desktop runs on macOS and Windows. Add the block below to its configuration file, then restart Claude Desktop:

1. macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "affinity": {
      "command": "npx",
      "args": ["-y", "@alkaness/talk-to-affinity-mcp"]
    }
  }
}
```

### 4.3 Cursor

Add the block below to `~/.cursor/mcp.json` for every project, or to `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "affinity": {
      "command": "npx",
      "args": ["-y", "@alkaness/talk-to-affinity-mcp"]
    }
  }
}
```

### 4.4 From a clone

```sh
git clone https://github.com/Alkaness/talk-to-affinity-mcp.git
cd talk-to-affinity-mcp
npm install
npm run build
```

Then start `node <clone>/dist/src/index.js`, for example `claude mcp add affinity -- node /path/to/talk-to-affinity-mcp/dist/src/index.js`, or in a JSON configuration:

```json
{
  "mcpServers": {
    "affinity": {
      "command": "node",
      "args": ["/path/to/talk-to-affinity-mcp/dist/src/index.js"]
    }
  }
}
```

## 5. Tools

The server exposes 14 tools. The MCP instructions it publishes tell the client the workflow: status first, read before writing, render after every visual change, `run_script` last.

| Tool | Main inputs | Output |
|---|---|---|
| `get_status` | none | connection, Affinity and SDK versions, permissions, open documents with their paths, file access; never fails |
| `run_script` | `code`, `mutates` (default true), `timeoutMs` | the returned value as JSON, console `logs` |
| `sdk_docs` | `action` list, read, search or hints; `topic`, `query`, `from`, `to` | topic names, numbered lines, or at most 20 matches with context |
| `render` | `target` spread, selection or nodes; `spreadIndex`, `ids`, `maxSize` | image |
| `get_document` | `spreadIndex`, `depth`, `limit`, `query` | document, spread and artboards, layer tree or matches, selection, fonts in use |
| `get_nodes` | `ids` (up to 100) | geometry, fills, strokes, effects, text runs, image size |
| `list_fonts` | `query`, `limit` | total count, families with their styles |
| `create_nodes` | `nodes` (rect, ellipse, star, shape, path, text, image, layer), `parentId`, `spreadIndex`, `fontFallback` | IDs in the shape of the input, undo steps |
| `update_nodes` | `updates` with `id`, `set` and `move`; `fontFallback` | IDs per node, undo steps |
| `delete_nodes` | `ids` | count, undo steps |
| `undo` | `steps`, `redo` | steps done, history position and size |
| `manage_document` | `action` create, open, save, saveAs or close, with its options | current document, open count, notes |
| `export` | `path` (format from the extension), `preset`, `target`, `ids`, `scale`, `width` or `height`, `overwrite` | files with path, bytes and pixel size |
| `compare_to_reference` | `reference` (PNG or JPEG), `target`, `ids`, `maxSize`, `threshold`, `fit`, `heatmap` | score, diff ratio, up to 5 regions in document pixels, heatmap image |

## 6. Configuration

Every variable is optional.

| Variable | Default | Purpose |
|---|---|---|
| `AFFINITY_MCP_URL` | `http://127.0.0.1:6767/sse`, then `http://[::1]:6767/sse` | The endpoint to use; when set, only this URL is tried. |
| `AFFINITY_DESKTOP_DIR` | found by a probe file (section 3.1) | The folder on this computer that Affinity calls its Desktop. |
| `AFFINITY_SDK_DIR` | the known installation folders (sections 3.1 to 3.3) | Affinity's `Resources/JSLib` folder, read when the endpoint cannot serve the SDK documentation. |
| `WINEPREFIX` | unset: only `~/.wine` and `~/.local/share/affinity-infinity/prefix` are searched | A further Wine prefix searched for Affinity's Desktop and its SDK documentation. |
| `XDG_DESKTOP_DIR` | from `~/.config/user-dirs.dirs` | A further folder searched for Affinity's Desktop. |

## 7. Conventions

1. Units: geometry is in document pixels, with the origin at the top-left corner of the spread; boxes are `[x, y, width, height]`. Font sizes are in points and rotations in degrees.
2. Node IDs: an ID without `/` is a stable tag that the write tools store on the nodes they create or change. An ID with `/` is a position (`spread/child/child`, children counted back to front from 0) and can change when the tree changes.
3. Undo steps: `update_nodes` and `delete_nodes` add 1 undo step. `create_nodes` adds 1, plus 1 for each level at which a new layer contains another new layer. Every write result states `undoSteps`, and `undo` reverts them.
4. All or nothing: if part of a write call fails, the document is restored to its state before the call, and the error says so.
5. Files: paths are paths on this computer, absolute or starting with `~`. Files pass through the folder `talk-to-affinity` in Affinity's Desktop and are removed after each call. A document opened or saved as through `manage_document` is edited as a copy in that folder; `save` writes the copy back to its path.
6. Current document: the tools act on the document that is current in Affinity. Scripts cannot switch documents, so the user activates another document when needed.

## 8. Privacy and safety

1. The endpoint has no authentication and listens on the loopback address only. Any program on this computer can reach it while it is enabled.
2. The server never calls the endpoint's `add_sdk_hint` or `report_sdk_issue`. No data leaves this computer, except the query of `sdk_docs` with `action: "hints"`, which Affinity sends to its online hint pool.
3. Nothing is discarded, closed or overwritten without an explicit parameter: an existing file is replaced only with `overwrite: true`, and `close` keeps unsaved changes unless `discardChanges: true`.
4. `run_script` runs any code with Affinity's script permissions, such as file access to the Desktop when that setting is on.

## 9. Troubleshooting and known limits

### 9.1 Messages and fixes

| Message | Cause | Fix |
|---|---|---|
| Affinity is not reachable | Affinity is not running, or its MCP server is off | Enable Settings > Model Context Protocol > Enable MCP server, then restart Affinity. Set `AFFINITY_MCP_URL` if the endpoint is elsewhere. |
| Affinity does not allow scripts to access files | File access is off | Turn on Settings > Model Context Protocol > Access files on your Desktop. |
| Affinity's Desktop ... was not found on this computer | The Desktop folder is not in a searched place | Set `AFFINITY_DESKTOP_DIR` (section 3.1). |
| SDK documentation is unavailable | The endpoint did not serve the documentation, and no local folder was found | Set `AFFINITY_SDK_DIR` to Affinity's `Resources/JSLib` folder. |
| Font family ... is not installed | The font is missing in Affinity | Use a family from `list_fonts`, install the font and restart Affinity, or set `fontFallback: true`. |
| ... may have run ... | Affinity did not answer in time, or the connection closed during the call | Restart Affinity if it exited; the server reconnects by itself. Read the document with `get_document` before a retry. |

### 9.2 Known limits

1. The tools act on the current document only.
2. There is no SVG import; vector shapes come from SVG path data in `create_nodes`.
3. Without file access, renders are JPEG of at most 1,024 px, and `compare_to_reference` compares spreads only, not chosen nodes.
4. Under Wine, Affinity offers only the fonts that Wine finds.
5. Affinity can exit during a script; this happened in the live tests under Wine without a known cause. Restart it; the server reconnects.

## 10. Development

1. `npm install`, then `npm run build`.
2. `npm test` runs the unit tests against a fake Affinity endpoint; no Affinity is needed.
3. `npm run test:live` also runs the live tests against a running Affinity with both settings of section 3 on. The live tests create their own documents and close them without saving.
4. `npx @modelcontextprotocol/inspector node dist/src/index.js` opens the server in the MCP Inspector.
5. The project is developed from specifications: `specs/constitution.md` holds the rules, `specs/roadmap.md` the plan, and each slice of `specs/` its requirements, design and tasks. Test names start with the requirement they verify.

## 11. License

MIT; see `LICENSE`. Affinity and Canva are trademarks of Canva. This project is not affiliated with Canva.
