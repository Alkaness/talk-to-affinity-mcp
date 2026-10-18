# Slice 004: Files and export

Status: approved at gate G1, 2026-10-14.

## 1. Problem

After slice 003 an agent can build and edit the current document, but it cannot create, open, save or close documents or export them. It sees only JPEG renders of at most 1,024 px of a whole spread or of the current selection, and it cannot place images. Several Affinity rules stand in the way:

1. Scripts may touch files only inside Affinity's Desktop folder (R-51). Under Wine that folder has a Windows path (R-09).
2. `saveAs` overwrites files without a warning (R-52), and `close` discards unsaved changes.
3. Chosen nodes can be exported only through the document's selection (R-48), and changing the selection adds undo steps (R-27).
4. A script that changes the selection and then closes the document can crash Affinity (R-46).

Slice 004 adds two tools: `manage_document` and `export`. It extends `render` with chosen nodes and sizes up to 2,048 px, adds the type `image` to `create_nodes` and image details to `get_nodes`, and reports file access and host paths. Files move between the host and Affinity through a staging folder on the Desktop, so the tools accept any path on the computer that runs the server.

## 2. User stories

### US-1 Export a design (P1)

As an agent, I want to write a document, a spread or chosen nodes to a file in a common format at a chosen size.

1. Given an open document, when `export` receives `path: "/home/u/out/poster.png"` and `scale: 2`, then a PNG of the current spread at twice the document size is written to that path, and no staged file remains.
2. Given the ID of a logo layer and `target: "nodes"`, then only the logo is written, cropped to its visible box over a transparent background.
3. Given a `path` that exists, when `overwrite` is not true, then the call fails and the file is unchanged.

### US-2 Manage documents (P1)

As an agent, I want to create, open, save and close documents at paths of my choice.

1. Given no document, when `manage_document` creates a 1,200 x 800 px document, adds nodes, saves it as `/home/u/work/poster.af`, closes it and opens it again, then its content and node IDs are unchanged.
2. Given a document with unsaved changes, when `close` runs without `discardChanges: true`, then the call fails, names the parameter, and the document stays open.
3. Given a document opened from `/home/u/work/poster.af`, when it is changed and saved, then `/home/u/work/poster.af` holds the change.

### US-3 Look closely (P1)

As an agent, I want to see chosen nodes, or a spread at a higher resolution, without changing the document.

1. Given a small icon, when `render` receives its ID with `maxSize: 2048`, then an image of only that icon returns with its longest side 2,048 px, and history, dirty flag and selection are unchanged.

### US-4 Place images (P1)

As an agent, I want to place an image file in the document.

1. Given a PNG on the host, when `create_nodes` receives `{type: "image", src, box}`, then the image appears in the box with its aspect ratio kept, embedded in the document, in 1 undo step.

### US-5 Know what is possible (P2)

As a user, I want to know whether file access works before an agent relies on it.

1. Given file access is off in Affinity, when an agent calls `export`, then the call fails naming the setting, and `get_status` reports the access as off.

## 3. Functional requirements

### 3.1 Host paths and staging

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-401 | P1 | The paths given to the tools of this slice shall be paths on the computer that runs the server: absolute, or starting with `~` for the home folder. Other paths shall be rejected before any script runs. | |
| FR-402 | P1 | If Affinity's file access is off (`Environment.permissions.fileSystem` false), then every call that reads or writes files shall fail before any change with a message naming Settings > Model Context Protocol > Access files on your Desktop. | R-09, R-55 |
| FR-403 | P1 | The server shall pass files to and from Affinity only through the folder `talk-to-affinity` in Affinity's Desktop folder. It shall find that folder on the host by writing a probe file from a script and looking for it, in this order, under: `AFFINITY_DESKTOP_DIR`; the Desktop path that Affinity reports; that path inside the Wine prefixes `WINEPREFIX`, `~/.wine` and `~/.local/share/affinity-infinity/prefix`; the XDG desktop folder; `~/Desktop`. If none holds the probe, then the call shall fail naming `AFFINITY_DESKTOP_DIR`. | R-09, R-51 |
| FR-404 | P1 | The files that a call stages shall be removed when the call ends, also when it fails, and the staging folder shall be removed when it is empty. Copies of open documents stay while the documents are open (FR-411). Staged names shall not start with a dot. | R-51 |
| FR-405 | P1 | If a target file of `export` or `saveAs` exists and `overwrite` is not true, then the call shall fail before anything is written to the target folder, naming `overwrite`. If the target folder does not exist, then the call shall fail naming the folder. | R-52 |

