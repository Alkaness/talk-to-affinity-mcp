// MCP server and tools (specs/001-foundation/plan.md section 2).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { AffinityError, ScriptError, Upstream, VERSION } from './affinity.js';
import { compareImages, decode, heatmap, type Image } from './compare.js';
import { ACCESS_FIX, checkFolder, checkTarget, hostPath, LOCATE_FIX, Staging } from './staging.js';
import { parsePath } from './svgpath.js';

export const INSTRUCTIONS = `Talk to Affinity controls Affinity by Canva through Affinity's own MCP endpoint.

Workflow:
1. Call get_status first. When it reports connected: false, give the user the fix it returns.
2. Create, open, save and close documents with manage_document.
3. Read before changing: get_document for the overview and layer tree, get_nodes for exact styling, list_fonts for installed fonts.
4. Change it with create_nodes, update_nodes and delete_nodes. Each call is all or nothing and reports its undo steps; undo reverts them.
5. After every visual change, call render and look at the image. To match a reference image, call compare_to_reference: its regions are in document pixels. Write files with export.
6. Use run_script only for what the typed tools do not cover; look the SDK up with sdk_docs first.

Rules:
- All geometry is in document pixels, origin at the top-left corner of the spread.
- Tools act on the current document. Scripts cannot switch documents; ask the user to activate another one when needed.
- File paths are paths on this computer (absolute or ~). File tools need Settings > Model Context Protocol > Access files on your Desktop in Affinity. Opened files are edited as copies; save writes them back.
- Existing files are replaced only with overwrite: true; close keeps unsaved changes unless discardChanges: true.`;

const STATUS = `const { app } = require('/application.js');
const { Environment } = require('/environment.js');
const current = app.documents.current;
return {
  affinity: app.version,
  sdk: Environment.sdkVersionStr,
  platform: app.platformName,
  desktop: app.userDesktopPath,
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
return { id: d.sessionUuid, spreads: spreads.length, spread: Math.max(0, spreads.findIndex((s) => s.isSameNode(current))), selection: d.selection.length, width: d.widthPixels, height: d.heightPixels };`;
interface RenderInfo {
  id: string;
  spreads: number;
  spread: number;
  selection: number;
  width: number;
  height: number;
}

const NO_DOCUMENT = 'No document is open in Affinity. Open or create one first.';
const IDS =
  'IDs: an ID without "/" is a stable tag; an ID with "/" is a position (spread/child/child..., children counted back to front from 0) that can change when the tree changes, so read again after edits.';
const TYPES = ['artboard', 'rect', 'ellipse', 'star', 'shape', 'path', 'text', 'image', 'layer', 'group', 'raster', 'adjustment', 'filter', 'other'] as const;

// Write schemas (specs/003-write-model/spec.md tables 3.7 and 3.8; names from R-37 and R-43).
const BLEND = ['Normal', 'Darken', 'Multiply', 'ColourBurn', 'LinearBurn', 'DarkerColour', 'Lighten', 'Screen', 'ColourDodge', 'Add', 'LighterColour', 'Overlay', 'SoftLight', 'HardLight', 'VividLight', 'LinearLight', 'PinLight', 'HardMix', 'Difference', 'Exclusion', 'Subtract', 'Divide', 'Hue', 'Saturation', 'Colour', 'Luminosity', 'Average', 'Negation', 'Reflect', 'Glow', 'ContrastInvert', 'Erase', 'Pigment'] as const;
const KINDS = ['Arrow', 'CalloutEllipse', 'CalloutRectangle', 'Cat', 'Cat2', 'Cat3', 'Cat4', 'Cloud', 'Cog', 'Crescent', 'Diamond', 'DoubleStar', 'Heart', 'Pie', 'Polygon', 'Segment', 'Spiral', 'SquareStar', 'Tear', 'Trapezoid', 'Triangle'];
const ALIGNS = ['Left', 'Centre', 'Right', 'JustifyLeft', 'JustifyCentre', 'JustifyRight', 'JustifyAll'] as const;
const SHAPED = ['rect', 'ellipse', 'star', 'shape'];
const STROKED = [...SHAPED, 'path'];
const TEXT_FIELDS = ['text', 'runs', 'family', 'style', 'size', 'color', 'align'] as const;
const color = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'a colour is "#rrggbb" or "#rrggbbaa"');
const xy = z.number();
const fill = z.union([
  color,
  z.null(),
  z.object({ gradient: z.enum(['Linear', 'Radial']), angle: z.number().optional(), stops: z.array(z.object({ at: z.number().min(0).max(1), color }).strict()).min(2).max(64) }).strict(),
]);
const stroke = z
  .object({
    color: color.optional(),
    width: z.number().min(0).max(10000).optional(),
    align: z.enum(['Inside', 'Centre', 'Outside']).optional(),
    cap: z.enum(['Butt', 'Round', 'Square']).optional(),
    join: z.enum(['Miter', 'Round', 'Bevel']).optional(),
    dash: z.array(z.number().positive()).max(32).optional(),
  })
  .strict();
