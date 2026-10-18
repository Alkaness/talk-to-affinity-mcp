# Slice 005: Visual compare

Status: approved at gate G1, 2026-10-18.

## 1. Problem

An agent that rebuilds a design from a mockup, or that checks whether an edit changed only what it should, has only `render` images to judge by. Judging likeness by eye is unreliable. A shape 40 px out of place or a colour slightly off is easy to miss in a 1,024 px JPEG, and the image does not tell the agent where to look in document pixels.

Slice 005 adds one tool, `compare_to_reference`. It renders the current document, compares the render pixel by pixel with a reference image on the host, and returns two figures, the worst regions in document pixels, and a heatmap. Three facts shape the design:

1. Affinity's renderer returns JPEG of at most 1,024 px and needs no file access (R-08, R-57). Its compression and edge noise make 0.512% of pixels differ by more than 16 from a lossless render of the same spread (R-58).
2. A PNG export through the staging folder is lossless and repeats to the pixel, but it needs file access (R-58, FR-402).
3. Decoding PNG and JPEG on the host needs `pngjs` and `jpeg-js`, which constitution item 10 admits from this slice.

## 2. User stories

### US-1 Match a mockup (P1)

As an agent that rebuilds a design from a reference image, I want to know how close the document is and where it differs, in document pixels.

1. Given a document built from `/home/u/mockup.png`, when `compare_to_reference` receives `reference: "/home/u/mockup.png"`, then it returns `score`, `diffRatio`, up to 5 regions with boxes in document pixels, and a heatmap image.
2. Given a shape placed 40 px away from its place in the reference, then the first region overlaps that shape's box in the document or its place in the reference.

### US-2 Check a change (P1)

As an agent, I want to export a spread as a reference, edit the document, and confirm that only the intended area changed.

1. Given a PNG exported from the current spread, when nothing has changed and the comparison uses a PNG render, then `score` is 1, `diffRatio` is 0 and `regions` is empty.
2. Given a poster exported as a PNG and one of its shapes then moved by 40 px, then every region overlaps the shape's old or new box.

### US-3 Compare one element (P2)

1. Given a logo exported earlier as a PNG and its node ID, when `target` is `nodes` with that ID, then only the logo is rendered and compared, cut as in FR-415.

### US-4 Wrong proportions (P1)

1. Given a reference of 800 x 800 px and a spread of 1,200 x 800 px, when `fit` is not given, then the call fails naming both sizes and `fit`.

### US-5 Without file access (P2)

1. Given that file access is off, when a spread is compared, then the call succeeds through Affinity's renderer, reports `render: "jpeg"`, and its `note` names the setting that allows lossless renders.

## 3. Functional requirements

### 3.1 Inputs

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-501 | P1 | `compare_to_reference` shall take the fields of table 3.5. `reference` is a host path (FR-401). `ids` is required with `target: "nodes"` and refused otherwise; `spreadIndex` is refused unless `target` is `spread`. These rules are checked before any script runs. | |
| FR-502 | P1 | The reference shall be a PNG or JPEG file, recognised by its content and not by its extension, of at most 40,000,000 pixels. If the file is missing, has another format, is larger, or cannot be decoded, then the call shall fail naming the file before any script runs. | |

### 3.2 Rendering

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-503 | P1 | The server shall render the target as a PNG export through the staging folder. Target `spread` is the page of spread `spreadIndex`, by default the current one. Target `nodes` is cut as in FR-415. The render's longest side is the smaller of `maxSize` and the longest side of the reference, and small areas are enlarged. Staged files follow FR-404. | R-47, R-48, R-58 |
| FR-504 | P2 | If the staging folder cannot be used, because file access is off (FR-402) or Affinity's Desktop is not found (FR-403), and `target` is `spread`, then the server shall use Affinity's renderer instead. That render is a JPEG whose longest side is at most 1,024 px and is never enlarged. It is reduced to the size of FR-503 when it is larger. The result shall report `render: "jpeg"` and give the fix of FR-402 or FR-403 in `note`. With `target: "nodes"`, the call shall fail with that fix. | R-08, R-57 |
| FR-505 | P1 | `compare_to_reference` shall leave the document's history, dirty flag and selection unchanged. | R-49 |

