# Research: measured facts (slice 000)

Measured on 2026-10-14 against Affinity 3.3.1.4940 (`Affinity 3.3.1.4940 Win32 (Oct  6 2026)`), running under Wine through the AppImage `Affinity-Infinity-x86_64.AppImage` on Linux. Client: `@modelcontextprotocol/sdk` 1.32.1 on Node 22.19.0. Probes: `spike/probe.mjs` and `spike/r*.js`. Verbatim tool list: `specs/000-spike/native-tools.json`.

The probes were removed after slice 001 (they remain in commit 84ac2a2). Each entry states the answer, the evidence, and the consequence for the design.

## 1. Endpoint and protocol

### R-01 Listening address

1. Affinity under Wine listens on `127.0.0.1:6767` only (listen backlog 5). `http://[::1]:6767/sse` is refused with `ECONNREFUSED`. `http://localhost:6767/sse` works on this machine because `localhost` maps to `127.0.0.1`.
2. Connecting (SSE stream, endpoint event, `initialize`) takes 510 to 536 ms.
3. Evidence: `node spike/probe.mjs hosts`; `ss -ltnp` shows the socket owned by `wineserver`.
4. Consequence: try `127.0.0.1` first, then `[::1]` (reported for macOS). Order costs nothing because a refused connection fails at once.

### R-02 Server identity and tools

1. `serverInfo` is `{"name":"Affinity","version":"1.0.0"}`; negotiated protocol `2025-11-25`; capabilities `{"tools":{}}`; server instructions: "You MUST read the 'preamble' documentation before using the SDK."
2. Exactly 11 tools, matching the roadmap list: `add_sdk_hint`, `execute_script`, `list_library_scripts`, `list_sdk_documentation`, `read_library_script`, `read_sdk_documentation_topic`, `render_selection`, `render_spread`, `report_sdk_issue`, `save_script_to_library`, `search_sdk_hints`.
3. Settings persist in `%APPDATA%\Affinity\Affinity\3.0\Settings\MCPPreferences.xml` with the keys `EnableMCPServer`, `EnableLocalMemory`, `EnableReadScripts`, `EnableWriteScripts`, `EnableCanvaAI`, `EnableFileSystem`, `EnableNetwork`, `EnableReporting`. Defaults on first run: MCP off, file system off, network off, reporting on.
4. Consequence: the fake upstream in unit tests emulates exactly these 11 tools and schemas.

### R-03 Preamble gate

1. Before the preamble read in a session, `execute_script` returns `isError: true` with "The preamble documentation topic has not yet been read." Documentation reads return `isError: false` with the prefix `ERROR: The preamble documentation topic has not yet been read.` The two error styles differ.
2. A preamble read opens the gate even when the read itself fails with "File not found" (see R-16).
3. After the gate opens, `execute_script` works for the rest of the session.
4. Consequence: the server calls `read_sdk_documentation_topic {filename:"preamble"}` once per session and ignores its result.

### R-11 Session lifetime

1. A session left idle for 300 s still works: the next `execute_script` returns in 9 ms. No server-side idle timeout was observed.
2. Session death was not reproduced in this slice; the community report of HTTP 404 on the message URL after long sessions remains unconfirmed. A restart of Affinity ends every session.
3. The endpoint event carries `/message?session_id=<uuid>`. A POST for an unknown session ID returns HTTP 404, so a request sent on a lost session is refused before any script runs.
4. Consequence: the server keeps one session open and reconnects when a call fails with a closed stream or HTTP 404 (FR-105); a 404 means the request was not delivered, so it is safe to repeat.

### R-12 Concurrent sessions

1. A second SSE session works while a first session is open. Each session has its own preamble gate.
2. Consequence: the server can coexist with MCP Inspector or another client.

## 2. Script execution

### R-04 Output channel

1. Only console output returns, as one text content item. `console.log`, `console.info`, `console.warn` and `console.error` all land in the same text, in order; lines end with `\n`.
2. Unicode round-trips unchanged (`Ünïcødé ✓ 日本語 🎨`).
3. Output time grows faster than linearly with size: 100 KB in 29 ms, 300 KB in 105 ms, 500 KB in 1,301 ms, 1 MB in 4,675 ms. A 5 MB output did not finish within 120 s. 10,000 short lines (48,890 characters) take 30 ms.
4. Consequence: the server caps a result at 256 KB (NFR) and truncates with a marker; tree outputs are paginated.

### R-05 Error shapes