const effects = z
  .array(
    z
      .object({
        type: z.enum(['OuterShadow', 'InnerShadow', 'OuterGlow', 'GaussianBlur']),
        enabled: z.boolean().optional(),
        opacity: z.number().min(0).max(1).optional(),
        blendMode: z.enum(BLEND).optional(),
        radius: z.number().min(0).max(10000).optional(),
        color: color.optional(),
        offset: z.number().min(0).max(10000).optional(),
        angle: z.number().optional(),
        intensity: z.number().min(0).max(1).optional(),
      })
      .strict(),
  )
  .max(4)
  .refine((l) => new Set(l.map((e) => e.type)).size === l.length, 'at most one effect per type');
const fontFields = { family: z.string().min(1).optional(), style: z.string().min(1).optional(), size: z.number().positive().max(10000).optional(), color: color.optional() };
const runs = z.array(z.object({ text: z.string(), ...fontFields }).strict()).min(1).max(1000);
const align = z.union([z.enum(ALIGNS), z.array(z.enum(ALIGNS)).min(1).max(10000)]);
const shapeFields = { cornerRadius: z.number().min(0).max(100000).optional(), points: z.number().int().min(3).max(64).optional(), innerRadius: z.number().gt(0).lt(1).optional(), sides: z.number().int().min(3).max(100).optional() };
const common = { name: z.string().min(1).max(200).optional(), rotation: z.number().optional(), fill: fill.optional(), opacity: z.number().min(0).max(1).optional(), blendMode: z.enum(BLEND).optional(), effects: effects.optional(), ...shapeFields, text: z.string().optional(), runs: runs.optional(), ...fontFields, align: align.optional() };

type Ctx = z.RefinementCtx;
const issue = (ctx: Ctx, message: string) => ctx.addIssue({ code: 'custom', message });

/** Text rules shared by node specs and `set`: content from text or runs, a style only with its family. */
function checkText(n: { text?: string; runs?: { family?: string; style?: string }[]; family?: string; style?: string }, ctx: Ctx, needContent: boolean) {
  if (n.text !== undefined && n.runs !== undefined) issue(ctx, 'give the content either as text or runs, not both');
  else if (needContent && n.text === undefined && n.runs === undefined) issue(ctx, 'text nodes need their content as text or runs');
  if ([n, ...(n.runs ?? [])].some((r) => r.style && !(r.family ?? n.family))) issue(ctx, 'a style needs its family');
}

/** A node spec as the checks see it; the schema below defines every field. */
interface Spec {
  [field: string]: unknown;
  type: string;
  id?: string;
  kind?: string;
  d?: string;
  box?: number[];
  at?: number[];
  sides?: number;
  text?: string;
  runs?: { family?: string; style?: string }[];
  family?: string;
  style?: string;
  children?: Spec[];
  src?: string;
}
const nodeSchema: z.ZodType<Spec> = z
  .object({
    type: z.enum(['rect', 'ellipse', 'star', 'shape', 'path', 'text', 'image', 'layer']),
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/, 'an id has 1 to 64 characters from A-Z a-z 0-9 _ . : - and starts with a letter or _').optional(),
    box: z.tuple([xy, xy, z.number().positive(), z.number().positive()]).optional(),
    at: z.tuple([xy, xy]).optional(),
    stroke: stroke.optional(),
    kind: z.string().optional(),
    d: z.string().min(1).max(200000).optional(),
    fillRule: z.enum(['nonzero', 'evenodd']).optional(),
    src: z.string().min(1).optional(),
    fit: z.enum(['contain', 'stretch']).optional(),
    ...common,
    get children(): z.ZodOptional<z.ZodArray<z.ZodType<Spec>>> {
      return z.array(nodeSchema).max(500).optional();
    },
  })
  .strict()
  .superRefine((n, ctx) => {
    const t = n.type;
    const frame = t === 'text' && n.kind === 'frame';
    const only = (field: string, types: string[], what = types.join(', ')) => {
      if ((n as Spec)[field] !== undefined && !types.includes(t)) issue(ctx, `${field} applies only to ${what}`);
    };
    const boxed = SHAPED.includes(t) || frame || t === 'image';
    if (boxed && !n.box) issue(ctx, `box is required for ${frame ? 'frame text' : t}`);
    if (n.box && !boxed) issue(ctx, 'box applies only to rect, ellipse, star, shape, image and frame text');
    if (t === 'text' && !frame && !n.at) issue(ctx, 'art text needs at: the start of its first baseline');
    if (n.at && (t !== 'text' || frame)) issue(ctx, 'at applies only to art text');
    only('rotation', [...STROKED, 'text', 'image'], 'nodes other than layers');
    only('src', ['image']);
    only('fit', ['image']);
    if (t === 'image' && !n.src) issue(ctx, 'image needs src, the path of an image file on this computer');
    only('fill', STROKED);
    only('stroke', STROKED);
    only('cornerRadius', ['rect']);
    only('points', ['star']);
    only('innerRadius', ['star']);
    only('d', ['path']);
    only('fillRule', ['path']);
    if (t === 'shape' && !KINDS.includes(n.kind ?? '')) issue(ctx, `kind of a shape is one of ${KINDS.join(', ')}`);
    if (t === 'text' && n.kind !== undefined && n.kind !== 'art' && n.kind !== 'frame') issue(ctx, 'kind of a text is art or frame');
    if (n.kind !== undefined && t !== 'shape' && t !== 'text') issue(ctx, 'kind applies only to shape and text');
    if (n.sides !== undefined && !(t === 'shape' && n.kind === 'Polygon')) issue(ctx, 'sides applies only to shapes of kind Polygon');
    if (t === 'path') {
      if (!n.d) issue(ctx, 'path needs d, the SVG path data');
      else {
        try {
          if (!parsePath(n.d).some((p) => p.segments.length)) issue(ctx, 'the path data draws nothing');
        } catch (e) {
          issue(ctx, (e as Error).message);
        }
      }
    }
    if (t === 'text') checkText(n, ctx, true);
    else for (const f of TEXT_FIELDS) only(f, ['text']);
    if (n.children !== undefined && t !== 'layer') issue(ctx, 'only layers take children');
  });

