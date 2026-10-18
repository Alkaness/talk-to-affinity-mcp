# Slice 004: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. New `src/staging.ts` holds the host side of file transfer: it resolves host paths (FR-401), checks file access and finds the Desktop on the host by a probe file (FR-402, FR-403), creates and removes per-call folders (FR-404), checks targets (FR-405), keeps the copies of open documents with their origin (FR-407 to FR-411), and maps Affinity paths to host paths (FR-423).
2. `src/sdk.js` gains the document actions (`fileAccess`, `documentInfo`, `createDocument`, `openDocument`, `saveDocument`, `closeDocument`), `exportFiles`, the pure helper `exportSize`, the image definition in `createNodes`, and `image` in `getNodes`.
3. `src/tools.ts` registers `manage_document` and `export`, extends `render` with `target: "nodes"` and `maxSize`, adds the type `image` to the node schema, adds `files` and host paths to `get_status` and host paths to `get_document`, and updates the instructions and descriptions (FR-425). The server then has 13 tools.
4. Every file goes through `<Desktop>/talk-to-affinity/`. A call that stages files works in its own folder `call-<hex>`, which the server removes in a `finally` block. A document opened or saved through `manage_document` lives in its own folder `doc-<hex>` with a file `origin.txt` that holds its host path; the folder stays while the document is open, so a restarted server still knows the origin.
5. A copy is newer than its origin when its modification time is later. Copies are made with the timestamps kept (`fs.cpSync` with `preserveTimestamps`), so a copy that Affinity has not saved is never written back.
6. The unit suite runs the staging logic against the fake, whose stub `File`, `FileSystemApi`, `Document` and export write real files into a temporary folder that stands for the Desktop. The live suite covers the SDK glue.

## 2. Tool contracts

### 2.1 `manage_document`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `action` | enum | `create`, `open`, `save`, `saveAs`, `close` | required |
| `width`, `height` | number | above 0, at most 100,000; `create` only, required there | |
| `units` | enum | `Pixel`, `Point`, `Millimetre`, `Centimetre`, `Inch`, `Pica`; `create` only | `Pixel` |
| `dpi` | integer | 1 to 10,000; `create` only | 72 |
| `pages` | integer | 1 to 500; `create` only | 1 |
| `transparent` | boolean | `create` only | false |
| `path` | string | host path (FR-401); `open` and `saveAs` only, required there; `.af` for `saveAs` | |
| `overwrite` | boolean | `saveAs` only | false |
| `discardChanges` | boolean | `close` only | false |

A `superRefine` rejects fields that do not belong to the action. Output: `{document, open, note?, warnings?}` (FR-412).

### 2.2 `export`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `path` | string | host path; the extension picks the format (spec table 3.8) unless `preset` is given | required |
| `preset` | string | one of the 64 preset names | from the extension |
| `target` | enum | `spread`, `nodes`, `selection`, `document` | `spread` |
| `spreadIndex` | integer | 0 or more; `spread` only | current spread |
| `ids` | array of strings | 1 to 500; required for `nodes`, else refused | |
| `scale` | number | above 0, at most 32 | |
| `width`, `height` | integer | 1 to 32,768 | |
| `overwrite` | boolean | | false |

At most one of `scale`, `width` and `height`; none of them for `.svg`, `.pdf` and `.eps` without `preset` (FR-416). Output: `{files: [{path, bytes, width?, height?}], preset}`.

### 2.3 `render`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `target` | enum | `spread`, `selection`, `nodes` | `spread` |
| `spreadIndex` | integer | 0 or more | current spread |
| `ids` | array of strings | 1 to 500; required for `nodes` | |
| `maxSize` | integer | 64 to 2,048 | 1,024 when the export path is taken |

Without `maxSize`, `spread` and `selection` use the native renderer as before (FR-420). Otherwise the export of 3.6 writes `JPEG (High quality)` with longest side `maxSize`, and the server returns the file as MCP image content `image/jpeg` (FR-419).

### 2.4 `create_nodes` type `image` and `get_status`

1. Image specs take `src`, `box`, `fit` and the common fields `id`, `name`, `rotation`, `opacity`, `blendMode`, `effects` (spec table 3.9). `fill`, `stroke`, the shape fields, the text fields and `children` are refused by the existing per-type rules.
2. `get_status` adds `files: {access, desktop, hostDesktop}` and maps `documents[].path` (FR-423, FR-424). It still never throws: a failed probe gives `hostDesktop: null` and `fix`.

## 3. Design details

### 3.1 Host paths (FR-401)

`hostPath(p)`: `~` and `~/...` expand to `os.homedir()`; then `path.isAbsolute` must hold, otherwise the tool fails before any script with "Paths are paths on this computer: absolute, or starting with ~". The result is `path.resolve(p)`.

### 3.2 Access and location (FR-402, FR-403)

