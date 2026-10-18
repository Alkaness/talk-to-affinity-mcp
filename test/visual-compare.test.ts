// Slice 005 unit tests. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { Upstream } from '../src/affinity.js';
import { compareImages, decode, dimensions, heatmap, resample, type Image } from '../src/compare.js';
import { createServer, INSTRUCTIONS } from '../src/tools.js';
import { fakeDocument, fakeFiles, startFake } from './fake-affinity.js';

const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');
const jsonOf = (r: CallToolResult) => JSON.parse(textOf(r));
const temp = () => mkdtempSync(join(tmpdir(), 'ttam-'));
type Paint = (x: number, y: number) => number[];
const WHITE: Paint = () => [255, 255, 255, 255];

/** An RGBA image painted pixel by pixel. */
function image(w: number, h: number, paint: Paint): Image {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
function png(w: number, h: number, paint: Paint = WHITE) {
  const p = new PNG({ width: w, height: h });
  p.data.set(image(w, h, paint).data);
  return PNG.sync.write(p);
}
const square = (x0: number, y0: number, s: number): Paint => (x, y) => (x >= x0 && x < x0 + s && y >= y0 && y < y0 + s ? [0, 0, 0, 255] : [255, 255, 255, 255]);
const overlaps = (a: number[], b: number[]) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

// 1. Reference files

test('FR-502 sizes come from the header; other content, too many pixels and corrupt files are refused naming the file', () => {
  assert.deepEqual(dimensions(png(30, 20)), [30, 20]);
  assert.deepEqual(dimensions(jpeg.encode({ width: 30, height: 20, data: Buffer.from(image(30, 20, WHITE).data) }, 90).data), [30, 20]);
  assert.equal(dimensions(Buffer.from('not an image')), null);
  assert.throws(() => decode(Buffer.from('not an image'), 'x.png'), /x\.png is not a PNG or JPEG file/);
  const huge = png(1, 1);
  huge.writeUInt32BE(8000, 16);
  huge.writeUInt32BE(6000, 20);
  assert.throws(() => decode(huge, 'huge.png'), /huge\.png has 8000 x 6000 pixels; at most 40,000,000/);
  assert.throws(() => decode(png(10, 10).subarray(0, 40), 'cut.png'), /cut\.png could not be decoded/);
  const back = decode(png(3, 2, () => [10, 20, 30, 255]), 'ok.png');
  assert.deepEqual([back.width, back.height, ...back.data.slice(0, 4)], [3, 2, 10, 20, 30, 255]);
});

// 2. Comparison

const area = (w: number, h: number): [number, number, number, number] => [0, 0, w, h];

test('FR-507 identical images score 1 with no regions; transparency counts as white; differences above threshold count', () => {
  const a = image(64, 32, square(8, 8, 8));
  assert.deepEqual(compareImages(a, a, { area: area(64, 32), threshold: 32 }).regions, []);
  const same = compareImages(a, a, { area: area(64, 32), threshold: 32 });
  assert.deepEqual([same.score, same.diffRatio], [1, 0]);
  const clear = compareImages(image(8, 8, () => [0, 0, 0, 0]), image(8, 8, WHITE), { area: area(8, 8), threshold: 0 });
  assert.deepEqual([clear.score, clear.diffRatio], [1, 0]);
  const grey = (v: number): Paint => () => [v, v, v, 255];
  const at32 = compareImages(image(8, 8, grey(100)), image(8, 8, grey(132)), { area: area(8, 8), threshold: 32 });
  assert.deepEqual([at32.diffRatio, at32.score], [0, 0.8745]);
  assert.equal(compareImages(image(8, 8, grey(100)), image(8, 8, grey(133)), { area: area(8, 8), threshold: 32 }).diffRatio, 1);
  assert.equal(compareImages(image(8, 8, () => [100, 0, 0, 255]), image(8, 8, () => [100, 0, 40, 255]), { area: area(8, 8), threshold: 32 }).diffRatio, 1, 'the largest channel counts');
});

test('FR-508 a moved square ranks its cells first, in reading order, at most 5, in document pixels', () => {
  const before = image(320, 160, square(40, 40, 40));
  const after = image(320, 160, square(80, 40, 40));
  const r = compareImages(after, before, { area: area(320, 160), threshold: 32 });
  assert.equal(r.diffRatio, 0.0625);
  assert.deepEqual(
    r.regions.map((x) => x.box),
    [
      [40, 40, 20, 20],
      [60, 40, 20, 20],
      [80, 40, 20, 20],
      [100, 40, 20, 20],
      [40, 60, 20, 20],
    ],
  );
  assert.ok(r.regions.every((x) => x.diffRatio === 1 && (overlaps(x.box, [40, 40, 40, 40]) || overlaps(x.box, [80, 40, 40, 40]))));
  const scaled = compareImages(after, before, { area: [100, 50, 640, 320], threshold: 32 });
  assert.deepEqual(scaled.regions[0].box, [180, 130, 40, 40]);
  // Side ceil(34 / 16) = 3: the last column and row are 1 px.
  const one = compareImages(image(34, 10, (x, y) => (x === 33 && y === 9 ? [0, 0, 0, 255] : [255, 255, 255, 255])), image(34, 10, WHITE), { area: area(34, 10), threshold: 32 });
  assert.deepEqual(one.regions, [{ box: [33, 9, 1, 1], diffRatio: 1 }]);
  const half = compareImages(image(32, 16, (x, y) => (y < 2 && x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255])), image(32, 16, WHITE), { area: area(32, 16), threshold: 32 });
  assert.deepEqual(half.regions, [{ box: [0, 0, 2, 2], diffRatio: 1 }, { box: [2, 0, 2, 2], diffRatio: 0.5 }]);
});

