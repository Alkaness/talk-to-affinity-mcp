// Host-side image comparison (specs/005-visual-compare/plan.md section 3).
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { AffinityError } from './affinity.js';

/** RGBA pixels (4 bytes each) after decoding; RGB over white (3 bytes each) for comparing. */
export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}
export type Box = [number, number, number, number];

const MAX_PIXELS = 40_000_000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Width and height from a PNG or JPEG header, or null for other content (plan 3.1 item 2). */
export function dimensions(b: Uint8Array): [number, number] | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a) return [v.getUint32(16), v.getUint32(20)];
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 <= b.length; ) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) i++; // fill byte
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
    else i += 2 + v.getUint16(i + 2);
  }
  return null;
}

/** FR-502: decodes a PNG or JPEG file to RGBA; errors name the file. */
export function decode(b: Buffer, name: string): Image {
  const wh = dimensions(b);
  if (!wh) throw new AffinityError(`${name} is not a PNG or JPEG file.`);
  if (wh[0] * wh[1] > MAX_PIXELS) throw new AffinityError(`${name} has ${wh[0]} x ${wh[1]} pixels; at most 40,000,000 are compared.`);
  try {
    return b[0] === 0x89 ? PNG.sync.read(b) : jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 1024 });
  } catch (e) {
    throw new AffinityError(`${name} could not be decoded: ${(e as Error).message}`);
  }
}

/** RGBA composited over white, as RGB (FR-506). */
export function flatten(img: Image): Image {
  const n = img.width * img.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(img.data[i * 4 + c] * a + 255 * (1 - a));
  }
  return { width: img.width, height: img.height, data: out };
}

/** For each of `to` output pixels, the input pixels its span covers and their covered fractions. */
function spans(from: number, to: number) {
  const k = from / to;
  return Array.from({ length: to }, (_, i) => {
    const a = i * k;
    const b = a + k;
    const at: number[] = [];
    const w: number[] = [];
    for (let j = Math.floor(a); j < Math.min(from, Math.ceil(b)); j++) {
      at.push(j);
      w.push((Math.min(b, j + 1) - Math.max(a, j)) / k);
    }
    return { at, w };
  });
}

/** Area-average resampling of an RGB image, one axis after the other (plan 3.3 item 2). */
export function resample(img: Image, w: number, h: number): Image {
  if (img.width === w && img.height === h) return img;
  const xs = spans(img.width, w);
  const ys = spans(img.height, h);
  const mid = new Float32Array(w * img.height * 3);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < w; x++) {
      const { at, w: f } = xs[x];
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = 0; k < at.length; k++) s += img.data[(y * img.width + at[k]) * 3 + c] * f[k];
        mid[(y * w + x) * 3 + c] = s;
      }
    }
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const { at, w: f } = ys[y];
    for (let x = 0; x < w * 3; x++) {
      let s = 0;
      for (let k = 0; k < at.length; k++) s += mid[at[k] * w * 3 + x] * f[k];
      out[y * w * 3 + x] = Math.round(s);
    }
  }
  return { width: w, height: h, data: out };
}

function crop(img: Image, x: number, y: number, w: number, h: number): Image {
  const out = new Uint8Array(w * h * 3);
  for (let r = 0; r < h; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 3, ((y + r) * img.width + x + w) * 3), r * w * 3);
  return { width: w, height: h, data: out };
}

export interface Options {
  area: Box; // the document pixels the render covers
  threshold: number;
  fit?: 'stretch' | 'contain';
  longest?: number; // the render is reduced to this longest side when larger (FR-504)
}

/** FR-506 to FR-508: compares an RGBA render covering `area` with an RGBA reference. */
export function compareImages(render: Image, reference: Image, o: Options) {
  let a = flatten(render);
  const longer = Math.max(a.width, a.height);
  if (o.longest && longer > o.longest) a = resample(a, Math.max(1, Math.round((a.width * o.longest) / longer)), Math.max(1, Math.round((a.height * o.longest) / longer)));
  let area = o.area;
  const [rw, rh] = [reference.width, reference.height];
  if (o.fit === 'contain') {
    const wide = rw / rh > a.width / a.height;
    const w = wide ? a.width : Math.max(1, Math.round((a.height * rw) / rh));
    const h = wide ? Math.max(1, Math.round((a.width * rh) / rw)) : a.height;
    const x = Math.floor((a.width - w) / 2);
    const y = Math.floor((a.height - h) / 2);
    const [sx, sy] = [area[2] / a.width, area[3] / a.height];
    area = [area[0] + x * sx, area[1] + y * sy, w * sx, h * sy];
    a = crop(a, x, y, w, h);
  } else if (!o.fit) {
    const off = Math.abs(rw / rh / (area[2] / area[3]) - 1);
    if (off > 0.01)
      throw new AffinityError(
        `The reference is ${rw} x ${rh} px and the target area is ${r2(area[2])} x ${r2(area[3])} document pixels; their aspect ratios differ by ${(off * 100).toFixed(1)}%, more than 1%. Set fit to stretch or contain, or compare a matching target.`,
      );
  }
  const b = resample(flatten(reference), a.width, a.height);
  const n = a.width * a.height;
  const deltas = new Uint8Array(n);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const d = Math.max(Math.abs(a.data[p] - b.data[p]), Math.abs(a.data[p + 1] - b.data[p + 1]), Math.abs(a.data[p + 2] - b.data[p + 2]));
    deltas[i] = d;
    sum += d;
    if (d > o.threshold) count++;
  }
  // FR-508: square cells, 16 along the longer side; stable sort keeps reading order for ties.
  const side = Math.ceil(Math.max(a.width, a.height) / 16);
  const [sx, sy] = [area[2] / a.width, area[3] / a.height];
  const cells: { box: Box; diffRatio: number; share: number }[] = [];
  for (let cy = 0; cy < a.height; cy += side)
    for (let cx = 0; cx < a.width; cx += side) {
      const w = Math.min(side, a.width - cx);
      const h = Math.min(side, a.height - cy);
      let hit = 0;
      for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) if (deltas[y * a.width + x] > o.threshold) hit++;
      if (hit) cells.push({ box: [r2(area[0] + cx * sx), r2(area[1] + cy * sy), r2(w * sx), r2(h * sy)], diffRatio: r4(hit / (w * h)), share: hit / (w * h) });
    }
  cells.sort((p, q) => q.share - p.share);
  return {
    score: r4(1 - sum / (n * 255)),
    diffRatio: r4(count / n),
    size: [a.width, a.height] as [number, number],
    area: area.map(r2) as Box,
    regions: cells.slice(0, 5).map(({ box, diffRatio }) => ({ box, diffRatio })),
    compared: a,
    deltas,
  };
}

/** FR-510: the compared render in light grey, differing pixels towards red, as JPEG (plan 3.4). */
export function heatmap(render: Image, deltas: Uint8Array, threshold: number): Buffer {
  const n = render.width * render.height;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 3;
    const grey = 255 - (255 - (0.299 * render.data[p] + 0.587 * render.data[p + 1] + 0.114 * render.data[p + 2])) * 0.3;
    const t = deltas[i] > threshold ? 0.4 + (0.6 * (deltas[i] - threshold)) / Math.max(1, 255 - threshold) : 0;
    out[i * 4] = Math.round(grey + (255 - grey) * t);
    out[i * 4 + 1] = out[i * 4 + 2] = Math.round(grey * (1 - t));
    out[i * 4 + 3] = 255;
  }
  return jpeg.encode({ width: render.width, height: render.height, data: out }, 80).data;
}
