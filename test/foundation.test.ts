// Slice 001 unit tests. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AffinityError, Upstream } from '../src/affinity.js';
import { createServer } from '../src/tools.js';
import { allCalls, fixtureModules, refusedUrl, startFake, type FakeOptions } from './fake-affinity.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textOf = (r: CallToolResult) => r.content.map((c) => ('text' in c ? c.text : '')).join('');
const jsonOf = (r: CallToolResult) => JSON.parse(textOf(r));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const BIN = new URL('../src/index.js', import.meta.url).pathname;

async function setup(ctx: TestContext, options: FakeOptions = {}, urls?: string[]) {
  const fake = await startFake({ modules: fixtureModules().modules, preamble: 'System preamble', ...options });
  const upstream = new Upstream(urls ?? [fake.url]);
  const server = createServer(upstream);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const close = async () => {
    await client.close();
    await server.close();
    await upstream.close();
    await fake.close();
  };
  ctx.after(close);
  return { fake, upstream, client, call };
}

/** True when the call is refused, either as a protocol error or as an error result. */
async function refused(fn: () => Promise<CallToolResult>) {
  try {
    return (await fn()).isError === true;
  } catch {
    return true;
  }
}

// 1. Package

test('NFR-101 runtime dependencies are exactly the MCP SDK, zod, pngjs and jpeg-js', () => {
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@modelcontextprotocol/sdk', 'jpeg-js', 'pngjs', 'zod']);
});

test('NFR-102 the package declares Node 20 or later', () => {
  assert.equal(pkg.engines.node, '>=20');
});

// 2. Connection and session

test('FR-101 the first call connects and reads the preamble before forwarding', async (ctx) => {
  const t = await setup(ctx);
  await t.call('run_script', { code: 'return 1' });
  assert.deepEqual(t.fake.calls.map((c) => c.tool), ['read_sdk_documentation_topic', 'execute_script']);
  assert.equal(t.fake.calls[0].args.filename, 'preamble');
});

test('FR-102 an unreachable endpoint fails within 3 s naming the setting, the restart and the URLs', async (ctx) => {
  const url = await refusedUrl();
  const upstream = new Upstream([url]);
  const t0 = Date.now();
  await assert.rejects(upstream.connect(), (e: Error) => {
    assert.ok(e instanceof AffinityError);
    assert.match(e.message, /Settings > Model Context Protocol > Enable MCP server/);
    assert.match(e.message, /restart/);
    assert.ok(e.message.includes(url));
    return true;
  });
  assert.ok(Date.now() - t0 < 3000);
});

test('FR-102 an endpoint that accepts but never answers fails within the 3 s budget', async (ctx) => {
  const sockets: net.Socket[] = [];
  const silent = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
  ctx.after(() => {
    sockets.forEach((s) => s.destroy());
    silent.close();
  });
  const url = `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/sse`;
  const t0 = Date.now();
  await assert.rejects(new Upstream([url]).connect(), /no answer within/);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 2900 && elapsed < 3600, `elapsed ${elapsed} ms`);
});

test('FR-103 default URLs try 127.0.0.1 then [::1]; AFFINITY_MCP_URL replaces them', async (ctx) => {
  const saved = process.env.AFFINITY_MCP_URL;
  delete process.env.AFFINITY_MCP_URL;
  assert.deepEqual(new Upstream().urls, ['http://127.0.0.1:6767/sse', 'http://[::1]:6767/sse']);
  process.env.AFFINITY_MCP_URL = 'http://127.0.0.1:9/sse';
  assert.deepEqual(new Upstream().urls, ['http://127.0.0.1:9/sse']);
  if (saved === undefined) delete process.env.AFFINITY_MCP_URL;
  else process.env.AFFINITY_MCP_URL = saved;

  const fake = await startFake({ preamble: 'p' });
  const upstream = new Upstream([await refusedUrl(), fake.url]);
  ctx.after(async () => {
    await upstream.close();
    await fake.close();
  });
  await upstream.connect();
  assert.equal(upstream.url, fake.url);
});

