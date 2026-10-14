// Slice 002 unit tests. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Upstream } from '../src/affinity.js';
import { createServer } from '../src/tools.js';
import { en, fakeDocument, fakeNode, gradient, NO_EXTENT, startFake, type FakeOptions, type NodeProps } from './fake-affinity.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');

async function setup(ctx: TestContext, modules: Record<string, unknown>, options: FakeOptions = {}) {
  const fake = await startFake({ preamble: 'p', modules, ...options });
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
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const json = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    assert.equal(r.isError, undefined, textOf(r));
    return JSON.parse(textOf(r));
  };
  return { fake, client, call, json };
}

// Fixture: spread 0 lists 11 nodes back to front; spread 1 holds two tagged nodes. Every assignment lands in `log`.
const log: string[] = [];
const N = (cls: string, p: NodeProps = {}, kids: object[] = []) => fakeNode(cls, p, kids, log);
const shadow = { type: en('OuterShadow'), enabled: true, opacity: 0.5, blendMode: en('Multiply'), radius: 4, colour: { rgba8: { r: 0, g: 0, b: 0, alpha: 255 } }, offset: 3, angle: Math.PI / 4, intensity: 0 };
const blur = { type: en('GaussianBlur'), enabled: false, opacity: 1, blendMode: en('Normal'), radius: 2.5 };
const deepDot = N('ShapeNode', { name: 'Deep dot', shape: 'Ellipse', tag: 'd2', box: [300, 300, 10, 10], fill: '#000000ff' });
const styled = N('ShapeNode', {
  name: 'Styled',
  shape: 'Ellipse',
  box: [89.80762113533163, 409.8076211353316, 106.6025403784439, 84.64101615137758],
  fill: '#ff8c00ff',
  locked: true,
  rotation: Math.PI / 6,
  opacity: 0.5,
  blend: 'Multiply',
  effects: [shadow, blur],
});
const fixture = fakeDocument({
  log,
  spreads: [
    [
      N('ShapeNode', { name: 'Red rect', shape: 'Rectangle', tag: 'r1', box: [20, 20, 120, 80], fill: '#dc2828ff' }),
      N('ShapeNode', { name: 'Blue ellipse', shape: 'Ellipse', box: [160, 20, 120, 80], visibleBox: [158, 18, 124, 84], fill: '#2850dcff', pen: '#000000ff', width: 4, dash: [3, 1] }),
      N('ShapeNode', { name: 'Gradient rect', shape: 'Rectangle', box: [540, 20, 120, 80], fill: gradient(0, [[0, '#ff0000ff'], [1, '#0000ffff']]) }),
      N('ArtTextNode', {
        name: 'Two-run text',
        box: [22.63671875, 174.23046875, 166.67578125, 26.19140625],
        text: 'Hello World',
        runs: [
          [0, 6, 'Arial', 'Bold', 700, false, 36, '#c80000ff'],
          [6, 9, 'DejaVu Serif', 'Book', 400, false, 24, '#0000c8ff'],
          [9, 11, 'DejaVu Serif', 'Book', 400, false, 24, '#0000c8ff'],
        ],
        paragraphs: [[0, 11, 'Left']],
      }),
      N('FrameTextNode', {
        name: 'Frame text',
        box: [300, 150, 160, 80],
        text: 'One\nTwo\nThree',
        runs: [[0, 13, 'Arial', 'Regular', 400, false, 12, '#000000ff']],
        paragraphs: [
          [0, 8, 'Left'],
          [8, 13, 'Center'],
        ],
      }),
      N('ContainerNode', { name: 'My Layer', box: [160, 300, 150, 40] }, [
        N('ShapeNode', { name: 'Hidden square', shape: 'Rectangle', hidden: true, box: [160, 300, 40, 40], fill: '#ff00ffff' }),
        N('ContainerNode', { name: 'Inner layer', box: [300, 300, 10, 10] }, [deepDot]),
      ]),
      N('ContainerNode', { name: 'Empty layer', box: NO_EXTENT }, [N('ShapeNode', { name: 'Ghost', shape: 'Rectangle', hidden: true })]),
      styled,
      N('ShapeNode', { name: 'Artboard 1', shape: 'Rectangle', artboard: true, tag: 'd2', box: [0, 0, 400, 300], fill: '#ffffffff' }),
      N('ShapeNode', { name: 'Heart', shape: 'Heart', box: [600, 400, 50, 50] }),
      N('ShapeNode', { name: 'Bitmap fill', shape: 'Rectangle', fill: { fillType: en('Bitmap'), fill: {} } }),
    ],
    [N('ShapeNode', { name: 'Second spread rect', shape: 'Rectangle', tag: 'r1' }), N('PolyCurveNode', { name: 'Tagged path', tag: 'z9' })],
  ],
  selection: [styled, deepDot],
  fonts: [
    ['Arial-BoldMT', true],
    ['ArialMT', true],
    ['DejaVuSerif-Italic', false],
  ],
  families: [
    ['Zapf Dingbats', [['Regular', 400, false]]],
    [
      'Arial',
      [
        ['Regular', 400, false],
        ['Italic', 400, true],
        ['Bold', 700, false],
        ['Bold Italic', 700, true],
      ],
    ],
    ['DejaVu Serif', [['Book', 400, false], ['Bold', 700, false]]],
    ['arial Narrow', [['Regular', 400, false]]],
  ],
});

