// Emulation of Affinity's native MCP endpoint for unit tests (research R-02 to R-05, R-16).
// execute_script runs the received script in a Node vm context with stub SDK modules.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, dirname, extname, join } from 'node:path';
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

// Slice 002: SDK-like documents for the read tools (research R-19 to R-31).

/** An SDK enum value: it stringifies to its key name (R-29). */
export const en = (name: string) => ({ isEnumValue: true, toString: () => name });
const rgba8 = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >>> 24) & 255, g: (v >>> 16) & 255, b: (v >>> 8) & 255, alpha: v & 255 };
};
export const solid = (hex: string) => ({ fillType: en('Solid'), fill: { colour: { rgba8: rgba8(hex) } } });
export const NO_FILL = { fillType: en('None'), fill: {} };
/** A gradient fill; `type` is the raw number the SDK returns (R-29). */
export const gradient = (type: number, stops: [number, string][]) => ({
  fillType: en('Gradient'),
  fill: { gradientFillType: type, gradient: { stops: stops.map(([position, hex]) => ({ position, midpoint: 0.5, colour: { rgba8: rgba8(hex) } })) } },
});
const box = (b: number[]) => ({ x: b[0], y: b[1], width: b[2], height: b[3] });
export const NO_EXTENT = [-1.7976931348623157e308, -1.7976931348623157e308, 0, 0]; // R-21
const collection = (items: object[]) => ({ toArray: () => items.slice(), [Symbol.iterator]: () => items[Symbol.iterator](), get length() { return items.length; } });

export type Run = [begin: number, end: number, family: string, style: string, weight: number, italic: boolean, heightPx: number, hex: string];

export interface NodeProps {
  name?: string;
  tag?: string;
  shape?: string;
  box?: number[];
  visibleBox?: number[];
  fill?: string | object;
  pen?: string;
  width?: number;
  dash?: number[];
  lineType?: string; // default: Dash when dash is given, else Solid
  scale?: number; // uniform node scale
  raster?: [width: number, height: number]; // pixel size of an image node (R-54)
  noBrush?: boolean; // an unfilled shape: hasBrushFill is false (R-44)
  hidden?: boolean;
  locked?: boolean;
  artboard?: boolean;
  rotation?: number; // radians
  opacity?: number;
  blend?: string;
  effects?: object[];
  text?: string;
  runs?: Run[];
  paragraphs?: [begin: number, end: number, align: string][];
}

/** A node as the SDK presents it; children are listed back to front (R-20). Assignments go to `log`. */
export function fakeNode(cls: string, p: NodeProps = {}, kids: object[] = [], log: string[] = []): any {
  const tags: Record<string, string> = p.tag ? { 'ttam-id': p.tag } : {};
  const text = p.text ?? '';
  const points = [...text]; // story positions count code points (R-30)
  const target: any = {
    [Symbol.toStringTag]: cls,
    description: p.name ?? cls,
    spreadBaseBox: box(p.box ?? [0, 0, 10, 10]),
    spreadVisibleBox: box(p.visibleBox ?? p.box ?? [0, 0, 10, 10]),
    isVisible: !p.hidden,
    isLocked: !!p.locked,
    isArtboardEnabled: !!p.artboard,
    transform: { decompose: () => ({ rotation: p.rotation ?? 0, scaleX: p.scale ?? 1, scaleY: p.scale ?? 1, shear: 0, translateX: 0, translateY: 0 }) },
    globalOpacity: p.opacity ?? 1,
    blendMode: en(p.blend ?? 'Normal'),
    hasBrushFill: !(p.noBrush || cls === 'ContainerNode' || cls.endsWith('TextNode')), // R-22, R-44
    get brushFillDescriptor() {
      if (!this.hasBrushFill) throw new Error('read brushFillDescriptor of a node without a brush fill (R-44: this crashed Affinity)');
      return typeof p.fill === 'string' ? solid(p.fill) : (p.fill ?? NO_FILL);
    },
    hasPenFill: true,
    penFillDescriptor: p.pen ? solid(p.pen) : NO_FILL,
    lineWeight: p.width ?? 0,
    strokeAlignment: en('Centre'),
    lineCap: en('Butt'),
    lineJoin: en('Round'),
    dashPattern: p.dash ?? [],
    lineType: en(p.lineType ?? (p.dash?.length ? 'Dash' : 'Solid')),
    layerEffectsInterface: { effects: p.effects ?? [] },
    tagInterface: { hasKey: (k: string) => k in tags, getValueForKey: (k: string) => tags[k] },
    children: collection(kids),
    ...(p.shape ? { shapeType: en(p.shape) } : {}),
    ...(p.raster ? { rasterWidth: p.raster[0], rasterHeight: p.raster[1] } : {}),
    ...(cls.endsWith('TextNode')
      ? {
          text,
          story: {
            length: points.length,
            getText: (begin: number, length: number) => points.slice(begin, begin + length).join(''),
            glyphAttRuns: (p.runs ?? []).map(([begin, end, familyName, traitsName, weight, isItalic, height, hex]) => ({
              begin,
              end,
              glyphAtts: { font: { familyName, traitsName, weight, isItalic }, height, brushFill: solid(hex) },
            })),
            paragraphAttRuns: (p.paragraphs ?? []).map(([begin, end, align]) => ({ begin, end, paragraphAtts: { alignXType: en(align) } })),
          },
        }
      : {}),
  };
  const node = new Proxy(target, {
    set(t, k, v) {
      log.push(String(k));
      t[k] = v;
      return true;
    },
  });
  target.isSameNode = (o: unknown) => o === node;
  return node;
}