1. `begin()` runs `ttam.fileAccess(probe)` once per file call. The script reads `Environment.permissions.fileSystem` and `app.userDesktopPath`; when access is on, it creates `<Desktop>/talk-to-affinity` with `FileSystemApi.createDirectories` and writes `probe-<hex>.txt` with `File.create(path, 'w').writeString(...)` (R-51). Access off returns the FR-402 message as `{fail}`, before any change.
2. The host looks for `talk-to-affinity/probe-<hex>.txt` under, in order: `AFFINITY_DESKTOP_DIR`; the reported path itself; for a path `X:\rest`, `<prefix>/drive_c/rest` (only for `C:`) for each prefix of `WINEPREFIX`, `~/.wine`, `~/.local/share/affinity-infinity/prefix`; `XDG_DESKTOP_DIR`, else the `XDG_DESKTOP_DIR` line of `~/.config/user-dirs.dirs` with `$HOME` expanded; `~/Desktop` (R-09). The first hit is cached with the reported path; the probe is removed. A miss fails naming `AFFINITY_DESKTOP_DIR`.
3. Later calls run the access check again (the setting can change), but the probe only when the reported path changed.
4. Affinity-side paths are the reported Desktop path plus `/talk-to-affinity/...` with forward slashes, which Affinity accepts (R-51). Staged names keep the original base name behind a numeric prefix (`1-logo.png`), so they never start with a dot (R-09, R-51).

### 3.3 Cleanup and targets (FR-404, FR-405)

1. `withCall(fn)` creates `call-<hex>`, runs `fn`, and in `finally` removes the folder with `rmSync({recursive, force})` and then `talk-to-affinity` itself when empty (`rmdirSync`, ignoring `ENOTEMPTY`).
2. `checkTarget(file, overwrite)`: a missing parent folder fails naming it; an existing file without `overwrite` fails naming `overwrite`. `export` checks every final name after Affinity wrote into the call folder and before the first copy into the target folder; `saveAs` checks before its script.

### 3.4 Document copies (FR-407 to FR-411, FR-423)