const nodesSchema = z
  .array(nodeSchema)
  .min(1)
  .max(200)
  .superRefine((list, ctx) => {
    let count = 0;
    let deepest = 0;
    const ids = new Set<string>();
    const visit = (n: Spec, depth: number) => {
      count++;
      deepest = Math.max(deepest, depth);
      if (n.id !== undefined) {
        if (ids.has(n.id)) issue(ctx, `id "${n.id}" is used twice`);
        ids.add(n.id);
      }
      n.children?.forEach((c) => visit(c, depth + 1));
    };
    list.forEach((n) => visit(n, 1));
    if (count > 500) issue(ctx, `at most 500 nodes per call (got ${count})`);
    if (deepest > 10) issue(ctx, 'layers can be nested at most 10 levels deep');
  });

const setSchema = z
  .object({ ...common, box: z.tuple([xy, xy, z.number().min(0), z.number().min(0)]).optional(), stroke: stroke.nullable().optional(), hidden: z.boolean().optional(), locked: z.boolean().optional() })
  .strict()
  .superRefine((s, ctx) => {
    if (!Object.keys(s).length) issue(ctx, 'set changes nothing');
    checkText(s, ctx, false);
  });

/** Path data becomes segments before it is sent (plan section 1). */
const prepare = (n: Spec): object => ({ ...n, ...(n.d ? { d: undefined, segments: parsePath(n.d) } : {}), ...(n.children ? { children: n.children.map(prepare) } : {}) });

const WRITE_RULES = 'All or nothing: if any part fails, the document is restored and the error says so.';

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
/** The single file Affinity wrote into a folder; it may have appended _1 to the name (R-48). */
function onlyFile(dir: string) {
  const names = readdirSync(dir);
  if (names.length !== 1) throw new AffinityError(`Affinity wrote ${names.length} files instead of 1.`);
  return join(dir, names[0]);
}

