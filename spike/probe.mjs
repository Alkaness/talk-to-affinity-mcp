#!/usr/bin/env node
// Slice 000 spike probe for Affinity's native MCP endpoint. Throwaway: deleted when slice 001 is done.
//
// Usage: node spike/probe.mjs <command> [args] [--url URL] [--timeout MS] [--trace] [--full]
//   hosts                  R-01  which loopback address answers
//   tools                  R-02  server info, protocol version, tools/list (saved to specs/000-spike/native-tools.json)
//   gate                   R-03  execute_script before and after the preamble read
//   run <file.js>...       run script files in one session (preamble read first)
//   eval '<code>'...       run inline scripts in one session
//   call <tool> '<json>'   call any native tool (preamble read first)
//   render [spread]        R-08  render a spread of the current document into spike/out/
//   idle [seconds]         R-11  call, stay idle, call again in the same session
//   docs                   pull every SDK topic into .cache/sdk-docs/
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const has = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv.splice(i, 1).length > 0;
};
const urlArg = opt('--url') ?? process.env.AFFINITY_MCP_URL;
const timeout = Number(opt('--timeout') ?? 120000);
const trace = has('--trace');
const full = has('--full');
const [command, ...rest] = argv;

const CANDIDATES = urlArg
  ? [urlArg]
  : ['http://[::1]:6767/sse', 'http://127.0.0.1:6767/sse'];

function traced(transport) {
  let handler;
  Object.defineProperty(transport, 'onmessage', {
    get: () => handler,
    set: (h) => {
      handler = (m, extra) => {
        console.error('<-', JSON.stringify(m).slice(0, 4000));
        h(m, extra);
      };
    },
  });
  const send = transport.send.bind(transport);
  transport.send = (m, o) => {
    console.error('->', JSON.stringify(m).slice(0, 4000));
    return send(m, o);
  };
  return transport;
}

async function connectTo(url, connectTimeout = 5000) {
  const client = new Client({ name: 'ttam-spike', version: '0.0.0' });
  const transport = new SSEClientTransport(new URL(url));
  if (trace) traced(transport);
  const t0 = performance.now();
  try {
    await client.connect(transport, { timeout: connectTimeout });
  } catch (e) {
    // A failed connect leaves the EventSource retrying forever, which keeps the process alive.
    await transport.close().catch(() => {});
    throw e;
  }
  return { client, transport, url, ms: Math.round(performance.now() - t0) };
}

async function connect() {
  const errors = [];
  for (const url of CANDIDATES) {
    try {
      const c = await connectTo(url);
      console.error(`connected ${url} in ${c.ms} ms`);
      return c;
    } catch (e) {
      errors.push(`${url}: ${e?.cause?.code ?? e?.code ?? ''} ${e?.message ?? e}`);
    }
  }
  throw new Error(`no endpoint answered:\n  ${errors.join('\n  ')}`);
}

async function call(client, name, args = {}) {
  const t0 = performance.now();
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    return { res, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { err: e, ms: Math.round(performance.now() - t0) };
  }
}

function show({ res, err, ms }, label = '') {
  console.log(`--- ${label} (${ms} ms)`);
  if (err) {
    console.log(`THROWN ${err.constructor?.name}: code=${err.code ?? ''} ${err.message}`);
    return;
  }
  if (res.isError) console.log('isError: true');
  for (const c of res.content ?? []) {
    if (c.type === 'text') {
      const t = full ? c.text : c.text.slice(0, 2000);
      console.log(`[text, ${c.text.length} chars]\n${t}${t.length < c.text.length ? '\n[...truncated]' : ''}`);
    } else if (c.type === 'image') {
      console.log(`[image ${c.mimeType}, ${c.data.length} base64 chars]`);
    } else {
      console.log(`[${c.type}]`, JSON.stringify(c).slice(0, 500));
    }
  }
  const extra = Object.keys(res).filter((k) => !['content', 'isError'].includes(k));
  if (extra.length) console.log('other result keys:', extra.join(', '));
}

