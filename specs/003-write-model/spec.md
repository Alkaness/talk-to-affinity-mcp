# Slice 003: Write model

Status: approved at gate G1, 2026-10-14; implemented and verified at gate G4, 2026-10-14.

## 1. Problem

After slice 002 an agent can read a document in detail but can change it only with SDK scripts. A script that changes several things adds several undo steps, keeps its earlier changes when it fails halfway (R-07), gives new nodes no stable IDs (R-06), and lets Affinity replace a missing font without a word (R-36). Several SDK details are hard to discover: stroke changes need a field mask (R-37), text replacement needs a text sub-selection (R-38), gradients need a transform (R-40), edits on another spread fail unless that spread is made current (R-42).

Slice 003 adds four tools: `create_nodes`, `update_nodes`, `delete_nodes` and `undo`. Each call is all or nothing, reports its undo steps, and returns stable IDs.

## 2. User stories

### US-1 Build a layout (P1)

As an agent, I want to create shapes, text, paths and layers in one call, with IDs I can use afterwards.

1. Given an open document, when `create_nodes` receives a background rectangle, a title text, three shapes and an icon given as SVG path data, then the nodes appear in the given order with the given geometry and styles, the result lists their IDs in the shape of the input, and the call adds 1 undo step.
2. Given a layer spec with a rectangle and a text inside, then the layer and its children are created in 1 undo step.

### US-2 Adjust a design (P1)

As an agent, I want to change fill, stroke, position, size, rotation, opacity, effects and text of several nodes at once.

1. Given three nodes, when `update_nodes` changes the fill of one, moves another and replaces the text of a third, then all changes apply in 1 undo step.
2. Given a node whose ID is a path, when it is updated, then it receives a stable ID and the result reports the new ID beside the old one.

### US-3 Remove and revert (P1)

As an agent, I want to delete nodes and undo my own steps.

1. Given two nodes, when `delete_nodes` receives their IDs, then both are gone after 1 undo step.
2. Given a `create_nodes` call that reported 2 undo steps, when `undo` runs with `steps: 2`, then the document is as before the call.

### US-4 All or nothing (P1)

As a user, I do not want half-applied changes.

1. Given an update list where the third entry fails in Affinity, then the document is unchanged afterwards and the error names the failure and states that the document was restored.

### US-5 Only installed fonts (P1)

As an agent, I want to know when a font does not exist instead of getting a silent substitute.

1. Given a text spec with family "Helvetica Neue" on a machine without it, when `create_nodes` runs without `fontFallback`, then nothing changes and the error lists up to 5 installed families with the closest names.
2. Given the same spec with `fontFallback: true`, then the text is created and the result warns that Affinity substitutes the font.

## 3. Functional requirements

### 3.1 All write tools

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-301 | P1 | The write tools shall check their input against the schemas of sections 3.7 and 3.8 and reject invalid input before any script runs. | |
| FR-302 | P1 | Each write call shall run as one script that records the history position first. If a command fails or the script throws, then the script shall undo back to that position, and the error shall name the failure and state that the document was restored. | R-07, R-41 |
| FR-303 | P1 | `update_nodes` and `delete_nodes` shall add exactly 1 undo step. `create_nodes` shall add 1 undo step, plus 1 for each nesting level at which a new layer contains another new layer. Every write result shall state `undoSteps`. | R-32, R-33, R-41, R-42 |
| FR-304 | P1 | If no document is open, then the write tools shall fail with the message of FR-205. | R-13 |
| FR-305 | P1 | When the nodes or the parent of a call lie on a spread that is not current, the server shall make that spread current within the same undo step and report `spread` in the result. If they lie on more than one spread, then the call shall fail before any change. | R-35, R-42 |
| FR-306 | P1 | Every node that a write tool creates or updates shall carry a `ttam-id` tag that is its ID (FR-202): the `id` given in its spec, or a generated ID made of its type and the lowest number not yet used as a tag in the document (for example `rect3`). If a given `id` is already a tag in the document or occurs twice in the call, then the call shall fail before any change. | R-06, R-41 |
| FR-307 | P1 | Write inputs shall use the read model's conventions: boxes `[x, y, w, h]` in document pixels relative to the spread, colours `#rrggbb` or `#rrggbbaa`, rotation in degrees (clockwise) about the box centre, text sizes in points, stroke widths in pixels, dash lengths as multiples of the stroke width, and the type, blend-mode, cap, join, alignment and effect names that `get_nodes` reports. | R-14, R-37, R-43 |