### 3.3 Comparison

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-506 | P1 | Both images shall be composited over white. The reference shall then be resampled to the render's size. This requires the aspect ratio of the reference to be within 1% of the aspect ratio of the target area in document pixels, unless `fit` is given. With `fit: "stretch"`, the reference shall be resampled to the render's size whatever its aspect ratio. With `fit: "contain"`, the reference shall be scaled to the largest size that fits inside the render with its aspect ratio kept, and centred; only the part of the render that it covers is compared. If the ratios differ by more than 1% and `fit` is not given, then the call shall fail naming both sizes in pixels and `fit`. | R-58 |
| FR-507 | P1 | A pixel shall count as different when the largest absolute difference of its red, green and blue values exceeds `threshold`. `diffRatio` shall be the share of compared pixels that differ. `score` shall be 1 minus the mean, over the compared pixels, of that largest difference divided by 255. Both are rounded to 4 decimals. | R-58 |
| FR-508 | P1 | The compared image shall be divided into square cells whose side is its longer side divided by 16, rounded up; cells in the last row and column may be smaller. `regions` shall list up to 5 cells that hold at least one differing pixel, ordered by their share of differing pixels, highest first, with ties in reading order. Each region shall give `box`, the cell as `[x, y, width, height]` in document pixels relative to the spread, rounded to 0.01, and `diffRatio`, the cell's share of differing pixels. | R-57, R-58 |
| FR-509 | P1 | The default `threshold` shall be 32. With it, a reference that is Affinity's render of a spread, saved as JPEG, shall differ from a PNG render of that unchanged spread in less than 1% of pixels. | R-58 |

### 3.4 Output and descriptions

| ID | Pri | Requirement | Ref |
|---|---|---|---|
| FR-510 | P1 | The result shall give, as text content, `{score, diffRatio, threshold, render, size, area, reference, regions}` and `note` when there is one. `render` is `png` or `jpeg`. `size` is the compared size in pixels as `[width, height]`. `area` is the compared area as `[x, y, width, height]` in document pixels, rounded to 0.01; with `fit: "contain"` it is the part covered by the reference. `reference` is the reference's own size in pixels as `[width, height]`. Unless `heatmap` is false, the result shall also give a heatmap as MCP image content: a JPEG at the compared size that shows the render in light grey and differing pixels in red, stronger red for larger differences. | R-57 |
| FR-511 | P2 | The MCP instructions and the tool description shall state when to use `compare_to_reference` and that its regions are in document pixels. The instructions stay within 1,500 characters (FR-127), and the server exposes 14 tools. | |

### 3.5 Fields of `compare_to_reference`

| Field | Value | Default |
|---|---|---|
| `reference` | host path of a PNG or JPEG file | required |
| `target` | `spread` or `nodes` | `spread` |
| `spreadIndex` | spread index from 0, for `target: "spread"` | the current spread |
| `ids` | 1 to 500 node IDs on one spread, for `target: "nodes"` | none |
| `maxSize` | 64 to 2,048: the largest longest side of the compared images | 1,024 |
| `threshold` | 0 to 255 | 32 |
| `fit` | `stretch` or `contain` | none: ratios must match within 1% |
| `heatmap` | return the heatmap image | true |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-501 | A comparison of a 1,200 x 800 px spread with a 1,024 x 683 px PNG reference completes within 2 s, heatmap included. |
| NFR-502 | A comparison at `maxSize: 2048` with a 2,048 x 1,365 px PNG reference completes within 4 s, heatmap included. |

## 5. Out of scope

1. `target: "selection"`. `get_document` reports the selected IDs, which `target: "nodes"` takes.
2. Comparing two spreads or two documents directly. One of them is exported first and then serves as the reference.
3. Perceptual measures (SSIM, colour difference in Lab), tolerance for anti-aliasing, and masks that exclude areas.
4. Naming the nodes inside a region. `get_document` with its boxes gives them.
5. Reference formats other than PNG and JPEG (WebP, TIFF, GIF), which would need further dependencies.
6. Searching for the offset at which the images align best.

## 6. Open questions

None.

## 7. Status

Measured 2026-10-18: `npm test` 109 of 109 pass (38, 19, 20, 23 and 9 for slices 001 to 005); `npm run test:live` 161 of 161 pass (109 unit plus 52 live) against Affinity 3.3.1 under Wine. An earlier full run lost Affinity after the slice 003 test NFR-301 and failed every later live test on the closed endpoint; after a restart of Affinity the full run passed (R-60 item 4). Affinity's render saved as JPEG differed from the PNG render in 0.33% of pixels (FR-509). A comparison at 1,024 px took 843 to 860 ms (NFR-501) and one at 2,048 px 1,292 to 1,363 ms (NFR-502), each through the server. Tests are found by requirement ID in `test/visual-compare.test.ts` (unit) and `test/live.test.ts` (live).

| ID | Unit | Live |
|---|---|---|
| FR-501, FR-502 | pass | not applicable: refused before any script |
| FR-503 | pass | pass |
| FR-504 | pass | not applicable: a script cannot turn file access off |
| FR-505 | not applicable: SDK commands | pass |
| FR-506, FR-507, FR-508, FR-510 | pass | pass |
| FR-509 | not applicable: needs Affinity's render | pass |
| FR-511 | pass | not applicable: description text |
| NFR-501, NFR-502 | not applicable | pass |
