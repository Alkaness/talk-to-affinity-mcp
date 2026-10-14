// MCP server and tools (specs/001-foundation/plan.md section 2).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AffinityError, ScriptError, Upstream, VERSION } from './affinity.js';

export const INSTRUCTIONS = `Talk to Affinity controls Affinity by Canva through Affinity's own MCP endpoint.

Workflow:
1. Call get_status first. When it reports connected: false, give the user the fix it returns.
2. Read the document before changing it.
3. After every visual change, call render and look at the image; compare it with a reference when the user gave one.
4. Use run_script only for what the typed tools do not cover. It runs Affinity's JavaScript SDK; look the SDK up with sdk_docs first.

Rules:
- All geometry is in document pixels, origin at the top-left corner of the spread.
- Tools act on the current document. Scripts cannot switch documents; ask the user to activate another one when needed.
- Scripts can read and write files only on the Desktop.`;

const STATUS = `const { app } = require('/application.js');
const { Environment } = require('/environment.js');
const current = app.documents.current;
return {
  affinity: app.version,
  sdk: Environment.sdkVersionStr,
  platform: app.platformName,
  permissions: Environment.permissions,
  roots: Environment.fileSystemRoots,
  documents: app.documents.all.map((d) => ({
    title: d.title,
    path: d.path || null,
    dirty: d.isDirty,
    current: !!current && d.sessionUuid === current.sessionUuid,
    spreads: [...d.spreads].length,
  })),
};`;

const RENDER_INFO = `const d = require('/application.js').app.documents.current;
if (!d) return null;
const spreads = [...d.spreads];
const current = d.currentSpread;
return { id: d.sessionUuid, spreads: spreads.length, spread: Math.max(0, spreads.findIndex((s) => s.isSameNode(current))), selection: d.selection.length };`;

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

