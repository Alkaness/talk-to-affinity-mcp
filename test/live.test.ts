// Live tests of slices 001 and 002 against a running Affinity (AFFINITY_LIVE=1). They create and close their own documents.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Upstream } from '../src/affinity.js';
import { createServer } from '../src/tools.js';

const LIVE = process.env.AFFINITY_LIVE === '1';
const live = (name: string, fn: (ctx: TestContext) => Promise<void>) => test(`live ${name}`, { skip: !LIVE && 'set AFFINITY_LIVE=1' }, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');
const jsonOf = (r: CallToolResult) => JSON.parse(textOf(r));
const BIN = new URL('../src/index.js', import.meta.url).pathname;

async function setup(ctx: TestContext, upstream = new Upstream(['http://127.0.0.1:6767/sse', 'http://[::1]:6767/sse'])) {
  const server = createServer(upstream);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'live-test', version: '0.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const documents: string[] = [];
  ctx.after(async () => {
    // Close the test's own documents first, while the session is still open.
    for (const id of documents) {
      await call('run_script', { code: `const d = require('/application.js').app.documents.all.find((x) => x.sessionUuid === '${id}'); if (d) d.close();` });
    }
    await client.close();
    await server.close();
    await upstream.close();
  });
  return { upstream, client, call, documents };
}

/** Creates a 400 x 300 px document; the setup's cleanup closes it without saving. */
async function newDocument(t: Awaited<ReturnType<typeof setup>>) {
  const r = await t.call('run_script', {
    code: "const { Document, NewDocumentOptions } = require('/document.js'); const { UnitType } = require('/units.js'); const o = NewDocumentOptions.createDefault(); o.units = UnitType.Pixel; o.width = 400; o.height = 300; o.dpi = 72; return Document.create(o).sessionUuid;",
  });
  const id = jsonOf(r).result as string;
  t.documents.push(id);
  return id;
}

const ADD_RECT = "const { app } = require('/application.js'); const { ShapeNodeDefinition, NodeChildType } = require('/nodes.js'); const { AddChildNodesCommandBuilder } = require('/commands.js'); const { ShapeRectangle } = require('/shapes.js'); const { Rectangle } = require('/geometry.js'); const { Colour } = require('/colours.js'); const doc = app.documents.current; const b = AddChildNodesCommandBuilder.create(); b.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), new Rectangle(20, 20, 100, 60), Colour.createRGBA8({ r: 200, g: 40, b: 40, alpha: 255 }))); b.setInsertionTarget(doc.currentSpread); doc.executeCommand(b.createCommand(true, NodeChildType.Main));";

live('NFR-104 FR-101 FR-126 first call connects within 2 s and reports Affinity', async (ctx) => {
  const t = await setup(ctx);
  const t0 = performance.now();
  const s = jsonOf(await t.call('get_status'));
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(s.connected, true);
  assert.match(s.affinity, /Affinity 3\./);
  assert.equal(typeof s.sdk, 'string');
  assert.equal(typeof s.permissions.fileSystem, 'boolean');
  assert.ok(Array.isArray(s.roots) && Array.isArray(s.documents));
});

live('FR-102 FR-125 an unused port is reported unreachable within 3 s', async (ctx) => {
  const t = await setup(ctx, new Upstream(['http://127.0.0.1:6768/sse']));
  const t0 = Date.now();
  const s = jsonOf(await t.call('get_status'));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(s.connected, false);
  assert.match(s.reason, /127\.0\.0\.1:6768/);
  assert.match(s.fix, /Enable MCP server/);
});

live('FR-103 the default URLs reach Affinity on 127.0.0.1', async (ctx) => {
  const saved = process.env.AFFINITY_MCP_URL;
  delete process.env.AFFINITY_MCP_URL;
  const upstream = new Upstream();
  if (saved !== undefined) process.env.AFFINITY_MCP_URL = saved;
  ctx.after(() => upstream.close());
  await upstream.connect();
  assert.equal(upstream.url, 'http://127.0.0.1:6767/sse');
});

live('FR-105 a session that ended is replaced on the next call', async (ctx) => {
  const t = await setup(ctx);
  await t.call('get_status');
  await (t.upstream as unknown as { session: { client: Client } }).session.client.close();
  const r = await t.call('run_script', { code: 'return 3' });
  assert.equal(jsonOf(r).result, 3);
});

live('FR-130 a real preamble-gate answer is handled by reading the preamble and repeating', async (ctx) => {
  class SkipFirstPreamble extends Upstream {
    skipped = false;
    protected override async readPreamble(client: Client) {
      if (!this.skipped) {
        this.skipped = true;
        return;
      }
      return super.readPreamble(client);
    }
  }
  const t = await setup(ctx, new SkipFirstPreamble(['http://127.0.0.1:6767/sse']));
  assert.equal(jsonOf(await t.call('run_script', { code: 'return 5' })).result, 5);
});

live('FR-106 a timed-out mutating script is reported as possibly run', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('run_script', { code: 'const t = Date.now(); while (Date.now() - t < 2500) {} return 1', timeoutMs: 1000 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /may have run/);
  await sleep(2500);
});

live('FR-108 FR-109 results and logs come back separately, including SDK objects', async (ctx) => {
  const t = await setup(ctx);
  await newDocument(t);
  const r = jsonOf(
    await t.call('run_script', {
      code: "console.log('hi'); const a = { big: 10n }; a.self = a; return { a, spread: require('/application.js').app.documents.current.currentSpread, none: undefined }",
    }),
  );
  assert.deepEqual(r.logs, ['hi']);
  assert.deepEqual(r.result, { a: { big: '10', self: '[Circular]' }, spread: '[object SpreadNode]' });
});

live('FR-110 FR-111 thrown errors and syntax errors are errors', async (ctx) => {
  const t = await setup(ctx);
  const thrown = await t.call('run_script', { code: "console.log('before'); throw new Error('boom')" });
  assert.equal(thrown.isError, true);
  assert.match(textOf(thrown), /boom[\s\S]*at [\s\S]*before/);
  const syntax = await t.call('run_script', { code: 'this is not js (' });
  assert.equal(syntax.isError, true);
  assert.match(textOf(syntax), /SyntaxError/);
});

live('FR-112 FR-113 size limits hold in Affinity', async (ctx) => {
  const t = await setup(ctx);
  assert.match(textOf(await t.call('run_script', { code: "return 'x'.repeat(262145)" })), /too large/);
  const many = jsonOf(await t.call('run_script', { code: 'for (let i = 0; i < 600; i++) console.log(i)' }));
  assert.equal(many.logs.length, 500);
  assert.equal(many.dropped, 100);
});

live('FR-114 a failure after a document change reports the undo step', async (ctx) => {
  const t = await setup(ctx);
  await newDocument(t);
  const r = await t.call('run_script', { code: `${ADD_RECT} throw new Error('after change');` });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /added 1 undo step/);
});

