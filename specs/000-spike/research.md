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