test('FR-104 a failed connection leaves no retry timer behind', async (ctx) => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  await assert.rejects(new Upstream([await refusedUrl()]).connect());
  await sleep(100);
  assert.ok(timers() <= before, `timers before ${before}, after ${timers()}`);
});

test('FR-105 a mutating call whose request never reached Affinity is repeated on a new session', async (ctx) => {
  const t = await setup(ctx);
  await t.call('run_script', { code: 'return 1' });
  t.fake.forgetSessions(); // the next message POST gets HTTP 404
  const r = await t.call('run_script', { code: 'return 2', mutates: true });
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(jsonOf(r).result, 2);
  assert.equal(t.fake.executed, 2);
  assert.equal(t.fake.calls.filter((c) => c.args.filename === 'preamble').length, 2);
});

test('FR-105 a mutating call interrupted in flight is not repeated and reports that it may have run', async (ctx) => {
  const t = await setup(ctx, { scriptDelayMs: 300 });
  await t.call('run_script', { code: 'return 0', mutates: false });
  const pending = t.call('run_script', { code: 'return 1', mutates: true, timeoutMs: 5000 });
  await sleep(100);
  await t.fake.restart();
  const r = await pending;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /closed while the script was running\. It may have run/);
});

test('FR-105 a read-only call interrupted in flight is repeated on a new session', async (ctx) => {
  const t = await setup(ctx, { scriptDelayMs: 300 });
  await t.call('run_script', { code: 'return 0', mutates: false });
  const pending = t.call('run_script', { code: 'return 7', mutates: false, timeoutMs: 5000 });
  await sleep(100);
  await t.fake.restart();
  const r = await pending;
  assert.equal(r.isError, undefined, textOf(r));
  assert.equal(jsonOf(r).result, 7);
});

test('FR-105 a session that ended while idle is replaced on the next call', async (ctx) => {
  const t = await setup(ctx);
  await t.call('get_status');
  await t.fake.restart();
  await sleep(100);
  const r = await t.call('run_script', { code: 'return 3' });
  assert.equal(jsonOf(r).result, 3);
});

test('FR-106 a timed-out mutating call says it may have run; a read-only one does not', async (ctx) => {
  const t = await setup(ctx, { scriptDelayMs: 1500 });
  const w = await t.call('run_script', { code: 'return 1', timeoutMs: 1000 });
  assert.equal(w.isError, true);
  assert.match(textOf(w), /may have run/);
  const r = await t.call('run_script', { code: 'return 1', timeoutMs: 1000, mutates: false });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /did not answer within 1000 ms/);
  assert.doesNotMatch(textOf(r), /may have run/);
});

test('FR-107 a failed preamble read does not stop scripts', async (ctx) => {
  const t = await setup(ctx, { preamble: null });
  const r = await t.call('run_script', { code: 'return 4' });
  assert.equal(jsonOf(r).result, 4);
});

test('FR-130 a preamble-gate answer triggers a preamble read and one repeat', async (ctx) => {
  const t = await setup(ctx);
  await t.call('run_script', { code: 'return 1' });
  t.fake.forgetPreamble();
  const r = await t.call('run_script', { code: 'return 5', mutates: true });
  assert.equal(jsonOf(r).result, 5);
  assert.equal(t.fake.executed, 2);
  assert.equal(t.fake.calls.filter((c) => c.args.filename === 'preamble').length, 2);
});

// 3. Envelope

test('FR-108 the returned value and the console output come back separately', async (ctx) => {
  const t = await setup(ctx);
  const r = jsonOf(await t.call('run_script', { code: "console.log('a'); console.warn('b'); console.error({ c: 1 }); return 5" }));
  assert.deepEqual(r, { result: 5, logs: ['a', 'b', '{"c":1}'] });
  const forged = jsonOf(await t.call('run_script', { code: 'console.log(\'ttam:000000000000:{"ok":true,"result":666}\'); return 1' }));
  assert.equal(forged.result, 1);
});