live('FR-115 run_script returns result and logs', async (ctx) => {
  const t = await setup(ctx);
  assert.deepEqual(jsonOf(await t.call('run_script', { code: "console.log('x'); return [1, 2]", mutates: false })), { result: [1, 2], logs: ['x'] });
});

live('FR-117 FR-118 FR-119 FR-120 documentation answers from the native or the local source', async (ctx) => {
  const t = await setup(ctx);
  const list = textOf(await t.call('sdk_docs', { action: 'list' }));
  assert.match(list, /^source: (native|local)/);
  assert.ok(list.includes('nodes.js'));
  assert.match(textOf(await t.call('sdk_docs', { action: 'read', topic: 'application.js', from: 1, to: 3 })), /\n1: /);
  assert.match(textOf(await t.call('sdk_docs', { action: 'search', query: 'createSetTagValueForKey' })), /commands\.js:\d+/);
});

live('FR-123 FR-124 render returns images and names missing preconditions', async (ctx) => {
  const t = await setup(ctx);
  await newDocument(t);
  const empty = await t.call('render', { target: 'selection' });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /Nothing is selected/);
  await t.call('run_script', { code: ADD_RECT });
  const spread = await t.call('render');
  assert.equal(spread.content[0].type, 'image');
  assert.equal((spread.content[0] as { mimeType: string }).mimeType, 'image/jpeg');
  const selection = await t.call('render', { target: 'selection' });
  assert.equal(selection.content[0].type, 'image');
  assert.match(textOf(await t.call('render', { spreadIndex: 9 })), /does not exist/);
});

