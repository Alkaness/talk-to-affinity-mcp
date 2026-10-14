// Envelope that runs inside Affinity's script engine (specs/001-foundation/plan.md section 3.3).
// src/affinity.ts fills in the two double-underscore placeholders below before sending.
// The read library and the body are defined first, at top level: the body sees the library but not the envelope's variables.

// Read library of the read tools (specs/002-read-model/plan.md section 3). It only reads: getters, enumerations, isSameNode.
var ttam = (() => {
  const TAG = 'ttam-id';
  const SHAPES = { Rectangle: 'rect', Ellipse: 'ellipse', Star: 'star' };
  const CLASSES = { PolyCurveNode: 'path', ImageNode: 'image', ContainerNode: 'layer', GroupNode: 'group', RasterNode: 'raster', PatternRasterNode: 'raster' };
  const r2 = (v) => Math.round(v * 100) / 100;
  const deg = (rad) => r2((rad * 180) / Math.PI);
  const lower = (s) => String(s).toLowerCase();
  const hex = (c) => {
    const v = c.rgba8;
    return '#' + [v.r, v.g, v.b, v.alpha].map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  // R-21: a layer with only hidden content reports x = -1.797e308 and no size.
  const box = (b) => (b.x <= -1e300 ? null : [r2(b.x), r2(b.y), r2(b.width), r2(b.height)]);
  const current = () => require('/application.js').app.documents.current || null;

  // Visits every node of every spread depth first, children back to front (R-20), with its ID: the first node
  // in this order that carries a tag claims it, every other node is named by its path (FR-202, FR-203).
  function walk(doc, visit) {
    const claimed = new Set();
    const down = (nodes, path, parentId, depth, spread) =>
      nodes.forEach((node, i) => {
        const p = path + '/' + i;
        let id = p;
        if (node.tagInterface.hasKey(TAG)) {
          const tag = String(node.tagInterface.getValueForKey(TAG));
          if (!claimed.has(tag)) {
            claimed.add(tag);
            id = tag;
          }
        }
        const children = node.children.toArray();
        visit(node, { spread, path: p, id, parentId, depth, childCount: children.length });
        down(children, p, id, depth + 1, spread);
      });
    doc.spreads.toArray().forEach((s, i) => down(s.children.toArray(), String(i), null, 1, i));
  }

  // Type table, spec section 3.5 (R-19).
  function typeOf(node) {
    const c = String(node).slice(8, -1);
    if (node.isArtboardEnabled) return { type: 'artboard' };
    if (c === 'ShapeNode') {
      const s = String(node.shapeType);
      return SHAPES[s] ? { type: SHAPES[s] } : { type: 'shape', kind: s };
    }
    if (CLASSES[c]) return { type: CLASSES[c] };
    if (c.endsWith('AdjustmentRasterNode')) return { type: 'adjustment', kind: c.slice(0, -20) };
    if (c.endsWith('FilterRasterNode')) return { type: 'filter', kind: c.slice(0, -16) };
    if (c.endsWith('TextNode')) return { type: 'text', kind: c === 'ArtTextNode' ? 'art' : c === 'FrameTextNode' ? 'frame' : c.slice(0, -8) };
    return { type: 'other', kind: c };
  }

  function describe(node, id) {
    const t = typeOf(node);
    const e = { id, type: t.type };
    if (t.kind) e.kind = t.kind;
    e.name = node.description;
    e.box = box(node.spreadBaseBox);
    if (!node.isVisible) e.hidden = true;
    if (node.isLocked) e.locked = true;
    return e;
  }

  function matches(node, q) {
    if (q.type && typeOf(node).type !== q.type) return false;
    if (q.name && !lower(node.description).includes(lower(q.name))) return false;
    if (q.text && !(typeOf(node).type === 'text' && lower(node.text).includes(lower(q.text)))) return false;
    return true;
  }

  // R-22, R-29: fillType names the kind; gradientFillType is a number matched against GradientFillType values.
  function fill(fd) {
    const type = String(fd.fillType);
    const f = fd.fill;
    if (type === 'None') return null;
    if (type === 'Solid') return hex(f.colour);
    if (type !== 'Gradient') return { type };
    const { Colour } = require('/colours.js');
    const kinds = require('/fills.js').GradientFillType;
    return {
      gradient: Object.keys(kinds).find((k) => kinds[k] && kinds[k].value === f.gradientFillType) || String(f.gradientFillType),
      stops: f.gradient.stops.map((s) => ({ at: r2(s.position), color: hex(new Colour(s.colour)) })),
    };
  }

  function stroke(node) {
    const color = fill(node.penFillDescriptor);
    if (color === null || !node.lineWeight) return null;
    const s = { color, width: r2(node.lineWeight), align: String(node.strokeAlignment), cap: String(node.lineCap), join: String(node.lineJoin) };
    const dash = node.dashPattern;
    if (dash && dash.length) s.dash = Array.from(dash, (d) => r2(d));
    return s;
  }

  // R-24, R-30: positions count code points, so run text comes from the story; height is in document pixels.
  // ponytail: runs cover the whole story, so linked frames report each other's runs; limit to storyRange if needed.
  function text(node, dpi) {
    const story = node.story;
    const key = (r) => JSON.stringify([r.family, r.style, r.weight, r.italic, r.size, r.color]);
    const runs = [];
    for (const r of story.glyphAttRuns) {
      const a = r.glyphAtts;
      const font = a.font;
      const run = { text: story.getText(r.begin, r.end - r.begin), family: font.familyName, style: font.traitsName, weight: font.weight, italic: font.isItalic, size: r2((a.height * 72) / dpi), color: fill(a.brushFill) };
      const last = runs[runs.length - 1];
      if (last && key(last) === key(run)) last.text += run.text;
      else runs.push(run);
    }
    const align = [];
    for (const r of story.paragraphAttRuns) {
      const t = story.getText(r.begin, r.end - r.begin);
      const paragraphs = (t.match(/\r\n|[\r\n\u2029]/g) || []).length + (/[\r\n\u2029]$/.test(t) ? 0 : 1);
      for (let i = 0; i < paragraphs; i++) align.push(String(r.paragraphAtts.alignXType));
    }
    return { content: node.text, runs, align };
  }

  function effect(fx) {
    const e = { type: String(fx.type), enabled: fx.enabled, opacity: r2(fx.opacity), blendMode: String(fx.blendMode) };
    if ('radius' in fx) e.radius = r2(fx.radius);
    if ('colour' in fx && fx.colour) e.color = hex(fx.colour);
    if ('offset' in fx) e.offset = r2(fx.offset);
    if ('angle' in fx) e.angle = deg(fx.angle);
    if ('intensity' in fx) e.intensity = r2(fx.intensity);
    return e;
  }

  function detail(node, v, dpi) {
    const e = describe(node, v.id);
    e.parent = v.parentId;
    e.childCount = v.childCount;
    const visible = box(node.spreadVisibleBox);
    if (JSON.stringify(visible) !== JSON.stringify(e.box)) e.visibleBox = visible;
    const rotation = deg(node.transform.decompose().rotation);
    if (rotation) e.rotation = rotation;
    if (node.globalOpacity !== 1) e.opacity = r2(node.globalOpacity);
    const blend = String(node.blendMode);
    if (blend !== 'Normal') e.blendMode = blend;
    const isText = e.type === 'text';
    if (node.hasBrushFill && !isText) e.fill = fill(node.brushFillDescriptor);
    if (node.hasPenFill) e.stroke = stroke(node);
    if (isText) e.text = text(node, dpi);
    const effects = node.layerEffectsInterface.effects;
    if (effects.length) e.effects = effects.map(effect);
    return e;
  }

  // get_document (plan 3.3). Returns null without a document and {fail} for an unknown spread.
  function getDocument(o) {
    const doc = current();
    if (!doc) return null;
    const spreads = doc.spreads.toArray();
    const here = Math.max(0, spreads.findIndex((s) => s.isSameNode(doc.currentSpread)));
    const index = o.spreadIndex === undefined ? here : o.spreadIndex;
    if (index >= spreads.length) return { fail: 'Spread ' + index + ' does not exist; the document has ' + spreads.length + ' spread(s), indexed from 0.' };
    const fonts = [];
    doc.enumerateFontNames((name, installed) => {
      fonts.push({ name, installed }); // block body: a truthy return would end the enumeration (R-25)
    });
    const pending = doc.selection.nodes.toArray();
    const selection = [];
    const artboards = [];
    const nodes = [];
    const listed = new Map();
    let count = 0;
    let omitted = 0;
    walk(doc, (node, v) => {
      const at = pending.findIndex((s) => s.isSameNode(node)); // R-31: identity needs isSameNode
      if (at >= 0) {
        selection.push(v.id);
        pending.splice(at, 1);
      }
      if (v.spread !== index) return;
      if (v.depth === 1 && node.isArtboardEnabled) artboards.push({ id: v.id, name: node.description, box: box(node.spreadBaseBox) });
      if (o.query ? !matches(node, o.query) : v.depth > o.depth) return;
      if (count >= o.limit) {
        omitted++;
        return;
      }
      count++;
      const e = describe(node, v.id);
      listed.set(v.path, [e, v.childCount]);
      if (o.query || v.depth === 1) nodes.push(e);
      else {
        const parent = listed.get(v.path.slice(0, v.path.lastIndexOf('/')))[0];
        (parent.children || (parent.children = [])).push(e);
      }
    });
    if (!o.query) {
      listed.forEach(([e, n]) => {
        if (n > (e.children ? e.children.length : 0)) e.childCount = n;
      });
    }
    const out = {
      document: { title: doc.title, path: doc.path || null, dpi: doc.dpi, units: String(doc.units), width: r2(doc.widthPixels), height: r2(doc.heightPixels), colorFormat: String(doc.format), dirty: doc.isDirty, spreads: spreads.length, currentSpread: here },
      spread: { index, box: box(spreads[index].spreadBaseBox), artboards },
      selection,
      fonts,
      [o.query ? 'matches' : 'nodes']: nodes,
    };
    if (omitted) {
      out.omitted = omitted;
      out.hint = 'Listed ' + count + ' of ' + (count + omitted) + ' nodes. Narrow the request with a smaller depth or a query, read chosen nodes with get_nodes, or raise limit (at most 2000).';
    }
    return out;
  }

  // get_nodes (plan 3.4). A path matches the node at that path; a tag matches the node that claims it.
  function getNodes(ids) {
    const doc = current();
    if (!doc) return null;
    const wanted = new Set(ids);
    const found = new Map();
    walk(doc, (node, v) => {
      const keys = [v.path, v.id].filter((k) => wanted.has(k));
      if (keys.length) {
        const e = detail(node, v, doc.dpi);
        keys.forEach((k) => found.set(k, e));
      }
    });
    return ids.map((id) => found.get(id) || { id, error: 'not found' });
  }

  // list_fonts (plan 3.5, R-25).
  function listFonts(o) {
    const all = require('/fonts.js').FontFamily.all.map((f) => ({ f, name: f.name, key: lower(f.name) }));
    const q = lower(o.query || '');
    const hits = all.filter((x) => x.key.includes(q)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return {
      total: all.length,
      matching: hits.length,
      families: hits.slice(0, o.limit).map((x) => ({ family: x.name, styles: x.f.fonts.map((s) => ({ style: s.traitsName, weight: s.weight, italic: s.isItalic })) })),
    };
  }

  return { getDocument, getNodes, listFonts };
})();

var __ttamBody = function () {
__BODY__
};
(function (body) {
  var NONCE = '__NONCE__';
  var MAX_RESULT = 262144;
  var MAX_LINES = 500;
  var MAX_LOG_CHARS = 65536;
  var NAMES = ['log', 'info', 'warn', 'error', 'debug'];
  var logs = [];
  var logChars = 0;
  var dropped = 0;
  var saved = {};

  // BigInt -> string, ancestor cycle -> '[Circular]', SDK handle object (non-plain, no own keys) -> String(value).
  function replacer() {
    var ancestors = [];
    return function (key, value) {
      if (typeof value === 'bigint') return String(value);
      if (value === null || typeof value !== 'object') return value;
      while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.indexOf(value) !== -1) return '[Circular]';
      var proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null && !Array.isArray(value) && Object.keys(value).length === 0) return String(value);
      ancestors.push(value);
      return value;
    };
  }

  function format(value) {
    if (typeof value === 'string') return value;
    try {
      var s = JSON.stringify(value, replacer());
      return s === undefined ? String(value) : s;
    } catch (e) {
      return String(value);
    }
  }

  function collect() {
    var line = Array.prototype.map.call(arguments, format).join(' ');
    if (logs.length < MAX_LINES && logChars + line.length <= MAX_LOG_CHARS) {
      logs.push(line);
      logChars += line.length;
    } else {
      dropped++;
    }
  }

  function currentDocument() {
    try {
      var d = require('/application.js').app.documents.current;
      return d ? { id: d.sessionUuid, position: d.history.position } : null;
    } catch (e) {
      return null;
    }
  }

  function emit(head) {
    for (var i = 0; i < NAMES.length; i++) console[NAMES[i]] = saved[NAMES[i]];
    console.log(NONCE + '{' + head + ',"logs":' + JSON.stringify(logs) + (dropped ? ',"dropped":' + dropped : '') + '}');
  }

  function fail(fields) {
    fields.ok = false;
    emit(JSON.stringify(fields).slice(1, -1));
  }

  for (var i = 0; i < NAMES.length; i++) {
    saved[NAMES[i]] = console[NAMES[i]];
    console[NAMES[i]] = collect;
  }
  var before = currentDocument();
  var value;
  try {
    value = body();
  } catch (e) {
    var after = currentDocument();
    var error = {
      error: e && e.message !== undefined ? String(e.message) : String(e),
      name: e && e.name ? String(e.name) : undefined,
      stack: e && e.stack ? String(e.stack) : undefined,
    };
    if (before && after && before.id === after.id && after.position !== before.position) error.undoSteps = after.position - before.position;
    fail(error);
    return;
  }
  var json;
  try {
    json = JSON.stringify(value === undefined ? null : value, replacer());
  } catch (e) {
    fail({ error: 'Could not serialize the result: ' + e });
    return;
  }
  if (json === undefined) json = 'null';
  if (json.length > MAX_RESULT) {
    fail({ error: 'Result too large: ' + json.length + ' characters (limit ' + MAX_RESULT + '). Narrow the request.', size: json.length });
    return;
  }
  emit('"ok":true,"result":' + json);
})(__ttamBody);
