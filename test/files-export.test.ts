// Slice 004 unit tests. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Upstream } from '../src/affinity.js';
import { candidates, hostPath, Staging } from '../src/staging.js';
import { createServer, INSTRUCTIONS } from '../src/tools.js';
import { fakeDocument, fakeFiles, fakeNode, startFake, type FilesOptions } from './fake-affinity.js';

const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');
const jsonOf = (r: CallToolResult) => JSON.parse(textOf(r));
const temp = () => mkdtempSync(join(tmpdir(), 'ttam-'));

/** A server over the fake with one document of `spreads` and a temporary folder as Affinity's Desktop. */
async function setup(ctx: TestContext, o: Partial<FilesOptions> & { spreads?: object[][] } = {}) {
  const desktop = o.desktop ?? temp();
  const d = fakeDocument({ spreads: o.spreads ?? [[]] });
  const modules = fakeFiles(d.modules, d.doc, { desktop, toHost: o.toHost, access: o.access });
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
  const run = async (code: string) => jsonOf(await call('run_script', { code, mutates: false })).result;
  return { fake, call, run, desktop, out: temp() };
}

// 1. Paths, access and location

test('FR-401 relative paths are refused before any script; ~ is the home folder', async (ctx) => {
  const t = await setup(ctx);
  for (const [tool, args] of [
    ['export', { path: 'out.png' }],
    ['manage_document', { action: 'open', path: 'a.af' }],
    ['manage_document', { action: 'saveAs', path: './a.af' }],
    ['create_nodes', { nodes: [{ type: 'image', src: 'a.png', box: [0, 0, 10, 10] }] }],
  ] as const) {
    const r = await t.call(tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(textOf(r), /not a path on this computer/);
  }
  assert.equal(t.fake.executed, 0);
  assert.equal(hostPath('~/x/y.png'), join(homedir(), 'x', 'y.png'));
  assert.equal(hostPath('/a/../b.png'), '/b.png');
});

test('FR-402 with file access off, file calls fail naming the setting and change nothing', async (ctx) => {
  const t = await setup(ctx, { access: false });
  for (const args of [{ path: join(t.out, 'a.png') }, { path: join(t.out, 'b.png'), target: 'nodes', ids: ['x'] }]) {
    const r = await t.call('export', args);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Settings > Model Context Protocol > Access files on your Desktop/);
  }
  assert.match(textOf(await t.call('render', { maxSize: 512 })), /Access files on your Desktop/);
  assert.equal(t.fake.executed, 3); // only the access checks ran
  assert.deepEqual(readdirSync(t.out), []);
  assert.deepEqual(readdirSync(t.desktop), []);
});

test('FR-403 candidate folders come in the order of the spec', () => {
  const home = homedir();
  const env = { AFFINITY_DESKTOP_DIR: '/override', WINEPREFIX: '/wp', XDG_DESKTOP_DIR: '/xdg' };
  assert.deepEqual(candidates('C:\\users\\u\\Desktop', env), [
    '/override',
    'C:\\users\\u\\Desktop',
    '/wp/drive_c/users/u/Desktop',
    join(home, '.wine', 'drive_c/users/u/Desktop'),
    join(home, '.local/share/affinity-infinity/prefix/drive_c/users/u/Desktop'),
    '/xdg',
    join(home, 'Desktop'),
  ]);
  assert.deepEqual(candidates('/Users/u/Desktop', {}).slice(0, 1), ['/Users/u/Desktop']);
});

test('FR-403 the Desktop is found inside a Wine prefix by the probe file, and AFFINITY_DESKTOP_DIR wins', async (ctx) => {
  const prefix = temp();
  const desk = join(prefix, 'drive_c', 'users', 'u', 'Desktop');
  mkdirSync(desk, { recursive: true });
  const saved = { WINEPREFIX: process.env.WINEPREFIX, AFFINITY_DESKTOP_DIR: process.env.AFFINITY_DESKTOP_DIR };
  ctx.after(() => Object.assign(process.env, saved));
  process.env.WINEPREFIX = prefix;
  delete process.env.AFFINITY_DESKTOP_DIR;
  const toHost = (p: string) => p.replace(/^C:\\/, prefix + '/drive_c/').replace(/\\/g, '/');
  const t = await setup(ctx, { desktop: 'C:\\users\\u\\Desktop', toHost });
  const s = jsonOf(await t.call('get_status'));
  assert.deepEqual(s.files, { access: true, desktop: 'C:\\users\\u\\Desktop', hostDesktop: desk });
  assert.deepEqual(readdirSync(desk), [], 'probe and staging folder removed');
});