live('FR-129 FR-131 the executable works against Affinity and exits when stdin closes', async (ctx) => {
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  ctx.after(() => child.kill());
  const lines = createInterface({ input: child.stdout });
  const next = () => new Promise<any>((resolve) => lines.once('line', (l) => resolve(JSON.parse(l))));
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await next();
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.equal(JSON.parse((await next()).result.content[0].text).connected, true);
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await Promise.race([exited, sleep(3000).then(() => 'timeout')]), 0);
});

// Slice 002: read model

/** Builds the read fixture in a new 800 x 600 px document at 72 DPI and returns its session UUID. */
const READ_FIXTURE = `const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const N = require('/nodes.js');
const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands.js');
const S = require('/shapes.js');
const { Rectangle, CurveBuilder, PolyCurve, Transform } = require('/geometry.js');
const { Colour, Gradient } = require('/colours.js');
const { FillDescriptor, GradientFill, GradientFillType, SolidFill } = require('/fills.js');
const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
const { StoryBuilder } = require('/storybuilder.js');
const { StoryDelta } = require('/storydelta.js');
const { FontWeight } = require('/fonts.js');
const { GlyphAttDoubleType } = require('/glyphatts.js');
const { BlendMode } = require('/blendmodeinterface.js');
const { Selection } = require('/selections.js');
const rgba = (r, g, b) => Colour.createRGBA8({ r, g, b, alpha: 255 });
const solid = (c) => FillDescriptor.createSolid(SolidFill.create(c));
const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 800; o.height = 600; o.dpi = 72;
const doc = Document.create(o);
const spread = doc.currentSpread;
function add(def, name, parent) {
  const b = AddChildNodesCommandBuilder.create();
  b.addNode(def);
  b.setInsertionTarget(parent || spread);
  doc.executeCommand(b.createCommand(true, N.NodeChildType.Main));
  const node = doc.selection.nodes.toArray()[0];
  node.userDescription = name;
  return node;
}
const shape = (s, x, y, w, h, c, name, parent) => add(N.ShapeNodeDefinition.create(s.create(), new Rectangle(x, y, w, h), c), name, parent);
const red = shape(S.ShapeRectangle, 20, 20, 120, 80, rgba(220, 40, 40), 'Red rect');
doc.executeCommand(DocumentCommand.createSetTagValueForKey(red.selfSelection, 'ttam-id', 'live-r1'));
add(N.ShapeNodeDefinition.create(S.ShapeEllipse.create(), new Rectangle(160, 20, 120, 80), rgba(40, 80, 220), rgba(0, 0, 0), LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(4))), 'Blue ellipse');
shape(S.ShapeStar, 300, 20, 80, 80, rgba(250, 200, 0), 'Star');
const cb = CurveBuilder.create();
cb.beginXY(420, 100); cb.lineToXY(470, 20); cb.lineToXY(520, 100); cb.close();
const pc = PolyCurve.create();
pc.addCurve(cb.createCurve());
add(N.PolyCurveNodeDefinition.create(pc, solid(rgba(20, 160, 80)), FillDescriptor.createNone(), LineStyleDescriptor.create(LineStyle.createDefault()), FillDescriptor.createNone()), 'Triangle');
const g = Gradient.create([{ colour: rgba(255, 0, 0), position: 0 }, { colour: rgba(0, 0, 255), position: 1 }]);
add(N.ShapeNodeDefinition.create(S.ShapeRectangle.create(), new Rectangle(540, 20, 120, 80), FillDescriptor.create(GradientFill.create(g, GradientFillType.Radial), true, Transform.createIdentity())), 'Gradient rect');
const sb = StoryBuilder.create();
sb.setToArtisticTextDefaultStyle(doc.dpi);
sb.applyGlyphDelta(StoryDelta.createComposite([StoryDelta.createFamilyName('Arial'), StoryDelta.createWeight(FontWeight.Bold), StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, 36), StoryDelta.createBrushFill(solid(rgba(200, 0, 0)))]));
sb.addText('Hello ');
sb.applyGlyphDelta(StoryDelta.createComposite([StoryDelta.createFamilyName('DejaVu Serif'), StoryDelta.createWeight(FontWeight.Normal), StoryDelta.createItalic(true), StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, 24), StoryDelta.createBrushFill(solid(rgba(0, 0, 200)))]));
sb.addText('World');
add(N.ArtTextNodeDefinition.createFromStoryBuilder({ x: 20, y: 200 }, sb), 'Two-run text');
const fb = StoryBuilder.create();
fb.setToFrameTextDefaultStyle(doc.dpi);
fb.addText('One');
fb.addParagraphBreak();
fb.addText('Two');
add(N.FrameTextNodeDefinition.createFromStoryBuilder(new Rectangle(300, 150, 160, 80), fb), 'Frame text');
const layer = add(N.ContainerNodeDefinition.create('My Layer'), 'My Layer');
doc.setVisible(false, shape(S.ShapeRectangle, 160, 300, 40, 40, rgba(255, 0, 255), 'Hidden square', layer).selfSelection);
const inner = add(N.ContainerNodeDefinition.create('Inner layer'), 'Inner layer', layer);
const deep = shape(S.ShapeEllipse, 300, 300, 10, 10, rgba(0, 0, 0), 'Deep dot', inner);
const empty = add(N.ContainerNodeDefinition.create('Empty layer'), 'Empty layer');
doc.setVisible(false, shape(S.ShapeRectangle, 0, 0, 10, 10, rgba(0, 0, 0), 'Ghost', empty).selfSelection);
shape(S.ShapeRectangle, 220, 300, 40, 40, rgba(0, 200, 200), 'Locked square').lock();
const rotated = shape(S.ShapeRectangle, 300, 300, 100, 40, rgba(100, 0, 150), 'Rotated');
doc.applyTransform(Transform.createRotate(Math.PI / 6), rotated.selfSelection);
const half = shape(S.ShapeRectangle, 440, 300, 100, 60, rgba(0, 0, 0), 'Half multiply');
doc.setOpacity(0.5, half.selfSelection);
doc.setBlendMode(BlendMode.Multiply, false, half.selfSelection);
const shadowed = shape(S.ShapeEllipse, 580, 300, 80, 80, rgba(255, 140, 0), 'Shadowed');
doc.setOuterShadowLayerEffectEnabled(shadowed.selfSelection, 0, true);
red.duplicate();
doc.selection = Selection.create(doc, [deep, shadowed]);
return doc.sessionUuid;`;