const text = (res) => (res?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function preamble(client) {
  const r = await call(client, 'read_sdk_documentation_topic', { filename: 'preamble' });
  console.error(`preamble read: ${r.err ? 'THROWN ' + r.err.message : text(r.res).length + ' chars'} (${r.ms} ms)`);
  return r;
}

function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

const commands = {
  async hosts() {
    for (const url of ['http://[::1]:6767/sse', 'http://127.0.0.1:6767/sse', 'http://localhost:6767/sse']) {
      try {
        const c = await connectTo(url, 3000);
        console.log(`OK    ${url} (${c.ms} ms)`);
        await c.client.close();
      } catch (e) {
        console.log(`FAIL  ${url}: ${e?.cause?.code ?? e?.code ?? ''} ${e?.message ?? e}`);
      }
    }
  },

  async tools() {
    const { client, transport } = await connect();
    console.log('serverInfo:', JSON.stringify(client.getServerVersion()));
    console.log('protocolVersion:', transport._protocolVersion);
    console.log('capabilities:', JSON.stringify(client.getServerCapabilities()));
    console.log('instructions:', client.getInstructions() ?? '(none)');
    const { tools } = await client.listTools();
    const out = 'specs/000-spike/native-tools.json';
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(tools, null, 2) + '\n');
    for (const t of tools) console.log(`- ${t.name} ${JSON.stringify(t.inputSchema?.properties ?? {})}`);
    console.log(`${tools.length} tools saved to ${out}`);
    await client.close();
  },

  async gate() {
    const { client } = await connect();
    show(await call(client, 'execute_script', { script: 'console.log("gate-before")' }), 'execute_script before preamble');
    show(await call(client, 'read_sdk_documentation_topic', { filename: 'application.js' }), 'doc topic before preamble');
    await preamble(client);
    show(await call(client, 'execute_script', { script: 'console.log("gate-after")' }), 'execute_script after preamble');
    await client.close();
  },

  async run() {
    const { client } = await connect();
    await preamble(client);
    for (const file of rest) show(await call(client, 'execute_script', { script: await readFile(file, 'utf8') }), file);
    await client.close();
  },

  async eval() {
    const { client } = await connect();
    await preamble(client);
    for (const [i, script] of rest.entries()) show(await call(client, 'execute_script', { script }), `eval #${i + 1}`);
    await client.close();
  },

  async call() {
    const [name, json = '{}'] = rest;
    const { client } = await connect();
    await preamble(client);
    show(await call(client, name, JSON.parse(json)), name);
    await client.close();
  },

  async render() {
    const spread = Number(rest[0] ?? 0);
    const { client } = await connect();
    await preamble(client);
    const r = await call(client, 'execute_script', {
      script: "const { app } = require('/application.js'); console.log(app.documents.current.sessionUuid);",
    });
    const uuid = text(r.res).trim();
    console.log('document_session_uuid:', uuid);
    const shot = await call(client, 'render_spread', { document_session_uuid: uuid, spread_index: spread });
    show(shot, `render_spread ${spread}`);
    const img = shot.res?.content?.find((c) => c.type === 'image');
    if (img) {
      const buf = Buffer.from(img.data, 'base64');
      const ext = img.mimeType.split('/')[1] ?? 'bin';
      const out = `spike/out/render-${spread}.${ext}`;
      await mkdir('spike/out', { recursive: true });
      await writeFile(out, buf);
      console.log(`saved ${out}: ${buf.length} bytes, ${JSON.stringify(imageSize(buf))}`);
    }
    await client.close();
  },

  async idle() {
    const seconds = Number(rest[0] ?? 300);
    const { client } = await connect();
    await preamble(client);
    show(await call(client, 'execute_script', { script: 'console.log("t0")' }), 'call at t=0');
    await new Promise((r) => setTimeout(r, seconds * 1000));
    show(await call(client, 'execute_script', { script: 'console.log("t1")' }), `call after ${seconds} s idle`);
    await client.close();
  },

  async docs() {
    const { client } = await connect();
    await preamble(client);
    const list = text((await call(client, 'list_sdk_documentation')).res);
    const names = list.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    let bytes = 0;
    for (const name of names) {
      const r = await call(client, 'read_sdk_documentation_topic', { filename: name });
      const body = r.err ? `ERROR: ${r.err.message}` : text(r.res);
      const out = join('.cache/sdk-docs', name);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, body);
      bytes += body.length;
    }
    console.log(`${names.length} topics, ${bytes} chars, saved to .cache/sdk-docs/`);
    await client.close();
  },
};

if (!commands[command]) {
  console.error('commands:', Object.keys(commands).join(', '));
  process.exit(2);
}
try {
  await commands[command]();
} catch (e) {
  console.error(e?.message ?? e);
  process.exit(1);
}
