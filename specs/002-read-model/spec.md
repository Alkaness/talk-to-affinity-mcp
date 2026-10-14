# Slice 002: Read model

Status: approved at gate G1, 2026-10-14; implemented and verified at gate G4, 2026-10-14.

## 1. Problem

After slice 001 an agent can only inspect a document by writing SDK scripts. That costs tokens, needs SDK knowledge, and returns whatever shape the script chose. The SDK also has no persistent node IDs, so nothing an agent reads can be referenced reliably later (R-06, R-07 in `specs/000-spike/research.md`).

Slice 002 adds three read-only tools: `get_document` for the overview and layer tree, `get_nodes` for exact styling, and `list_fonts` for the installed fonts. It also fixes the ID rules that the write tools of slice 003 will use.

## 2. User stories

### US-1 Understand a document (P1)

As an agent, I want a compact overview of the current document (size, spread, artboards, selection, fonts in use and the layer tree), so that I can plan changes without writing a script.

1. Given a document whose spread has 13 top-level nodes, one of them a layer with 2 children, when `get_document` is called with defaults, then it lists the 13 nodes back to front, each with ID, type, name and box, and the layer's 2 children.
2. Given a spread with more nodes than `limit`, when `get_document` is called, then the output stops at `limit` nodes and states how many were omitted and how to narrow the request.

### US-2 Inspect nodes exactly (P1)

As an agent that copies or adjusts a design, I want the exact fill, stroke, opacity, blend mode, effects and text styling of chosen nodes.

1. Given a text node with two styled runs, when `get_nodes` is called with its ID, then two runs return, each with family, style, weight, italic flag, size in points and colour.
2. Given a text run whose requested italic face does not exist, then the run reports the face Affinity actually uses (R-24).

### US-3 Stable references (P1)

As an agent, I want IDs that I can pass to later calls.

1. Given a node without a tag, its ID is its position path, and the tool descriptions say that path IDs change when the tree changes.
2. Given a node tagged by a write tool, its ID is the tag and survives edits elsewhere in the tree.

### US-4 Find nodes (P2)

As an agent, I want to find nodes by type, name or text without reading the whole tree.

1. Given `query: {text: "hello"}`, when `get_document` is called, then every node of the spread whose text contains "hello" (any case) returns in a flat list.

### US-5 Choose fonts that exist (P1)

As an agent, I want to know which font families and styles are installed before I use them.

1. Given `list_fonts` with `query: "arial"`, then the Arial family returns with its styles, weights and italic flags, together with the total family count.

## 3. Functional requirements

### 3.1 Read-only and IDs

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-201 | P1 | `get_document`, `get_nodes` and `list_fonts` shall leave the document's history position, history size and dirty flag unchanged, and shall not change the selection. | R-26, R-27 |
| FR-202 | P1 | A node's ID shall be the value of its `ttam-id` tag when the tag is present; otherwise its path `s/i/j/...`: the spread index, then the child index at each level, counted back to front from 0. | R-06, R-20 |
| FR-203 | P1 | If several nodes carry the same tag value, then the first of them in document order (spreads in order, depth first, back to front) shall keep the tag as its ID and the others shall report path IDs. | R-06 |
| FR-204 | P1 | The tool descriptions shall state that IDs containing `/` are positions that change when the tree changes, and that other IDs are stable tags. | |
| FR-205 | P1 | If no document is open, then `get_document` and `get_nodes` shall fail with a message naming that precondition; `list_fonts` shall work without a document. | R-13 |

### 3.2 `get_document`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-206 | P1 | `get_document` shall return the document's title, path, DPI, units, width and height in pixels, colour format, dirty flag, spread count and current spread index. | R-29 |
| FR-207 | P1 | `get_document` shall return, for the spread chosen by `spreadIndex` (default: the current spread), its index, box and artboards (ID, name, box). | R-19 |
| FR-208 | P1 | `get_document` shall return the IDs of the selected nodes and the fonts the document uses, each as PostScript name with an installed flag. | R-25, R-27, R-31 |
| FR-209 | P1 | `get_document` shall return the spread's nodes back to front, to `depth` levels (1 to 20, default 2). Each node has `id`, `type`, `name` and `box`; `hidden: true` and `locked: true` appear only when set; `kind` appears where the type table gives one; a node with children below the depth limit reports `childCount` instead of `children`, and a node whose children were cut off by `limit` reports `childCount` beside the listed `children`. | R-19, R-20 |
| FR-210 | P1 | If the tree within `depth` has more nodes than `limit` (1 to 2,000, default 500), then `get_document` shall stop at `limit` nodes and report the number omitted and how to narrow the request (`depth`, `query`, `get_nodes`). | R-04, R-15 |
| FR-211 | P2 | When `query` is given, `get_document` shall instead return a flat list of the spread's nodes at any depth that match every given condition: `type` equal, `name` containing the text (any case), `text` contained in the node's text content (any case). The list obeys `limit`. | R-24 |
| FR-212 | P1 | If `spreadIndex` does not exist, then `get_document` shall fail naming the number of spreads. | |

### 3.3 Node description

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-213 | P1 | Boxes shall be `[x, y, w, h]` in document pixels relative to the spread, rounded to 2 decimals. A box without extent (a layer with only hidden content) shall be `null`. | R-14, R-21 |
| FR-214 | P1 | Types shall follow table 3.5. | R-19 |
| FR-215 | P1 | Names shall be the node's description: the user's name when set, otherwise Affinity's default name. | R-19 |

