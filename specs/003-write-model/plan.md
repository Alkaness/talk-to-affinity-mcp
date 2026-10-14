# Slice 003: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. `src/tools.ts` registers `create_nodes`, `update_nodes`, `delete_nodes` and `undo`. Their zod schemas are strict (unknown keys are rejected) and recursive for layer children; a `superRefine` checks the per-type rules of tables 3.7 and 3.8, the ID pattern, duplicate IDs, the node count and the nesting depth, and parses path data. Invalid input therefore never reaches a script (FR-301).
2. `src/svgpath.ts` parses SVG path data into subpaths of absolute line and cubic segments (FR-310). The tool replaces `d` with these segments before the spec is sent, so the script only draws.
3. `src/sdk.js` gains the write functions `createNodes`, `updateNodes`, `deleteNodes` and `undo` in the `ttam` library, plus pure helpers that the unit tests call directly through `run_script`: `plan`, `nextId`, `matchFont`, `gradientData`, `rotationData`, `boxData`, `paragraphRanges` and `atomic`.
4. Each write function checks its preconditions first (document, IDs, spreads, fonts) and returns `{fail}` without changing anything; then it runs all commands inside `atomic`, which undoes back to the starting history position if anything throws (FR-302, R-41).
5. The SDK glue is verified by the live suite; the unit suite covers the parser, the schemas, the pure helpers and the tool descriptions.

## 2. Tool contracts

### 2.1 `create_nodes`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `nodes` | array of node specs (spec table 3.7) | 1 to 200 at the top, 500 in total, 10 levels | required |
| `parentId` | string | an existing node | top level of the spread |
| `spreadIndex` | integer | 0 or more; ignored with `parentId` | current spread |
| `fontFallback` | boolean | | false |

Output: `{created: [{id, name, children?}], undoSteps, warnings?, spread?}`.

### 2.2 `update_nodes`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `updates` | array of `{id, set?, move?: {parentId?, index?}}` | 1 to 100; `set` fields from spec table 3.8; `set` or `move` required | required |
| `fontFallback` | boolean | | false |

Output: `{updated: [{id, was?}], undoSteps: 1, warnings?, spread?}`.

### 2.3 `delete_nodes`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `ids` | array of strings | 1 to 500 | required |

Output: `{deleted, undoSteps: 1, spread?}`.

### 2.4 `undo`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `steps` | integer | 1 to 100 | 1 |
| `redo` | boolean | | false |

Output: `{done, position, size, undo, redo}` with the next undo and redo descriptions or `null`.

## 3. SDK script outline

### 3.1 Preconditions (FR-304 to FR-306, FR-312, FR-317, FR-323)