test('FR-403 a Desktop that no candidate holds fails naming AFFINITY_DESKTOP_DIR', async (ctx) => {
  const elsewhere = temp();
  const t = await setup(ctx, { desktop: 'C:\\nowhere\\Desktop', toHost: (p) => p.replace(/^C:\\nowhere\\Desktop/, elsewhere).replace(/\\/g, '/') });
  const r = await t.call('export', { path: join(t.out, 'a.png') });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /AFFINITY_DESKTOP_DIR/);
});

test('FR-424 get_status reports file access, the Desktop and its host folder, or the fix', async (ctx) => {
  const t = await setup(ctx);
  assert.deepEqual(jsonOf(await t.call('get_status')).files, { access: true, desktop: t.desktop, hostDesktop: t.desktop });
  const off = await setup(ctx, { access: false });
  const f = jsonOf(await off.call('get_status')).files;
  assert.equal(f.access, false);
  assert.equal(f.hostDesktop, null);
  assert.match(f.fix, /Access files on your Desktop/);
});

// 2. Staged files and targets

test('FR-404 FR-418 an export leaves no staged file and reports the written file', async (ctx) => {
  const t = await setup(ctx);
  const r = jsonOf(await t.call('export', { path: join(t.out, 'poster.png'), scale: 2 }));
  assert.equal(r.preset, 'PNG');
  assert.equal(r.files.length, 1);
  const f = r.files[0];
  assert.equal(f.path, join(t.out, 'poster.png'));
  assert.deepEqual([f.width, f.height], [1600, 1200]);
  const written = JSON.parse(readFileSync(f.path, 'utf8'));
  assert.equal(f.bytes, readFileSync(f.path).length);
  assert.deepEqual(written, { preset: 'PNG', area: { spreads: '1' }, size: { width: 1600, height: 1200 } });
  assert.deepEqual(readdirSync(t.desktop), []);
});

test('FR-404 a failed export also removes its staged files', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('export', { path: join(t.out, 'a.png'), preset: 'PNG (nope)' });
  assert.equal(r.isError, true);
  assert.deepEqual(readdirSync(t.desktop), []);
  assert.deepEqual(readdirSync(t.out), []);
});

test('FR-405 a missing folder and an existing file are refused; overwrite replaces the file', async (ctx) => {
  const t = await setup(ctx);
  const missing = await t.call('export', { path: join(t.out, 'no', 'a.png') });
  assert.match(textOf(missing), /folder .*no does not exist/);
  assert.equal(t.fake.executed, 0);
  const file = join(t.out, 'a.png');
  writeFileSync(file, 'old');
  const r = await t.call('export', { path: file });
  assert.match(textOf(r), /exists\. Set overwrite: true/);
  assert.equal(readFileSync(file, 'utf8'), 'old');
  jsonOf(await t.call('export', { path: file, overwrite: true }));
  assert.notEqual(readFileSync(file, 'utf8'), 'old');
  for (const args of [
    { action: 'saveAs', path: join(t.out, 'a.png') },
    { action: 'saveAs', path: file.replace('.png', '.af'), overwrite: false },
  ]) {
    if (args.path.endsWith('.af')) writeFileSync(args.path, 'doc');
    const before: number = t.fake.executed;
    const s = await t.call('manage_document', args);
    assert.equal(s.isError, true);
    assert.match(textOf(s), /\.af|overwrite/);
    assert.equal(t.fake.executed, before);
  }
});

// 3. manage_document

test('FR-406 FR-407 FR-410 fields of another action, and missing required fields, are refused before any script', async (ctx) => {
  const t = await setup(ctx);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ action: 'create', width: 10, height: 10, path: '/a.af' }, /path does not apply to action create/],
    [{ action: 'close', overwrite: true, dpi: 3 }, /dpi, overwrite do not apply/],
    [{ action: 'create', width: 10 }, /needs width and height/],
    [{ action: 'open' }, /open needs path/],
    [{ action: 'open', path: '/nonexistent/x.af' }, /does not exist/],
  ];
  for (const [args, re] of cases) assert.match(textOf(await t.call('manage_document', args)), re);
  assert.equal(t.fake.executed, 0);
});