### 3.2 `manage_document`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-406 | P1 | `action: "create"` shall create a document with the fields of table 3.7 and make it current. | R-35, R-48, R-53 |
| FR-407 | P1 | `action: "open"` shall copy the file at `path` into the staging folder and open the copy, which becomes current; it opens what Affinity opens, including PNG, SVG and Affinity 2 files. If that file is already open as the current document, then nothing shall be opened and the result shall say so. If it is open but not current, then the call shall fail, stating that scripts cannot switch documents. If Affinity cannot open the file, then the call shall fail naming the file. | R-13, R-51, R-52 |
| FR-408 | P1 | `action: "save"` shall save the current document. For a document opened or saved through `manage_document`, it shall then write the copy to the document's host path. If the document has never been saved, or was imported from another format, then the call shall fail naming `saveAs`. | R-52 |
| FR-409 | P1 | `action: "saveAs"` shall save the current document as `path`, which must end in `.af`, through the staging folder (FR-405 applies). Later `save` calls write to that path. | R-51, R-52 |
| FR-410 | P1 | `action: "close"` shall close the current document. If it has unsaved changes and `discardChanges` is not true, then the call shall fail naming `discardChanges`. The closing script shall change nothing else. | R-46, R-52 |
| FR-411 | P1 | When a document whose copy the server keeps is no longer open, closed through `manage_document` or in Affinity, the server shall write the copy to the document's host path if the copy was saved after the last write, and then remove the copy. It shall check this at the end of every `manage_document` call. If the write fails, then the copy shall stay, and the result shall name it under `warnings`. | R-52 |
| FR-412 | P1 | Every result shall give `document`, the current document after the action as `{title, path, dirty, spreads, width, height, dpi, units}` (width and height in pixels, `path` as in FR-423, `null` when unsaved), or `null` when no document is open, and `open`, the number of open documents. | R-29, R-52 |

### 3.3 `export`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-413 | P1 | `export` shall write the current document to `path` in the format of table 3.8, chosen by the file extension, or by `preset`, one of Affinity's 64 export presets. An unknown extension without `preset` shall fail before export, listing the extensions of table 3.8; an unknown preset shall fail listing up to 5 preset names closest to it. | R-50 |
| FR-414 | P1 | `target` shall be `spread` (the default; spread `spreadIndex`, by default the current one, cut to its page), `nodes` (the nodes in `ids`), `selection` (the current selection) or `document` (all spreads: one file for PDF, otherwise one file per spread named `<name>_<n>.<ext>`, counted from 1). | R-48 |
| FR-415 | P1 | For `nodes` and `selection`, the file shall contain only those nodes, hidden ones included, over a transparent background where the format has one, cut to the union of their visible boxes widened to whole pixels. The nodes of `ids` must lie on one spread; unknown IDs fail naming them. If the selection is empty, then the call shall fail. | R-48, R-49 |
| FR-416 | P1 | Raster formats shall be written at one pixel per document pixel, or at `scale` (above 0, at most 32) times that size, or at `width` or `height` pixels (1 to 32,768) with the other side keeping the aspect ratio; at most one of the three is given. If a side would exceed 32,768 px, then the call shall fail before export. The formats of table 3.8 without raster size (SVG, PDF, EPS) shall reject the size fields. | R-47 |
| FR-417 | P1 | `export` shall leave the document's history, dirty flag and selection unchanged. | R-49 |
| FR-418 | P1 | The result shall list the written files as `{path, bytes}`, with `width` and `height` in pixels for raster formats, and name the preset used. | R-47, R-48 |

### 3.4 `render`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-419 | P1 | `render` shall accept `target: "nodes"` with `ids`, rendered as in FR-415, and `maxSize` (64 to 2,048) for every target. With `target: "nodes"`, or with `maxSize`, the server shall render through an export as JPEG whose longest side is `maxSize` (default 1,024), enlarging small areas, and leave history, dirty flag and selection unchanged. | R-47, R-48, R-49 |
| FR-420 | P1 | Without `maxSize`, targets `spread` and `selection` shall keep using Affinity's renderer (FR-123), which needs no file access. | R-08 |

### 3.5 Images

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-421 | P1 | `create_nodes` shall create `image` nodes with the fields of table 3.9. The image is embedded in the document. If a file is missing or not a PNG, JPEG, WebP, TIFF or GIF image, then the call shall fail before any change naming the file. | R-54 |
| FR-422 | P1 | `get_nodes` shall report `image: {width, height}`, the pixel size of the embedded image, for image nodes. | R-54 |

### 3.6 Status, paths and descriptions

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-423 | P2 | `get_status`, `get_document` and `manage_document` shall report document paths as host paths: the original path of a copy (FR-407, FR-409), the host path of a file in Affinity's Desktop folder, and otherwise Affinity's own path. | R-09 |
| FR-424 | P2 | `get_status` shall report `files: {access, desktop, hostDesktop}`: whether file access is on, Affinity's Desktop path, and its host path (`null` with the fix of FR-403 when not found). | R-09, R-55 |
| FR-425 | P1 | The MCP instructions and the tool descriptions shall state that file paths are host paths, that file tools need the setting of FR-402, that opened documents are edited as copies written back by `save`, and the `overwrite` and `discardChanges` rules. The instructions stay within 1,500 characters (FR-127). | R-52 |