1. No document: `null`, mapped to the FR-205 message.
2. One walk (slice 002, now also passing each node's raw tag) collects every tag value in the document and resolves the requested IDs and parents. Unknown IDs, targets on more than one spread, given IDs already used, and text nodes asked to change size fail here.
3. Generated IDs: `nextId(type, used)` returns `<type><n>` with the lowest `n` not in `used`, and adds it (FR-306).
4. Fonts: for every requested family and style, `matchFont` looks the family up in `FontFamily.all` by lower-case name and the style by lower-case `traitsName`; without a style it takes the face of weight 400 that is not italic, else the first face (R-25). A miss returns the 5 families with the smallest edit distance (a name containing the request ranks first), or the family's styles. With `fontFallback` the miss becomes a warning and the family name is passed as is (R-36).

### 3.2 `atomic` (FR-302)

Records `history.position`; on a throw it calls `doc.undo()` until the position is back (R-41) and rethrows with "Nothing was changed: the document was restored to its state before the call."

### 3.3 Spread (FR-305)

When the target spread is not current, the first compound command starts with `createSetCurrentSpread(spread)`; edits then work in the same undo step (R-42). The result reports `spread`.

### 3.4 `create_nodes` (FR-303, FR-308 to FR-316)

1. `plan(nodes)` groups the specs into waves. Wave 1 holds the given specs; the children of a new layer join the same wave when none of them is a layer, otherwise they form a group of the next wave. The number of waves is the number of undo steps (R-32, R-42).
2. Each wave is one compound command. A group's specs are inserted with an explicit target (the parent, or the layer created in an earlier wave, found by its tag) and `InsertionMode.Inside_AtBack`, which appends in front (R-32). Inline children are inserted without a target in `Default` mode, which puts the first child into the selected empty layer and each next one in front of the previous sibling (R-32, R-42).
3. After each insertion (`andSelect` true): `createSetTagValueForKey(null, 'ttam-id', id)`, then `createSetOpacity`, `createSetBlendMode`, the effect commands and `createSetWindingMode`, all with a null selection, which reaches the new node (R-32, R-42).
4. Definitions carry the name (`userDescription`) and the rotation as `transform`: `rotationData(cx, cy, deg)` gives the matrix `(cos, -sin, cx - cos cx + sin cy, sin, cos, cy - sin cx - cos cy)` about the pivot (R-33). Pivots: box centre; art text: `at`; path: centre of `PolyCurve.boundingBox` (R-40).
5. Shapes: `ShapeRectangle`, `ShapeEllipse`, `ShapeStar` (`points`, `innerRadius`), `Shape<kind>` (`sides` for `Polygon`) (R-36, R-43); a rectangle radius sets every corner to `ShapeCornerType.Round` with absolute sizes (R-39). `ShapeNodeDefinition.create(shape, rectangle, brush, pen, lineStyleDescriptor)`.
6. Paths: one `CurveBuilder` per subpath (`beginXY`, `lineToXY`, `addBezierXY`, `close`) into one `PolyCurve`; `PolyCurveNodeDefinition.create(curve, brush, pen, lineStyleDescriptor, none)` (R-28, R-36).
7. Fills: a colour becomes `FillDescriptor.createSolid(SolidFill.create(colour))`; a gradient becomes `FillDescriptor.create(GradientFill.create(Gradient.create(stops), GradientFillType[kind]), true, new Transform(...gradientData(box, kind, angle)))` (R-40); none is `FillDescriptor.createNone()`.
8. Strokes: `LineStyle.createDefaultWithWeight(width)` with the `cap` and `join` setters, and `type = Dash` plus `dashPattern` when dashed; `LineStyleDescriptor.create(style, {strokeAlignment})` (R-37).
9. Text: a `StoryBuilder` set to the art or frame default style; per run a composite glyph delta with `createPostscriptName` of the matched face (or `createFamilyName` under fallback), `createGlyphDouble(Height, size x DPI / 72)` and `createBrushFill`; `\n` becomes `addParagraphBreak`; each paragraph starts with `applyParagraphDelta(createAlignX(...))` (R-30, R-36).
10. Effects: `<Type>LayerEffect.create()` with the given fields (angles in radians), set by `createSet<Type>LayerEffect`, with index 0 for the two shadows (R-34). One effect per type.
11. The result mirrors the specs; names are read from the created nodes (found by tag) after the last wave.

### 3.5 `update_nodes` (FR-317 to FR-322)

One compound command for all entries, each with an explicit selection, which also edits locked nodes (R-42):

1. `name`: `createSetDescription`; `opacity`, `blendMode`, `hidden`, `locked`: `createSetOpacity`, `createSetBlendMode`, `createSetVisibility`, `createSetEditable` (R-33).
2. `box`: `createTransform` with `boxData(current, target)`, a scale about the current corner plus a translation (R-33); text nodes accept a move only (R-38). `rotation`: `createTransform` with `rotationData` for the difference to the current `transform.decompose().rotation`, about the centre of the box after any `box` change (R-21, R-33).
3. `fill`: `createSetBrushFill` with the descriptor of 3.4 item 7, the gradient spanning the node's (new) box. `stroke: null`: `createSetPenFill` with none. A partial stroke: `createSetPenFill` for `color`, one `createSetLineStyle` whose `lineStyleMask` is the numeric OR of `Weight`, `Cap`, `Join`, and `DashPattern` plus `Type` for the fields given, and `createSetStrokeAlignment` for `align` (R-37).
4. `effects`: `createRemoveAllLayerEffects`, then the commands of 3.4 item 10 (R-34).
5. Shape fields: `createSetShape` with a clone of the node's shape changed as asked (R-36, R-39).
6. Text: `createSetText` on a selection with `TextSelection.create(node.storyRange)` replaces the content; `createFormatText` on code-point ranges restyles runs, the whole text, or each paragraph's alignment (`paragraphRanges`) (R-38).
7. `move`: `createMoveNodes(selection, child, Before)` to land at `index` among the parent's other children, `After` the last child without `index`, `Inside` an empty parent (R-35).
8. A node whose ID is a path gets `createSetTagValueForKey(selection, 'ttam-id', nextId(...))`, which also replaces a duplicated tag (R-41).

### 3.6 `delete_nodes` and `undo` (FR-323, FR-324)

1. `createDeleteSelection(Selection.create(doc, nodes, true))`, which drops nodes nested in other deleted nodes from the selection (R-33).
2. `undo` calls `doc.undo()` or `doc.redo()` while `canUndo` or `canRedo` holds, then reads `position`, `size` and, only when available, `undoDescription` and `redoDescription`, which throw otherwise (R-06, R-33).

### 3.7 Read model corrections (FR-325, FR-326)

1. `stroke()` adds `dash` only when `String(node.lineType)` is `Dash` (R-37).
2. `text()` multiplies sizes by `|transform.decompose().scaleY|` (R-38).

## 4. Files touched

| File | Change |
|---|---|
| `src/svgpath.ts` | new: SVG path data parser |
| `src/sdk.js` | write functions and pure helpers; walk passes raw tags; read corrections |
| `src/tools.ts` | four tools, schemas, path parsing, descriptions, instructions |
| `test/write-model.test.ts` | new: unit tests |
| `test/live.test.ts` | slice 003 live tests |
| `test/fake-affinity.ts` | `lineType` and scale on fake nodes |
| `test/foundation.test.ts` | FR-129 expects eleven tools |
| `specs/002-read-model/spec.md` | FR-219 and FR-220 point to FR-325 and FR-326 |
| `specs/roadmap.md` | slice status; node spec types |

## 5. Risks

1. Inline children rely on the selection staying on the newest node after the settings commands; measured for insertions with explicit targets (R-42) and verified for inline children by the live suite.
2. `box` on a rotated node scales its axis-aligned box, which shears the node; the tool description says so.
3. The edit-distance ranking of font suggestions is a heuristic; the full list stays available through `list_fonts`.
4. Redo steps left by a rollback remain in the history until the next change (R-41).
5. Text replacement through `createSetText` with `\n` is expected to create paragraphs; the live suite checks it.