### 3.4 `get_nodes`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-216 | P1 | `get_nodes` shall accept 1 to 100 IDs and return one entry per ID, in the given order, with `id`, `type`, `kind` (where the type table gives one), `name`, `box`, `parent` (ID or `null` at spread level) and `childCount`. | R-19 |
| FR-217 | P1 | Each entry shall add, only when they differ from the default: `visibleBox` (when it differs from `box`), `rotation` in degrees (when not 0), `opacity` (when not 1), `blendMode` (when not `Normal`), `hidden`, `locked`. | R-21, R-22 |
| FR-218 | P1 | Each entry shall give `fill`: `null` for none, `"#rrggbbaa"` for a solid colour, `{gradient, stops: [{at, color}]}` for a gradient (type name from the SDK enum), `{type}` for other fill types. Text nodes, whose colour lives in their runs, and nodes without a brush fill, such as layers, have no `fill`. | R-22 |
| FR-219 | P1 | Each entry shall give `stroke`: `null` when there is no pen fill or the width is 0, otherwise `{color, width, align, cap, join}` with width in document pixels and `dash` when a dash pattern is set. | R-22, R-30 |
| FR-220 | P1 | Text entries shall give `text: {content, runs, align}`: runs are the maximal character ranges with identical family, style, weight, italic flag, size and colour, each as `{text, family, style, weight, italic, size, color}` with size in points (height x 72 / DPI); `align` lists the alignment of every paragraph, in order. | R-24, R-30 |
| FR-221 | P2 | Entries with layer effects shall give `effects: [{type, enabled, opacity, blendMode, ...}]` with `radius`, `color`, `offset`, `angle` (degrees) and `intensity` when the effect has them. | R-23 |
| FR-222 | P1 | If an ID matches no node, then its entry shall be `{id, error: "not found"}` and the other entries shall still return. | |

### 3.5 Type table

| Node | `type` | `kind` |
|---|---|---|
| `ShapeNode` with `isArtboardEnabled` | `artboard` | |
| `ShapeNode`, shape `Rectangle` | `rect` | |
| `ShapeNode`, shape `Ellipse` | `ellipse` | |
| `ShapeNode`, shape `Star` | `star` | |
| `ShapeNode`, any other shape | `shape` | the shape type name, for example `Heart` |
| `PolyCurveNode` | `path` | |
| `ArtTextNode` | `text` | `art` |
| `FrameTextNode` | `text` | `frame` |
| other `...TextNode` classes | `text` | the class name without `TextNode`, for example `Table` |
| `ImageNode` | `image` | |
| `ContainerNode` | `layer` | |
| `GroupNode` | `group` | |
| `RasterNode`, `PatternRasterNode` | `raster` | |
| `...AdjustmentRasterNode` | `adjustment` | the name before `AdjustmentRasterNode`, for example `Curves` |
| `...FilterRasterNode` | `filter` | the name before `FilterRasterNode`, for example `GaussianBlur` |
| anything else | `other` | the class name |

### 3.6 `list_fonts`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-223 | P1 | `list_fonts` shall return the total number of installed families, the number matching `query` (case-insensitive substring of the family name; all when absent), and up to `limit` (1 to 500, default 50) matching families sorted by name, each with its styles as `{style, weight, italic}`. | R-10, R-25 |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-201 | `get_document` with defaults on a spread of 1,000 nodes completes within 2 s. |
| NFR-202 | `get_document` output for 500 nodes at depth 1 stays below 60,000 characters. |

## 5. Out of scope

1. Rendering chosen nodes (`render` target `nodes`): changing the selection adds undo steps (R-27), so it moves to slice 004, which can export a `Selection` object.
2. Image node details (file, pixel size): slice 004, which adds images.
3. Text frame overflow: the SDK has no getter (R-24).
4. Swatches, text styles, master pages, documents other than the current one (R-13).

## 6. Open questions

None.

## 7. Status

Measured 2026-10-14: `npm test` 57 of 57 pass (38 of slice 001, 19 of slice 002); `npm run test:live` 80 of 80 pass (57 unit plus 23 live) against Affinity 3.3.1.4940 under Wine. On a spread of 1,000 rectangles, `get_document` with defaults took 179 to 205 ms after a first call of 655 ms, and its output for 500 nodes at depth 1 was 40,395 characters; `get_nodes` for 100 IDs took 156 ms. Tests are found by requirement ID in `test/read-model.test.ts` (unit) and `test/live.test.ts` (live).

| ID | Unit | Live |
|---|---|---|
| FR-201 to FR-203 | pass | pass; a duplicate across spreads is unit-tested only |
| FR-204 | pass | not applicable: tool description text |
| FR-205 to FR-223 | pass | pass |
| NFR-201 | not applicable: needs Affinity | pass |
| NFR-202 | pass | pass |

## 8. Changes after approval

1. 2026-10-14, planning: the references of FR-206, FR-208, FR-219 and FR-220 now cite R-29 to R-31, measured for the plan (FR-206 cited a missing entry).
2. 2026-10-14, planning: FR-209 also gives `childCount` to a node whose children were cut off by `limit`, so a partial `children` list is visible as such.
3. 2026-10-14, planning: FR-220 lists one alignment per paragraph. Reason: `paragraphAttRuns` merges paragraphs with equal attributes (R-30), so its runs are not paragraphs.
4. 2026-10-14, analysis: FR-216 gives `kind` only where the type table has one, as FR-209 does; FR-218 leaves out `fill` for nodes without a brush fill, such as layers.