type TreeNode = { id: string; name: string; type: string; kind?: string; box: number[] | null; children?: TreeNode[]; childCount?: number; hidden?: boolean; locked?: boolean };
const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);

async function readFixture(t: Awaited<ReturnType<typeof setup>>) {
  const r = await t.call('run_script', { code: READ_FIXTURE });
  const id = jsonOf(r).result as string;
  t.documents.push(id);
  const tree = jsonOf(await t.call('get_document', { depth: 20 }));
  const byName = (name: string) => {
    const n = flatten(tree.nodes).find((x) => x.name === name);
    assert.ok(n, name);
    return n;
  };
  return { tree, byName };
}

live('FR-205 without an open document get_document and get_nodes fail and list_fonts works', async (ctx) => {
  const t = await setup(ctx);
  if (jsonOf(await t.call('get_status')).documents.length > 0) return ctx.skip('documents are open in Affinity');
  for (const [tool, args] of [['get_document', {}], ['get_nodes', { ids: ['0/0'] }]] as const) {
    const r = await t.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(textOf(r), /No document is open/, tool);
  }
  assert.ok(jsonOf(await t.call('list_fonts')).total > 0);
});

live('FR-201 FR-208 the read tools leave history, dirty flag and selection unchanged and report the selection', async (ctx) => {
  const t = await setup(ctx);
  const { tree, byName } = await readFixture(t);
  const STATE = "const d = require('/application.js').app.documents.current; return { position: d.history.position, size: d.history.size, dirty: d.isDirty, selection: d.selection.nodes.toArray().map((n) => n.description) };";
  const before = jsonOf(await t.call('run_script', { code: STATE, mutates: false })).result;
  const ids = flatten(tree.nodes).map((n) => n.id);
  const entries = jsonOf(await t.call('get_nodes', { ids }));
  await t.call('get_document', { query: { text: 'o' } });
  await t.call('get_document');
  await t.call('list_fonts', { query: 'a' });
  const after = jsonOf(await t.call('run_script', { code: STATE, mutates: false })).result;
  assert.deepEqual(after, before);
  assert.deepEqual([...before.selection].sort(), ['Deep dot', 'Shadowed']);
  assert.deepEqual([...tree.selection].sort(), [byName('Deep dot').id, byName('Shadowed').id].sort());
  assert.equal(entries.filter((e: { error?: string }) => e.error).length, 0);
  assert.ok(tree.fonts.some((f: { name: string; installed: boolean }) => f.name === 'Arial-BoldMT' && f.installed));
});