function errorText(e: unknown): string {
  if (e instanceof ScriptError) {
    const d = e.details;
    return [
      `Script error: ${e.message}`,
      d.stack,
      d.raw && `Output:\n${d.raw}`,
      d.logs?.length && `Logs:\n${d.logs.join('\n')}`,
      d.undoSteps && `The script added ${d.undoSteps} undo step(s) to the current document before failing. To revert, run app.documents.current.undo() that many times.`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (e instanceof AffinityError) return e.message;
  return `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
}

/** Turns thrown errors into error results, so the client always gets an explanation. */
function guarded<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(errorText(e));
    }
  };
}

function numbered(lines: string[], from: number, to: number) {
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l.length > 300 ? l.slice(0, 300) + ' [...]' : l}`)
    .join('\n');
}

export function createServer(upstream: Upstream): McpServer {
  const server = new McpServer({ name: 'talk-to-affinity-mcp', version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'get_status',
    {
      title: 'Affinity status',
      description: 'Report whether Affinity is reachable, its version, the script permissions and the open documents. Call this first; when connected is false, show the user the fix.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { result } = await upstream.runScript(STATUS, { readOnly: true, timeoutMs: 10000 });
        return ok({ connected: true, url: upstream.url, server: `talk-to-affinity-mcp ${VERSION}`, ...(result as object) });
      } catch (e) {
        if (e instanceof AffinityError && e.fix) return ok({ connected: false, reason: e.reason, fix: e.fix });
        return ok({ connected: true, url: upstream.url, error: errorText(e) }); // reachable, but the status script failed or timed out
      }
    },
  );

  server.registerTool(
    'run_script',
    {
      title: 'Run Affinity script',
      description:
        "Run JavaScript in Affinity with its SDK, for anything the typed tools do not cover. The code runs as a function body: `return` a JSON-serializable value to get it back as result; console output comes back as logs. Load SDK modules with require('/name.js'), for example const { app } = require('/application.js'). eval and new Function are blocked; setTimeout comes from require('/timers.js'). Scripts can read and write files only on the Desktop. Set mutates to false for read-only scripts so they can be retried safely. Geometry is in document pixels. Look the SDK up with sdk_docs.",
      inputSchema: {
        code: z.string().min(1).max(1_000_000),
        mutates: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(600000).default(60000),
      },
    },
    guarded(async ({ code, mutates, timeoutMs }) => {
      const out = await upstream.runScript(code, { readOnly: !mutates, timeoutMs });
      return ok(out);
    }),
  );

  server.registerTool(
    'sdk_docs',
    {
      title: 'Affinity SDK documentation',
      description:
        "Look up Affinity's JavaScript SDK before writing a run_script. action=list: topic names. action=read: one topic with numbered lines; from/to select a range (default: the first 400 lines). action=search: case-insensitive text search across all topics, at most 20 hits with context. action=hints: asks Affinity's online, crowd-sourced hint pool; the query is sent to Affinity's service and the answers are leads, not facts. When the endpoint cannot serve documentation, the local SDK sources (Resources/JSLib) answer instead.",
      inputSchema: {
        action: z.enum(['list', 'read', 'search', 'hints']),
        topic: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        from: z.number().int().min(1).optional(),
        to: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ action, topic, query, from, to }) => {
      if (action === 'list') {
        const { source, topics } = await upstream.listTopics();
        return ok(`source: ${source}\n${topics.length} topics\n${topics.join('\n')}`);
      }
      if (action === 'read') {
        if (!topic) return fail('sdk_docs read needs a topic.');
        const { source, text } = await upstream.readTopic(topic);
        const lines = text.split('\n');
        const start = from ?? 1;
        const end = Math.min(lines.length, to ?? start + 399);
        return ok(`source: ${source}\ntopic: ${topic} (${lines.length} lines), showing ${start}-${end}\n${numbered(lines, start, end)}`);
      }
      if (!query) return fail(`sdk_docs ${action} needs a query.`);
      if (action === 'hints') {
        const res = await upstream.call('search_sdk_hints', { prompt: query }, { readOnly: true });
        return res.isError ? res : { content: res.content };
      }
      const { source, topics } = await upstream.listTopics();
      const needle = query.toLowerCase();
      const hits: string[] = [];
      let total = 0;
      for (const name of topics) {
        const doc = await upstream.readTopic(name).catch(() => undefined);
        if (!doc) continue;
        const lines = doc.text.split('\n');
        lines.forEach((line, i) => {
          if (!line.toLowerCase().includes(needle)) return;
          total++;
          if (hits.length < 20) hits.push(`${name}:${i + 1}\n${numbered(lines, Math.max(1, i - 2), Math.min(lines.length, i + 4))}`);
        });
      }
      return ok(`source: ${source}\n${total} matches for "${query}"; showing ${hits.length}\n\n${hits.join('\n\n')}`);
    }),
  );

  server.registerTool(
    'render',
    {
      title: 'Render',
      description: "Render a spread of the current document (default: the current spread) or the current selection as a JPEG image, longest side at most 1,024 px. Use it to check every visual change.",
      inputSchema: {
        target: z.enum(['spread', 'selection']).default('spread'),
        spreadIndex: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ target, spreadIndex }) => {
      const info = (await upstream.runScript(RENDER_INFO, { readOnly: true, timeoutMs: 10000 })).result as { id: string; spreads: number; spread: number; selection: number } | null;
      if (!info) return fail('No document is open in Affinity. Open or create one first.');
      if (target === 'selection') {
        if (!info.selection) return fail('Nothing is selected in the current document.');
        return upstream.call('render_selection', { document_session_uuid: info.id }, { readOnly: true });
      }
      const index = spreadIndex ?? info.spread;
      if (index >= info.spreads) return fail(`Spread ${index} does not exist; the document has ${info.spreads} spread(s), indexed from 0.`);
      return upstream.call('render_spread', { document_session_uuid: info.id, spread_index: index }, { readOnly: true });
    }),
  );

  return server;
}
