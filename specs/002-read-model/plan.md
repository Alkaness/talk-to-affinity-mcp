# Slice 002: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. `src/sdk.js` gains a read library, `ttam`, defined at the top of the file before the body. Every script body sees it, so a read tool sends one line, for example `return ttam.getDocument({"depth":2,"limit":500});`. The library requires SDK modules only when a function runs, so scripts that do not use it pay only for parsing it (R-15).
2. `src/tools.ts` registers `get_document`, `get_nodes` and `list_fonts`. A shared `read()` helper runs the line as a read-only script (FR-105 retry rules apply) and maps the two precondition answers, `null` (no document) and `{fail}` (bad spread index), to error results.
3. One walk serves every read: a depth-first pass over all spreads, back to front, that assigns IDs by the claim rule and calls a visitor for every node. It never prunes, because a tag in a skipped subtree could claim an ID before a node that is listed (FR-203). A full pass over 1,000 nodes costs about 51 ms (R-31).
4. `test/fake-affinity.ts` gains `fakeDocument()`, which builds SDK-like documents (nodes, enums, fills, text stories, fonts) for the vm-based fake endpoint and records every property assignment, so unit tests can prove that reads assign nothing.

## 2. Tool contracts

The descriptions of `get_document` and `get_nodes` state the ID rule: IDs without `/` are stable tags, IDs with `/` are positions that change when the tree changes (FR-204).

### 2.1 `get_document`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `spreadIndex` | integer | 0 or more | current spread |
| `depth` | integer | 1 to 20 | 2 |
| `limit` | integer | 1 to 2,000 | 500 |
| `query` | object `{type, name, text}` | `type` from table 3.5 of the spec; `name`, `text` non-empty; all optional | none |

Read-only. Output: JSON text

```
{document: {title, path, dpi, units, width, height, colorFormat, dirty, spreads, currentSpread},
 spread: {index, box, artboards: [{id, name, box}]},
 selection: [id], fonts: [{name, installed}],
 nodes: [node] | matches: [node], omitted?, hint?}
node = {id, type, kind?, name, box, hidden?, locked?, children?: [node], childCount?}
```

Errors: no document open; `spreadIndex` out of range.

### 2.2 `get_nodes`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `ids` | array of strings | 1 to 100 items, each non-empty | required |

Read-only. Output: JSON array, one entry per ID in the given order:

```
{id, type, kind?, name, box, hidden?, locked?, parent, childCount, visibleBox?, rotation?, opacity?, blendMode?,
 fill?, stroke?, text?: {content, runs: [{text, family, style, weight, italic, size, color}], align: [string]},
 effects?: [{type, enabled, opacity, blendMode, radius?, color?, offset?, angle?, intensity?}]}
| {id, error: "not found"}
```

### 2.3 `list_fonts`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `query` | string | case-insensitive substring of the family name | all families |
| `limit` | integer | 1 to 500 | 50 |

Read-only; needs no document. Output: JSON text `{total, matching, families: [{family, styles: [{style, weight, italic}]}]}`.

## 3. SDK script outline

### 3.1 Walk and IDs (FR-202, FR-203)

1. `doc.spreads.toArray()` gives the spreads in order; `node.children.toArray()` gives children back to front (R-20), so the array index is the path segment.
2. For each child: path `<parent path>/<index>`. When `tagInterface.hasKey('ttam-id')` holds and the tag value is not yet in the claimed set, the node claims it and its ID is the tag; otherwise its ID is the path (R-06).
3. The visitor receives the node and `{spread, path, id, parentId, depth, childCount}`; `parentId` is the parent's ID, `null` at spread level.

### 3.2 Node description (FR-213 to FR-215)

1. Class: `String(node).slice(8, -1)` (R-17, R-19). Type: `isArtboardEnabled` first, then `shapeType` for `ShapeNode` (`String()` of the enum value, R-29), then a class table, then the suffixes `AdjustmentRasterNode`, `FilterRasterNode` and `TextNode` (table 3.5).
2. Name: `node.description` (R-19). Box: `spreadBaseBox` rounded to 2 decimals; `null` when `x` is at or below -1e300, the empty-layer sentinel (R-21).
3. `hidden` when `isVisible` is false; `locked` when `isLocked` is true (R-22).

### 3.3 `get_document` (FR-205 to FR-212)