const DEPTH_2 = [
  { id: 'r1', type: 'rect', name: 'Red rect', box: [20, 20, 120, 80] },
  { id: '0/1', type: 'ellipse', name: 'Blue ellipse', box: [160, 20, 120, 80] },
  { id: '0/2', type: 'rect', name: 'Gradient rect', box: [540, 20, 120, 80] },
  { id: '0/3', type: 'text', kind: 'art', name: 'Two-run text', box: [22.64, 174.23, 166.68, 26.19] },
  { id: '0/4', type: 'text', kind: 'frame', name: 'Frame text', box: [300, 150, 160, 80] },
  {
    id: '0/5',
    type: 'layer',
    name: 'My Layer',
    box: [160, 300, 150, 40],
    children: [
      { id: '0/5/0', type: 'rect', name: 'Hidden square', box: [160, 300, 40, 40], hidden: true },
      { id: '0/5/1', type: 'layer', name: 'Inner layer', box: [300, 300, 10, 10], childCount: 1 },
    ],
  },
  { id: '0/6', type: 'layer', name: 'Empty layer', box: null, children: [{ id: '0/6/0', type: 'rect', name: 'Ghost', box: [0, 0, 10, 10], hidden: true }] },
  { id: '0/7', type: 'ellipse', name: 'Styled', box: [89.81, 409.81, 106.6, 84.64], locked: true },
  { id: '0/8', type: 'artboard', name: 'Artboard 1', box: [0, 0, 400, 300] },
  { id: '0/9', type: 'shape', kind: 'Heart', name: 'Heart', box: [600, 400, 50, 50] },
  { id: '0/10', type: 'rect', name: 'Bitmap fill', box: [0, 0, 10, 10] },
];

// 1. get_document

test('FR-206 FR-207 FR-208 get_document reports the document, the spread with its artboards, the selection and the fonts', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const d = await t.json('get_document');
  assert.deepEqual(d.document, { title: 'Fixture', path: null, dpi: 72, units: 'Pixel', width: 800, height: 600, colorFormat: 'RGBA8', dirty: false, spreads: 2, currentSpread: 0 });
  assert.deepEqual(d.spread, { index: 0, box: [0, 0, 800, 600], artboards: [{ id: '0/8', name: 'Artboard 1', box: [0, 0, 400, 300] }] });
  assert.deepEqual(d.selection, ['d2', '0/7']);
  assert.deepEqual(d.fonts, [
    { name: 'Arial-BoldMT', installed: true },
    { name: 'ArialMT', installed: true },
    { name: 'DejaVuSerif-Italic', installed: false },
  ]);
  const other = await t.json('get_document', { spreadIndex: 1 });
  assert.deepEqual(other.spread.artboards, []);
  assert.equal(other.spread.index, 1);
});

test('FR-209 FR-202 FR-213 FR-215 get_document lists the nodes back to front to depth 2 by default', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const d = await t.json('get_document');
  assert.deepEqual(d.nodes, DEPTH_2);
  assert.equal(d.omitted, undefined);
  assert.equal(d.hint, undefined);
});

test('FR-209 depth 1 reports childCount instead of children; depth 3 reaches the deepest node', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const one = await t.json('get_document', { depth: 1 });
  assert.equal(one.nodes.length, 11);
  assert.deepEqual(one.nodes[5], { id: '0/5', type: 'layer', name: 'My Layer', box: [160, 300, 150, 40], childCount: 2 });
  assert.equal(one.nodes[6].childCount, 1);
  const three = await t.json('get_document', { depth: 3 });
  assert.deepEqual(three.nodes[5].children[1].children, [{ id: 'd2', type: 'ellipse', name: 'Deep dot', box: [300, 300, 10, 10] }]);
  assert.equal(three.nodes[5].children[1].childCount, undefined);
});