/** A staging that is already located, over a temporary Desktop. */
function located() {
  const host = temp();
  const s = new Staging(new Upstream(['http://127.0.0.1:1/sse']));
  s.located = { desktop: 'C:\\users\\u\\Desktop', host };
  return { s, host, root: join(host, 'talk-to-affinity') };
}

function copyFolder(root: string, name: string, origin: string, content: string, newer: boolean) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'origin.txt'), origin);
  const copy = join(root, name, 'poster.af');
  writeFileSync(copy, content);
  writeFileSync(copy + '~lock~', 'lock');
  const t = new Date(2026, 0, 1);
  if (existsSync(origin)) utimesSync(origin, t, t);
  const c = new Date(t.getTime() + (newer ? 60000 : 0));
  utimesSync(copy, c, c);
}

test('FR-411 a closed document is written back when its copy is newer, and its folder removed', () => {
  const { s, root } = located();
  const out = temp();
  const a = join(out, 'a', 'poster.af');
  const b = join(out, 'b', 'poster.af');
  const c = join(out, 'c', 'poster.af');
  for (const f of [a, b, c]) {
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, 'original');
  }
  copyFolder(root, 'doc-0001', a, 'changed', true);
  copyFolder(root, 'doc-0002', b, 'unsaved copy', false);
  copyFolder(root, 'doc-0003', c, 'open', true);
  const warnings = s.sync(['C:\\users\\u\\Desktop\\talk-to-affinity\\doc-0003\\poster.af']);
  assert.deepEqual(warnings, []);
  assert.equal(readFileSync(a, 'utf8'), 'changed');
  assert.equal(readFileSync(b, 'utf8'), 'original');
  assert.equal(readFileSync(c, 'utf8'), 'original');
  assert.deepEqual(readdirSync(root), ['doc-0003']);
});

test('FR-411 a copy that cannot be written back is kept and named under warnings', () => {
  const { s, root } = located();
  copyFolder(root, 'doc-00aa', '/nonexistent-dir/poster.af', 'changed', true);
  const warnings = s.sync([]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /doc-00aa.*poster\.af.*could not be written to \/nonexistent-dir\/poster\.af/);
  assert.ok(existsSync(join(root, 'doc-00aa')));
});

test('FR-423 Affinity paths map to host paths: copies to their origin, Desktop files into the host Desktop', () => {
  const { s, host, root } = located();
  copyFolder(root, 'doc-00bb', '/work/poster.af', 'x', false);
  assert.equal(s.mapPath('C:\\users\\u\\Desktop\\talk-to-affinity\\doc-00bb\\poster.af'), '/work/poster.af');
  assert.equal(s.mapPath('c:/Users/U/Desktop/talk-to-affinity/doc-00bb/poster.af'), '/work/poster.af');
  assert.equal(s.mapPath('C:\\users\\u\\Desktop\\art\\logo.af'), join(host, 'art', 'logo.af'));
  assert.equal(s.mapPath('D:\\other\\x.af'), 'D:\\other\\x.af');
  assert.equal(s.mapPath(''), null);
});

// 4. export

test('FR-413 the extension picks the preset; an unknown extension lists the formats', async (ctx) => {
  const t = await setup(ctx);
  const expected: Record<string, string> = { png: 'PNG', jpg: 'JPEG (High quality)', jpeg: 'JPEG (High quality)', webp: 'WebP (Lossless, default)', gif: 'GIF RGB', tif: 'TIFF RGB 8-bit', tiff: 'TIFF RGB 8-bit', psd: 'PSD (preserve editability)', svg: 'SVG (for export)', pdf: 'PDF (for export)', eps: 'EPS (for export)' };
  for (const [ext, preset] of Object.entries(expected)) assert.equal(jsonOf(await t.call('export', { path: join(t.out, 'f.' + ext) })).preset, preset, ext);
  const r = await t.call('export', { path: join(t.out, 'f.bmp') });
  assert.match(textOf(r), /\.png, \.jpg, \.jpeg, \.webp, \.gif, \.tif, \.tiff, \.psd, \.svg, \.pdf, \.eps, or give preset/);
  const p = jsonOf(await t.call('export', { path: join(t.out, 'print.bin'), preset: 'PDF (for print)' }));
  assert.equal(p.preset, 'PDF (for print)');
  assert.equal(p.files[0].width, undefined);
});