1. A thrown `Error`, a thrown string and a syntax error all return `isError: false`, with the message and a stack as plain text, for example `Error: boom\n    at main:1:7` and `SyntaxError: Unexpected identifier 'is'\n    at main:1:6`.
2. A top-level `return` is accepted silently (the script body runs inside a function named `main`). An empty script returns empty text.
3. A script that runs 65 s completes and returns normally; the endpoint applies no timeout of its own up to that length. Affinity stays responsive afterwards.
4. `eval` and `new Function` throw `EvalError: Code generation from strings disallowed for this context` (setting `AllowCodeGenerationFromStrings` is off by default).
5. `setTimeout` is not a global; it lives in `require('/timers.js')`.
6. A denied file operation throws `Error: PERMISSION_DENIED` (see R-09).
7. `console.log` and the other console methods are own, writable properties: a script can replace them to capture output and restore them afterwards.
8. `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on BigInt values.
9. Consequence: errors are detected only through the server's own envelope. The envelope is added textually around the code (no `eval`). Output without an envelope line is reported as an error together with the raw text. The envelope captures console output into `logs` and serializes results with a replacer that handles BigInt values, cycles and SDK objects.

### R-15 Size and speed

1. Script input size is not a constraint: 50 KB runs in 11 ms, 500 KB in 13 ms, 3 MB in 83 ms.
2. One `AddChildNodesCommandBuilder` with 1,000 rectangles executes in 44 ms as 1 undo step.
3. A recursive walk of 1,000 nodes that reads type, description, box and visibility takes 92 ms and serializes to 78,506 characters (about 79 characters per node).
4. Consequence: injecting a prelude of several KB into every script is free. A default tree limit of 500 nodes keeps output near 40 KB.

## 3. Document model

### R-06 Tags, undo steps and duplicates

1. `DocumentCommand.createSetTagValueForKey(selection, 'ttam-id', value)` stores a tag; `node.tagInterface.hasKey` and `getValueForKey` read it back. Alone, it is one undo step named "Set Metadata" and marks the document dirty.
2. A `CompoundCommandBuilder` holding an `AddChildNodesCommandBuilder` command (`andSelect = true`) followed by `createSetTagValueForKey(null, ...)` executes as exactly 1 undo step, and the tag lands on the new node. The null selection resolves to the selection left by the insertion.
3. `node.duplicate()` copies the tag: after duplicating a node tagged `A1`, two nodes carry `A1`.
4. One `doc.undo()` reverts exactly the last step.
5. `doc.history.position` and `doc.history.size` count steps. `doc.history.undoDescription` throws `INVALID_OP` when nothing can be undone.
6. Consequence: write tools tag new nodes inside the same compound command (one undo step, FR-301). Read tools must handle duplicate tags (first in document order keeps the ID).

### R-07 Atomicity

1. A script that executes a command and then throws leaves the change in place: history position 1, the node present, the document dirty.
2. Consequence: the server records `doc.history.position` before a mutation and undoes back to it when the script fails (FR-303).

### R-13 Document lifecycle

1. `Document.create(options)` creates a document and makes it current. `doc.saveAs(path)`, `doc.close()` and `Document.load(path)` work; a loaded document becomes current.
2. Each load gives the document a new `sessionUuid`; render calls therefore look the UUID up fresh.
3. Assigning `Document.current` has no effect. No script API switches the current document.
4. The primary file extension is `af` (`app.productPrimaryFileExtension`).
5. Under Wine, closing a saved document leaves a file named `<name>.af~lock~:com.dropbox.ignored` beside it (an alternate data stream that Wine turns into a file name).
6. Closing one document from a list obtained earlier through `app.documents.all` invalidated the other entries of that list in the same script; querying `app.documents.all` again after each close works.
7. Consequence: tools target the current document; `manage_document` reports the current document after every action and re-queries the document list after a close; the staging cleanup also removes `~lock~` leftovers.

### R-14 Units

1. Node geometry is in document pixels whatever the document unit. In a millimetre document at 300 DPI (2,480.31 x 3,507.87 px), `Rectangle(0, 0, 100, 100)` produces a box of 100 x 100 px, not 100 mm.
2. In a pixel document at 72 DPI, `Rectangle(10, 20, 100, 50)` produces the box `{x: 10, y: 20, width: 100, height: 50}`.
3. `UnitType` keys include `Pixel`, `Point`, `Millimetre`, `Centimetre`, `Inch`, `Pica`.
4. Consequence: the roadmap rule holds; all tool geometry is in document pixels.

### R-17 Insertion and selection

1. `AddChildNodesCommandBuilder.createCommand(andSelect, childListType)`: with `andSelect = false` the new node is not selected; with `true` it is the selection afterwards.
2. Iterating `spread.children` yields nodes in insertion order (the first inserted node first).
3. `String(node)` gives the class tag, for example `[object ShapeNode]`; `node.description` gives the default name, for example `Rectangle`.
4. Consequence: builders always pass `andSelect = true` and read new nodes from the selection.

## 4. Rendering, files and fonts

### R-08 Rendering

1. `render_spread` returns MCP image content, `image/jpeg`, longest side 1,024 px: an A4 document rendered at 724 x 1,024 px, 9,160 bytes, in 23 ms. `render_selection` works the same way (27 ms).
2. Consequence: `render` forwards the image content unchanged.

### R-09 Desktop sandbox and export

1. `app.userDesktopPath` is `C:\users\eugen\Desktop`; `Environment.fileSystemRoots` is the same single folder; `Environment.permissions` is `{fileSystem: true, network: false, genAI: false}` with the settings used.
2. In the Wine prefix, `drive_c/users/eugen/Desktop` is a symbolic link to `/home/eugen/Desktop`, so files written by scripts appear on the host immediately.
3. Writing at the Desktop root and in a normal subfolder works, with backslashes or forward slashes. A folder whose name starts with a dot (`.talk-to-affinity`) fails with `PERMISSION_DENIED`, for creating the folder, writing a file and exporting into it.
4. `doc.export(path, FileExportOptions.createWithPresetName('PNG'), FileExportArea.createForCurrentSpread())` without a size writes the spread at full document resolution (2,481 x 3,508 px for an A4 document at 300 DPI).
5. 64 export preset names exist, including `PNG`, `JPEG (Best quality)`, `SVG (for export)`, `PDF (for print)`, `PDF (digital - high quality)`, `TIFF RGB 8-bit`, `WebP (Lossless, default)` and `PSD (preserve editability)`.
6. Consequence: staging uses a visible folder `<Desktop>/talk-to-affinity/` (not a dot folder), removes it when empty, and maps the Windows path to the host with the probe file method.

### R-10 Fonts

1. Under Wine, `FontFamily.all` lists 268 families and `Font.all` 590 faces (system fonts such as DejaVu, Free and Droid families, plus Arial, Georgia, Courier New and other core fonts).
2. `FontWeight` keys: `Thin`, `ExtraLight`, `Light`, `Normal`, `Medium`, `SemiBold`, `Bold`, `ExtraBold`, `Black`.
3. `Font.create` with an unknown family throws `INVALID_ARGS`.
4. Consequence: FR-305 can detect missing fonts by that error and suggest installed families.

## 5. Facts outside the original questions

### R-16 SDK documentation source

1. The documentation topics are not installed with Affinity. They are fetched at request time into `%APPDATA%\Affinity\Affinity\3.0\temp\AffinityDownloadCache\` (observed files: the topic list, the 3,798-character preamble, and `nodes.js` at 299,890 bytes).
2. Reads are unreliable under Wine: in 2 of 9 sessions the preamble read returned 3,798 characters; in the other 7, and in every later session, `read_sdk_documentation_topic` returned `isError: true` "File not found" and `list_sdk_documentation` returned `isError: true` "Listing failed.".
3. The native topic list has 143 entries. The SDK module sources ship with Affinity in `Resources\JSLib\` (69 entries, including `examples` and `tests`), the module root for `require`; only `preamble` and the three range files (`param_ranges.min.json`, `struct_ranges.min.json`, `struct_array_sizes.min.json`) exist solely in the download. Each fetch writes the topic to a new file name in the cache.
4. Two `Affinity.exe` processes were running during these measurements (started 16:01:56 and 16:14:02). The second start rewrote the download cache index. The flaky reads may come from that; it is not confirmed.
5. The `JSLib` sources carry a BSD 3-Clause license, copyright Canva Pty Ltd. SDK objects derive from `HandleObject`, which keeps its native handle in a private field, so they have no own enumerable properties.
6. Consequence: `sdk_docs` uses the native topics when they load and falls back to the local `JSLib` folder when they fail. The server never depends on documentation for its own tools.

### R-18 Client-side connection leak

1. When the first SSE connection fails, the SDK's `SSEClientTransport` keeps its EventSource retrying, which keeps the Node process alive indefinitely.
2. Consequence: on any failed connect the server closes the transport explicitly (slice 001 requirement).

## 6. Slice 002 facts (2026-10-14, same build)

Measured with a fixture document (shapes, a path, two text nodes, a nested layer, hidden, locked, rotated, half-opacity and shadowed nodes) and probes run through the server's own `Upstream`. The probe scripts were not kept; the snippets below are the evidence.

### R-19 Node classes and names

1. `String(node)` gives the class: `ShapeNode`, `PolyCurveNode`, `ArtTextNode`, `FrameTextNode`, `ContainerNode`, `GroupNode`, `ImageNode`, `RasterNode`, 49 adjustment and live-filter classes ending in `AdjustmentRasterNode` or `FilterRasterNode`, `SpreadNode`, `MeasurementNode`, `EmbeddedDocumentNode`, and the text variants `CurvePathTextNode`, `PolyCurveTextNode`, `ShapePathTextNode`, `TableTextNode`, `ShapeTextNode`.
2. `node.shapeType` names the shape (`Rectangle`, `Ellipse`, `Star`, ...).
3. `node.description` is the user name when set (`userDescription`), otherwise the default name: `Rectangle`, `Ellipse`, `Circle` (an ellipse with equal sides), `Star`, `Poly Line`, `Layer`, or the text content cut at 25 characters.
4. An artboard is a top-level `ShapeNode` with `isArtboardEnabled` true; `spread.artboards` yields `ArtboardInterface` objects whose `.node` is that shape. Adding artboards resized the document to their union (1,000 x 600 px became 800 x 300 px).

### R-20 Child order

1. `children` iterates from back to front: of two overlapping rectangles inserted in one builder, the second covers the first in the render.

### R-21 Geometry

1. `spreadBaseBox` is the geometric box; `spreadVisibleBox` includes the stroke (a 120 x 80 ellipse with a 4 px centred stroke: base 120 x 80, visible 124 x 84).
2. `node.transform.decompose()` returns `rotation` (radians), `scaleX`, `scaleY`, `shear`, `translateX`, `translateY`. A rotated node reports its axis-aligned bounding box.
3. `doc.applyTransform(Transform.createRotate(a), selection)` rotates about the spread origin, not the node centre.
4. A layer whose only child is hidden reports the box `{x: -1.7976931348623157e+308, y: -1.7976931348623157e+308, width: 0, height: 0}`.

### R-22 Fill and stroke

1. `brushFillDescriptor.fill` is `SolidFill` (`colour.rgba8`), `GradientFill` or `NoFill`; `fillType` inspects as `Solid`, `Gradient`, `None`.
2. Gradient stops (`fill.gradient.stops`) carry `position`, `midpoint` and a raw colour handle that `new Colour(handle)` wraps. `gradientFillType` inspects as a number (0 for linear).
3. `penFillDescriptor`, `lineWeight` (pixels), `lineWeightPts`, `strokeAlignment` (`Centre`), `lineCap` (`Butt`), `lineJoin` (`Round`), `dashPattern` describe the stroke. Shapes without a stroke have a `NoFill` pen and weight 0.
4. Text nodes report `hasBrushFill` false; their colour lives in the text runs (R-24).
5. `globalOpacity` (0.5 after `doc.setOpacity(0.5, ...)`), `blendMode` (`Multiply`), `isVisible`, `isLocked` read back as set.
6. Enum values print their names through `require('/inspect.js').inspect(value)`.

### R-23 Layer effects

1. `node.layerEffectsInterface.effects` lists typed effects. An enabled outer shadow read back as type `OuterShadow`, `enabled` true, `opacity` 0.5, `blendMode` `Multiply`, `radius` 0, colour black, `offset` 0, `angle` 0.785 rad, `intensity` 0.

### R-24 Text

1. `node.text` is the content. `node.story.glyphAttRuns` yields `{glyphAtts, begin, end}`; `glyphAtts.font` gives `familyName`, `traitsName`, `weight` (number), `isItalic`; `glyphAtts.height` is the size in document pixels (36 at 72 DPI for a 36 pt request); `glyphAtts.brushFill` is the colour. `story.paragraphAttRuns` gives `alignXType` (`Left`).
2. A requested face that does not exist falls back silently: `DejaVu Serif` italic was requested, the family has only `Book` and `Bold`, and the run reports `Book`, not italic.
3. `TextFrameInterface` has no overflow getter.

### R-25 Fonts

1. `FontFamily.all` lists 268 families; `family.fonts` gives each face's `traitsName`, `weight`, `isItalic`, `width` and `postscriptName` (Arial: Regular 400, Italic 400, Bold 700, Bold Italic 700).
2. `doc.enumerateFontNames((name, installed) => { ... })` lists the PostScript names the document uses with an installed flag. A callback that returns a truthy value ended the enumeration after the first name; a callback with a block body listed all three.

### R-26 Reads do not mutate

1. Reading every property above for 15 nodes, the font lists and the selection left `history.position`, `history.size` and `isDirty` unchanged (35, 35, true before and after).

### R-27 Selection

1. `doc.selection.nodes` lists the selected nodes; the last inserted node stays selected after a builder command with `andSelect` true.
2. `DocumentCommand.createSetSelection(Selection.create(doc, nodes))` adds one undo step per change and marks the document dirty.
3. Consequence: read tools never change the selection; rendering chosen nodes needs an export area built from a `Selection` object (slice 004).

### R-28 Facts for the write model (slice 003)

1. No script API creates a `GroupNode`: `GroupNodeDefinition` has no constructor method and no command groups nodes. `ContainerNodeDefinition.create(name)` creates layers.
2. `PolyCurveNodeDefinition.create(curve, brushFill, lineFill, lineStyle, transparencyFill)` needs explicit `FillDescriptor` and `LineStyleDescriptor` arguments; `ShapeNodeDefinition.create` wraps a `Colour` but needs a `LineStyleDescriptor` (not a `LineStyle`) for the stroke. `CurveBuilder` uses `beginXY`, `lineToXY`, `addBezier`, `close`.
3. A gradient fill built with an identity transform renders as its end colour; gradients need a transform that spans the shape.

### R-29 Document properties and enum names

1. `doc.title` (`<Untitled>` for a new document), `doc.path` (empty until saved), `doc.dpi`, `doc.units`, `doc.widthPixels`, `doc.heightPixels`, `doc.format` and `doc.isDirty` describe the document; a new 800 x 600 px document at 72 DPI read back as units `Pixel`, format `RGBA8`.
2. SDK enum values carry an `isEnumValue` marker and stringify to their key name (`inspect.js`, `tryFormatEnumValue`): `String(node.blendMode)` is `Normal`, `String(node.shapeType)` is `Rectangle`, `String(doc.units)` is `Pixel`.
3. `fill.gradientFillType` is a plain number, not an enum value: 2 for a radial gradient. The enum `GradientFillType` from `/fills.js` has the keys `Linear` (`.value` 0), `Radial` (2), `Elliptical` and `Conical`, so the name is found by matching `.value`.

### R-30 Units and text positions

Measured in a 400 x 300 px document at 144 DPI.

1. A stroke created with weight 4 reads `lineWeight` 4 and `lineWeightPts` 2: `lineWeight` is in document pixels.
2. Artistic text in the default style (12 pt) reads `glyphAtts.height` 24: text height is in document pixels, so points = height x 72 / DPI.
3. Story positions count code points, not UTF-16 units: the text `A🎨Bé` has JavaScript length 5 and story length 4. `story.getText(begin, length)` returns the exact text of a run. The emoji formed its own run, because it is drawn with a fallback font.
4. A paragraph break appears as `\n` in `node.text`. `story.paragraphAttRuns` merges consecutive paragraphs with identical attributes: two left-aligned paragraphs form one run.
5. `node.dashPattern` is an array: `[]` without dashes, `[3, 1]` after `doc.setDashPattern([3, 1], ...)`.
6. A top-level node's `parent` is the `SpreadNode`; a spread's `parent` is the `DocumentNode`. `previousSibling` moves towards the back (index 0).

### R-31 Cost of a full read

Measured in a document with 1,000 rectangles on one spread, all selected.

1. A walk over every node that checks `tagInterface.hasKey` takes 51 ms.
2. `doc.selection.nodes.toArray()` returns the 1,000 nodes in 4 ms, in document order for this document.
3. 10,000 `isSameNode` calls take 1 ms. `node.handle` is a new `ShapeNodeHandle` object on every access, so node identity needs `isSameNode`.
4. Reading class, description, base box, visibility, lock, shape type, artboard flag and child count for 500 nodes takes 58 ms.
5. Consequence: a read tool can walk the whole document once per call (tags, selection, output) and still meet NFR-201.

## 7. Slice 003 facts (2026-10-14, same build)

Measured with probe scripts run through the server's own `Upstream`; each probe created its own documents and closed them.

### R-32 Insertion inside one compound command

1. `InsertionMode` keys: `Default` 0, `Inside_AtBack` 1, `Inside_AtFront` 2, `Behind` 3, `Top` 4.
2. With an explicit insertion target, `Default` and `Inside_AtBack` append at the end of the target's children (the front of the z-order), `Inside_AtFront` inserts at index 0 (the back), and `Behind` and `Top` fail with `INVALID_ARGS`.
3. Without a target, insertion is relative to the current selection: a selected empty layer receives the node inside it; a selected shape gets the node as the sibling above it (`Default`, `Top`) or below it (`Behind`); `Inside_AtFront` and `Inside_AtBack` put it inside the selected node even when that is a shape.
4. One `CompoundCommandBuilder` holding `[AddChildNodes(andSelect = true), SetTagValueForKey(null, ...)]` pairs for several nodes executes as 1 undo step, and each tag lands on its own node. This also holds for a new layer followed by children inserted relative to the selection.
5. A node created earlier in the same compound command can be reached only through the selection, and the selection cannot return to an intermediate created level. A created tree with branching below its second level therefore needs more than one command.
6. `NodeDefinition` has `userDescription` and `transform`, so names and rotations can be set before insertion.

### R-33 Updates, transforms, deletion and history

1. One compound command holding brush fill, pen fill, opacity, blend mode, description, visibility, `createSetEditable(false)` (locks), transform and tag commands for three nodes executes as 1 undo step; each change reads back as set (opacity 0.4 reads 0.4000000059604645).
2. `createSetLineStyle` with a `LineStyle` of weight 3, cap `Round`, join `Bevel` and dash `[4, 2]` did not change the stroke, with or without `lineStyleMask: LineStyleMask.All` (262143); `createSetStrokeAlignment` did. Resolved in R-37.
3. `TransformBuilder` applies operations in call order: `translateXY(-cx, -cy).rotate(a).translateXY(cx, cy)` rotates about `(cx, cy)`; a rectangle centred at (150, 120) kept its centre after a 30-degree rotation, also when the transform was set on the definition before insertion. A scale transform resized a box exactly to `[20, 30, 200, 25]`, kept the stroke weight of 4 px and left scale (2, 0.5) in the node transform.
4. `createDeleteSelection` is 1 undo step named "Delete"; `doc.undo()` and `doc.redo()` move through the history; after a redo `canRedo` is false and `redoDescription` is "Unknown".

### R-34 Layer effects

1. `OuterShadowLayerEffect`, `InnerShadowLayerEffect`, `OuterGlowLayerEffect` and `GaussianBlurLayerEffect` objects from `create()`, set through the matching `createSet...LayerEffect` commands (with index 0 where the command takes one) in one compound command: 1 undo step. They read back in the fixed order inner shadow, outer glow, outer shadow, Gaussian blur, with the values set. Defaults: inner shadow opacity 0.5, black, angle 45 degrees; outer glow white, intensity 0.5.
2. `createRemoveAllLayerEffects` is 1 undo step.

### R-35 Order and spreads

1. `NodeMoveType`: `Before` 0, `After` 1, `Inside` 2. `createMoveNodes(selection, target, After)` moved a node in front of the target; `Inside` moved it into a layer.
2. `NewDocumentOptions` with `isMultiPage` true, `isFacing` false and `pageCount` 2 creates 2 spreads; `pageCount` alone gave 1.
3. `createSetCurrentSpread` is an undoable command (1 step). Adding a node to a non-current spread through an explicit target works without switching (1 step; the current spread stays).

### R-36 Text, shapes and paths

1. A family unknown to `StoryDelta.createFamilyName` stays as the run's `familyName`, with `traitsName` empty, and is drawn with a fallback. `StoryDelta.createPostscriptName('Georgia-Bold')` selects the exact face (family Georgia, style Bold).
2. `StoryBuilder.applyParagraphDelta(StoryDelta.createAlignX(...))` sets the alignment per paragraph; `ParagraphAlignXType` keys: `Left`, `Centre`, `Right`, `JustifyLeft`, `JustifyCentre`, `JustifyRight`, `JustifyAll`, `TowardsSpine`, `AwayFromSpine`. `createFormatText(selection, delta)` restyles the whole text in 1 step.
3. `createSetText(selection, text)` appended the text instead of replacing it. The SDK examples select a text range with `selection.addSubSelectionForNode(node, TextSelection.create(node.storyRange))`; confirmed in R-38.
4. `ShapeStar` `points` and `innerRadius` (a ratio, default 0.382) and `ShapePolygon` `sides` apply at creation; `createSetShape` changes them in 1 step. Rectangle corners set with `corner.setRadius(10, width, height)` stayed at radius 0 in both `absoluteSizes` modes; the corner type has to be set too (R-39).
5. A `PolyCurve` takes several curves (subpaths); `CurveBuilder` offers `beginXY`, `lineToXY`, `addBezierXY` and `close`; an open curve with only a pen fill works. `WindingOrder`: `OddEven` 0, `NonZero` 1; `createSetWindingMode` is 1 undo step.

### R-37 Stroke updates and line types

1. `createSetLineStyle` applies the fields named by `lineStyleMask` when the mask is one `LineStyleMask` value (`Weight`) or a numeric OR of values (`Weight` 256, `Cap` 8, `Join` 16, `DashPattern` 64, `Type` 1): weight 3, cap Round, join Bevel and dash [4, 2] all applied. `LineStyleMask.All` (262143) and `createSetLineStyleDescriptor` with `All` changed nothing. One compound command with one masked command per field also applies all fields, as 1 undo step.
2. `LineType`: `None` 0, `Solid` 1, `Dash` 2, `Texture` 3. A dash pattern draws dashes only with type `Dash` (rendered): pattern [4, 2] on a `Solid` line drew a solid line. Dash lengths scale with the stroke width: pattern [4, 2] at width 4 drew dashes about 16 px long with gaps of about 8 px.
3. `LineStyle.create(options)` defaults to cap Round, join Round and dash pattern [1, 1] on a `Solid` line. `LineStyle.createDefaultWithWeight(w)` has an empty pattern, cap Butt and join Round, and its `cap`, `join`, `type` and `dashPattern` setters take effect when the style is used at creation. `LineStyleDescriptor.create(lineStyle, {strokeAlignment})` sets the alignment (`Inside`, `Centre`, `Outside`). `LineCap`: `Butt`, `Round`, `Square`; `LineJoin`: `Miter`, `Round`, `Bevel`, `MiterLegacy`.

### R-38 Text editing

1. `createSetText(selection, text)` replaces the whole text when the selection carries a `TextSelection` over `node.storyRange`; 1 undo step. Without that sub-selection it appends.
2. One compound command holding that replacement and then `createFormatText` commands on `TextSelection.create([{begin, end}])` ranges, counted in code points, restyled each range as given (Arial Bold 40 px, Georgia Regular 16 px): 1 undo step.
3. A transform that scales a text node by 2 doubles its box and leaves `glyphAtts.height` unchanged; the node transform then carries scale 2. Frame text behaves the same way, and no API was found that resizes a text frame without scaling its text (`TextFrameInterface` exposes `hasScaledText` and `textRenderScale` only).
4. Consequence: the size drawn is `height x 72 / DPI x` the node's vertical scale.

### R-39 Rectangle corners

1. `ShapeCornerType`: `Round` 0, `Straight` 1, `RoundInverse` 2, `Cutout` 3, `None` 4. With every corner's `cornerType` set to `Round` and `setAbsoluteSizes(true, w, h)`, `corner.setRadius(10, w, h)` gives a 10 px radius at creation; with absolute sizes off the radius is relative and read back as 0.5. Without the corner type the radius stays 0.

### R-40 Gradient fill transforms

Rendered with `render_spread` and inspected.

1. A gradient's transform maps its unit space onto the spread. A linear gradient runs from unit x = 0 (first stop) to x = 1 (last stop): with `new Transform(w, 0, x, 0, h, y)` it runs left to right across the box.
2. Radial and elliptical gradients are centred at the unit origin with radius 1: `new Transform(w / 2, 0, x + w / 2, 0, h / 2, y + h / 2)` centres an ellipse in the box that reaches its sides.
3. For a page angle `a` (0 degrees left to right, 90 degrees top to bottom), the transform `(L cos a, -L sin a, cx - L/2 cos a, L sin a, L cos a, cy - L/2 sin a)` with `L = |w cos a| + |h sin a|` and box centre `(cx, cy)` runs the gradient through the centre across the whole box; checked at 0, 45, 90 and 180 degrees.
4. `PolyCurve.boundingBox` gives exact curve bounds: a cubic from (0, 0) to (100, 0) with control points at y = 100 spans y 0 to 75.

### R-41 Failures, tags and size

1. After a script executed two commands and then threw, undoing back to the recorded history position restored the document tree. The undone steps remain as redo steps (`canRedo` true, history size unchanged).
2. Setting the `ttam-id` tag on a tagged node replaces its value.
3. 300 nodes, each inserted with an explicit target and tagged, in one compound command: 43 ms and 1 undo step.

### R-42 Selection-relative settings, locked nodes and spreads

1. Inside a compound command, `createSetOpacity`, `createSetBlendMode`, `createSet...LayerEffect`, `createSetWindingMode`, `createSetVisibility` and `createSetEditable` with a null selection apply to the node just inserted with `andSelect` true; a following insertion with an explicit target is not affected.
2. `createSetEditable(false)` deselects the node: a later null-selection `createSetVisibility` in the same compound did not reach it. Hiding first and locking second applied both.
3. With a new empty layer selected, the next relative insertion goes inside it in every mode (`Default`, `Top`, `Behind`). Default insertion after a selected shape, text or path node adds the next node as its sibling in front.
4. Commands with explicit selections edit locked nodes: fill, transform, name, visibility and deletion all applied.
5. Editing a node on a spread that is not current fails with `COMMAND_FAILED`; inserting into it works (R-35). A compound command that starts with `createSetCurrentSpread(spread)` and then edits or deletes the node executes as 1 undo step and leaves that spread current.

### R-43 Names and text placement

1. Shape type names equal the class name without `Shape`: `Arrow`, `CalloutEllipse`, `CalloutRectangle`, `Cat`, `Cat2`, `Cat3`, `Cat4`, `Cloud`, `Cog`, `Crescent`, `Diamond`, `DoubleStar`, `Ellipse`, `Heart`, `Pie`, `Polygon`, `QRCode`, `Rectangle`, `Segment`, `Spiral`, `SquareStar`, `Star`, `Tear`, `Trapezoid`, `Triangle`.
2. `BlendMode` has 33 keys: `Normal`, `Darken`, `Multiply`, `ColourBurn`, `LinearBurn`, `DarkerColour`, `Lighten`, `Screen`, `ColourDodge`, `Add`, `LighterColour`, `Overlay`, `SoftLight`, `HardLight`, `VividLight`, `LinearLight`, `PinLight`, `HardMix`, `Difference`, `Exclusion`, `Subtract`, `Divide`, `Hue`, `Saturation`, `Colour`, `Luminosity`, `Average`, `Negation`, `Reflect`, `Glow`, `ContrastInvert`, `Erase`, `Pigment`.
3. Art text created at `{x, y}` starts its first baseline there: the slice 002 fixture placed "Hello World" at (20, 200) and its glyph box ends at y 200.42; text with a descender placed at y 100 ends at 104.33.

### R-44 Unfilled shapes

1. A shape created with `FillDescriptor.createNone()` as its brush reports `hasBrushFill` false; `hasPenFill` stays true without a stroke (weight 0).
2. A probe that read `brushFillDescriptor` of such a node lost its connection, and Affinity had to be restarted; the same probe without that read ran normally. The library reads a descriptor only when the matching `has...Fill` holds. Corrected by R-46: the read itself is harmless; the probe had closed its document in the same script.
3. Consequence: whether a fill applies is decided by the node type, not by `hasBrushFill`.

### R-45 History items

1. `history.getItem(i).description` is the description of step `i`, counted from 0: at position `p` the next undo is item `p - 1` and the next redo is item `p`. After an undo, a description can lose its detail ("Delete b" became "Delete").
2. `undoDescription` and `redoDescription` throw `INVALID_OP` at position 0, even while `canRedo` holds.

## 8. Slice 004 facts (2026-10-14, same build)

Measured with probe scripts run through the server's own `Upstream`. Each probe created its own documents and closed them in a separate script (R-46). Test images were made with ImageMagick: 300 x 200 px in PNG, JPEG, WebP, TIFF, GIF, a PNG with transparency, an SVG, and a text file named `bad.png`.

### R-46 Closing a document in the script that changed its selection

1. A script that changed the selection of a document (with `createSetSelection`, or by inserting nodes with `andSelect` true) and then closed that document crashed Affinity with exit code -1073741819 (access violation). The stack ends in `LayerView.OnNewSelectionNotification` and `LayersDataSourceItem.EnsureVisible`: the layers panel handles the selection notification after the script has returned, when the document is gone. The crash depends on timing; several earlier probes that inserted nodes and closed their document in one script ran normally.
2. Retested in separate scripts (create, read, close): reading `brushFillDescriptor` of an unfilled shape returns a `FillDescriptor` whose fill is a `NoFill`, without a crash. The crash recorded in R-44 came from the close in the same script.
3. Consequence: the server closes a document in a script that changes nothing else, and probes and live tests close their documents in a separate call.

### R-47 Export size

1. The fourth argument of `doc.export(path, options, area, size)` takes a `Size` from `/geometry.js`, a plain `{width, height}` object, `null` or `undefined`. A number throws "expected Size or null"; `ExportScale` and `ExportSize` objects, with or without `.handle`, throw `INVALID_OP`; a height of 0 throws `INVALID_OP`.
2. Raster formats are written at exactly that size and stretched when its aspect ratio differs from the area: a 400 x 300 px spread exported at 800 x 800 px drew its circle as an ellipse. Without a size, the area is written at one image pixel per document pixel, at any DPI (R-09).
3. PDF and SVG ignore the size: with 800 x 600 px, a 400 x 300 px spread gave a PDF page of 400 x 300 pt and an SVG `viewBox` of 400 x 300.
4. Speed: a 400 x 300 px spread at 4,000 x 3,000 px PNG took 548 ms; a spread of 202 nodes at 1,448 x 2,048 px took 154 ms as PNG and 144 ms as JPEG.

### R-48 Export areas

1. `FileExportArea.createForCurrentSpread()` writes one file under the given name, covering the page: a node reaching beyond the page is cut off.
2. `createForSpreads('1')` counts spreads from 1 (`'0'` throws `INVALID_ARGS`) and appends `_1` to the file name. `createForWholeDocument()` writes one file per spread (`name_1.png`, `name_2.png`) for PNG, SVG and PSD, and one file with all pages for PDF.
3. `createForSelection(selection)` and `createForSelectionArea(selection)` use the document's current selection whatever `Selection` object they get: a selection constructed for node b exported node a, which was selected. With an empty selection both throw `INVALID_OP`.
4. `createForSelection` draws only the selected nodes, hidden ones included, over a transparent background. Its area is the union of the nodes' visible boxes (`spreadVisibleBox`, which includes strokes, shadows and blur), widened to whole pixels: a rectangle with the visible box x 40.61 to 180.61, y 40.61 to 140.61 gave 141 x 101 px. Children of a layer, a layer, and nodes on a spread that is not current export the same way. `createForSelectionArea` draws everything inside that area.
5. JPEG places transparent areas on white. A document created with `isTransparentBackground` true exports PNG with an alpha channel; other documents export an opaque white background.

### R-49 Preview selection

1. `doc.executeCommand(DocumentCommand.createSetSelection(selection), true)`, the preview form, changes `doc.selection` without a history step and without touching the dirty flag, also on a saved, clean document.
2. The next export uses that selection and ends the preview: afterwards `doc.selection` is again the selection from before the preview (checked with a selected node and with an empty selection), and history position and size are unchanged. A second export in the same script therefore sees the original selection.
3. A preview replaces the previous one: a preview spread switch followed by a preview selection left the spread as before. After the preview, ordinary commands and `undo` behave normally (1 step for an insertion, undo back).
4. Consequence: `render` and `export` select chosen nodes by preview and export once, leaving history, dirty flag and selection as they were.

### R-50 Formats and presets

1. `FileExportOptions.allPresetNames` lists 64 names: `PNG`, `PNG-8 (dithered)`, 4 `PNG-HDR` variants, `JPEG (Best quality)`, `JPEG (High quality)`, `JPEG (Medium quality)`, `JPEG (Low quality)`, `GIF RGB`, `GIF Grayscale`, 6 `TIFF` variants including `TIFF RGB 8-bit`, 4 `SVG` variants including `SVG (for export)`, 4 `EPS` variants including `EPS (for export)`, `PDF (for print)`, `PDF (press ready)`, `PDF (digital - small size)`, `PDF (digital - high quality)`, `PDF (for export)`, `PDF (flatten)`, `PDF/X-1a:2003`, `PDF/X-3:2003`, `PDF/X-4`, 4 `EPUB` variants, 2 `DWG` and 2 `DXF` variants, 3 `PSD` variants including `PSD (preserve editability)`, 2 `OpenEXR` variants, `Radiance HDR 32-bit linear`, `TGA`, `Enhanced Windows Metafile`, `Windows Metafile`, `Canva Design`, 7 `WebP` variants including `WebP (Lossless, default)`, and 4 `JPEG XL` variants.
2. The preset decides the format; the file name is used as given: preset `PNG` written to `x.jpg` holds PNG data, and a name without an extension gets none.
3. `FileExportOptions.createWithPresetName` with an unknown name throws `ERROR`.
4. A 400 x 300 px spread exported in 16 to 177 ms as PNG, JPEG, SVG, PDF, TIFF, WebP, PSD, GIF and EPS.

### R-51 Desktop sandbox for files

1. Export, `saveAs`, `Document.load` and `Bitmap.loadFromFile` outside the Desktop (`C:\users\eugen\Documents`, `Z:\tmp`) throw `PERMISSION_DENIED`, as does a dot folder or a file name starting with a dot inside the Desktop. In the Wine prefix, `drive_c/users/eugen/Documents` links to `/home/eugen/Documents` just as the Desktop links to `/home/eugen/Desktop`; the sandbox still refuses it.
2. Inside the Desktop, spaces, non-ASCII characters (`p5 space ü.png`) and forward slashes work. Export creates missing folders; `File.create(path, 'w')` in a missing folder throws `NO_SUCH_FILE_OR_DIRECTORY`; `FileSystemApi.createDirectories` and `FileSystemApi.exists` work.
3. `Document.load` of a missing file, or of a file that is not an image or document, throws `PERMISSION_DENIED` as well.

### R-52 Saving and loading

1. A new document has `mustSaveAs` true; `save()` on it throws `SAVE_TO_TEMPORARY_ARCHIVE_ERROR`.
2. `saveAs(path)` and `save()` return nothing, clear the dirty flag and leave the history unchanged. `saveAs` uses the path as given, without adding an extension; the title becomes the file name without `.af`.
3. `saveAs` onto an existing file overwrites it without a warning.
4. `Document.load` of a saved file gives a clean document at history 0 of 0 with its tags (`rect1`), and makes it current.
5. Loading a file that is already open returns the open document (same `sessionUuid`) and does not make it current.
6. `Document.load` also imports PNG (a `RasterNode`), SVG (vector nodes) and Affinity 2 `.afdesign` files. The imported PNG and SVG documents have `mustSaveAs` true and keep their extension in the title (`src.png`); the `.afdesign` document has `mustSaveAs` false.
7. Under Wine an open document has a 99-byte `<file>~lock~` beside it. When the document is closed, or saved under another name, a 4-byte `<file>~lock~:com.dropbox.ignored` remains (R-13).
8. Undoing back to the saved history position leaves `isDirty` true.

### R-53 New documents

1. `NewDocumentOptions.width` and `height` are in the document's `units`: `Pixel` 1,000 x 500 at 300 DPI gives 1,000 x 500 px; `Millimetre` 210 x 297 at 300 DPI gives 2,480.31 x 3,507.87 px.

### R-54 Images

1. `Bitmap.loadFromFile(path)` reads PNG, JPEG, WebP, TIFF and GIF, each as `RGBA8` at 300 x 200 px in 6 to 91 ms. SVG and the text file named `.png` throw `NOT_SUPPORTED`, a missing file throws `ERROR`, and a file outside the Desktop throws `PERMISSION_DENIED`.
2. `ImageNodeDefinition.create(RasterFormat.RGBA8)` with `setBitmap(bitmap)`, inserted together with a tag in one compound command, adds 1 undo step. The node is an `ImageNode` named "Image" whose box is the bitmap size in document pixels at any DPI: 300 x 200 at 72 and at 300 DPI.
3. The definition transform `(w / bw, 0, x, 0, h / bh, y)`, for a bitmap of `bw` x `bh` px, places the image in the box `[x, y, w, h]`; `get_nodes` reads the box back exactly, and transparency is kept.
4. The bitmap is embedded: `imageFilePath` is empty, and after the source file was deleted the image still rendered and saved (the document file grew to 441,030 bytes).
5. `rasterWidth` and `rasterHeight` give the pixel size. `hasBrushFill` is false; the pen fill exists with weight 0, so `get_nodes` reports `stroke: null`.

### R-55 Setting name

1. Affinity's English resources name the setting "Access files on your Desktop", described as "Open, edit and save files on your Desktop when required to complete tasks.", on the "Model Context Protocol" page of the settings.

### R-56 Slice 004 implementation checks

Measured 2026-10-18 by the slice 004 live suite and a timing script through the server.

1. `ImageNodeDefinition` takes `userDescription` and a rotation in its transform like the other definitions: an image named "Photo", rotated by 30 degrees with opacity 0.5, read back with those values.
2. `createForSelection` after a preview selection of a hidden node exports that node at its box: a hidden 20 x 10 px rectangle inside a layer gave a 20 x 10 px PNG.
3. A document loaded from a copy in the staging folder and saved by `doc.save()` writes the copy; closing it in a separate script did not crash Affinity.
4. A PNG export of a 1,000 x 1,000 px spread with 200 ellipses at 2,048 x 2,048 px took 555 to 840 ms through the server (staging, export and copy); a JPEG export of one node at 2,048 x 1,024 px for `render` took 517 to 538 ms.