live('FR-202 FR-203 FR-206 FR-207 FR-209 FR-213 FR-214 FR-215 get_document describes the fixture', async (ctx) => {
  const t = await setup(ctx);
  await readFixture(t);
  const d = jsonOf(await t.call('get_document'));
  assert.deepEqual({ ...d.document, title: undefined }, { title: undefined, path: null, dpi: 72, units: 'Pixel', width: 800, height: 600, colorFormat: 'RGBA8', dirty: true, spreads: 1, currentSpread: 0 });
  assert.deepEqual(d.spread, { index: 0, box: [0, 0, 800, 600], artboards: [] });
  const top: TreeNode[] = d.nodes;
  assert.equal(top.length, 14);
  assert.equal(top[0].name, 'Red rect'); // the first inserted node is at the back (R-20)
  assert.equal(top[0].id, 'live-r1');
  top.forEach((n, i) => i > 0 && assert.equal(n.id, `0/${i}`, n.name));
  assert.equal(top.filter((n) => n.name === 'Red rect').length, 2, 'the duplicate carries the same tag but reports its path');
  const by = (name: string) => top.find((n) => n.name === name) as TreeNode;
  const types = Object.fromEntries(top.map((n) => [n.name, n.kind ? `${n.type}/${n.kind}` : n.type]));
  assert.deepEqual(types, {
    'Red rect': 'rect',
    'Blue ellipse': 'ellipse',
    Star: 'star',
    Triangle: 'path',
    'Gradient rect': 'rect',
    'Two-run text': 'text/art',
    'Frame text': 'text/frame',
    'My Layer': 'layer',
    'Empty layer': 'layer',
    'Locked square': 'rect',
    Rotated: 'rect',
    'Half multiply': 'rect',
    Shadowed: 'ellipse',
  });
  assert.deepEqual(by('Red rect').box, [20, 20, 120, 80]);
  assert.deepEqual(by('Rotated').box, [89.81, 409.81, 106.6, 84.64]);
  assert.equal(by('Empty layer').box, null);
  assert.equal(by('Locked square').locked, true);
  assert.deepEqual(
    by('My Layer').children?.map((n) => [n.name, n.hidden, n.childCount]),
    [
      ['Hidden square', true, undefined],
      ['Inner layer', undefined, 1],
    ],
  );
});