test('FR-413 an unknown preset fails listing the 5 closest names', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('export', { path: join(t.out, 'a.jpg'), preset: 'JPEG (High)' });
  assert.match(textOf(r), /Unknown export preset "JPEG \(High\)"\. The closest presets are "JPEG \(High quality\)", /);
  assert.equal((textOf(r).match(/", "/g) ?? []).length, 4);
});

test('FR-416 size fields: one at most, none for SVG, PDF and EPS, and the pixel size of an area', async (ctx) => {
  const t = await setup(ctx);
  assert.match(textOf(await t.call('export', { path: join(t.out, 'a.png'), scale: 2, width: 10 })), /at most one of scale, width and height/);
  for (const ext of ['svg', 'pdf', 'eps']) assert.match(textOf(await t.call('export', { path: join(t.out, 'a.' + ext), width: 100 })), /no pixel size/);
  assert.equal((await t.call('export', { path: join(t.out, 'a.png'), scale: 40 })).isError, true);
  const size = (w: number, h: number, o: object) => t.run(`return ttam.exportSize(${w}, ${h}, ${JSON.stringify(o)})`);
  assert.deepEqual(await size(400, 300, {}), { width: 400, height: 300 });
  assert.deepEqual(await size(400, 300, { scale: 2 }), { width: 800, height: 600 });
  assert.deepEqual(await size(400, 300, { width: 1000 }), { width: 1000, height: 750 });
  assert.deepEqual(await size(400, 300, { height: 30 }), { width: 40, height: 30 });
  assert.deepEqual(await size(100, 50, { longest: 2048 }), { width: 2048, height: 1024 });
  assert.deepEqual(await size(1000, 1, { scale: 0.1 }), { width: 100, height: 1 });
  assert.match((await size(20000, 100, { scale: 2 })).fail, /40000 x 200 px; a side can be at most 32,768 px/);
});

test('FR-414 FR-418 a document exports one file per spread, or one PDF', async (ctx) => {
  const t = await setup(ctx, { spreads: [[], [], []] });
  const r = jsonOf(await t.call('export', { path: join(t.out, 'deck.png'), target: 'document' }));
  assert.deepEqual(r.files.map((f: { path: string }) => f.path), [1, 2, 3].map((n) => join(t.out, `deck_${n}.png`)));
  assert.deepEqual(JSON.parse(readFileSync(join(t.out, 'deck_3.png'), 'utf8')).area, { spreads: '3' });
  const pdf = jsonOf(await t.call('export', { path: join(t.out, 'deck.pdf'), target: 'document' }));
  assert.deepEqual(pdf.files.map((f: { path: string }) => f.path), [join(t.out, 'deck.pdf')]);
  assert.deepEqual(JSON.parse(readFileSync(join(t.out, 'deck.pdf'), 'utf8')).area, { whole: true });
  const two = jsonOf(await t.call('export', { path: join(t.out, 'two.png'), spreadIndex: 1 }));
  assert.deepEqual(JSON.parse(readFileSync(two.files[0].path, 'utf8')).area, { spreads: '2' });
  assert.match(textOf(await t.call('export', { path: join(t.out, 'x.png'), spreadIndex: 5 })), /Spread 5 does not exist/);
});

test('FR-415 target rules: ids only with nodes, unknown ids named, an empty selection refused', async (ctx) => {
  const t = await setup(ctx, { spreads: [[fakeNode('ShapeNode', { tag: 'logo', shape: 'Rectangle' })]] });
  assert.match(textOf(await t.call('export', { path: join(t.out, 'a.png'), ids: ['logo'] })), /ids belongs to target nodes/);
  assert.match(textOf(await t.call('export', { path: join(t.out, 'a.png'), target: 'nodes' })), /target nodes needs ids/);
  assert.match(textOf(await t.call('export', { path: join(t.out, 'a.png'), target: 'nodes', ids: ['logo', 'nope'] })), /No node has the ID "nope"/);
  assert.match(textOf(await t.call('export', { path: join(t.out, 'a.png'), target: 'selection' })), /Nothing is selected/);
  assert.deepEqual(readdirSync(t.out), []);
});

// 5. render and images

