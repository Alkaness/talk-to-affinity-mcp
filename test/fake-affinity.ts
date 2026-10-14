// Emulation of Affinity's native MCP endpoint for unit tests (research R-02 to R-05, R-16).
// execute_script runs the received script in a Node vm context with stub SDK modules.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const TOOLS = JSON.parse(readFileSync(new URL('../../specs/000-spike/native-tools.json', import.meta.url), 'utf8'));
const GATE = 'The preamble documentation topic has not yet been read.';

export interface FakeOptions {
  preamble?: string | null; // null: "File not found", as under Wine (R-16)
  topics?: Record<string, string> | null; // null: "Listing failed."
  modules?: Record<string, unknown>; // stub SDK modules served to require()
  scriptDelayMs?: number;
}

export interface FakeCall {
  tool: string;
  args: Record<string, unknown>;
}

/** Every call received by every fake in this process (FR-128). */
export const allCalls: FakeCall[] = [];

export interface Fake {
  url: string;
  options: FakeOptions;
  calls: FakeCall[];
  executed: number;
  restart(): Promise<void>;
  forgetSessions(): void;
  forgetPreamble(): void;
  close(): Promise<void>;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export async function startFake(options: FakeOptions = {}): Promise<Fake> {
  const sessions = new Map<string, { transport: SSEServerTransport; gate: boolean }>();

  function run(script: string): string {
    const out: string[] = [];
    const write = (...a: unknown[]) => out.push(a.map(String).join(' '));
    const sandboxConsole = { log: write, info: write, warn: write, error: write, debug: write };
    const require = (name: string) => {
      const m = options.modules?.[name];
      if (!m) throw new Error(`Cannot find module '${name}'`);
      return m;
    };
    try {
      vm.runInNewContext(script, { console: sandboxConsole, require }, { timeout: 5000 });
    } catch (e) {
      const err = e as Error;
      out.push(`${err.name}: ${err.message}\n    at main:1:1`);
    }
    return out.length ? out.join('\n') + '\n' : '';
  }

  function makeServer(id: string) {
    const server = new Server({ name: 'Affinity', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: "You MUST read the 'preamble' documentation before using the SDK." });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const s = sessions.get(id);
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const call = { tool: req.params.name, args };
      fake.calls.push(call);
      allCalls.push(call);
      switch (req.params.name) {
        case 'read_sdk_documentation_topic': {
          const name = String(args.filename);
          if (name === 'preamble') {
            if (s) s.gate = true; // the gate opens even when the read fails (R-03)
            return options.preamble == null ? text('File not found', true) : text(options.preamble);
          }
          if (!s?.gate) return text(`ERROR: ${GATE}`);
          const topic = options.topics?.[name];
          return topic === undefined ? text('File not found', true) : text(topic);
        }
        case 'list_sdk_documentation':
          return options.topics == null ? text('Listing failed.', true) : text(Object.keys(options.topics).join(', '));
        case 'execute_script': {
          if (!s?.gate) return text(GATE, true);
          if (options.scriptDelayMs) await new Promise((r) => setTimeout(r, options.scriptDelayMs));
          fake.executed++;
          return text(run(String(args.script)));
        }
        case 'render_spread':
        case 'render_selection':
          return { content: [{ type: 'image', mimeType: 'image/jpeg', data: 'ZmFrZQ==' }] };
        case 'search_sdk_hints':
          return text(`hint for: ${String(args.prompt)}`);
        default:
          return text('ok');
      }
    });
    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, { transport, gate: false });
      transport.onclose = () => sessions.delete(transport.sessionId);
      await makeServer(transport.sessionId).connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const s = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (!s) {
        res.writeHead(404).end('Session not found');
        return;
      }
      await s.transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));

  const fake: Fake = {
    url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/sse`,
    options,
    calls: [],
    executed: 0,
    async restart() {
      // Ends every event stream, as an Affinity restart does.
      for (const s of [...sessions.values()]) await s.transport.close();
      sessions.clear();
    },
    forgetSessions() {
      // Server-side session loss with the stream left open: message POSTs get HTTP 404.
      sessions.clear();
    },
    forgetPreamble() {
      for (const s of sessions.values()) s.gate = false;
    },
    async close() {
      await fake.restart();
      httpServer.closeAllConnections();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
  return fake;
}

/** Stub SDK modules describing one open document with two spreads (the second current). */
export function fixtureModules(overrides: { current?: unknown; selection?: number } = {}) {
  const spreadA = { isSameNode: (o: unknown) => o === spreadA };
  const spreadB = { isSameNode: (o: unknown) => o === spreadB };
  const doc = {
    title: 'Fixture',
    path: '',
    isDirty: false,
    sessionUuid: 'DOC-1',
    history: { position: 0 },
    spreads: [spreadA, spreadB],
    currentSpread: spreadB,
    selection: { length: overrides.selection ?? 1 },
  };
  const current = 'current' in overrides ? overrides.current : doc;
  return {
    doc,
    modules: {
      '/application.js': {
        app: { version: 'Affinity 3.3.1.4940 Win32 (Oct  6 2026)', platformName: 'Win32', documents: { current, all: current ? [doc] : [] } },
      },
      '/environment.js': {
        Environment: { sdkVersionStr: '0.1', permissions: { fileSystem: true, network: false, genAI: false }, fileSystemRoots: ['C:\\users\\eugen\\Desktop'] },
      },
    },
  };
}

/** A URL on which nothing listens. */
export async function refusedUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/sse`;
}