test('FR-109 results serialize undefined, BigInt, cycles, shared references and SDK objects', async (ctx) => {
  const t = await setup(ctx);
  const run = async (code: string) => jsonOf(await t.call('run_script', { code })).result;
  assert.equal(await run('return undefined'), null);
  assert.equal(await run('let x = 1'), null);
  assert.deepEqual(await run('return { big: 10n }'), { big: '10' });
  assert.deepEqual(await run("const a = { name: 'a' }; a.self = a; return a"), { name: 'a', self: '[Circular]' });
  assert.deepEqual(await run('const s = { v: 1 }; return { x: s, y: s }'), { x: { v: 1 }, y: { v: 1 } });
  assert.deepEqual(await run("class ShapeNode { get [Symbol.toStringTag]() { return 'ShapeNode' } } return { n: new ShapeNode() }"), { n: '[object ShapeNode]' });
  assert.equal(await run("return '$& $1 $$ $`'"), '$& $1 $$ $`');
});

test('FR-110 a thrown error returns its message, stack and earlier logs', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('run_script', { code: "console.log('before'); throw new Error('boom')" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /boom/);
  assert.match(textOf(r), /at /);
  assert.match(textOf(r), /before/);
  const s = await t.call('run_script', { code: "throw 'raw string'" });
  assert.equal(s.isError, true);
  assert.match(textOf(s), /raw string/);
});

test('FR-111 output without a result line is an error carrying the raw output', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('run_script', { code: 'this is not js (' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /SyntaxError/);
});

test('FR-112 a result over 262,144 characters is refused with a size error', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('run_script', { code: "return 'x'.repeat(262145)" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /too large/);
  const ok = await t.call('run_script', { code: "return 'x'.repeat(200000)" });
  assert.equal(jsonOf(ok).result.length, 200000);
});

test('FR-113 console output is capped at 500 lines and 65,536 characters', async (ctx) => {
  const t = await setup(ctx);
  const lines = jsonOf(await t.call('run_script', { code: 'for (let i = 0; i < 600; i++) console.log(i)' }));
  assert.equal(lines.logs.length, 500);
  assert.equal(lines.dropped, 100);
  const chars = jsonOf(await t.call('run_script', { code: "console.log('a'.repeat(40000)); console.log('b'.repeat(40000))" }));
  assert.equal(chars.logs.length, 1);
  assert.equal(chars.dropped, 1);
});

test('FR-114 a failure after changing the current document reports the undo steps added', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('run_script', { code: "require('/application.js').app.documents.current.history.position += 2; throw new Error('late')" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /added 2 undo step/);
});

// 4. run_script

test('FR-115 run_script enforces its parameter limits', async (ctx) => {
  const t = await setup(ctx);
  assert.ok(await refused(() => t.call('run_script', { code: '' })));
  assert.ok(await refused(() => t.call('run_script', { code: 'return 1', timeoutMs: 999 })));
  assert.ok(await refused(() => t.call('run_script', { code: 'return 1', timeoutMs: 600001 })));
  assert.ok(await refused(() => t.call('run_script', { code: 'x'.repeat(1_000_001) })));
  assert.deepEqual(jsonOf(await t.call('run_script', { code: 'return [1, 2]' })), { result: [1, 2], logs: [] });
});

test('FR-116 the run_script description states the script rules', async (ctx) => {
  const t = await setup(ctx);
  const { tools } = await t.client.listTools();
  const d = tools.find((x) => x.name === 'run_script')?.description ?? '';
  for (const s of ['function body', 'return', "require('/", 'eval', '/timers.js', 'Desktop']) assert.ok(d.includes(s), s);
});

// 5. sdk_docs

const bigTopic = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n');
const needles = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? `x ${i} NeEdLe` : `y ${i}`)).join('\n');

test('FR-117 sdk_docs list returns topic names from the native source', async (ctx) => {
  const t = await setup(ctx, { topics: { 'application.js': 'a', 'nodes.js': 'n' } });
  const r = textOf(await t.call('sdk_docs', { action: 'list' }));
  assert.match(r, /^source: native/);
  assert.ok(r.includes('nodes.js'));
});