1. `app.documents.current`; `null` when none. Current spread index: position of `currentSpread` among the spreads, matched with `isSameNode` (as in slice 001's `render`).
2. Document fields: `title`, `path` or `null`, `dpi`, `String(units)`, `widthPixels`, `heightPixels`, `String(format)`, `isDirty` (R-29).
3. Spread fields: the index, `spreadBaseBox` of the spread, and the artboards found by the walk (item 5).
4. Fonts: `doc.enumerateFontNames((name, installed) => { ... })` with a block body, because a truthy return ends the enumeration (R-25).
5. One walk. For every node: match it against the pending selection nodes with `isSameNode` and record its ID on a match (R-27, R-31). On the chosen spread only, depth-1 nodes of type `artboard` are recorded as artboards, and:
   - without `query`: a node within `depth` is listed while fewer than `limit` nodes are listed, else counted as omitted; a listed node is attached to its listed parent;
   - with `query`: a node that matches every condition is listed while fewer than `limit` are listed, else counted as omitted.
6. After the walk, a listed node whose listed children are fewer than its children gets `childCount`.
7. `omitted` and `hint` appear only when nodes were omitted.

### 3.4 `get_nodes` (FR-216 to FR-222)

1. One walk. A requested path matches the node at that path; a requested tag matches the node that claims it. Each match builds its entry once.
2. Entry: the node description plus `parent` and `childCount`; `visibleBox` when it differs from `box`; `rotation` = `transform.decompose().rotation` in degrees, rounded to 2 decimals, when not 0 (R-21); `opacity` = `globalOpacity` when not 1; `blendMode` when not `Normal` (R-22, R-29).
3. `fill` when `hasBrushFill` holds and the node is not text (R-22): `fillType` `None` gives `null`, `Solid` gives `#rrggbbaa` from `colour.rgba8`, `Gradient` gives the `GradientFillType` key whose `.value` equals `gradientFillType` and the stops with `new Colour(stop.colour).rgba8` (R-29), any other type gives `{type}`.
4. `stroke` when `hasPenFill` holds: `null` for a `None` pen or `lineWeight` 0, otherwise colour as in item 3, `lineWeight` in pixels, `strokeAlignment`, `lineCap`, `lineJoin`, and `dashPattern` when non-empty (R-22, R-30).
5. `text` for text nodes: content `node.text`; runs from `story.glyphAttRuns` with text `story.getText(begin, end - begin)`, because positions count code points (R-30); family, `traitsName`, `weight`, `isItalic`, size `height * 72 / dpi` rounded to 2 decimals, colour of `brushFill`; adjacent runs with equal fields merge. `align`: for each paragraph run, `String(alignXType)` once per paragraph in the run (paragraph breaks counted in the run text, R-30).
6. `effects` when `layerEffectsInterface.effects` is non-empty: `type`, `enabled`, `opacity`, `blendMode`, and `radius`, `colour`, `offset`, `angle` (degrees), `intensity` where the effect class has them (R-23).
7. IDs never matched become `{id, error: "not found"}`.

### 3.5 `list_fonts` (FR-223)

`FontFamily.all` (R-25): names compared lower-case; matching families sorted by lower-case name; for the first `limit`, `family.fonts` gives `traitsName`, `weight`, `isItalic`.

### 3.6 Read-only guarantee (FR-201)

The library calls getters, `toArray`, `isSameNode`, `getText`, `getValueForKey` and the two font enumerations only; it never executes a command or assigns a property, and never touches the selection (R-26, R-27). The tools run with `readOnly: true`.

## 4. Files touched

| File | Change |
|---|---|
| `src/sdk.js` | `ttam` read library before the body |
| `src/tools.ts` | three tools, `read()` helper, shared no-document message, instructions name the read tools |
| `test/fake-affinity.ts` | `fakeDocument()` with enums, fills, stories, fonts and an assignment log |
| `test/read-model.test.ts` | unit tests FR-201 to FR-223, NFR-202 |
| `test/live.test.ts` | live tests for every P1 requirement, NFR-201, NFR-202 |
| `test/foundation.test.ts` | FR-129 expects seven tools |
| `specs/roadmap.md` | slice status; `get_nodes` input without `detail` |

## 5. Risks

1. Linked text frames: runs come from the whole story, so a frame that shares its story reports the other frames' runs too. Upgrade path: limit runs to the node's story range.
2. Every read walks the whole document: about 51 ms per 1,000 nodes (R-31), so a 20,000-node document adds about 1 s per call. Upgrade path: cache the walk per document history position.
3. Selection matching is quadratic in the worst case: 1,000 selected nodes in a 1,000-node document cost about 500,000 `isSameNode` calls, about 50 ms (R-31).
4. The unit tests run the library against stub objects in Node's vm; the live suite repeats every P1 case on Affinity.
5. Results above 262,144 characters fail with the envelope's size error (FR-112), which asks to narrow the request; 2,000 nodes at about 80 characters each stay below it (R-15).
