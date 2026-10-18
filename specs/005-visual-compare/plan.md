# Slice 005: Plan

Implements `spec.md` of this folder. Research references point to `specs/000-spike/research.md`.

## 1. Design summary

1. New `src/compare.ts` holds the host-side image work as pure functions: reading the size from a file header, decoding PNG and JPEG, compositing over white, resampling, fitting, the metrics, the cells and the heatmap. It has no knowledge of Affinity, so the unit suite tests it on generated images.
2. `src/tools.ts` registers `compare_to_reference`. The tool checks its inputs and the reference before any script (FR-501, FR-502), renders through `ttam.exportFiles` as `PNG` (FR-503), or through `render_spread` when staging is unavailable (FR-504), and hands both images to `compare.ts`. The server then has 14 tools.
3. `src/sdk.js`: `area(nodes)` returns the area's origin as well as its size, and `exportFiles` reports each job's area as `area: [x, y, width, height]` in document pixels, so the host can map cells back to the spread (FR-508). The `export` tool ignores the new field.
4. Runtime dependencies `pngjs` 7.0.0 (MIT) and `jpeg-js` 0.4.4 (BSD-3-Clause), both pure JavaScript without dependencies, as constitution item 10 provides; development dependency `@types/pngjs` 6.0.5. `jpeg-js` ships its own types.
5. The fake gains an option for the image that `render_spread` returns; the unit tests of the tool replace the fake's `doc.export` with one that writes a real PNG.

## 2. Tool contract

### 2.1 `compare_to_reference`

| Parameter | Type | Constraint | Default |
|---|---|---|---|
| `reference` | string | host path (FR-401) of a PNG or JPEG file | required |
| `target` | enum | `spread`, `nodes` | `spread` |
| `spreadIndex` | integer | 0 or more; `spread` only | current spread |
| `ids` | array of strings | 1 to 500; required for `nodes`, else refused | |
| `maxSize` | integer | 64 to 2,048 | 1,024 |
| `threshold` | integer | 0 to 255 | 32 |
| `fit` | enum | `stretch`, `contain` | none |
| `heatmap` | boolean | | true |

Output: text content `{score, diffRatio, threshold, render, size, area, reference, regions: [{box, diffRatio}], note?}` (FR-510), followed by image content `image/jpeg` unless `heatmap` is false.

## 3. Design details

### 3.1 Reference (FR-502)

1. The host resolves `reference` with `hostPath`, checks that it is a file, and reads it.
2. `dimensions(buf)` reads the size from the header without decoding. PNG: the 8-byte signature `89 50 4E 47 0D 0A 1A 0A`, then width and height as big-endian 32-bit integers at bytes 16 and 20 of the `IHDR` chunk. JPEG: `FF D8`, then the markers in order until a start-of-frame marker (`C0` to `CF` except `C4`, `C8` and `CC`), whose height and width are big-endian 16-bit integers at offsets 5 and 7 of its segment. Any other content is "not a PNG or JPEG file".
3. More than 40,000,000 pixels fails before decoding, naming the file and its size. Otherwise `PNG.sync.read` or `jpeg.decode(buf, {useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 1024})` decodes to RGBA; a decoder error fails naming the file ("could not be decoded: <message>").
4. All of this happens before the first script runs.

### 3.2 Render (FR-503, FR-504, FR-505)

1. Size: `L = min(maxSize, max(reference width, reference height))`.
2. PNG path: `staging.begin()`, then `withCall`, then `ttam.exportFiles({target, spreadIndex, ids, preset: 'PNG', size: {longest: L}, dir, name: 'compare.png'})`. The single file of the job's folder is decoded with `pngjs`. The covered area is the job's `area`: for a spread `[0, 0, widthPixels, heightPixels]`, for nodes the union of their visible boxes widened to whole pixels (R-48 item 4). The export is stretched to its exact size (R-47 item 2), so the image maps to the area with one scale per axis. The call folder is removed in `finally` (FR-404). The preview selection leaves history, dirty flag and selection unchanged (R-49, FR-505).
3. Fallback: when `staging.begin()` throws the fix of FR-402 (`ACCESS_FIX`) or FR-403 (`LOCATE_FIX`, now exported by `staging.ts`), and `target` is `spread`, the host runs `RENDER_INFO`, which now also returns the page size, checks `spreadIndex` as `render` does, and calls `render_spread`. Its JPEG is decoded with `jpeg-js`. By R-57 it has one scale `s = image width / page width` for both axes, and it covers `[0, 0, page width, image height / s]`. When its longest side exceeds `L`, the render is resampled down so that its longest side is `L`, with the same area. The result's `note` is the error's reason and fix, followed by "Until then, Affinity's JPEG render is compared." With `target: "nodes"` the error is passed on.
4. Any other error, and a native call that returns `isError`, fails the call.