### 3.2 `create_nodes`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-308 | P1 | `create_nodes` shall accept `nodes` (1 to 200 specs, at most 500 nodes in total), `parentId` (default: the top level of spread `spreadIndex`, by default the current spread) and `fontFallback` (default false). It shall insert the nodes in front of the parent's existing children, in the given order from back to front. | R-32 |
| FR-309 | P1 | `create_nodes` shall create the types `rect`, `ellipse`, `star`, `shape`, `path`, `text` and `layer` with the fields of table 3.7. Only `layer` takes `children`, nested at most 10 levels deep. | R-19, R-28, R-36, R-39, R-43 |
| FR-310 | P1 | `path` shall take SVG path data `d` with the commands M, L, H, V, C, S, Q, T, A and Z in absolute and relative form, including implicit repetition. Quadratic segments shall become exact cubic segments; arcs shall become cubic segments spanning at most 90 degrees each. `fillRule` selects non-zero or even-odd filling. | R-36, R-40 |
| FR-311 | P1 | `text` of kind `art` shall start its first baseline at `at`; `text` of kind `frame` shall fill `box`. Content comes from `text`, styled by the node's `family`, `style`, `size` and `color`, or from `runs`, each with its own text and any of those fields. A `\n` starts a new paragraph. `align` sets one alignment for all paragraphs or one per paragraph. | R-24, R-36, R-38, R-43 |
| FR-312 | P1 | Fonts shall be matched to installed faces: the family by name in any case, the style by name in any case. If a family or style is not installed and `fontFallback` is false, then the call shall fail before any change, listing up to 5 installed families whose names are closest, or the family's installed styles. With `fontFallback` true, the call shall proceed and the result shall list each substitution under `warnings`. | R-10, R-25, R-36 |
| FR-313 | P1 | A gradient fill `{gradient, stops: [{at, color}]}` shall span the node's box: `Linear` along `angle` (degrees, default 0 = left to right), `Radial` as an ellipse centred in the box that reaches its sides. | R-29, R-40 |
| FR-314 | P1 | A stroke `{color, width, align, cap, join, dash}` shall draw solid without `dash` and dashed with it. | R-37 |
| FR-315 | P2 | `effects` shall create `OuterShadow`, `InnerShadow`, `OuterGlow` and `GaussianBlur` layer effects with the fields that `get_nodes` reports for them; missing fields keep Affinity's defaults. | R-23, R-34 |
| FR-316 | P1 | The result of `create_nodes` shall mirror the input tree as `[{id, name, children?}]` and add `undoSteps`, and `warnings` and `spread` when present. | R-32 |

### 3.3 `update_nodes`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-317 | P1 | `update_nodes` shall accept 1 to 100 entries `{id, set, move}` and apply all of them in one undo step. If an ID matches no node, then the call shall fail before any change and name every unknown ID. | R-33, R-42 |
| FR-318 | P1 | `set` shall change only the fields it names, from table 3.8. `fill: null` removes the fill; `stroke: null` removes the stroke, and a partial `stroke` changes only the fields given; `effects` replaces all effects, and `[]` removes them. | R-33, R-34, R-37 |
| FR-319 | P1 | `box` shall move and scale the node so that its box becomes the given one; on a text node it shall only move it, and a different size shall be rejected. `rotation` shall set the absolute rotation about the box centre. | R-21, R-33, R-38 |
| FR-320 | P1 | On a text node, `text` or `runs` shall replace the content, and `family`, `style`, `size`, `color` and `align` shall restyle the whole text, with fonts matched as in FR-312. | R-38 |
| FR-321 | P2 | `move: {parentId, index}` shall place the node inside another parent and/or at a child index counted back to front; without `index` the node goes in front. | R-35 |
| FR-322 | P1 | The result of `update_nodes` shall list `{id}` per entry, in order, with `was` holding the old ID when the update gave the node a new one (FR-306), plus `undoSteps` and `spread` when switched. | R-41 |