test('FR-210 limit stops the listing, counts the omitted nodes and marks a parent whose children were cut', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const d = await t.json('get_document', { limit: 7 });
  assert.deepEqual(
    d.nodes.map((n: { id: string }) => n.id),
    ['r1', '0/1', '0/2', '0/3', '0/4', '0/5'],
  );
  assert.deepEqual(d.nodes[5].children.map((n: { id: string }) => n.id), ['0/5/0']);
  assert.equal(d.nodes[5].childCount, 2);
  assert.equal(d.omitted, 7);
  for (const word of ['depth', 'query', 'get_nodes']) assert.ok(d.hint.includes(word), word);
});

test('FR-203 a duplicated tag stays with the first node in document order, depth first and across spreads', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const d = await t.json('get_document', { depth: 3 });
  assert.equal(d.nodes[0].id, 'r1');
  assert.equal(d.nodes[5].children[1].children[0].id, 'd2'); // 0/5/1/0 comes before 0/8 in document order
  assert.equal(d.nodes[8].id, '0/8');
  const second = await t.json('get_document', { spreadIndex: 1 });
  assert.deepEqual(
    second.nodes.map((n: { id: string }) => n.id),
    ['1/0', 'z9'],
  );
});

test('FR-214 types and kinds follow the type table', async (ctx) => {
  const rows: [string, NodeProps, string, string?][] = [
    ['ShapeNode', { shape: 'Rectangle' }, 'rect'],
    ['ShapeNode', { shape: 'Ellipse' }, 'ellipse'],
    ['ShapeNode', { shape: 'Star' }, 'star'],
    ['ShapeNode', { shape: 'Heart' }, 'shape', 'Heart'],
    ['ShapeNode', { shape: 'Rectangle', artboard: true }, 'artboard'],
    ['PolyCurveNode', {}, 'path'],
    ['ArtTextNode', {}, 'text', 'art'],
    ['FrameTextNode', {}, 'text', 'frame'],
    ['TableTextNode', {}, 'text', 'Table'],
    ['ImageNode', {}, 'image'],
    ['ContainerNode', {}, 'layer'],
    ['GroupNode', {}, 'group'],
    ['RasterNode', {}, 'raster'],
    ['PatternRasterNode', {}, 'raster'],
    ['CurvesAdjustmentRasterNode', {}, 'adjustment', 'Curves'],
    ['GaussianBlurFilterRasterNode', {}, 'filter', 'GaussianBlur'],
    ['EmbeddedDocumentNode', {}, 'other', 'EmbeddedDocumentNode'],
  ];
  const doc = fakeDocument({ spreads: [rows.map(([cls, p]) => fakeNode(cls, p))] });
  const t = await setup(ctx, doc.modules);
  const d = await t.json('get_document', { depth: 1 });
  assert.deepEqual(
    d.nodes.map((n: { type: string; kind?: string }) => [n.type, n.kind]),
    rows.map(([, , type, kind]) => [type, kind]),
  );
});

test('FR-211 query returns a flat list of the nodes at any depth that match every condition', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const ids = async (query: object, limit?: number) => {
    const d = await t.json('get_document', { query, ...(limit ? { limit } : {}) });
    assert.equal(d.nodes, undefined);
    return { ids: d.matches.map((n: { id: string }) => n.id), omitted: d.omitted };
  };
  assert.deepEqual(await ids({ type: 'ellipse' }), { ids: ['0/1', 'd2', '0/7'], omitted: undefined });
  assert.deepEqual((await ids({ name: 'LAYER' })).ids, ['0/5', '0/5/1', '0/6']);
  assert.deepEqual((await ids({ text: 'two' })).ids, ['0/4']); // text content, not the name "Two-run text"
  assert.deepEqual((await ids({ type: 'text', name: 'frame' })).ids, ['0/4']);
  assert.deepEqual(await ids({ type: 'ellipse' }, 2), { ids: ['0/1', 'd2'], omitted: 1 });
  const flat = await t.json('get_document', { query: { name: 'deep' } });
  assert.deepEqual(flat.matches, [{ id: 'd2', type: 'ellipse', name: 'Deep dot', box: [300, 300, 10, 10] }]);
});