// Spec table 3.8.
const FORMATS: Record<string, { preset: string; raster: boolean }> = {
  png: { preset: 'PNG', raster: true },
  jpg: { preset: 'JPEG (High quality)', raster: true },
  jpeg: { preset: 'JPEG (High quality)', raster: true },
  webp: { preset: 'WebP (Lossless, default)', raster: true },
  gif: { preset: 'GIF RGB', raster: true },
  tif: { preset: 'TIFF RGB 8-bit', raster: true },
  tiff: { preset: 'TIFF RGB 8-bit', raster: true },
  psd: { preset: 'PSD (preserve editability)', raster: true },
  svg: { preset: 'SVG (for export)', raster: false },
  pdf: { preset: 'PDF (for export)', raster: false },
  eps: { preset: 'EPS (for export)', raster: false },
};
const VECTOR = /^(SVG|PDF|EPS|EPUB|DWG|DXF|Enhanced Windows Metafile|Windows Metafile|Canva)/;
const ACTION_FIELDS: Record<string, string[]> = { create: ['width', 'height', 'units', 'dpi', 'pages', 'transparent'], open: ['path'], save: [], saveAs: ['path', 'overwrite'], close: ['discardChanges'] };
const FILE_RULES = "Paths are paths on this computer, absolute or starting with ~; this needs Affinity's Settings > Model Context Protocol > Access files on your Desktop.";

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
  const staging = new Staging(upstream);

  /** Runs one library call (plan 002 section 1): null means no document, {fail} a failed precondition; both throw. */
  const run = async (call: string, readOnly = true): Promise<any> => {
    const { result } = await upstream.runScript(`return ${call};`, { readOnly, timeoutMs: readOnly ? 30000 : 60000 });
    if (result === null) throw new AffinityError(NO_DOCUMENT);
    const failed = (result as { fail?: string }).fail;
    if (failed) throw new AffinityError(failed);
    return result;
  };
  const read = async (call: string, readOnly = true): Promise<CallToolResult> => ok(await run(call, readOnly));

  /** The current document's session and spreads for Affinity's renderer (FR-123). */
  const renderInfo = async () => {
    const info = (await upstream.runScript(RENDER_INFO, { readOnly: true, timeoutMs: 10000 })).result as RenderInfo | null;
    if (!info) throw new AffinityError(NO_DOCUMENT);
    return info;
  };
  const renderSpread = (info: RenderInfo, spreadIndex?: number) => {
    const index = spreadIndex ?? info.spread;
    if (index >= info.spreads) throw new AffinityError(`Spread ${index} does not exist; the document has ${info.spreads} spread(s), indexed from 0.`);
    return upstream.call('render_spread', { document_session_uuid: info.id, spread_index: index }, { readOnly: true });
  };

  server.registerTool(
    'get_status',
    {
      title: 'Affinity status',
      description: "Report whether Affinity is reachable, its version, the script permissions, the open documents with their paths on this computer, and file access (files: whether it is on, Affinity's Desktop and that folder on this computer, or the fix). Call this first; when connected is false, show the user the fix.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { result } = await upstream.runScript(STATUS, { readOnly: true, timeoutMs: 10000 });
        const { desktop, ...status } = result as { desktop: string; permissions: { fileSystem: boolean }; documents: { path: string | null }[] };
        const located = await staging.begin().then(
          (l) => ({ hostDesktop: l.host }),
          (e) => ({ hostDesktop: null, fix: e instanceof AffinityError && e.fix ? e.fix : errorText(e) }),
        ); // FR-424
        for (const d of status.documents) d.path = staging.mapPath(d.path); // FR-423
        return ok({ connected: true, url: upstream.url, server: `talk-to-affinity-mcp ${VERSION}`, ...status, files: { access: !!status.permissions.fileSystem, desktop, ...located } });
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
      description:
        "Render a spread of the current document (default: the current spread), the current selection, or chosen nodes (target nodes with ids: only those nodes, cut to their visible box) as a JPEG image. Without maxSize, spread and selection render at most 1,024 px. With nodes or maxSize (64 to 2,048) the longest side is maxSize (default 1,024), small areas enlarged; this needs Affinity's file access. History, selection and the saved state are unchanged. Use it to check every visual change.",
      inputSchema: {
        target: z.enum(['spread', 'selection', 'nodes']).default('spread'),
        spreadIndex: z.number().int().min(0).optional(),
        ids: z.array(z.string().min(1)).min(1).max(500).optional(),
        maxSize: z.number().int().min(64).max(2048).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ target, spreadIndex, ids, maxSize }) => {
      if ((target === 'nodes') !== (ids !== undefined)) return fail('ids belongs to target nodes, and target nodes needs ids.');
      if (spreadIndex !== undefined && target !== 'spread') return fail('spreadIndex applies only to target spread.');
      if (target === 'nodes' || maxSize !== undefined) {
        // FR-419: through an export, with the document unchanged (plan 2.3).
        await staging.begin();
        return staging.withCall(async (c) => {
          const r = await run(`ttam.exportFiles(${JSON.stringify({ target, spreadIndex, ids, preset: 'JPEG (High quality)', size: { longest: maxSize ?? 1024 }, dir: c.dir, name: 'render.jpg' })})`);
          return { content: [{ type: 'image', mimeType: 'image/jpeg', data: readFileSync(onlyFile(join(c.host, r.files[0].sub))).toString('base64') }] };
        });
      }
      const info = await renderInfo();
      if (target === 'selection') {
        if (!info.selection) return fail('Nothing is selected in the current document.');
        return upstream.call('render_selection', { document_session_uuid: info.id }, { readOnly: true });
      }
      return renderSpread(info, spreadIndex);
    }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Read document',
      description: `Describe the current document: size in pixels, DPI, units, the spread (default: the current one) with its artboards, the selected node IDs, the fonts in use, and the layer tree back to front, to depth levels and at most limit nodes. With query, return instead a flat list of the spread's nodes at any depth that match every given condition: type, name (part, any case), text content (part, any case). Boxes are [x, y, width, height] in document pixels; fields at their default are left out. Use get_nodes for fills, strokes, effects and text styling. ${IDS}`,
      inputSchema: {
        spreadIndex: z.number().int().min(0).optional(),
        depth: z.number().int().min(1).max(20).default(2),
        limit: z.number().int().min(1).max(2000).default(500),
        query: z.object({ type: z.enum(TYPES).optional(), name: z.string().min(1).optional(), text: z.string().min(1).optional() }).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => {
      const r = await run(`ttam.getDocument(${JSON.stringify(args)})`);
      if (r.document.path) {
        await staging.tryLocate();
        r.document.path = staging.mapPath(r.document.path); // FR-423
      }
      return ok(r);
    }),
  );

  server.registerTool(
    'get_nodes',
    {
      title: 'Read nodes',
      description: `Return the exact properties of up to 100 nodes of the current document, one entry per ID in the given order: type, name, box, parent, child count and, when they differ from the default, visible box, rotation in degrees, opacity, blend mode, hidden, locked; fill ("#rrggbbaa", a gradient with stops, or null); stroke (colour, width in pixels, alignment, cap, join, dash, or null); text (content, styled runs with family, style, weight, italic, size in points and colour, paragraph alignment); layer effects. An unknown ID returns {id, error}. ${IDS}`,
      inputSchema: { ids: z.array(z.string().min(1)).min(1).max(100) },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ ids }) => read(`ttam.getNodes(${JSON.stringify(ids)})`)),
  );

  server.registerTool(
    'list_fonts',
    {
      title: 'List fonts',
      description:
        "List the font families installed for Affinity, sorted by name, each with its styles (name, weight, italic), plus the total and the matching family count. query keeps families whose name contains it (any case). Check fonts here before using them: Affinity replaces a missing font silently.",
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true },
    },
    guarded(async (args) => read(`ttam.listFonts(${JSON.stringify(args)})`)),
  );

  server.registerTool(
    'create_nodes',
    {
      title: 'Create nodes',
      description: `Create rectangles, ellipses, stars, named shapes, SVG paths, text, images and layers in the current document, in front of the parent's children and in the given order (back to front). parentId is a node ID or a spread index such as "0" for its top level (default: the current spread). ${WRITE_RULES} The call adds 1 undo step, plus 1 for each level at which a new layer contains another new layer; the result states undoSteps and mirrors the input with each node's stable ID: its id when given, otherwise one like rect3. Geometry is in document pixels: box is [x, y, width, height]; art text is placed by the start of its first baseline (at: [x, y]); frame text fills its box. Colours are "#rrggbb" or "#rrggbbaa"; gradients span the box ({gradient: "Linear", angle} or "Radial", stops: [{at, color}]); rotation is in degrees, clockwise, about the box centre (art text: about at); text size is in points; stroke width in pixels; dash lengths in stroke widths. Text uses text plus family, style, size, color, or runs [{text, family, style, size, color}]; "\\n" starts a paragraph; align is one value or one per paragraph. Fonts must be installed (list_fonts) unless fontFallback is true. d accepts SVG commands M L H V C S Q T A Z. Images: src is the path of a PNG, JPEG, WebP, TIFF or GIF file on this computer, embedded into the document; fit contain (default) keeps its aspect centred in box, stretch fills box; this needs Affinity's file access.`,
      inputSchema: {
        nodes: nodesSchema,
        parentId: z.string().min(1).optional(),
        spreadIndex: z.number().int().min(0).optional(),
        fontFallback: z.boolean().default(false),
      },
    },
    guarded(async (args) => {
      const nodes = args.nodes.map(prepare) as Spec[];
      const go = () => read(`ttam.createNodes(${JSON.stringify({ ...args, nodes })})`, false);
      const images: Spec[] = [];
      const collect = (l: Spec[]) => l.forEach((n) => (n.type === 'image' ? images.push(n) : collect(n.children ?? [])));
      collect(nodes);
      if (!images.length) return go();
      // FR-421 (plan 3.7): files are checked on this computer, then staged for the call.
      for (const n of images) {
        n.src = hostPath(n.src!);
        if (!isFile(n.src)) return fail(`The image ${n.src} does not exist. Nothing was changed.`);
      }
      await staging.begin();
      return staging.withCall(async (c) => {
        for (const n of images) n.staged = c.stage(n.src!);
        return go();
      });
    }),
  );

  server.registerTool(
    'update_nodes',
    {
      title: 'Update nodes',
      description: `Change nodes of the current document in 1 undo step. set changes only the fields it names: name, box (moves and scales; text nodes can only move; a rotated node scales along its bounding box), rotation (absolute degrees), fill (null removes it), stroke (null removes it; a partial stroke changes only its fields), opacity, blendMode, hidden, locked, effects (replaces all; [] removes them), cornerRadius, points, innerRadius, sides, and for text text or runs (replace the content), family, style, size, color, align (restyle all of it). move: {parentId, index} puts the node into another parent (a node ID or a spread index such as "0") and/or at a child index counted back to front. ${WRITE_RULES} Unknown IDs change nothing. A node addressed by a position ID gets a stable ID; the result lists it with the old ID as was.`,
      inputSchema: {
        updates: z
          .array(
            z
              .object({ id: z.string().min(1), set: setSchema.optional(), move: z.object({ parentId: z.string().min(1).optional(), index: z.number().int().min(0).optional() }).strict().optional() })
              .strict()
              .superRefine((u, ctx) => {
                if (!u.set && !u.move) issue(ctx, 'an update needs set or move');
              }),
          )
          .min(1)
          .max(100),
        fontFallback: z.boolean().default(false),
      },
    },
    guarded(async (args) => read(`ttam.updateNodes(${JSON.stringify(args)})`, false)),
  );

  server.registerTool(
    'delete_nodes',
    {
      title: 'Delete nodes',
      description: `Delete nodes of the current document, with everything inside them, in 1 undo step. ${WRITE_RULES} Unknown IDs change nothing.`,
      inputSchema: { ids: z.array(z.string().min(1)).min(1).max(500) },
    },
    guarded(async (args) => read(`ttam.deleteNodes(${JSON.stringify(args)})`, false)),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo',
      description: "Undo, or with redo: true redo, up to steps steps of the current document's history, including steps the user made in Affinity. Returns the number of steps done, the history position and size, and the descriptions of the next undo and redo.",
      inputSchema: { steps: z.number().int().min(1).max(100).default(1), redo: z.boolean().default(false) },
    },
    guarded(async (args) => read(`ttam.undo(${JSON.stringify(args)})`, false)),
  );

  server.registerTool(
    'manage_document',
    {
      title: 'Manage documents',
      description: `Create, open, save or close documents; the result gives the current document afterwards (title, path, dirty, spreads, width and height in pixels, dpi, units) and the number of open documents. create: width and height in units (default Pixel), dpi (72), pages (1), transparent; the new document becomes current. open: path of a file Affinity opens (.af, .afdesign, PNG, SVG and others); Affinity edits a copy that save writes back to path, and the copy becomes current; a file that is open in Affinity but not current cannot be reached, because scripts cannot switch documents. save: saves the current document (to its original path for an opened file); a new or imported document needs saveAs. saveAs: path ending in .af; an existing file is replaced only with overwrite: true. close: closes the current document; with unsaved changes only when discardChanges is true. ${FILE_RULES}`,
      inputSchema: {
        action: z.enum(['create', 'open', 'save', 'saveAs', 'close']),
        width: z.number().positive().max(100000).optional(),
        height: z.number().positive().max(100000).optional(),
        units: z.enum(['Pixel', 'Point', 'Millimetre', 'Centimetre', 'Inch', 'Pica']).optional(),
        dpi: z.number().int().min(1).max(10000).optional(),
        pages: z.number().int().min(1).max(500).optional(),
        transparent: z.boolean().optional(),
        path: z.string().min(1).optional(),
        overwrite: z.boolean().optional(),
        discardChanges: z.boolean().optional(),
      },
    },
    guarded(async (a) => {
      const extra = Object.keys(a).filter((k) => k !== 'action' && (a as Record<string, unknown>)[k] !== undefined && !ACTION_FIELDS[a.action].includes(k));
      if (extra.length) return fail(`${extra.join(', ')} ${extra.length > 1 ? 'do' : 'does'} not apply to action ${a.action}.`);
      if (a.action === 'create' && (a.width === undefined || a.height === undefined)) return fail('create needs width and height.');
      if ((a.action === 'open' || a.action === 'saveAs') && !a.path) return fail(`${a.action} needs path.`);
      const info = () => run('ttam.documentInfo()', false) as Promise<{ document: { path: string | null } | null; open: string[]; count: number }>;
      let note: string | undefined;
      if (a.action === 'create') {
        await run(`ttam.createDocument(${JSON.stringify({ width: a.width, height: a.height, units: a.units ?? 'Pixel', dpi: a.dpi ?? 72, pages: a.pages ?? 1, transparent: !!a.transparent })})`, false);
      } else if (a.action === 'open') {
        const file = hostPath(a.path!);
        if (!isFile(file)) return fail(`${file} does not exist.`);
        await staging.begin();
        const now = await info();
        if (now.document && staging.mapPath(now.document.path) === file) note = 'The file is already open as the current document; nothing was opened.';
        else if (now.open.some((p) => staging.mapPath(p) === file)) return fail(`${file} is open in Affinity but is not the current document, and scripts cannot switch documents. Ask the user to bring it to the front in Affinity.`);
        else {
          const copy = staging.newCopy(file, file);
          try {
            await run(`ttam.openDocument(${JSON.stringify(copy.affinity)})`, false);
          } catch (e) {
            rmSync(copy.folder, { recursive: true, force: true });
            staging.tidy();
            return fail(`Affinity could not open ${file}: ${errorText(e)}`);
          }
        }
      } else if (a.action === 'save') {
        await staging.begin();
        const { path } = await run('ttam.saveDocument({})', false);
        try {
          staging.writeBack(path); // FR-408
        } catch (e) {
          return fail(`Affinity saved the document in its copy, but writing it to ${staging.mapPath(path)} failed: ${(e as Error).message}. Try save again, or saveAs another path.`);
        }
      } else if (a.action === 'saveAs') {
        const file = hostPath(a.path!);
        if (!file.toLowerCase().endsWith('.af')) return fail('saveAs needs a path ending in .af.');
        checkTarget(file, a.overwrite);
        await staging.begin();
        const copy = staging.newCopy(file);
        try {
          await run(`ttam.saveDocument(${JSON.stringify({ as: copy.affinity })})`, false);
        } catch (e) {
          rmSync(copy.folder, { recursive: true, force: true });
          throw e;
        }
        cpSync(copy.host, file, { preserveTimestamps: true });
      } else {
        await run(`ttam.closeDocument(${!!a.discardChanges})`, false); // R-46: a script of its own
      }
      const end = await info();
      if (end.document?.path || end.open.some(Boolean)) await staging.tryLocate();
      const warnings = staging.sync(end.open); // FR-411
      if (end.document) end.document.path = staging.mapPath(end.document.path);
      return ok({ document: end.document, open: end.count, ...(note ? { note } : {}), ...(warnings.length ? { warnings } : {}) });
    }),
  );

  server.registerTool(
    'export',
    {
      title: 'Export',
      description: `Write the current document to a file. The extension of path picks the format: ${Object.entries(FORMATS)
        .map(([e, f]) => `.${e} (${f.preset})`)
        .join(', ')}; preset names any of Affinity's 64 export presets instead. target: spread (default; spreadIndex, default the current spread, cut to the page), nodes (ids on one spread: only those nodes, hidden ones included, cut to their visible box, transparent where the format allows), selection, or document (PDF: one file; otherwise one file per spread, name_1.ext, name_2.ext, ...). Raster size: 1 pixel per document pixel, or scale (up to 32), or width or height in pixels (the other side keeps the aspect); at most 32,768 px a side; SVG, PDF and EPS take no size. An existing file is replaced only with overwrite: true. History, selection and the saved state are unchanged. ${FILE_RULES}`,
      inputSchema: {
        path: z.string().min(1),
        preset: z.string().min(1).optional(),
        target: z.enum(['spread', 'nodes', 'selection', 'document']).default('spread'),
        spreadIndex: z.number().int().min(0).optional(),
        ids: z.array(z.string().min(1)).min(1).max(500).optional(),
        scale: z.number().positive().max(32).optional(),
        width: z.number().int().min(1).max(32768).optional(),
        height: z.number().int().min(1).max(32768).optional(),
        overwrite: z.boolean().default(false),
      },
    },
    guarded(async (a) => {
      const file = hostPath(a.path);
      const ext = extname(file).slice(1).toLowerCase();
      const format = FORMATS[ext];
      if (!a.preset && !format) return fail(`The extension of ${basename(file)} names no format. Use one of ${Object.keys(FORMATS).map((e) => '.' + e).join(', ')}, or give preset.`);
      const sizes = [a.scale, a.width, a.height].filter((v) => v !== undefined).length;
      if (sizes > 1) return fail('Give at most one of scale, width and height.');
      if (sizes && !a.preset && !format.raster) return fail(`.${ext} files have no pixel size: leave out scale, width and height.`);
      if ((a.target === 'nodes') !== (a.ids !== undefined)) return fail('ids belongs to target nodes, and target nodes needs ids.');
      if (a.spreadIndex !== undefined && a.target !== 'spread') return fail('spreadIndex applies only to target spread.');
      const preset = a.preset ?? format.preset;
      const raster = format && !a.preset ? format.raster : !VECTOR.test(preset);
      checkFolder(dirname(file)); // before anything is exported
      await staging.begin();
      return staging.withCall(async (c) => {
        const o = { target: a.target, spreadIndex: a.spreadIndex, ids: a.ids, preset, size: { scale: a.scale, width: a.width, height: a.height }, dir: c.dir, name: basename(file) };
        const r = await run(`ttam.exportFiles(${JSON.stringify(o)})`);
        const stem = basename(file, extname(file));
        const out = (r.files as { sub: string; n?: number; width: number; height: number }[]).map((f) => ({ f, src: onlyFile(join(c.host, f.sub)), dest: f.n ? join(dirname(file), `${stem}_${f.n}${extname(file)}`) : file }));
        for (const x of out) checkTarget(x.dest, a.overwrite); // FR-405: before the first file reaches the folder
        for (const x of out) cpSync(x.src, x.dest);
        return ok({ files: out.map((x) => ({ path: x.dest, bytes: statSync(x.dest).size, ...(raster ? { width: x.f.width, height: x.f.height } : {}) })), preset });
      });
    }),
  );

  server.registerTool(
    'compare_to_reference',
    {
      title: 'Compare to reference',
      description:
        "Compare the current document pixel by pixel with a reference image, to see how closely it matches a mockup or an earlier export and where it differs. reference: a PNG or JPEG file on this computer (absolute or ~). target: spread (default; spreadIndex, default the current spread, its page) or nodes (ids on one spread, cut to their visible box). Both images are compared over white at the smaller of maxSize (default 1,024) and the reference's longest side; their aspect ratios must match within 1% unless fit is stretch, or contain (the reference centred inside the render, only that part compared). A pixel differs when a colour channel differs by more than threshold (0 to 255, default 32, which absorbs JPEG noise). Returns score (1 minus the mean difference), diffRatio (share of differing pixels), up to 5 regions (the worst of 16 cells along the longer side) with box [x, y, width, height] in document pixels and diffRatio, and a heatmap image with differences in red unless heatmap is false. Renders a lossless PNG through Affinity's file access; without it, a spread is compared with Affinity's JPEG render and note says how to turn the access on. History, selection and the saved state are unchanged.",
      inputSchema: {
        reference: z.string().min(1),
        target: z.enum(['spread', 'nodes']).default('spread'),
        spreadIndex: z.number().int().min(0).optional(),
        ids: z.array(z.string().min(1)).min(1).max(500).optional(),
        maxSize: z.number().int().min(64).max(2048).default(1024),
        threshold: z.number().int().min(0).max(255).default(32),
        fit: z.enum(['stretch', 'contain']).optional(),
        heatmap: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async (a) => {
      if ((a.target === 'nodes') !== (a.ids !== undefined)) return fail('ids belongs to target nodes, and target nodes needs ids.');
      if (a.spreadIndex !== undefined && a.target !== 'spread') return fail('spreadIndex applies only to target spread.');
      const file = hostPath(a.reference);
      if (!isFile(file)) return fail(`${file} does not exist.`);
      const reference = decode(readFileSync(file), file); // FR-502: before any script
      const longest = Math.min(a.maxSize, Math.max(reference.width, reference.height));
      let note: string | undefined;
      try {
        await staging.begin();
      } catch (e) {
        // FR-504: without staging, a spread falls back to Affinity's renderer.
        if (!(e instanceof AffinityError && (e.fix === ACCESS_FIX || e.fix === LOCATE_FIX)) || a.target !== 'spread') throw e;
        note = `${e.message} Until then, Affinity's JPEG render is compared.`;
      }
      let shot: { image: Image; area: [number, number, number, number] };
      if (!note) {
        shot = await staging.withCall(async (c) => {
          const r = await run(`ttam.exportFiles(${JSON.stringify({ target: a.target, spreadIndex: a.spreadIndex, ids: a.ids, preset: 'PNG', size: { longest }, dir: c.dir, name: 'compare.png' })})`);
          return { image: decode(readFileSync(onlyFile(join(c.host, r.files[0].sub))), "Affinity's export"), area: r.files[0].area };
        });
      } else {
        const info = await renderInfo();
        const res = await renderSpread(info, a.spreadIndex);
        const img = res.content.find((c) => c.type === 'image');
        if (res.isError || !img || img.type !== 'image') throw new AffinityError(`Affinity's renderer failed: ${res.content.map((c) => ('text' in c ? c.text : '')).join('')}`);
        const image = decode(Buffer.from(img.data, 'base64'), "Affinity's render");
        shot = { image, area: [0, 0, info.width, (image.height * info.width) / image.width] }; // R-57: one scale, the partial last row cut
      }
      const r = compareImages(shot.image, reference, { area: shot.area, threshold: a.threshold, fit: a.fit, longest });
      const out = ok({ score: r.score, diffRatio: r.diffRatio, threshold: a.threshold, render: note ? 'jpeg' : 'png', size: r.size, area: r.area, reference: [reference.width, reference.height], regions: r.regions, ...(note ? { note } : {}) });
      if (a.heatmap) out.content.push({ type: 'image', mimeType: 'image/jpeg', data: heatmap(r.compared, r.deltas, a.threshold).toString('base64') });
      return out;
    }),
  );

  return server;
}