test('FR-118 sdk_docs read returns numbered ranges and defaults to the first 400 lines', async (ctx) => {
  const t = await setup(ctx, { topics: { 'big.js': bigTopic } });
  const all = textOf(await t.call('sdk_docs', { action: 'read', topic: 'big.js' }));
  assert.ok(all.includes('1: line 1') && all.includes('400: line 400'));
  assert.ok(!all.includes('401: line 401'));
  assert.match(all, /450 lines/);
  const part = textOf(await t.call('sdk_docs', { action: 'read', topic: 'big.js', from: 10, to: 12 }));
  assert.deepEqual(part.split('\n').filter((l) => /^\d+: /.test(l)), ['10: line 10', '11: line 11', '12: line 12']);
});

test('FR-119 sdk_docs search returns at most 20 case-insensitive hits with context and the total', async (ctx) => {
  const t = await setup(ctx, { topics: { 'a.js': needles } });
  const r = textOf(await t.call('sdk_docs', { action: 'search', query: 'needle' }));
  assert.match(r, /30 matches/);
  assert.equal(r.split('\n').filter((l) => /^a\.js:\d+$/.test(l)).length, 20);
  assert.ok(r.includes('y 1'), 'context lines are included');
});

test('FR-120 sdk_docs falls back to the local JSLib folder and names it', async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'jslib-'));
  writeFileSync(join(dir, 'application.js'), 'class Application {}\n');
  mkdirSync(join(dir, 'examples'));
  writeFileSync(join(dir, 'examples', 'grid.js'), 'makeGrid()\n');
  const saved = process.env.AFFINITY_SDK_DIR;
  process.env.AFFINITY_SDK_DIR = dir;
  const t = await setup(ctx, { preamble: null, topics: null });
  const list = textOf(await t.call('sdk_docs', { action: 'list' }));
  assert.match(list, /^source: local/);
  assert.ok(list.includes('examples/grid.js'));
  assert.match(textOf(await t.call('sdk_docs', { action: 'read', topic: 'examples/grid.js' })), /1: makeGrid\(\)/);
  assert.match(textOf(await t.call('sdk_docs', { action: 'search', query: 'application' })), /application\.js:1/);
  assert.ok(await refused(() => t.call('sdk_docs', { action: 'read', topic: '../outside.js' })));
  if (saved === undefined) delete process.env.AFFINITY_SDK_DIR;
  else process.env.AFFINITY_SDK_DIR = saved;
});

test('FR-121 each documentation topic is fetched at most once', async (ctx) => {
  const t = await setup(ctx, { topics: { 'nodes.js': 'n' } });
  await t.call('sdk_docs', { action: 'read', topic: 'nodes.js' });
  await t.call('sdk_docs', { action: 'read', topic: 'nodes.js' });
  await t.call('sdk_docs', { action: 'search', query: 'n' });
  assert.equal(t.fake.calls.filter((c) => c.args.filename === 'nodes.js').length, 1);
});

test('FR-122 sdk_docs hints forwards the query and says it goes online', async (ctx) => {
  const t = await setup(ctx);
  assert.match(textOf(await t.call('sdk_docs', { action: 'hints', query: 'blend mode' })), /hint for: blend mode/);
  const { tools } = await t.client.listTools();
  assert.match(tools.find((x) => x.name === 'sdk_docs')?.description ?? '', /online/);
});

// 6. render

