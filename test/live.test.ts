// Slice 001 live tests against a running Affinity (AFFINITY_LIVE=1). They create and close their own documents.
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