test('FR-212 an unknown spread index names the number of spreads', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const r = await t.call('get_document', { spreadIndex: 5 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Spread 5 does not exist; the document has 2 spread/);
});

test('FR-205 get_document and get_nodes need an open document; list_fonts does not', async (ctx) => {
  const none = fakeDocument({ spreads: [], current: null, families: [['Arial', [['Regular', 400, false]]]] });
  const t = await setup(ctx, none.modules);
  for (const [tool, args] of [['get_document', {}], ['get_nodes', { ids: ['0/0'] }]] as const) {
    const r = await t.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(textOf(r), /No document is open/, tool);
  }
  assert.equal((await t.json('list_fonts')).total, 1);
});

// 2. get_nodes

test('FR-216 FR-222 get_nodes returns one entry per ID, in order, with canonical IDs, parent and child count', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const e = await t.json('get_nodes', { ids: ['0/7', 'r1', '0/0', 'nope', '1/0', 'd2', '0/8', '0/5', '9/9'] });
  assert.deepEqual(
    e.map((x: { id: string }) => x.id),
    ['0/7', 'r1', 'r1', 'nope', '1/0', 'd2', '0/8', '0/5', '9/9'],
  );
  assert.deepEqual(e[3], { id: 'nope', error: 'not found' });
  assert.deepEqual(e[8], { id: '9/9', error: 'not found' });
  assert.deepEqual(e[1], { id: 'r1', type: 'rect', name: 'Red rect', box: [20, 20, 120, 80], parent: null, childCount: 0, fill: '#dc2828ff', stroke: null });
  assert.equal(e[4].name, 'Second spread rect');
  assert.equal(e[5].parent, '0/5/1');
  assert.deepEqual(e[7], { id: '0/5', type: 'layer', name: 'My Layer', box: [160, 300, 150, 40], parent: null, childCount: 2, stroke: null });
});

test('FR-217 FR-221 get_nodes adds only fields that differ from the default, including effects', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const [s, e, empty] = await t.json('get_nodes', { ids: ['0/7', '0/1', '0/6'] });
  assert.deepEqual(s, {
    id: '0/7',
    type: 'ellipse',
    name: 'Styled',
    box: [89.81, 409.81, 106.6, 84.64],
    locked: true,
    parent: null,
    childCount: 0,
    rotation: 30,
    opacity: 0.5,
    blendMode: 'Multiply',
    fill: '#ff8c00ff',
    stroke: null,
    effects: [
      { type: 'OuterShadow', enabled: true, opacity: 0.5, blendMode: 'Multiply', radius: 4, color: '#000000ff', offset: 3, angle: 45, intensity: 0 },
      { type: 'GaussianBlur', enabled: false, opacity: 1, blendMode: 'Normal', radius: 2.5 },
    ],
  });
  assert.deepEqual(e.visibleBox, [158, 18, 124, 84]);
  assert.equal(empty.box, null);
  assert.equal('visibleBox' in empty, false);
  const hidden = (await t.json('get_nodes', { ids: ['0/5/0'] }))[0];
  assert.equal(hidden.hidden, true);
});

test('FR-218 fills: solid colour, gradient with stops, none and other fill types; text has no fill', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const [solid, grad, none, other, text, layer] = await t.json('get_nodes', { ids: ['r1', '0/2', '0/9', '0/10', '0/3', '0/5'] });
  assert.equal(solid.fill, '#dc2828ff');
  assert.deepEqual(grad.fill, {
    gradient: 'Linear',
    stops: [
      { at: 0, color: '#ff0000ff' },
      { at: 1, color: '#0000ffff' },
    ],
  });
  assert.equal(none.fill, null);
  assert.deepEqual(other.fill, { type: 'Bitmap' });
  assert.equal('fill' in text, false);
  assert.equal('fill' in layer, false);
});

test('FR-219 strokes report colour, width, alignment, cap, join and dash; no stroke is null', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const [stroked, plain] = await t.json('get_nodes', { ids: ['0/1', 'r1'] });
  assert.deepEqual(stroked.stroke, { color: '#000000ff', width: 4, align: 'Centre', cap: 'Butt', join: 'Round', dash: [3, 1] });
  assert.equal(plain.stroke, null);
});

