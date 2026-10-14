// R-02b: is the SDK documentation read flaky? Repeats preamble and listing calls across sessions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const url = process.env.AFFINITY_MCP_URL ?? 'http://127.0.0.1:6767/sse';
const sessions = Number(process.argv[2] ?? 4);
const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let s = 0; s < sessions; s++) {
  const client = new Client({ name: 'ttam-spike-docs', version: '0.0.0' });
  const transport = new SSEClientTransport(new URL(url));
  await client.connect(transport);
  const row = [];
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    const p = await client.callTool({ name: 'read_sdk_documentation_topic', arguments: { filename: 'preamble' } });
    row.push(`pre:${text(p).length}${p.isError ? '!' : ''}/${Math.round(performance.now() - t0)}ms`);
    await sleep(i * 250);
  }
  const l = await client.callTool({ name: 'list_sdk_documentation', arguments: {} });
  row.push(`list:${text(l).length}${l.isError ? '!' : ''}`);
  const n = await client.callTool({ name: 'read_sdk_documentation_topic', arguments: { filename: 'nodes.js' } });
  row.push(`nodes:${text(n).length}${n.isError ? '!' : ''}`);
  console.log(`session ${s}: ${row.join('  ')}`);
  await client.close();
  await sleep(500);
}