live('FR-216 FR-217 FR-218 FR-219 FR-220 FR-221 FR-222 get_nodes reports geometry, fills, strokes, text and effects', async (ctx) => {
  const t = await setup(ctx);
  const { byName } = await readFixture(t);
  const names = ['Red rect', 'Blue ellipse', 'Gradient rect', 'Two-run text', 'Frame text', 'My Layer', 'Rotated', 'Half multiply', 'Shadowed', 'Deep dot', 'Triangle'];
  const [red, ellipse, grad, art, frame, layer, rotated, half, shadowed, deep, triangle, missing] = jsonOf(await t.call('get_nodes', { ids: [...names.map((n) => byName(n).id), 'nope'] }));
  assert.deepEqual(red, { id: 'live-r1', type: 'rect', name: 'Red rect', box: [20, 20, 120, 80], parent: null, childCount: 0, fill: '#dc2828ff', stroke: null });
  assert.deepEqual(ellipse.stroke, { color: '#000000ff', width: 4, align: 'Centre', cap: 'Butt', join: 'Round' });
  assert.deepEqual(ellipse.visibleBox, [158, 18, 124, 84]);
  assert.deepEqual(grad.fill, {
    gradient: 'Radial',
    stops: [
      { at: 0, color: '#ff0000ff' },
      { at: 1, color: '#0000ffff' },
    ],
  });
  assert.equal('fill' in art, false);
  const serif = jsonOf(await t.call('list_fonts', { query: 'DejaVu Serif', limit: 1 })).families[0];
  const italicExists = serif.family === 'DejaVu Serif' && serif.styles.some((s: { italic: boolean }) => s.italic);
  assert.deepEqual(art.text.runs, [
    { text: 'Hello ', family: 'Arial', style: 'Bold', weight: 700, italic: false, size: 36, color: '#c80000ff' },
    { ...art.text.runs[1], text: 'World', family: 'DejaVu Serif', italic: italicExists, size: 24, color: '#0000c8ff' }, // R-24: the face in use
  ]);
  assert.equal(art.text.content, 'Hello World');
  assert.deepEqual(art.text.align, ['Left']);
  assert.equal(frame.text.content, 'One\nTwo');
  assert.deepEqual(frame.text.align, ['Left', 'Left']);
  assert.equal(frame.text.runs[0].size, 12);
  assert.equal(layer.childCount, 2);
  assert.equal(rotated.rotation, 30);
  assert.equal(half.opacity, 0.5);
  assert.equal(half.blendMode, 'Multiply');
  assert.deepEqual(shadowed.effects, [{ type: 'OuterShadow', enabled: true, opacity: 0.5, blendMode: 'Multiply', radius: 0, color: '#000000ff', offset: 0, angle: 45, intensity: 0 }]);
  assert.equal(deep.parent, byName('Inner layer').id);
  assert.equal(triangle.fill, '#14a050ff');
  assert.deepEqual(missing, { id: 'nope', error: 'not found' });
});

live('FR-220 FR-219 at 144 DPI text sizes are points, stroke widths are pixels and run text follows code points', async (ctx) => {
  const t = await setup(ctx);
  const code = `const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const N = require('/nodes.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const S = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');
const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
const { StoryBuilder } = require('/storybuilder.js');
const { StoryDelta } = require('/storydelta.js');
const { FontWeight } = require('/fonts.js');
const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 400; o.height = 300; o.dpi = 144;
const doc = Document.create(o);
const b = AddChildNodesCommandBuilder.create();
b.addNode(N.ShapeNodeDefinition.create(S.ShapeRectangle.create(), new Rectangle(10, 10, 100, 50), Colour.createRGBA8({ r: 255, g: 0, b: 0, alpha: 255 }), Colour.createRGBA8({ r: 0, g: 0, b: 0, alpha: 255 }), LineStyleDescriptor.create(LineStyle.createDefaultWithWeight(4))));
const sb = StoryBuilder.create();
sb.setToArtisticTextDefaultStyle(doc.dpi);
sb.addText('A\\u{1F3A8}');
sb.applyGlyphDelta(StoryDelta.createWeight(FontWeight.Bold));
sb.addText('B\\u00e9');
b.addNode(N.ArtTextNodeDefinition.createFromStoryBuilder({ x: 20, y: 150 }, sb));
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(false, N.NodeChildType.Main));
return doc.sessionUuid;`;
  t.documents.push(jsonOf(await t.call('run_script', { code })).result);
  const [rect, text] = jsonOf(await t.call('get_nodes', { ids: ['0/0', '0/1'] }));
  assert.equal(rect.stroke.width, 4);
  assert.equal(text.text.content, 'A🎨Bé');
  assert.deepEqual(
    text.text.runs.map((r: { text: string; weight: number; size: number }) => [r.text, r.weight, r.size]),
    [
      ['A🎨', 400, 12],
      ['Bé', 700, 12],
    ],
  ); // story positions count code points (R-30); UTF-16 slicing would split the emoji
});