### 3.4 `delete_nodes` and `undo`

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-323 | P1 | `delete_nodes` shall accept 1 to 500 IDs and delete those nodes with their descendants in one undo step, returning the number deleted. If an ID matches no node, then it shall fail before any change and name every unknown ID. | R-33, R-42 |
| FR-324 | P1 | `undo` shall undo `steps` steps (1 to 100, default 1) of the current document, or redo them when `redo` is true, stopping early when nothing is left, and return the number of steps done, the history position and size, and the descriptions of the next undo and redo. | R-06, R-33 |

### 3.5 Read model corrections

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-325 | P1 | `get_nodes` shall report a stroke's `dash` only when its line type is `Dash`. This replaces the rule "when a dash pattern is set" of FR-219. | R-37 |
| FR-326 | P1 | `get_nodes` shall report text sizes multiplied by the node's vertical scale, so a text node that was scaled reports the size drawn. This extends FR-220. | R-38 |

### 3.6 Tool descriptions

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-327 | P1 | The descriptions of the write tools shall state the undo-step rule, the all-or-nothing rule and the ID rule, and that art text is placed by its baseline. | R-43 |

### 3.7 Node specs for `create_nodes`

| Field | Types | Value | Default |
|---|---|---|---|
| `type` | all | `rect`, `ellipse`, `star`, `shape`, `path`, `text`, `layer` | required |
| `id` | all | 1 to 64 characters from `A-Z a-z 0-9 _ . : -` | generated (FR-306) |
| `name` | all | 1 to 200 characters | Affinity's default name |
| `box` | `rect`, `ellipse`, `star`, `shape`, frame `text` | `[x, y, w, h]`, `w` and `h` above 0 | required |
| `rotation` | all but `layer` | degrees, about the box centre; art `text` turns about `at`, because its box is known only after creation | 0 |
| `fill` | `rect`, `ellipse`, `star`, `shape`, `path` | colour, gradient (FR-313) or `null` | none |
| `stroke` | `rect`, `ellipse`, `star`, `shape`, `path` | `{color, width, align, cap, join, dash}`; `align` `Inside`, `Centre`, `Outside`; `cap` `Butt`, `Round`, `Square`; `join` `Miter`, `Round`, `Bevel` | none; `width` 1, `align` `Centre`, `cap` `Butt`, `join` `Round` |
| `opacity` | all | 0 to 1 | 1 |
| `blendMode` | all | one of the 33 names of R-43 | `Normal` |
| `effects` | all | list of `{type, enabled, opacity, blendMode, radius, color, offset, angle, intensity}` (FR-315) | none |
| `cornerRadius` | `rect` | pixels, 0 or more | 0 |
| `points`, `innerRadius` | `star` | 3 to 64; ratio above 0 and below 1 | 5; 0.382 |
| `kind` | `shape` | `Arrow`, `CalloutEllipse`, `CalloutRectangle`, `Cat`, `Cat2`, `Cat3`, `Cat4`, `Cloud`, `Cog`, `Crescent`, `Diamond`, `DoubleStar`, `Heart`, `Pie`, `Polygon`, `Segment`, `Spiral`, `SquareStar`, `Tear`, `Trapezoid`, `Triangle` | required |
| `sides` | `shape` of kind `Polygon` | 3 to 100 | Affinity's default |
| `d`, `fillRule` | `path` | SVG path data (FR-310); `nonzero` or `evenodd` | required; `nonzero` |
| `kind` | `text` | `art` or `frame` | `art` |
| `at` | art `text` | `[x, y]`, the start of the first baseline | required |
| `text` or `runs` | `text` | string; list of `{text, family, style, size, color}` | one of them required |
| `family`, `style`, `size`, `color` | `text` | installed family and style (FR-312); points above 0; colour | Affinity's default text style |
| `align` | `text` | `Left`, `Centre`, `Right`, `JustifyLeft`, `JustifyCentre`, `JustifyRight`, `JustifyAll`, or a list with one per paragraph | `Left` |
| `children` | `layer` | node specs | none |

