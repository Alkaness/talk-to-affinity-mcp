// MCP server and tools (specs/001-foundation/plan.md section 2).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AffinityError, ScriptError, Upstream, VERSION } from './affinity.js';
import { parsePath } from './svgpath.js';

export const INSTRUCTIONS = `Talk to Affinity controls Affinity by Canva through Affinity's own MCP endpoint.

Workflow:
1. Call get_status first. When it reports connected: false, give the user the fix it returns.
2. Read before changing: get_document for the overview and layer tree, get_nodes for exact styling, list_fonts for installed fonts.
3. Change it with create_nodes, update_nodes and delete_nodes. Each call is all or nothing and reports its undo steps; undo reverts them.
4. After every visual change, call render and look at the image; compare it with a reference when the user gave one.
5. Use run_script only for what the typed tools do not cover. It runs Affinity's JavaScript SDK; look the SDK up with sdk_docs first.

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
}
const nodeSchema: z.ZodType<Spec> = z
  .object({
    type: z.enum(['rect', 'ellipse', 'star', 'shape', 'path', 'text', 'layer']),
    id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/, 'an id has 1 to 64 characters from A-Z a-z 0-9 _ . : - and starts with a letter or _').optional(),
    box: z.tuple([xy, xy, z.number().positive(), z.number().positive()]).optional(),
    at: z.tuple([xy, xy]).optional(),
    stroke: stroke.optional(),
    kind: z.string().optional(),
    d: z.string().min(1).max(200000).optional(),
    fillRule: z.enum(['nonzero', 'evenodd']).optional(),
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
    if ((SHAPED.includes(t) || frame) && !n.box) issue(ctx, `box is required for ${frame ? 'frame text' : t}`);
    if (n.box && !(SHAPED.includes(t) || frame)) issue(ctx, 'box applies only to rect, ellipse, star, shape and frame text');
    if (t === 'text' && !frame && !n.at) issue(ctx, 'art text needs at: the start of its first baseline');
    if (n.at && (t !== 'text' || frame)) issue(ctx, 'at applies only to art text');
    only('rotation', [...STROKED, 'text'], 'nodes other than layers');
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
      if (!info) return fail(NO_DOCUMENT);
      if (target === 'selection') {
        if (!info.selection) return fail('Nothing is selected in the current document.');
        return upstream.call('render_selection', { document_session_uuid: info.id }, { readOnly: true });
      }
      const index = spreadIndex ?? info.spread;
      if (index >= info.spreads) return fail(`Spread ${index} does not exist; the document has ${info.spreads} spread(s), indexed from 0.`);
      return upstream.call('render_spread', { document_session_uuid: info.id, spread_index: index }, { readOnly: true });
    }),
  );

  /** Runs one library call (plan 002 section 1): null means no document, {fail} a failed precondition. */
  const read = async (call: string, readOnly = true): Promise<CallToolResult> => {
    const { result } = await upstream.runScript(`return ${call};`, { readOnly, timeoutMs: readOnly ? 30000 : 60000 });
    if (result === null) return fail(NO_DOCUMENT);
    const failed = (result as { fail?: string }).fail;
    return failed ? fail(failed) : ok(result);
  };

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
    guarded(async (args) => read(`ttam.getDocument(${JSON.stringify(args)})`)),
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
      description: `Create rectangles, ellipses, stars, named shapes, SVG paths, text and layers in the current document, in front of the parent's children and in the given order (back to front). parentId is a node ID or a spread index such as "0" for its top level (default: the current spread). ${WRITE_RULES} The call adds 1 undo step, plus 1 for each level at which a new layer contains another new layer; the result states undoSteps and mirrors the input with each node's stable ID: its id when given, otherwise one like rect3. Geometry is in document pixels: box is [x, y, width, height]; art text is placed by the start of its first baseline (at: [x, y]); frame text fills its box. Colours are "#rrggbb" or "#rrggbbaa"; gradients span the box ({gradient: "Linear", angle} or "Radial", stops: [{at, color}]); rotation is in degrees, clockwise, about the box centre (art text: about at); text size is in points; stroke width in pixels; dash lengths in stroke widths. Text uses text plus family, style, size, color, or runs [{text, family, style, size, color}]; "\\n" starts a paragraph; align is one value or one per paragraph. Fonts must be installed (list_fonts) unless fontFallback is true. d accepts SVG commands M L H V C S Q T A Z.`,
      inputSchema: {
        nodes: nodesSchema,
        parentId: z.string().min(1).optional(),
        spreadIndex: z.number().int().min(0).optional(),
        fontFallback: z.boolean().default(false),
      },
    },
    guarded(async (args) => read(`ttam.createNodes(${JSON.stringify({ ...args, nodes: args.nodes.map(prepare) })})`, false)),
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

  return server;
}