test('FR-220 text runs merge equal ranges, sizes are points, run text follows code points, alignment per paragraph', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const [art, frame] = await t.json('get_nodes', { ids: ['0/3', '0/4'] });
  assert.deepEqual(art.text, {
    content: 'Hello World',
    runs: [
      { text: 'Hello ', family: 'Arial', style: 'Bold', weight: 700, italic: false, size: 36, color: '#c80000ff' },
      { text: 'World', family: 'DejaVu Serif', style: 'Book', weight: 400, italic: false, size: 24, color: '#0000c8ff' },
    ],
    align: ['Left'],
  });
  assert.deepEqual(frame.text.align, ['Left', 'Left', 'Center']);

  const hiDpi = fakeDocument({
    dpi: 144,
    spreads: [
      [
        fakeNode('ArtTextNode', {
          text: 'A🎨Bé',
          runs: [
            [0, 1, 'Arial', 'Regular', 400, false, 24, '#000000ff'],
            [1, 2, 'Noto Color Emoji', 'Regular', 400, false, 24, '#000000ff'],
            [2, 4, 'Arial', 'Regular', 400, false, 24, '#000000ff'],
          ],
          paragraphs: [[0, 4, 'Left']],
        }),
      ],
    ],
  });
  const h = await setup(ctx, hiDpi.modules);
  const [node] = await h.json('get_nodes', { ids: ['0/0'] });
  assert.deepEqual(
    node.text.runs.map((r: { text: string; size: number }) => [r.text, r.size]),
    [
      ['A', 12],
      ['🎨', 12],
      ['Bé', 12],
    ],
  );
});

// 3. list_fonts

test('FR-223 list_fonts counts, filters, sorts and limits families with their styles', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const all = await t.json('list_fonts');
  assert.equal(all.total, 4);
  assert.equal(all.matching, 4);
  assert.deepEqual(
    all.families.map((f: { family: string }) => f.family),
    ['Arial', 'arial Narrow', 'DejaVu Serif', 'Zapf Dingbats'],
  );
  const arial = await t.json('list_fonts', { query: 'ARIAL', limit: 1 });
  assert.deepEqual(arial, {
    total: 4,
    matching: 2,
    families: [
      {
        family: 'Arial',
        styles: [
          { style: 'Regular', weight: 400, italic: false },
          { style: 'Italic', weight: 400, italic: true },
          { style: 'Bold', weight: 700, italic: false },
          { style: 'Bold Italic', weight: 700, italic: true },
        ],
      },
    ],
  });
});

// 4. Read-only, descriptions, size

test('FR-201 the read tools assign no property and are marked read-only', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  await t.json('get_document', { depth: 20 });
  await t.json('get_document', { query: { text: 'o' } });
  await t.json('get_nodes', { ids: ['r1', '0/1', '0/2', '0/3', '0/4', '0/5', '0/6', '0/7', '0/8', '0/9', '0/10', '1/0', 'z9'] });
  await t.json('list_fonts');
  assert.deepEqual(log, []);
  const { tools } = await t.client.listTools();
  for (const name of ['get_document', 'get_nodes', 'list_fonts']) assert.equal(tools.find((x) => x.name === name)?.annotations?.readOnlyHint, true, name);
});

test('FR-201 a read interrupted in flight is repeated on a new session', async (ctx) => {
  const t = await setup(ctx, fixture.modules, { scriptDelayMs: 300 });
  await t.json('list_fonts');
  const pending = t.call('get_document');
  await sleep(100);
  await t.fake.restart();
  const r = await pending;
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(JSON.parse(textOf(r)).nodes.length, 11);
});

test('FR-204 the descriptions state that IDs with "/" are positions and other IDs are stable tags', async (ctx) => {
  const t = await setup(ctx, fixture.modules);
  const { tools } = await t.client.listTools();
  for (const name of ['get_document', 'get_nodes']) {
    const d = tools.find((x) => x.name === name)?.description ?? '';
    assert.match(d, /"\/"/, name);
    assert.match(d, /stable tag/, name);
    assert.match(d, /change when the tree changes/, name);
  }
});

test('NFR-202 500 nodes at depth 1 stay below 60,000 characters', async (ctx) => {
  const nodes = Array.from({ length: 500 }, (_, i) => fakeNode('ShapeNode', { name: 'Rectangle', shape: 'Rectangle', box: [1234.567 + i, 987.654, 120.5, 80.25] }));
  const doc = fakeDocument({ spreads: [nodes] });
  const t = await setup(ctx, doc.modules);
  const r = await t.call('get_document', { depth: 1 });
  const d = JSON.parse(textOf(r));
  assert.equal(d.nodes.length, 500);
  assert.ok(textOf(r).length < 60000, `length ${textOf(r).length}`);
});
