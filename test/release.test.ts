// Slice 006 tests: the package, the README and the CHANGELOG. Test names start with the requirement ID (constitution 2.4).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Upstream } from '../src/affinity.js';
import { createServer } from '../src/tools.js';
import { fixtureModules, startFake } from './fake-affinity.js';

const LIVE = process.env.AFFINITY_LIVE === '1';
const ROOT = new URL('../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const README = read('README.md');
const CHANGELOG = read('CHANGELOG.md');
const jsonOf = (r: CallToolResult) => JSON.parse(r.content.map((c) => ('text' in c ? c.text : '')).join(''));
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;

/** The text after the heading that `heading` matches, up to the next heading of the same or a higher level. */
function part(text: string, heading: RegExp) {
  const m = heading.exec(text);
  assert.ok(m, `heading ${heading}`);
  const level = m[0].indexOf(' ');
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(new RegExp(`^#{2,${level}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}
const section = (n: number) => part(README, new RegExp(`^## ${n}\\. .*$`, 'm'));
const has = (text: string, ...parts: string[]) => {
  for (const p of parts) assert.ok(text.includes(p), p);
};

async function inProcess(ctx: TestContext) {
  const fake = await startFake({ modules: fixtureModules().modules, preamble: 'p' });
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
  return client;
}

async function stdio(ctx: TestContext, bin: string, env: Record<string, string>) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: 'ignore' }));
  ctx.after(() => client.close());
  return client;
}