test('FR-506 resampling averages areas; aspect ratios beyond 1% need fit; stretch and contain', () => {
  const four = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200, 100, 100, 100]) };
  assert.deepEqual([...resample(four, 1, 1).data], [100, 100, 100]);
  assert.deepEqual([...resample({ width: 1, height: 1, data: new Uint8Array([7, 8, 9]) }, 2, 1).data], [7, 8, 9, 7, 8, 9]);
  const wide = image(300, 200, WHITE);
  assert.throws(() => compareImages(wide, image(200, 200, WHITE), { area: area(300, 200), threshold: 32 }), /reference is 200 x 200 px and the target area is 300 x 200 document pixels.*differ by 33\.3%.*fit/);
  assert.equal(compareImages(wide, image(301, 200, WHITE), { area: area(300, 200), threshold: 32 }).score, 1, 'within 1%');
  const stretched = compareImages(wide, image(200, 200, WHITE), { area: area(300, 200), threshold: 32, fit: 'stretch' });
  assert.deepEqual([stretched.size, stretched.score], [[300, 200], 1]);
  // contain: a 100 x 100 reference covers the centred 200 x 200 px of the render; the black margins are not compared.
  const framed = image(300, 200, (x) => (x < 50 || x >= 250 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const contained = compareImages(framed, image(100, 100, WHITE), { area: [10, 20, 600, 400], threshold: 32, fit: 'contain' });
  assert.deepEqual([contained.size, contained.area, contained.diffRatio], [[200, 200], [110, 20, 400, 400], 0]);
  const reduced = compareImages(image(400, 200, WHITE), image(200, 100, WHITE), { area: area(400, 200), threshold: 32, longest: 200 });
  assert.deepEqual(reduced.size, [200, 100]);
});

test('FR-510 the heatmap is a JPEG at the compared size, grey where equal and red where different', () => {
  const r = compareImages(image(32, 16, square(0, 0, 8)), image(32, 16, WHITE), { area: area(32, 16), threshold: 32 });
  const map = jpeg.decode(heatmap(r.compared, r.deltas, 32), { useTArray: true });
  assert.deepEqual([map.width, map.height], [32, 16]);
  const px = (x: number, y: number) => [...map.data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 3)];
  const [rd, gd, bd] = px(3, 3);
  assert.ok(rd > 200 && gd < 60 && bd < 60, `red: ${px(3, 3)}`);
  assert.ok(px(20, 10).every((v) => v > 230), `light: ${px(20, 10)}`);
});

// 3. The tool over the fake