### 3.8 Fields of `set` for `update_nodes`

| Field | Applies to | Effect |
|---|---|---|
| `name`, `opacity`, `blendMode`, `effects` | all | as in table 3.7 |
| `hidden`, `locked` | all | hide or show; lock or unlock |
| `box`, `rotation` | all | FR-319 |
| `fill`, `stroke` | nodes that `get_nodes` reports them for | FR-318 |
| `cornerRadius` | `rect` | radius of every corner |
| `points`, `innerRadius` | `star` | as in table 3.7 |
| `sides` | `shape` of kind `Polygon` | as in table 3.7 |
| `text`, `runs`, `family`, `style`, `size`, `color`, `align` | `text` | FR-320 |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-301 | `create_nodes` with 200 flat nodes completes within 3 s. |
| NFR-302 | The result of `create_nodes` for 100 nodes stays below 8,000 characters. |

## 5. Out of scope

1. Image nodes: slice 004.
2. Groups: no script API creates them (R-28).
3. Artboards, adjustment and filter layers: backlog.
4. Creating nodes hidden or locked: locking through the selection deselects the node and breaks the chain of insertions within one undo step (R-42); `update_nodes` sets both afterwards.
5. Resizing a text frame without scaling its text: no API was found (R-38).
6. Editing path geometry and per-corner radii; the gradient angle in `get_nodes`.
7. Linked text frames and text on a path.

## 6. Open questions

None.

## 7. Status

Measured 2026-10-14: `npm test` 77 of 77 pass (38, 19 and 20 for slices 001 to 003); `npm run test:live` 111 of 111 pass (77 unit plus 34 live) against Affinity 3.3.1 under Wine. `create_nodes` with 200 rectangles took 545 ms in an empty document and 1,797 to 2,018 ms with 200 to 400 nodes already present; its result for 100 nodes was 3,627 characters. Tests are found by requirement ID in `test/write-model.test.ts` (unit) and `test/live.test.ts` (live).

| ID | Unit | Live |
|---|---|---|
| FR-301 | pass | not applicable: refused before any script |
| FR-302, FR-303, FR-306, FR-312, FR-313, FR-319, FR-320 | pass (pure helpers) | pass |
| FR-304, FR-325, FR-326 | pass | pass |
| FR-305, FR-307 to FR-309, FR-311, FR-314 to FR-318, FR-321 to FR-324 | not applicable: SDK commands | pass |
| FR-310 | pass (parser) | pass |
| FR-327 | pass | not applicable: tool description text |
| NFR-301, NFR-302 | not applicable | pass |

## 8. Changes after approval

1. 2026-10-14, planning: a given `id` starts with a letter or `_`, and a `parentId` made of digits names the top level of that spread, in `create_nodes` and in `move`. Reason: without it a node could not be moved back to the top level.
2. 2026-10-14, planning: `update_nodes` takes `fontFallback`, so FR-320 matches fonts exactly as FR-312 does.
3. 2026-10-14, implementation: a stroke given without `color` is black.
4. 2026-10-14, implementation: `get_nodes` reports `fill: null` for an unfilled rectangle, ellipse, star, shape, path or artboard. Affinity reports such nodes without a brush fill (R-44), and slice 002 had omitted their `fill`, as for layers.
5. 2026-10-14, implementation: `undo` reads its descriptions from the history items, because the description getters throw at position 0 (R-45).
6. 2026-10-14, implementation: the script envelope reports undo steps of a failed script only when the history position grew; a failed script that had undone steps reported a negative count (FR-114).