### 3.3 Comparison (FR-506 to FR-509)

1. `flatten(rgba)` composites each pixel over white: `c * a / 255 + 255 * (1 - a / 255)`, rounded, to RGB.
2. `resample(img, w, h)` averages areas, one axis after the other: each output pixel takes the weighted mean of the input pixels its span covers, weighted by the covered fraction. This reduces and enlarges with the same code; for a 2 x 2 reduction it equals the averaging of R-58.
3. Fit, with the render of `W x H` px covering `area`:
   1. The aspect ratios compared are the reference's `rw / rh` and the area's `area.w / area.h`. With no `fit`, `|(rw / rh) / (area.w / area.h) - 1| > 0.01` fails: "The reference is rw x rh px and the target area is w x h document pixels; their aspect ratios differ by p%, more than 1%. Set fit to stretch or contain, or compare a matching target." Otherwise, and with `stretch`, the reference is resampled to `W x H`.
   2. `contain`: the largest rectangle with the reference's aspect ratio inside `W x H` (`W x round(W * rh / rw)` or `round(H * rw / rh) x H`), centred with its offset rounded down. The render is cut to it, the reference resampled to its size, and the compared area is that rectangle mapped into `area`.
4. `diff(a, b, threshold)`: per pixel the largest absolute channel difference `d`; `differs` when `d > threshold`. `score = 1 - sum(d) / (n * 255)` and `diffRatio = differing / n`, each rounded to 4 decimals (FR-507).
5. Cells (FR-508): side `ceil(max(w, h) / 16)` of the compared image; cells in reading order; those with a differing pixel sorted by share, highest first, with a stable sort so that ties keep reading order; the first 5 are mapped to document pixels with the area's scale per axis and rounded to 0.01.
6. FR-509 sets the default `threshold` to 32 (R-58). The live test saves Affinity's render of a spread as a JPEG reference and compares it with the unchanged spread through the PNG path; the 1,024 x 682 px reference is resampled to the 1,024 x 683 px render (aspect within 1%).

### 3.4 Heatmap and output (FR-510)

1. The heatmap is the compared render as light grey, `255 - (255 - luma) * 0.3` with `luma = 0.299 r + 0.587 g + 0.114 b`. Each differing pixel is blended towards `#ff0000` by `0.4 + 0.6 * (d - threshold) / max(1, 255 - threshold)`.
2. It is encoded with `jpeg.encode(.., 80)` at the compared size and returned as `image/jpeg` content after the text content.
3. `size` is the compared size, `area` the compared area rounded to 0.01, `reference` the reference's own size.

### 3.5 Instructions (FR-511)

Workflow step 5 becomes: "After every visual change, call render and look at the image. To match a reference image, call compare_to_reference: its regions are in document pixels. Write files with export." The FR-127 test keeps the 1,500-character limit; FR-129 expects 14 tools.

## 4. Files touched

| File | Change |
|---|---|
| `src/compare.ts` | new: `dimensions`, `decode`, `flatten`, `resample`, `compareImages` (fit, differences, cells), `heatmap` |
| `src/tools.ts` | `compare_to_reference`, page size in `RENDER_INFO`, instructions step 5 |
| `src/sdk.js` | `area` with origin; `area` in the `exportFiles` result |
| `src/staging.ts` | export `LOCATE_FIX` |
| `package.json` | `pngjs`, `jpeg-js`; `@types/pngjs` |
| `test/fake-affinity.ts` | `renderImage` option for `render_spread` and `render_selection` |
| `test/visual-compare.test.ts` | new: unit tests |
| `test/live.test.ts` | slice 005 live tests |
| `test/foundation.test.ts` | FR-129 expects 14 tools; NFR-101 admits `pngjs` and `jpeg-js` |
| `specs/001-foundation/spec.md` | NFR-101 and its change note |
| `specs/roadmap.md` | tool contract row and slice status |

## 5. Risks

1. The page of a spread is assumed to start at the spread origin, as for every document `manage_document` creates (single pages, not facing). A facing or multi-page spread would shift the regions; the live suite uses single pages.
2. `jpeg-js` decodes baseline and progressive JPEG; CMYK and arithmetic-coded JPEGs may fail to decode, which FR-502 reports naming the file.
3. Resampling the reference by area averaging blurs edges when it reduces a lot; differences at edges then stay below `threshold` more often. The reference's own size bounds the render, so a large reference is reduced at most to `maxSize`.
4. Affinity's render cuts its last partial row (R-57); the area of item 3.2.3 accounts for it. Should a later build round instead, the mapping is off by at most one render pixel.