// One packed copy of the repository serves every test (plan 3.1): packing the repository itself would remove dist, which holds these tests.
const work = mkdtempSync(join(tmpdir(), 'ttam-release-'));
after(() => rmSync(work, { recursive: true, force: true }));
let packed: Promise<{ files: string[]; size: number; unpackedSize: number; dir: string }> | undefined;
const pack = () =>
  (packed ??= (async () => {
    const copy = join(work, 'copy');
    mkdirSync(join(copy, 'dist', 'src'), { recursive: true });
    for (const f of ['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'src']) cpSync(join(ROOT, f), join(copy, f), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'));
    writeFileSync(join(copy, 'dist', 'src', 'stale.js'), '');
    const out = execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: copy, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const [r] = JSON.parse(out.slice(out.search(/^\[/m)));
    execFileSync('tar', ['-xzf', join(work, r.filename), '-C', work]);
    symlinkSync(join(ROOT, 'node_modules'), join(work, 'package', 'node_modules'));
    return { files: r.files.map((f: { path: string }) => f.path).sort(), size: r.size, unpackedSize: r.unpackedSize, dir: join(work, 'package') };
  })());

// 1. Version and package

test('FR-601 the version is 0.1.0 in the package, the lock file, the CHANGELOG and the server', async (ctx) => {
  const lock = JSON.parse(read('package-lock.json'));
  assert.deepEqual([pkg.version, lock.version, lock.packages[''].version], ['0.1.0', '0.1.0', '0.1.0']);
  assert.equal(/^## \[(\d+\.\d+\.\d+)\]/m.exec(CHANGELOG)?.[1], '0.1.0');
  const client = await inProcess(ctx);
  assert.equal(client.getServerVersion()?.version, '0.1.0');
  assert.equal(jsonOf(await call(client, 'get_status')).server, 'talk-to-affinity-mcp 0.1.0');
});

test('FR-602 FR-603 packing builds afresh and packs exactly the 11 files', async () => {
  const { files } = await pack();
  const modules = ['affinity', 'compare', 'index', 'sdk', 'staging', 'svgpath', 'tools'].map((m) => `dist/src/${m}.js`);
  assert.deepEqual(files, ['CHANGELOG.md', 'LICENSE', 'README.md', ...modules, 'package.json'].sort());
});

test('FR-604 the unpacked tarball starts through its bin file and answers over stdio', async (ctx) => {
  const { dir } = await pack();
  assert.equal(pkg.bin['talk-to-affinity-mcp'], 'dist/src/index.js');
  const bin = join(dir, pkg.bin['talk-to-affinity-mcp']);
  assert.equal(readFileSync(bin, 'utf8').split('\n')[0], '#!/usr/bin/env node');
  const fake = await startFake({ modules: fixtureModules().modules, preamble: 'p' });
  ctx.after(() => fake.close());
  const client = await stdio(ctx, bin, { AFFINITY_MCP_URL: fake.url });
  const v = client.getServerVersion();
  assert.deepEqual([v?.name, v?.version], ['talk-to-affinity-mcp', '0.1.0']);
  const s = jsonOf(await call(client, 'get_status'));
  assert.deepEqual([s.connected, s.server], [true, 'talk-to-affinity-mcp 0.1.0']);
  assert.equal(jsonOf(await call(client, 'run_script', { code: 'return 1 + 1', mutates: false })).result, 2); // the envelope is the prelude dist/src/sdk.js
});

test('live FR-604 the unpacked tarball connects to Affinity', { skip: !LIVE && 'set AFFINITY_LIVE=1' }, async (ctx) => {
  const { dir } = await pack();
  const client = await stdio(ctx, join(dir, 'dist', 'src', 'index.js'), {});
  const s = jsonOf(await call(client, 'get_status'));
  assert.equal(s.connected, true);
  assert.match(s.affinity, /Affinity 3\./);
  assert.equal(s.server, 'talk-to-affinity-mcp 0.1.0');
});

test('FR-605 the package publishes as public and names its repository', () => {
  assert.deepEqual(pkg.publishConfig, { access: 'public' });
  assert.ok(pkg.keywords.includes('mcp') && pkg.keywords.includes('affinity'));
  assert.equal(pkg.homepage, 'https://github.com/Alkaness/talk-to-affinity-mcp#readme');
  assert.equal(pkg.bugs.url, 'https://github.com/Alkaness/talk-to-affinity-mcp/issues');
});

test('NFR-601 the tarball is at most 100 kB packed and 300 kB unpacked', async () => {
  const { size, unpackedSize } = await pack();
  assert.ok(size <= 100_000, `packed ${size}`);
  assert.ok(unpackedSize <= 300_000, `unpacked ${unpackedSize}`);
});

// 2. README

test('FR-606 the README has the 11 numbered sections in order', () => {
  const titles = ['Overview', 'Requirements', 'Setup by operating system', 'Client configuration', 'Tools', 'Configuration', 'Conventions', 'Privacy and safety', 'Troubleshooting and known limits', 'Development', 'License'];
  assert.deepEqual([...README.matchAll(/^## (.+)$/gm)].map((m) => m[1]), titles.map((t, i) => `${i + 1}. ${t}`));
});

test('FR-607 the tool table lists every registered tool once, in order, with the count', async (ctx) => {
  const names = (await (await inProcess(ctx)).listTools()).tools.map((t) => t.name);
  const s = section(5);
  assert.deepEqual([...s.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]), names);
  assert.equal(names.length, 14);
  has(s, `${names.length} tools`);
});

test('FR-608 the client configuration covers Claude Code, Claude Desktop, Cursor and a clone', () => {
  const s = section(4);
  has(s, 'claude mcp add', 'cmd /c', 'npx -y @alkaness/talk-to-affinity-mcp', 'claude_desktop_config.json', '.cursor/mcp.json', 'dist/src/index.js');
  const blocks = [...s.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 3, `${blocks.length} JSON blocks`);
  for (const b of blocks)
    for (const server of Object.values(b.mcpServers) as { command: string; args: string[] }[]) {
      const line = [server.command, ...server.args].join(' ');
      assert.ok(line === 'npx -y @alkaness/talk-to-affinity-mcp' || /^node \S+\/dist\/src\/index\.js$/.test(line), line);
    }
});

test('FR-609 the configuration section names every environment variable the server reads', () => {
  const src = readdirSync(join(ROOT, 'src')).filter((f) => /\.(ts|js)$/.test(f)).map((f) => read(join('src', f))).join('\n');
  const vars = [...new Set([...src.matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(vars, ['AFFINITY_DESKTOP_DIR', 'AFFINITY_MCP_URL', 'AFFINITY_SDK_DIR', 'WINEPREFIX', 'XDG_DESKTOP_DIR']);
  has(section(6), ...vars.map((v) => `\`${v}\``));
});

test('FR-610 the setup names both settings, the verified Linux setup and the unverified systems', () => {
  const s = section(3);
  has(s.slice(0, s.search(/^### /m)), 'Settings > Model Context Protocol > Enable MCP server', 'restart', 'Settings > Model Context Protocol > Access files on your Desktop');
  const linux = part(s, /^### 3\.1 Linux under Wine$/m);
  has(linux, '3.3.1.4940', '22.19.0', '127.0.0.1', 'AFFINITY_DESKTOP_DIR', 'AFFINITY_SDK_DIR', 'list_fonts');
  assert.ok(!linux.includes('not live-verified'));
  has(part(s, /^### 3\.2 Windows$/m), 'not live-verified');
  has(part(s, /^### 3\.3 macOS$/m), 'not live-verified');
});

test('FR-611 the privacy and safety section states what leaves the computer and what needs a parameter', () => {
  has(section(8), 'add_sdk_hint', 'report_sdk_issue', '`sdk_docs`', 'hints', 'overwrite', 'discardChanges', 'no authentication', 'loopback', '`run_script`');
});

test('FR-612 troubleshooting gives causes and fixes, and the known limits are listed', () => {
  const s = section(9);
  has(part(s, /^### 9\.1 .*$/m), 'Enable MCP server', 'Access files on your Desktop', 'AFFINITY_DESKTOP_DIR', 'AFFINITY_SDK_DIR', 'fontFallback', 'list_fonts', 'restart');
  has(part(s, /^### 9\.2 .*$/m), 'current document', 'SVG', '1,024', 'Wine');
});

// 3. CHANGELOG

test('FR-613 the CHANGELOG entry for 0.1.0 lists the tools, the Affinity versions and the known limits', async (ctx) => {
  has(CHANGELOG, 'Keep a Changelog', '## [0.1.0] - 2026-10-18', '[0.1.0]: https://github.com/Alkaness/talk-to-affinity-mcp/releases/tag/v0.1.0');
  const entry = part(CHANGELOG, /^## \[0\.1\.0\] - 2026-10-18$/m);
  const added = part(entry, /^### Added$/m);
  const names = (await (await inProcess(ctx)).listTools()).tools.map((t) => t.name);
  has(added, ...names.map((n) => `\`${n}\``), '3.2', '3.3.1.4940');
  has(part(entry, /^### Known limits$/m), 'current document', 'SVG', '1,024', 'Wine');
});

test('NFR-602 the README and the CHANGELOG have no emoji, and the README numbers its headings', () => {
  for (const [name, text] of [['README.md', README], ['CHANGELOG.md', CHANGELOG]]) assert.ok(!/\p{Extended_Pictographic}/u.test(text), name);
  for (const [h] of README.matchAll(/^#{2,} .*$/gm)) assert.match(h, /^#{2,} \d+(\.\d+)*\.? /);
});