/** A server over the fake whose exports write white PNGs of the requested size; the Desktop is a temporary folder. */
async function setup(ctx: TestContext, o: { access?: boolean; renderImage?: string } = {}) {
  const desktop = temp();
  const d = fakeDocument({ spreads: [[]] });
  const modules = fakeFiles(d.modules, d.doc, { desktop, access: o.access });
  const exports: { size: { width: number; height: number } }[] = [];
  d.doc.export = (path: string, _options: unknown, where: { spreads?: string }, size: { width: number; height: number }) => {
    const file = where.spreads ? path.replace(/\.png$/, '_1.png') : path; // R-48 item 2
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, png(size.width, size.height));
    exports.push({ size: { width: size.width, height: size.height } }); // a plain object outside the script's realm
  };
  const fake = await startFake({ preamble: 'p', modules, renderImage: o.renderImage });
  const upstream = new Upstream([fake.url]);
  const server = createServer(upstream);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  ctx.after(async () => {
    await client.close();
    await server.close();
    await upstream.close();
    await fake.close();
  });
  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'compare_to_reference', arguments: args })) as CallToolResult;
  const out = temp();
  const file = (name: string, data: Buffer) => {
    writeFileSync(join(out, name), data);
    return join(out, name);
  };
  return { fake, client, call, desktop, exports, file };
}

test('FR-501 FR-502 target rules and the reference are checked before any script', async (ctx) => {
  const t = await setup(ctx);
  const ref = t.file('ref.png', png(40, 30));
  for (const [args, message] of [
    [{ reference: ref, ids: ['a'] }, /ids belongs to target nodes/],
    [{ reference: ref, target: 'nodes' }, /target nodes needs ids/],
    [{ reference: ref, target: 'nodes', ids: ['a'], spreadIndex: 0 }, /spreadIndex applies only to target spread/],
    [{ reference: 'ref.png' }, /not a path on this computer/],
    [{ reference: join(tmpdir(), 'missing-ttam.png') }, /does not exist/],
    [{ reference: t.file('bad.png', Buffer.from('text')) }, /bad\.png is not a PNG or JPEG file/],
  ] as const) {
    const r = await t.call(args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(textOf(r), message);
  }
  assert.equal(t.fake.executed, 0);
});

test('FR-503 FR-510 the spread renders as PNG at the smaller of maxSize and the reference, and no staged file remains', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call({ reference: t.file('ref.png', png(400, 300)) });
  assert.equal(r.isError, undefined, textOf(r));
  assert.deepEqual(jsonOf(r), { score: 1, diffRatio: 0, threshold: 32, render: 'png', size: [400, 300], area: [0, 0, 800, 600], reference: [400, 300], regions: [] });
  assert.deepEqual(t.exports.at(-1)!.size, { width: 400, height: 300 });
  assert.equal(r.content[1].type, 'image');
  assert.equal((r.content[1] as { mimeType: string }).mimeType, 'image/jpeg');
  assert.deepEqual(readdirSync(t.desktop), []);
  const small = await t.call({ reference: t.file('big.png', png(1600, 1200)), maxSize: 200, heatmap: false });
  assert.deepEqual(jsonOf(small).size, [200, 150]);
  assert.equal(small.content.length, 1, 'no heatmap');
});

test('FR-504 without file access a spread is compared with the native JPEG render; nodes fail naming the setting', async (ctx) => {
  const native = jpeg.encode({ width: 800, height: 600, data: Buffer.from(image(800, 600, WHITE).data) }, 90).data.toString('base64');
  const t = await setup(ctx, { access: false, renderImage: native });
  const r = await t.call({ reference: t.file('ref.png', png(400, 300)) });
  assert.equal(r.isError, undefined, textOf(r));
  const j = jsonOf(r);
  assert.deepEqual([j.render, j.size, j.area, j.diffRatio], ['jpeg', [400, 300], [0, 0, 800, 600], 0]);
  assert.match(j.note, /Access files on your Desktop.*Affinity's JPEG render is compared/);
  assert.ok(t.fake.calls.some((c) => c.tool === 'render_spread'));
  const nodes = await t.call({ reference: t.file('n.png', png(40, 30)), target: 'nodes', ids: ['a'] });
  assert.equal(nodes.isError, true);
  assert.match(textOf(nodes), /Access files on your Desktop/);
});

test('FR-511 the instructions and the description name compare_to_reference; 14 tools', async (ctx) => {
  const t = await setup(ctx);
  assert.match(INSTRUCTIONS, /compare_to_reference: its regions are in document pixels/);
  assert.ok(INSTRUCTIONS.length <= 1500, `${INSTRUCTIONS.length} characters`);
  const { tools } = await t.client.listTools();
  assert.equal(tools.length, 14);
  assert.match(tools.find((x) => x.name === 'compare_to_reference')!.description!, /in document pixels/);
});