live('FR-207 FR-214 artboards are listed with the spread and typed artboard', async (ctx) => {
  const t = await setup(ctx);
  const code = `const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { Rectangle } = require('/geometry.js');
const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 1000; o.height = 600; o.dpi = 72;
const doc = Document.create(o);
doc.addRectangularArtboard(new Rectangle(0, 0, 400, 300), false, false);
doc.addRectangularArtboard(new Rectangle(500, 0, 300, 300), false, false);
return doc.sessionUuid;`;
  t.documents.push(jsonOf(await t.call('run_script', { code })).result);
  const d = jsonOf(await t.call('get_document'));
  assert.deepEqual(
    d.spread.artboards.map((a: { id: string; box: number[] }) => [a.id, a.box]),
    [
      ['0/0', [0, 0, 400, 300]],
      ['0/1', [500, 0, 300, 300]],
    ],
  );
  assert.deepEqual(
    d.nodes.map((n: TreeNode) => [n.id, n.type, n.name]),
    d.spread.artboards.map((a: { id: string; name: string }) => [a.id, 'artboard', a.name]),
  );
  assert.deepEqual([d.document.width, d.document.height], [800, 300]); // R-19: the document becomes the union of its artboards
});

live('FR-211 FR-212 query finds nodes at any depth; an unknown spread is named', async (ctx) => {
  const t = await setup(ctx);
  await readFixture(t);
  const names = async (query: object) => jsonOf(await t.call('get_document', { query })).matches.map((n: TreeNode) => n.name);
  assert.deepEqual(await names({ type: 'ellipse' }), ['Blue ellipse', 'Deep dot', 'Shadowed']);
  assert.deepEqual(await names({ text: 'HELLO' }), ['Two-run text']);
  assert.deepEqual(await names({ name: 'layer' }), ['My Layer', 'Inner layer', 'Empty layer']);
  const r = await t.call('get_document', { spreadIndex: 9 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Spread 9 does not exist; the document has 1 spread/);
});

live('FR-223 list_fonts lists installed families with their styles', async (ctx) => {
  const t = await setup(ctx);
  const f = jsonOf(await t.call('list_fonts', { query: 'arial', limit: 500 }));
  assert.ok(f.total >= f.matching && f.matching >= 1);
  const arial = f.families.find((x: { family: string }) => x.family === 'Arial');
  assert.deepEqual(
    arial.styles.map((s: { style: string; weight: number; italic: boolean }) => [s.style, s.weight, s.italic]),
    [
      ['Regular', 400, false],
      ['Italic', 400, true],
      ['Bold', 700, false],
      ['Bold Italic', 700, true],
    ],
  );
});

live('FR-210 NFR-201 NFR-202 a 1,000-node spread is read within 2 s, capped at 500 nodes below 60,000 characters', async (ctx) => {
  const t = await setup(ctx);
  const code = `const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const N = require('/nodes.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const S = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');
const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 2000; o.height = 2000; o.dpi = 72;
const doc = Document.create(o);
const b = AddChildNodesCommandBuilder.create();
for (let i = 0; i < 1000; i++) b.addNode(N.ShapeNodeDefinition.create(S.ShapeRectangle.create(), new Rectangle((i % 40) * 50 + 0.25, Math.floor(i / 40) * 50 + 0.5, 40.125, 40.5), Colour.createRGBA8({ r: i % 256, g: 0, b: 0, alpha: 255 })));
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(false, N.NodeChildType.Main));
return doc.sessionUuid;`;
  t.documents.push(jsonOf(await t.call('run_script', { code })).result);
  const t0 = performance.now();
  const r = await t.call('get_document');
  const ms = performance.now() - t0;
  const d = jsonOf(r);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`);
  assert.equal(d.nodes.length, 500);
  assert.equal(d.omitted, 500);
  assert.match(d.hint, /get_nodes/);
  const one = textOf(await t.call('get_document', { depth: 1 }));
  assert.ok(one.length < 60000, `${one.length} characters`);
});