export interface DocumentProps {
  spreads: object[][];
  current?: number | null; // null: no document open
  selection?: object[];
  dpi?: number;
  fonts?: [name: string, installed: boolean][];
  families?: [name: string, styles: [style: string, weight: number, italic: boolean][]][];
  log?: string[];
}

/** SDK modules describing one open document built from fake nodes, plus the font list. */
export function fakeDocument(o: DocumentProps) {
  const log = o.log ?? [];
  const spreads = o.spreads.map((kids, i) => {
    const s: any = { [Symbol.toStringTag]: 'SpreadNode', spreadBaseBox: box([0, 0, 800, 600]), children: collection(kids), description: `Spread ${i}` };
    s.isSameNode = (x: unknown) => x === s;
    return s;
  });
  const doc = new Proxy(
    {
      title: 'Fixture',
      path: '',
      dpi: o.dpi ?? 72,
      units: en('Pixel'),
      widthPixels: 800,
      heightPixels: 600,
      format: en('RGBA8'),
      isDirty: false,
      sessionUuid: 'DOC-1',
      history: { position: 0, size: 0 },
      spreads: collection(spreads),
      currentSpread: spreads[o.current ?? 0],
      selection: { nodes: collection(o.selection ?? []), length: (o.selection ?? []).length },
      enumerateFontNames(callback: (name: string, installed: boolean) => unknown) {
        for (const [name, installed] of o.fonts ?? []) if (callback(name, installed)) break; // a truthy return ends it (R-25)
      },
    },
    {
      set(t: any, k, v) {
        log.push(`document.${String(k)}`);
        t[k] = v;
        return true;
      },
    },
  );
  const families = (o.families ?? []).map(([name, styles]) => ({
    name,
    fonts: styles.map(([traitsName, weight, isItalic]) => ({ traitsName, weight, isItalic })),
  }));
  const current = o.current === null ? null : doc;
  return {
    doc,
    log,
    modules: {
      '/application.js': { app: { version: 'Affinity 3.3.1.4940 Win32 (Oct  6 2026)', documents: { current, all: current ? [doc] : [] } } },
      '/fonts.js': { FontFamily: { all: families } },
      '/fills.js': { GradientFillType: { Conical: en('Conical'), Radial: Object.assign(en('Radial'), { value: 2 }), Elliptical: en('Elliptical'), Linear: Object.assign(en('Linear'), { value: 0 }), keys: () => [] } },
      '/colours.js': {
        Colour: class {
          rgba8: unknown;
          constructor(handle: { rgba8: unknown }) {
            this.rgba8 = handle.rgba8;
          }
        },
      },
    },
  };
}

// Slice 004: files over a real folder that stands for Affinity's Desktop (research R-47 to R-52).

export const PRESETS = ['PNG', 'JPEG (High quality)', 'WebP (Lossless, default)', 'GIF RGB', 'TIFF RGB 8-bit', 'PSD (preserve editability)', 'SVG (for export)', 'PDF (for export)', 'EPS (for export)', 'PDF (for print)', 'JPEG (Best quality)'];

export interface FilesOptions {
  desktop: string; // the path Affinity reports
  toHost?: (p: string) => string; // where that path lies on the host (default: the same path)
  access?: boolean;
}

/** Adds stub file, export and document modules to `modules`; doc.export writes a JSON record of its arguments. */
export function fakeFiles(modules: Record<string, any>, doc: any, o: FilesOptions) {
  const host = (p: string) => (o.toHost ?? ((x: string) => x))(p).replace(/\\/g, '/');
  modules['/application.js'].app.userDesktopPath = o.desktop;
  modules['/environment.js'] = { Environment: { sdkVersionStr: '0.1', permissions: { fileSystem: o.access ?? true, network: false, genAI: false }, fileSystemRoots: [o.desktop] } };
  modules['/fs.js'] = {
    FileSystemApi: { createDirectories: (p: string) => mkdirSync(host(p), { recursive: true }) },
    File: {
      create: (p: string) => {
        if (!existsSync(dirname(host(p)))) throw new Error('NO_SUCH_FILE_OR_DIRECTORY');
        return { writeString: (t: string) => writeFileSync(host(p), t), close() {} };
      },
    },
  };
  modules['/document.js'] = {
    FileExportOptions: { allPresetNames: PRESETS, createWithPresetName: (preset: string) => ({ preset }) },
    FileExportArea: { createForSpreads: (s: string) => ({ spreads: s }), createForWholeDocument: () => ({ whole: true }), createForSelection: () => ({ selection: true }) },
    Document: {
      load: (p: string) => {
        if (!existsSync(host(p))) throw new Error('PERMISSION_DENIED');
        return doc;
      },
    },
  };
  doc.export = (path: string, options: { preset: string }, area: { spreads?: string }, size: unknown) => {
    // R-48 item 2: a spread area appends _1 to the name.
    const file = area.spreads ? join(dirname(host(path)), basename(host(path), extname(path)) + '_1' + extname(path)) : host(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ preset: options.preset, area, size }));
  };
  return modules;
}