### 3.7 Fields of `manage_document`

| Action | Field | Value | Default |
|---|---|---|---|
| `create` | `width`, `height` | above 0, at most 100,000, in `units` | required |
| `create` | `units` | `Pixel`, `Point`, `Millimetre`, `Centimetre`, `Inch`, `Pica` | `Pixel` |
| `create` | `dpi` | 1 to 10,000 | 72 |
| `create` | `pages` | 1 to 500 spreads of one page each | 1 |
| `create` | `transparent` | transparent background | false |
| `open` | `path` | host path of a file Affinity opens | required |
| `saveAs` | `path`, `overwrite` | host path ending in `.af`; replace an existing file | required; false |
| `close` | `discardChanges` | close even with unsaved changes | false |

### 3.8 Export formats

| Extension | Preset | Size fields |
|---|---|---|
| `.png` | `PNG` | yes |
| `.jpg`, `.jpeg` | `JPEG (High quality)` | yes |
| `.webp` | `WebP (Lossless, default)` | yes |
| `.gif` | `GIF RGB` | yes |
| `.tif`, `.tiff` | `TIFF RGB 8-bit` | yes |
| `.psd` | `PSD (preserve editability)` | yes |
| `.svg` | `SVG (for export)` | no |
| `.pdf` | `PDF (for export)` | no |
| `.eps` | `EPS (for export)` | no |

With `preset`, the extension is free and the size fields are passed to Affinity, which ignores them for vector presets (R-47).

### 3.9 Image nodes for `create_nodes`

| Field | Value | Default |
|---|---|---|
| `type` | `image` | required |
| `src` | host path of a PNG, JPEG, WebP, TIFF or GIF file | required |
| `box` | `[x, y, w, h]` in document pixels, `w` and `h` above 0 | required |
| `fit` | `contain`: the largest box with the image's aspect ratio, centred in `box`; `stretch`: exactly `box` | `contain` |
| `id`, `name`, `rotation`, `opacity`, `blendMode`, `effects` | as in table 3.7 of slice 003 | as there |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-401 | `export` of a spread with 200 nodes at 2,048 px completes within 2 s. |
| NFR-402 | `render` of chosen nodes at 2,048 px completes within 3 s. |

## 5. Out of scope

1. Switching the current document: no script API does it (R-13), and loading an open file does not either (R-52).
2. Linked images, replacing an image's bitmap, cropping and masks, image fills.
3. Placing SVG or PDF content in the current document; `open` imports such files as separate documents (R-52).
4. Export settings beyond the presets (quality, colour profile, bleed, DPI metadata) and export areas by artboard; artboards export as nodes by their ID.
5. Packages (`saveAsPackage`) and password-protected documents.
6. Linked resources of an opened document that are referenced by relative paths: the copy lies in the staging folder.

## 6. Open questions

None.

## 7. Status

Measured 2026-10-18: `npm test` 100 of 100 pass (38, 19, 20 and 23 for slices 001 to 004); `npm run test:live` 147 of 147 pass (100 unit plus 47 live) against Affinity 3.3.1 under Wine. In one earlier full run the slice 001 documentation test FR-117 failed once and passed when repeated, which matches the unreliable native documentation of R-16. Export of a 1,000 x 1,000 px spread with 200 ellipses at 2,048 x 2,048 px PNG took 555 to 840 ms (NFR-401); `render` of one node at 2,048 px took 517 to 538 ms (NFR-402), each through the server. Tests are found by requirement ID in `test/files-export.test.ts` (unit) and `test/live.test.ts` (live).

| ID | Unit | Live |
|---|---|---|
| FR-401 | pass | not applicable: refused before any script |
| FR-402 | pass | not applicable: a script cannot turn the setting off |
| FR-403, FR-404, FR-405, FR-424 | pass | pass |
| FR-406, FR-409, FR-410, FR-412 | pass (field rules) | pass |
| FR-407, FR-408, FR-411, FR-423 | pass (copies, write-back, path mapping) | pass |
| FR-413 to FR-416, FR-418 | pass | pass |
| FR-417 | not applicable: SDK commands | pass |
| FR-419, FR-420, FR-421, FR-422 | pass | pass |
| FR-425 | pass | not applicable: description text |
| NFR-401, NFR-402 | not applicable | pass |

## 8. Changes after approval

1. 2026-10-18, implementation: `spreadIndex` applies only to `target: "spread"` and `ids` only to `target: "nodes"`, in `export` and `render`; `manage_document` refuses fields of other actions. Other combinations fail before any script.
2. 2026-10-18, implementation: when `get_status` cannot report `hostDesktop`, `files` also holds `fix`: the setting of FR-402 when file access is off, else the text of FR-403.