test('FR-419 FR-420 render: nodes need ids, maxSize is 64 to 2,048, and without it the native renderer runs', async (ctx) => {
  const t = await setup(ctx);
  assert.match(textOf(await t.call('render', { target: 'nodes' })), /target nodes needs ids/);
  assert.equal((await t.call('render', { maxSize: 32 })).isError, true);
  assert.equal((await t.call('render', { maxSize: 4096 })).isError, true);
  const r = await t.call('render', {});
  assert.equal(r.content[0].type, 'image');
  assert.ok(t.fake.calls.some((c) => c.tool === 'render_spread'));
});

test('FR-421 image specs need src and box, take no fill, and a missing file is refused before any script', async (ctx) => {
  const t = await setup(ctx);
  const bad: [object, RegExp][] = [
    [{ type: 'image', box: [0, 0, 10, 10] }, /image needs src/],
    [{ type: 'image', src: '/a.png' }, /box is required for image/],
    [{ type: 'image', src: '/a.png', box: [0, 0, 10, 10], fill: '#ff0000' }, /fill applies only to/],
    [{ type: 'rect', box: [0, 0, 10, 10], src: '/a.png' }, /src applies only to image/],
    [{ type: 'image', src: '/a.png', box: [0, 0, 10, 10], fit: 'cover' }, /fit/],
  ];
  for (const [spec, re] of bad) assert.match(textOf(await t.call('create_nodes', { nodes: [spec] })), re);
  const r = await t.call('create_nodes', { nodes: [{ type: 'layer', children: [{ type: 'image', src: '/nonexistent/a.png', box: [0, 0, 10, 10] }] }] });
  assert.match(textOf(r), /The image \/nonexistent\/a\.png does not exist\. Nothing was changed\./);
  assert.equal(t.fake.executed, 0);
});

test('FR-421 image placement keeps the aspect with contain and fills the box with stretch', async (ctx) => {
  const t = await setup(ctx);
  const r3 = (l: number[]) => l.map((v) => Math.round(v * 1000) / 1000);
  assert.deepEqual(r3(await t.run('return ttam.imageData([0, 0, 200, 200], 300, 200, "contain")')), [0.667, 0, 0, 0, 0.667, 33.333]);
  assert.deepEqual(await t.run('return ttam.imageData([10, 20, 600, 100], 300, 200, "stretch")'), [2, 0, 10, 0, 0.5, 20]);
  assert.deepEqual(await t.run('return ttam.multiply([1, 0, 5, 0, 1, 7], [2, 0, 1, 0, 3, 1])'), [2, 0, 6, 0, 3, 8]);
});

test('FR-422 get_nodes reports the pixel size of image nodes', async (ctx) => {
  const t = await setup(ctx, { spreads: [[fakeNode('ImageNode', { tag: 'photo', raster: [300, 200] })]] });
  const [n] = jsonOf(await t.call('get_nodes', { ids: ['photo'] }));
  assert.equal(n.type, 'image');
  assert.deepEqual(n.image, { width: 300, height: 200 });
  assert.equal(n.fill, undefined);
});

// 6. Descriptions

test('FR-425 instructions and descriptions state the file rules', async (ctx) => {
  assert.ok(INSTRUCTIONS.length <= 1500, `length ${INSTRUCTIONS.length}`);
  for (const s of ['paths on this computer', 'Access files on your Desktop', 'copies', 'save writes them back', 'overwrite: true', 'discardChanges: true', 'manage_document', 'export']) assert.ok(INSTRUCTIONS.includes(s), s);
  const t = await setup(ctx);
  const client = new Client({ name: 'list', version: '0' });
  const server = createServer(new Upstream([t.fake.url]));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  ctx.after(() => client.close());
  const tools = Object.fromEntries((await client.listTools()).tools.map((x) => [x.name, x.description ?? '']));
  for (const name of ['manage_document', 'export']) for (const s of ['paths on this computer', 'Access files on your Desktop']) assert.ok(tools[name].includes(s), `${name}: ${s}`);
  for (const s of ['copy that save writes back', 'overwrite: true', 'discardChanges is true', 'scripts cannot switch documents']) assert.ok(tools.manage_document.includes(s), s);
  assert.ok(tools.export.includes('overwrite: true'));
  assert.match(tools.render, /file access/);
  assert.match(tools.create_nodes, /file access/);
});
