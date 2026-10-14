// Slice 003 unit tests. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Upstream } from '../src/affinity.js';
import { parsePath, type Subpath } from '../src/svgpath.js';
import { createServer } from '../src/tools.js';
import { fakeDocument, fakeNode, startFake } from './fake-affinity.js';

const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');

async function setup(ctx: TestContext, modules: Record<string, unknown> = fakeDocument({ spreads: [[]] }).modules) {
  const fake = await startFake({ preamble: 'p', modules });
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
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      return (await client.callTool({ name, arguments: args })) as CallToolResult;
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true } as CallToolResult;
    }
  };
  /** Runs a body in the fake and returns its result: the pure helpers of the read and write library. */
  const run = async (code: string) => {
    const r = await call('run_script', { code, mutates: false });
    assert.equal(r.isError, undefined, textOf(r));
    return JSON.parse(textOf(r)).result;
  };
  return { fake, client, call, run };
}

const round = (p: Subpath[]) => JSON.parse(JSON.stringify(p, (_, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
const cubicAt = (p0: number[], s: number[], t: number) => {
  const [x1, y1, x2, y2, x, y] = s.slice(1) as number[];
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x, u * u * u * p0[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y];
};

// 1. Path data

test('FR-310 lines, horizontal and vertical moves and close, absolute and relative', () => {
  const abs = parsePath('M10 20 L30 40 H50 V60 Z');
  assert.deepEqual(abs, [{ start: [10, 20], segments: [['L', 30, 40], ['L', 50, 40], ['L', 50, 60]], closed: true }]);
  assert.deepEqual(parsePath('m10 20 l20 20 h20 v20 z'), abs);
});

test('FR-310 implicit repetition and the line-to after a move-to', () => {
  assert.deepEqual(parsePath('M0 0 10 10 20 0')[0].segments, [['L', 10, 10], ['L', 20, 0]]);
  assert.deepEqual(parsePath('m5 5 10 10 10 -10')[0].segments, [['L', 15, 15], ['L', 25, 5]]);
  assert.deepEqual(parsePath('M0 0 L1 1 2 2')[0].segments, [['L', 1, 1], ['L', 2, 2]]);
});

test('FR-310 cubic and smooth cubic segments reflect the previous control point', () => {
  const [p] = parsePath('M0 0 C10 0 20 10 20 20 S30 40 40 40 s10 0 10 10');
  assert.deepEqual(p.segments, [
    ['C', 10, 0, 20, 10, 20, 20],
    ['C', 20, 30, 30, 40, 40, 40],
    ['C', 50, 40, 50, 40, 50, 50],
  ]);
  assert.deepEqual(parsePath('M0 0 S10 10 20 0')[0].segments, [['C', 0, 0, 10, 10, 20, 0]]);
});

test('FR-310 quadratic segments become exact cubic segments, with smooth reflection', () => {
  assert.deepEqual(round(parsePath('M0 0 Q10 10 20 0 T40 0')), [
    {
      start: [0, 0],
      segments: [
        ['C', 6.667, 6.667, 13.333, 6.667, 20, 0],
        ['C', 26.667, -6.667, 33.333, -6.667, 40, 0],
      ],
      closed: false,
    },
  ]);
  assert.deepEqual(round(parsePath('m0 0 q10 10 20 0')), round(parsePath('M0 0 Q10 10 20 0')));
});

test('FR-310 arcs become cubic segments of at most 90 degrees that stay on the ellipse', () => {
  const quarter = parsePath('M100 0 A100 100 0 0 1 0 100')[0];
  assert.equal(quarter.segments.length, 1);
  assert.deepEqual(quarter.segments[0].slice(5), [0, 100]);
  const three = parsePath('M100 0 A100 100 0 1 0 0 100')[0];
  assert.equal(three.segments.length, 3);
  for (const p of [quarter, three]) {
    let from: number[] = p.start;
    for (const s of p.segments) {
      const [x, y] = cubicAt(from, s as number[], 0.5);
      assert.ok(Math.abs(Math.hypot(x, y) - 100) < 0.1, `radius ${Math.hypot(x, y)}`);
      from = s.slice(5) as number[];
    }
  }
  const rotated = parsePath('M0 0 a50 25 90 0 1 0 100')[0];
  assert.deepEqual(rotated.segments.at(-1)?.slice(5), [0, 100]);
});

test('FR-310 arcs with zero radius become lines and radii too small are scaled up', () => {
  assert.deepEqual(parsePath('M0 0 A0 5 0 0 1 10 0')[0].segments, [['L', 10, 0]]);
  const half = parsePath('M0 0 A1 1 0 0 1 100 0')[0];
  assert.equal(half.segments.length, 2);
  const [x, y] = cubicAt([0, 0], half.segments[0] as number[], 1);
  assert.ok(Math.abs(x - 50) < 0.01 && Math.abs(Math.abs(y) - 50) < 0.01, `${x} ${y}`);
  assert.deepEqual(parsePath('M5 5 A10 10 0 0 1 5 5')[0].segments, []);
});

test('FR-310 compact numbers, exponents and arc flags without separators', () => {
  assert.deepEqual(parsePath('M.5.5L-1e1-2')[0], { start: [0.5, 0.5], segments: [['L', -10, -2]], closed: false });
  const a = round(parsePath('M0 0a5 5 0 0010 0'));
  assert.deepEqual(a[0].segments.at(-1).slice(5), [10, 0]);
});

test('FR-310 a command after close starts a new subpath at the start point; move-to starts another', () => {
  const p = parsePath('M0 0 L10 0 Z L0 10 M5 5 L6 6');
  assert.deepEqual(p, [
    { start: [0, 0], segments: [['L', 10, 0]], closed: true },
    { start: [0, 0], segments: [['L', 0, 10]], closed: false },
    { start: [5, 5], segments: [['L', 6, 6]], closed: false },
  ]);
});

test('FR-310 invalid path data is refused with the reason', () => {
  assert.throws(() => parsePath(''), /empty/);
  assert.throws(() => parsePath('L10 10'), /must start with M/);
  assert.throws(() => parsePath('M0 0 X5'), /Unknown command "X"/);
  assert.throws(() => parsePath('M0 0 L10'), /expects 2 numbers/);
  assert.throws(() => parsePath('M0 0 A5 5 0 2 0 10 10'), /flag/);
});

// 2. Schemas and descriptions

const rect = { type: 'rect', box: [0, 0, 10, 10] };
const layers = (depth: number): object => (depth === 1 ? { type: 'layer', children: [rect] } : { type: 'layer', children: [layers(depth - 1)] });

test('FR-301 invalid input is refused before any script runs', async (ctx) => {
  const t = await setup(ctx);
  const cases: [string, Record<string, unknown>, RegExp?][] = [
    ['create_nodes', { nodes: [{ ...rect, colour: '#ffffff' }] }, /colour/],
    ['create_nodes', { nodes: [{ ...rect, fill: '#12345' }] }],
    ['create_nodes', { nodes: [{ ...rect, opacity: 2 }] }],
    ['create_nodes', { nodes: [{ type: 'rect' }] }, /box/],
    ['create_nodes', { nodes: [{ type: 'text', text: 'x' }] }, /at/],
    ['create_nodes', { nodes: [{ type: 'text', at: [0, 0] }] }, /text or runs/],
    ['create_nodes', { nodes: [{ type: 'text', at: [0, 0], text: 'a', runs: [{ text: 'b' }] }] }, /text or runs/],
    ['create_nodes', { nodes: [{ type: 'text', at: [0, 0], text: 'a', style: 'Bold' }] }, /family/],
    ['create_nodes', { nodes: [{ type: 'shape', kind: 'Heart', box: [0, 0, 5, 5], sides: 5 }] }, /sides/],
    ['create_nodes', { nodes: [{ ...rect, children: [rect] }] }, /children/],
    ['create_nodes', { nodes: [layers(11)] }, /10 levels/],
    ['create_nodes', { nodes: [{ type: 'layer', children: Array(250).fill(rect) }, { type: 'layer', children: Array(250).fill(rect) }] }, /500/],
    ['create_nodes', { nodes: [{ ...rect, id: 'a' }, { ...rect, id: 'a' }] }, /twice/],
    ['create_nodes', { nodes: [{ ...rect, id: 'a/b' }] }],
    ['create_nodes', { nodes: [{ type: 'path', d: 'M0 0 X' }] }, /Unknown command/],
    ['create_nodes', { nodes: [{ type: 'rect', box: [0, 0, 0, 10] }] }],
    ['update_nodes', { updates: [{ id: 'x' }] }, /set or move/],
    ['update_nodes', { updates: [{ id: 'x', set: { colour: '#fff' } }] }, /colour/],
    ['update_nodes', { updates: [{ id: 'x', set: { text: 'a', runs: [{ text: 'b' }] } }] }, /text or runs/],
    ['delete_nodes', { ids: [] }],
    ['undo', { steps: 0 }],
    ['undo', { steps: 101 }],
  ];
  for (const [tool, args, reason] of cases) {
    const r = await t.call(tool, args);
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args).slice(0, 80)}`);
    if (reason) assert.match(textOf(r), reason, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(t.fake.calls.filter((c) => c.tool === 'execute_script').length, 0);
});

test('FR-327 the write tool descriptions state the undo-step, all-or-nothing and ID rules and baseline placement', async (ctx) => {
  const t = await setup(ctx);
  const { tools } = await t.client.listTools();
  const d = (name: string) => tools.find((x) => x.name === name)?.description ?? '';
  for (const name of ['create_nodes', 'update_nodes', 'delete_nodes']) {
    assert.match(d(name), /undo step/, name);
    assert.match(d(name), /restored/, name);
  }
  assert.match(d('create_nodes'), /baseline/);
  assert.match(d('create_nodes'), /stable/);
  assert.match(d('update_nodes'), /stable/);
  assert.match(d('undo'), /redo/);
});

// 3. Pure helpers of the write library

test('FR-303 waves: new layers that contain new layers add one undo step per level', async (ctx) => {
  const t = await setup(ctx);
  const count = (nodes: object[]) => t.run(`return ttam.plan(${JSON.stringify(nodes)}).length`);
  const card = { type: 'layer', children: [rect, { type: 'text', at: [0, 0], text: 'x' }] };
  assert.equal(await count([rect, rect]), 1);
  assert.equal(await count([card, card]), 1);
  assert.equal(await count([{ type: 'layer', children: [card] }]), 2);
  assert.equal(await count([{ type: 'layer', children: [{ type: 'layer', children: [card] }] }]), 3);
  assert.equal(await count([{ type: 'layer', children: [card, card, rect] }, rect]), 2);
  const plan = await t.run(`return ttam.plan(${JSON.stringify([{ id: 'L', type: 'layer', children: [card] }])})`);
  assert.equal(plan[0][0].items[0].inline.length, 0);
  assert.equal(plan[1][0].parent, 'L');
  assert.equal(plan[1][0].items[0].inline.length, 2);
});

test('FR-306 generated IDs use the type and the lowest unused number', async (ctx) => {
  const t = await setup(ctx);
  assert.deepEqual(await t.run("const used = new Set(['rect1', 'rect2', 'text1']); return [ttam.nextId('rect', used), ttam.nextId('rect', used), ttam.nextId('text', used), ttam.nextId('layer', used)]"), ['rect3', 'rect4', 'text2', 'layer1']);
});

test('FR-312 fonts match installed families and styles in any case and suggest close names', async (ctx) => {
  const t = await setup(ctx);
  const families = [
    ['Arial', [['Regular', 400, false, 'ArialMT'], ['Italic', 400, true, 'Arial-ItalicMT'], ['Bold', 700, false, 'Arial-BoldMT']]],
    ['Arial Black', [['Regular', 900, false, 'Arial-Black']]],
    ['DejaVu Serif', [['Book', 400, false, 'DejaVuSerif'], ['Bold', 700, false, 'DejaVuSerif-Bold']]],
    ['Georgia', [['Bold', 700, false, 'Georgia-Bold'], ['Regular', 400, false, 'Georgia']]],
    ['Helvetica', [['Regular', 400, false, 'Helvetica']]],
    ['Times New Roman', [['Regular', 400, false, 'TimesNewRomanPSMT']]],
    ['Verdana', [['Regular', 400, false, 'Verdana']]],
  ].map(([name, styles]) => ({ name, fonts: (styles as [string, number, boolean, string][]).map(([traitsName, weight, isItalic, postscriptName]) => ({ traitsName, weight, isItalic, postscriptName })) }));
  const match = (family: string, style?: string) => t.run(`return ttam.matchFont(${JSON.stringify(families)}, ${JSON.stringify(family)}, ${JSON.stringify(style ?? null)})`);
  assert.deepEqual(await match('arial', 'BOLD'), { family: 'Arial', style: 'Bold', postscriptName: 'Arial-BoldMT' });
  assert.deepEqual(await match('Georgia'), { family: 'Georgia', style: 'Regular', postscriptName: 'Georgia' }); // weight 400, not italic
  assert.deepEqual(await match('DejaVu Serif'), { family: 'DejaVu Serif', style: 'Book', postscriptName: 'DejaVuSerif' });
  const missing = await match('Helvetica Neue');
  assert.equal(missing.missing, 'family');
  assert.equal(missing.suggestions.length, 5);
  assert.equal(missing.suggestions[0], 'Helvetica');
  assert.deepEqual(await match('DejaVu Serif', 'Italic'), { missing: 'style', family: 'DejaVu Serif', styles: ['Book', 'Bold'] });
});

test('FR-313 FR-319 gradient, rotation and box matrices', async (ctx) => {
  const t = await setup(ctx);
  const r = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000 + 0);
  assert.deepEqual(r(await t.run("return ttam.gradientData([20, 20, 160, 100], 'Linear', 0)")), [160, 0, 20, 0, 160, 70]);
  assert.deepEqual(r(await t.run("return ttam.gradientData([20, 160, 160, 100], 'Linear', 90)")), [0, -100, 100, 100, 0, 160]);
  assert.deepEqual(r(await t.run("return ttam.gradientData([220, 160, 160, 100], 'Radial', 0)")), [80, 0, 300, 0, 50, 210]);
  assert.deepEqual(r(await t.run('return ttam.rotationData(150, 120, 90)')), [0, -1, 270, 1, 0, -30]);
  assert.deepEqual(r(await t.run('return ttam.boxData([10, 10, 100, 50], [20, 30, 200, 25])')), [2, 0, 0, 0, 0.5, 25]);
  assert.deepEqual(r(await t.run('return ttam.boxData([10, 10, 100, 0], [20, 30, 50, 10])')), [0.5, 0, 15, 0, 1, 20]);
});

test('FR-320 paragraph ranges count code points and include the break', async (ctx) => {
  const t = await setup(ctx);
  assert.deepEqual(await t.run("return ttam.paragraphRanges('A🎨\\nTwo\\n')"), [
    [0, 3],
    [3, 7],
    [7, 7],
  ]);
  assert.deepEqual(await t.run("return ttam.paragraphRanges('One')"), [[0, 3]]);
});

test('FR-302 atomic undoes back to the start and says the document was restored', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.run(`const doc = { history: { position: 3 }, undo() { this.history.position--; } };
let message;
try { ttam.atomic(doc, () => { doc.history.position += 2; throw new Error('COMMAND_FAILED'); }); } catch (e) { message = e.message; }
return { position: doc.history.position, message, ok: ttam.atomic(doc, () => 7) };`);
  assert.equal(r.position, 3);
  assert.match(r.message, /COMMAND_FAILED/);
  assert.match(r.message, /restored/);
  assert.equal(r.ok, 7);
});

// 4. No document, read model corrections

test('FR-304 the write tools need an open document', async (ctx) => {
  const t = await setup(ctx, fakeDocument({ spreads: [], current: null }).modules);
  for (const [tool, args] of [
    ['create_nodes', { nodes: [rect] }],
    ['update_nodes', { updates: [{ id: 'a', set: { name: 'b' } }] }],
    ['delete_nodes', { ids: ['a'] }],
    ['undo', {}],
  ] as const) {
    const r = await t.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(textOf(r), /No document is open/, tool);
  }
});

test('FR-218 an unfilled shape reports fill null without reading its brush descriptor', async (ctx) => {
  const doc = fakeDocument({ spreads: [[fakeNode('ShapeNode', { shape: 'Rectangle', noBrush: true }), fakeNode('ContainerNode')]] });
  const t = await setup(ctx, doc.modules);
  const [shape, layer] = JSON.parse(textOf(await t.call('get_nodes', { ids: ['0/0', '0/1'] })));
  assert.equal(shape.fill, null);
  assert.equal('fill' in layer, false);
});

test('FR-325 FR-326 get_nodes reports dash only for dashed lines and text sizes scaled by the node', async (ctx) => {
  const doc = fakeDocument({
    spreads: [
      [
        fakeNode('ShapeNode', { shape: 'Rectangle', pen: '#000000ff', width: 2, dash: [1, 1], lineType: 'Solid' }),
        fakeNode('ShapeNode', { shape: 'Rectangle', pen: '#000000ff', width: 2, dash: [4, 2] }),
        fakeNode('ArtTextNode', { text: 'Hi', runs: [[0, 2, 'Arial', 'Regular', 400, false, 12, '#000000ff']], paragraphs: [[0, 2, 'Left']], scale: 2 }),
      ],
    ],
  });
  const t = await setup(ctx, doc.modules);
  const r = await t.call('get_nodes', { ids: ['0/0', '0/1', '0/2'] });
  const [solid, dashed, text] = JSON.parse(textOf(r));
  assert.equal('dash' in solid.stroke, false);
  assert.deepEqual(dashed.stroke.dash, [4, 2]);
  assert.equal(text.text.runs[0].size, 24);
});