1. `open`: the host checks that the file exists (a missing file would report `PERMISSION_DENIED`, R-51), then compares its resolved path with the host paths of the open documents from `ttam.documentInfo()`. The current document: no change, `note: "already open"`. Another document: fail, "scripts cannot switch documents" (R-13, R-52). Otherwise the file is copied to `doc-<hex>/<name>` with timestamps kept, `origin.txt` is written, and `ttam.openDocument(path)` runs `Document.load`, which makes the copy current (R-52). A failed load removes the folder and fails naming the original file.
2. `save`: `ttam.saveDocument({})` fails with `mustSaveAs` naming `saveAs` (R-52 items 1 and 6); otherwise it runs `doc.save()` and returns the Affinity path. When the path lies in a `doc-<hex>` folder, the host copies the copy to its origin with timestamps kept; a failed write fails the call, stating that Affinity's copy holds the change.
3. `saveAs`: the host checks the path (`.af`, FR-405), creates `doc-<hex>` with `origin.txt` and runs `ttam.saveDocument({as})`, which calls `doc.saveAs` (R-52 items 2 and 3); then the host copies the file to the target. The folder of the previous copy, if any, becomes stale and is handled by item 5.
4. `close`: `ttam.closeDocument(discard)` returns `{fail}` naming `discardChanges` when `isDirty` holds without it, else calls `doc.close()` and nothing else (R-46).
5. `sync(open)` runs at the end of every `manage_document` call, after the final `ttam.documentInfo()`. For each `doc-<hex>` folder whose copy is not the path of an open document: when the copy is newer than its origin, or the origin is missing, it is copied there; then the folder is removed, with any Wine `~lock~` leftovers (R-13, R-52). A failed copy keeps the folder and adds the copy's host path to `warnings`.
6. `mapPath(affinityPath)`: an empty path is `null`; a path inside a `doc-<hex>` folder gives the content of its `origin.txt`; another path inside the Desktop gives the host Desktop plus the rest; any other path stays as Affinity reports it. Comparison ignores case and treats `\` and `/` alike. `get_status`, `get_document` and `manage_document` map their paths; when the Desktop has not been located yet, they try once and keep Affinity's path on failure.

### 3.5 Document scripts (FR-406, FR-412)

1. `createDocument(o)`: `NewDocumentOptions.createDefault()`, `units` first, then `width`, `height`, `dpi` (R-53); for more than one page `isMultiPage = true`, `isFacing = false`, `pageCount`; `isTransparentBackground`; `Document.create(o)` makes it current (R-13).
2. `documentInfo()`: `{document: {title, path, dirty, spreads, width, height, dpi, units} | null, open: [paths], count}` from `app.documents.current` and `app.documents.all` (R-13 item 6, R-52). The host replaces `path` with `mapPath` and drops the path list from the result.

### 3.6 Export script (FR-413 to FR-418)

1. Preset: the host maps the extension to the preset of spec table 3.8, or takes `preset`. The script checks the name against `FileExportOptions.allPresetNames`; a miss fails with the 5 names of smallest edit distance (`distance` of slice 003) (R-50).
2. Area and nodes: `spread` uses the spread `spreadIndex` (default: current) with `FileExportArea.createForSpreads(String(index + 1))` (R-48 item 2). `document` uses `createForWholeDocument()` for presets whose name starts with `PDF`, otherwise one export per spread as for `spread`. `nodes` resolves the IDs with `scan` (unknown IDs and more than one spread fail), selects them with `createSetSelection` in the preview form, and exports `createForSelection(null)`; `selection` exports the current selection, failing when it is empty (R-48 items 3 and 4, R-49).
3. Size: `exportSize(w, h, o)` returns `{width, height}` for the area: for a spread its page box, for nodes and the selection the union of their `spreadVisibleBox` with floor and ceiling (R-48 item 4). `scale` multiplies both sides, `width` or `height` sets one side and keeps the aspect for the other, `longest` (internal, for `render`) scales the longer side to that value; sides are rounded, at least 1, and a side above 32,768 fails before export. Raster presets always get the size explicitly, so the reported size is exact (R-47 item 2); vector presets get `null` (R-47 item 3). With `preset`, the size fields pass through as given (spec table 3.8).
4. Each export writes into its own subfolder `s<n>/` of the call folder; Affinity may append `_1` to the name (R-48 item 2), so the host takes the single file of each subfolder and names it `<name>.<ext>` for `spread`, `nodes` and `selection`, `<name>_<n>.<ext>` for `document` per spread, and `<name>.<ext>` for a PDF of the document.
5. Unchanged state (FR-417): the preview selection adds no history step and no dirty flag, and the export ends the preview, which restores the previous selection (R-49). When the export throws, the script previews the saved selection back before rethrowing. Spread exports select nothing.
6. Result: the host lists the copied files with their size in bytes, and `width` and `height` from the script for raster presets.

### 3.7 Images (FR-421, FR-422)

1. Host: for every image spec in the tree, `src` is resolved (FR-401), checked to exist, and copied into the call folder; the spec carries the Affinity path as `staged` and the host path as `src` for messages.
2. Script preconditions: `Bitmap.loadFromFile(staged)` for each image before `atomic`; `NOT_SUPPORTED` or `ERROR` fails naming `src` with "is missing or not a PNG, JPEG, WebP, TIFF or GIF image. Nothing was changed." (R-54 item 1).
3. Definition: `ImageNodeDefinition.create(RasterFormat.RGBA8)` from `/nodes.js` and `require('affinity:raster')`, `setBitmap(bitmap)` (R-54 item 2). Placement `(w / bw, 0, x, 0, h / bh, y)` for `stretch`; for `contain` the largest box of the bitmap's aspect centred in `box` (R-54 item 3). Rotation multiplies `rotationData` about the box centre with the placement. The node is inserted, tagged and styled as every other node (slice 003 plan 3.4), so it is 1 undo step.
4. `getNodes`: for type `image`, `image: {width: rasterWidth, height: rasterHeight}` (R-54 item 5).

### 3.8 Instructions (FR-425)

The rules section replaces the Desktop line with: file paths are host paths; file tools need Settings > Model Context Protocol > Access files on your Desktop; opened documents are edited as copies that `save` writes back; existing files are replaced only with `overwrite: true`; `close` keeps unsaved changes unless `discardChanges: true`. The workflow names `manage_document` and `export`. The FR-127 test checks the 1,500-character limit.

## 4. Files touched

| File | Change |
|---|---|
| `src/staging.ts` | new: host paths, access and location, call folders, targets, document copies, path mapping |
| `src/sdk.js` | document actions, `exportFiles`, `exportSize`, image definition and preconditions, `image` in `getNodes` |
| `src/tools.ts` | `manage_document`, `export`, `render` targets and `maxSize`, image specs, `get_status` files, path mapping, instructions |
| `test/fake-affinity.ts` | `fakeFiles`: stub `File`, `FileSystemApi`, `Document`, export options and areas, `Bitmap`, Desktop path |
| `test/files-export.test.ts` | new: unit tests |
| `test/live.test.ts` | slice 004 live tests; PNG writer and PNG and JPEG size readers |
| `test/foundation.test.ts` | FR-129 expects 13 tools |
| `specs/001-foundation/spec.md`, `specs/002-read-model/spec.md` | change notes for FR-423 |
| `specs/roadmap.md` | tool contract rows and slice status |

## 5. Risks

1. `createForSpreads` for a spread that is not current is assumed to cut to the page as `createForCurrentSpread` does (R-48 item 1); the live suite checks the size.
2. `doc.save()` of a document stored outside the Desktop (opened by the user in Affinity) may be refused by the sandbox; the error is passed on.
3. Write-back trusts modification times. A host file changed by another program after `open` is newer than the copy and is not overwritten by `sync`, but `save` still writes it; the description says that `save` writes back.
4. `ImageNodeDefinition.userDescription` for `name` is assumed from the other definitions; the live suite reads the name back.
5. Permission off cannot be switched by a script; FR-402 is covered by the fake only.