test('FR-123 render passes the image through for the current spread, a given spread and the selection', async (ctx) => {
  const t = await setup(ctx);
  const r = await t.call('render');
  assert.deepEqual(r.content[0], { type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' });
  assert.deepEqual(t.fake.calls.at(-1), { tool: 'render_spread', args: { document_session_uuid: 'DOC-1', spread_index: 1 } });
  await t.call('render', { spreadIndex: 0 });
  assert.equal(t.fake.calls.at(-1)?.args.spread_index, 0);
  await t.call('render', { target: 'selection' });
  assert.deepEqual(t.fake.calls.at(-1), { tool: 'render_selection', args: { document_session_uuid: 'DOC-1' } });
});

test('FR-124 render names the missing precondition', async (ctx) => {
  const none = await setup(ctx, { modules: fixtureModules({ current: null }).modules });
  assert.match(textOf(await none.call('render')), /No document is open/);
  const empty = await setup(ctx, { modules: fixtureModules({ selection: 0 }).modules });
  const r = await empty.call('render', { target: 'selection' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Nothing is selected/);
  assert.match(textOf(await empty.call('render', { spreadIndex: 5 })), /does not exist/);
});

// 7. get_status

test('FR-125 get_status succeeds while Affinity is unreachable and gives the fix', async (ctx) => {
  const url = await refusedUrl();
  const t = await setup(ctx, {}, [url]);
  const r = await t.call('get_status');
  assert.equal(r.isError, undefined);
  const s = jsonOf(r);
  assert.equal(s.connected, false);
  assert.ok(s.reason.includes(url));
  assert.match(s.fix, /Settings > Model Context Protocol > Enable MCP server/);
});

test('FR-126 get_status reports versions, permissions, roots and documents', async (ctx) => {
  const t = await setup(ctx);
  const s = jsonOf(await t.call('get_status'));
  assert.equal(s.connected, true);
  assert.equal(s.url, t.fake.url);
  assert.match(s.server, /^talk-to-affinity-mcp /);
  assert.match(s.affinity, /3\.3\.1\.4940/);
  assert.equal(s.sdk, '0.1');
  assert.equal(s.platform, 'Win32');
  assert.equal(s.permissions.fileSystem, true);
  assert.deepEqual(s.roots, ['C:\\users\\eugen\\Desktop']);
  assert.deepEqual(s.documents, [{ title: 'Fixture', path: null, dirty: false, current: true, spreads: 2 }]);
});

// 8. Server

test('FR-127 instructions stay under 1,500 characters and name the workflow and units', async (ctx) => {
  const t = await setup(ctx);
  const i = t.client.getInstructions() ?? '';
  assert.ok(i.length > 0 && i.length <= 1500, `length ${i.length}`);
  for (const s of ['get_status', 'render', 'run_script', 'document pixels']) assert.ok(i.includes(s), s);
});

test('FR-129 FR-131 the executable speaks MCP on stdout only and exits when stdin closes', async (ctx) => {
  const fake = await startFake({ modules: fixtureModules().modules, preamble: 'p' });
  const child = spawn(process.execPath, [BIN], { env: { ...process.env, AFFINITY_MCP_URL: fake.url }, stdio: ['pipe', 'pipe', 'pipe'] });
  ctx.after(async () => {
    child.kill();
    await fake.close();
  });
  const lines = createInterface({ input: child.stdout });
  const seen: string[] = [];
  const next = () => new Promise<any>((resolve) => lines.once('line', (l) => (seen.push(l), resolve(JSON.parse(l)))));
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  await next();
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual((await next()).result.tools.map((x: { name: string }) => x.name).sort(), ['compare_to_reference', 'create_nodes', 'delete_nodes', 'export', 'get_document', 'get_nodes', 'get_status', 'list_fonts', 'manage_document', 'render', 'run_script', 'sdk_docs', 'undo', 'update_nodes']);
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } });
  assert.equal(JSON.parse((await next()).result.content[0].text).connected, true);
  for (const l of seen) assert.doesNotThrow(() => JSON.parse(l));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await Promise.race([exited, sleep(3000).then(() => 'timeout')]), 0);
});

// 9. Timing

test('NFR-103 a live session adds less than 50 ms per call', async (ctx) => {
  const t = await setup(ctx);
  await t.call('run_script', { code: 'return 0', mutates: false });
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) await t.call('run_script', { code: 'return 1', mutates: false });
  const avg = (performance.now() - t0) / 10;
  assert.ok(avg < 50, `average ${avg.toFixed(1)} ms`);
});

test('NFR-104 the first call after start completes within 2 s', async (ctx) => {
  const t = await setup(ctx);
  const t0 = performance.now();
  await t.call('get_status');
  assert.ok(performance.now() - t0 < 2000);
});

// 10. Runs last: no call during this file may reach the hint or issue tools.

test('FR-128 the server never calls add_sdk_hint or report_sdk_issue', () => {
  assert.ok(allCalls.length > 50);
  assert.deepEqual(allCalls.filter((c) => c.tool === 'add_sdk_hint' || c.tool === 'report_sdk_issue'), []);
});
