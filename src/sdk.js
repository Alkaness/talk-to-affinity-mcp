// Envelope that runs inside Affinity's script engine (specs/001-foundation/plan.md section 3.3).
// src/affinity.ts fills in the two double-underscore placeholders below before sending.
// The read library and the body are defined first, at top level: the body sees the library but not the envelope's variables.

// Library of the read tools (specs/002-read-model/plan.md section 3) and the write tools (specs/003-write-model/plan.md
// section 3). The read functions only read: getters, enumerations, isSameNode.
var ttam = (() => {
  const TAG = 'ttam-id';
  const SHAPES = { Rectangle: 'rect', Ellipse: 'ellipse', Star: 'star' };
  const FILLED = ['artboard', 'rect', 'ellipse', 'star', 'shape', 'path'];
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
        let tag = null;
        if (node.tagInterface.hasKey(TAG)) {
          tag = String(node.tagInterface.getValueForKey(TAG));
          if (!claimed.has(tag)) {
            claimed.add(tag);
            id = tag;
          }
        }
        const children = node.children.toArray();
        visit(node, { spread, path: p, id, tag, parentId, depth, childCount: children.length });
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
    if (dash && dash.length && String(node.lineType) === 'Dash') s.dash = Array.from(dash, (d) => r2(d)); // R-37: other types ignore the pattern
    return s;
  }

  // R-24, R-30: positions count code points, so run text comes from the story; height is in document pixels.
  // ponytail: runs cover the whole story, so linked frames report each other's runs; limit to storyRange if needed.
  function text(node, dpi) {
    const story = node.story;
    const scale = Math.abs(node.transform.decompose().scaleY) || 1; // R-38: a scaled node draws its text scaled
    const key = (r) => JSON.stringify([r.family, r.style, r.weight, r.italic, r.size, r.color]);
    const runs = [];
    for (const r of story.glyphAttRuns) {
      const a = r.glyphAtts;
      const font = a.font;
      const run = { text: story.getText(r.begin, r.end - r.begin), family: font.familyName, style: font.traitsName, weight: font.weight, italic: font.isItalic, size: r2((a.height * 72 * scale) / dpi), color: fill(a.brushFill) };
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
    // R-44: an unfilled shape reports hasBrushFill false, and its descriptor must not be read.
    if (FILLED.includes(e.type)) e.fill = node.hasBrushFill ? fill(node.brushFillDescriptor) : null;
    if (node.hasPenFill) e.stroke = stroke(node);
    if (isText) e.text = text(node, dpi);
    if (e.type === 'image') e.image = { width: node.rasterWidth, height: node.rasterHeight }; // R-54
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

  // ---- Write library (specs/003-write-model/plan.md section 3) ----

  const RAD = Math.PI / 180;
  const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
  let modules;
  const sdk = () =>
    modules ||
    (modules = {
      N: require('/nodes.js'),
      C: require('/commands.js'),
      S: require('/shapes.js'),
      G: require('/geometry.js'),
      K: require('/colours.js'),
      F: require('/fills.js'),
      L: require('/linestyle.js'),
      B: require('/blendmodeinterface.js').BlendMode,
      FX: require('/layereffects.js'),
      Sel: require('/selections.js'),
      SB: require('/storybuilder.js').StoryBuilder,
      SD: require('/storydelta.js'),
      GA: require('/glyphatts.js').GlyphAttDoubleType,
    });

  // Waves (plan 3.4): the children of a new layer join its wave unless one of them is a layer (R-32, R-42).
  function plan(specs) {
    const waves = [];
    let groups = [{ parent: null, specs }];
    while (groups.length) {
      const next = [];
      waves.push(
        groups.map((g) => ({
          parent: g.parent,
          items: g.specs.map((spec) => {
            const kids = spec.children || [];
            const inline = kids.every((c) => c.type !== 'layer');
            if (kids.length && !inline) next.push({ parent: spec.id, specs: kids });
            return { spec, inline: inline ? kids : [] };
          }),
        })),
      );
      groups = next;
    }
    return waves;
  }

  function nextId(type, used) {
    for (let n = 1; ; n++) {
      if (!used.has(type + n)) {
        used.add(type + n);
        return type + n;
      }
    }
  }

  function distance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  }

  // The 5 names closest to q: names containing it (or contained in it) first, then by edit distance.
  function closest(names, q) {
    const k = lower(q);
    const rank = (n) => (lower(n).includes(k) || k.includes(lower(n)) ? 0 : 1000) + distance(lower(n), k);
    return names.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 5);
  }

  // FR-312: family and style by name in any case; without a style the face of weight 400 that is not italic.
  function matchFont(families, family, style) {
    const all = families.map((f) => ({ f, name: f.name, key: lower(f.name) }));
    const q = lower(family);
    const hit = all.find((x) => x.key === q);
    if (!hit) return { missing: 'family', suggestions: closest(all.map((x) => x.name), family) };
    const faces = Array.from(hit.f.fonts);
    const face = style ? faces.find((x) => lower(x.traitsName) === lower(style)) : faces.find((x) => x.weight === 400 && !x.isItalic) || faces[0];
    if (!face) return { missing: 'style', family: hit.name, styles: faces.map((x) => x.traitsName) };
    return { family: hit.name, style: face.traitsName, postscriptName: face.postscriptName };
  }

  // R-40: linear along the angle through the box centre, radial as an ellipse centred in the box.
  function gradientData(b, kind, angle) {
    const [x, y, w, h] = b;
    if (kind !== 'Linear') return [w / 2, 0, x + w / 2, 0, h / 2, y + h / 2];
    const a = (angle || 0) * RAD;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const len = Math.abs(w * c) + Math.abs(h * s);
    return [len * c, -len * s, x + w / 2 - (len / 2) * c, len * s, len * c, y + h / 2 - (len / 2) * s];
  }

  // R-33: rotation by deg (clockwise on the page) about (cx, cy).
  function rotationData(cx, cy, deg) {
    const c = Math.cos(deg * RAD);
    const s = Math.sin(deg * RAD);
    return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy];
  }

  const IDENTITY = [1, 0, 0, 0, 1, 0];
  // a after b, both as (m00, m01, tx, m10, m11, ty).
  function multiply(a, b) {
    return [a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2], a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5]];
  }

  // FR-421, R-54: a bitmap of bw x bh px placed in box; contain keeps its aspect, centred.
  function imageData(b, bw, bh, fit) {
    let [x, y, w, h] = b;
    if (fit !== 'stretch') {
      const k = Math.min(w / bw, h / bh);
      x += (w - bw * k) / 2;
      y += (h - bh * k) / 2;
      w = bw * k;
      h = bh * k;
    }
    return [w / bw, 0, x, 0, h / bh, y];
  }

  // Scale about the box corner and move it: box `from` becomes box `to`; a side of length 0 keeps scale 1.
  function boxData(from, to) {
    const sx = from[2] ? to[2] / from[2] : 1;
    const sy = from[3] ? to[3] / from[3] : 1;
    return [sx, 0, to[0] - sx * from[0], 0, sy, to[1] - sy * from[1]];
  }

  // Paragraphs as [begin, end) in code points (R-30), each including its break.
  function paragraphRanges(text) {
    const points = [...text];
    const out = [];
    let begin = 0;
    points.forEach((ch, i) => {
      if (ch === '\n' || ch === '\u2029') {
        out.push([begin, i + 1]);
        begin = i + 1;
      }
    });
    out.push([begin, points.length]);
    return out;
  }

  // FR-302: undo back to the start when anything throws (R-41).
  function atomic(doc, fn) {
    const start = doc.history.position;
    try {
      return fn();
    } catch (e) {
      for (let n = doc.history.position - start; n > 0; n--) doc.undo();
      const error = new Error((e && e.message ? e.message : String(e)) + ' Nothing was changed: the document was restored to its state before the call.');
      if (e && e.stack) error.stack = e.stack;
      throw error;
    }
  }

  const hexColour = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    const a = hex.length === 9;
    return sdk().K.Colour.createRGBA8({ r: (a ? v >>> 24 : v >>> 16) & 255, g: (a ? v >>> 16 : v >>> 8) & 255, b: (a ? v >>> 8 : v) & 255, alpha: a ? v & 255 : 255 });
  };
  const solidFill = (hex) => sdk().F.FillDescriptor.createSolid(sdk().F.SolidFill.create(hexColour(hex)));
  const centre = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
  const rectangle = (b) => new (sdk().G.Rectangle)(b[0], b[1], b[2], b[3]);
  const matrix = (data) => new (sdk().G.Transform)(data[0], data[1], data[2], data[3], data[4], data[5]);

  function fillDescriptor(f, box) {
    const { F, K } = sdk();
    if (f === undefined || f === null) return F.FillDescriptor.createNone();
    if (typeof f === 'string') return solidFill(f);
    const g = K.Gradient.create(f.stops.map((s) => ({ colour: hexColour(s.color), position: s.at })));
    return F.FillDescriptor.create(F.GradientFill.create(g, F.GradientFillType[f.gradient]), true, matrix(gradientData(box, f.gradient, f.angle)));
  }

  // R-37: a solid style without pattern; dashes need type Dash.
  function lineStyle(st) {
    const { L } = sdk();
    const ls = L.LineStyle.createDefaultWithWeight(st ? (st.width === undefined ? 1 : st.width) : 0);
    if (st && st.cap) ls.cap = L.LineCap[st.cap];
    if (st && st.join) ls.join = L.LineJoin[st.join];
    if (st && st.dash && st.dash.length) {
      ls.type = L.LineType.Dash;
      ls.dashPattern = st.dash;
    }
    return L.LineStyleDescriptor.create(ls, { strokeAlignment: L.StrokeAlignment[(st && st.align) || 'Centre'] });
  }
  const penFill = (st) => (st ? solidFill(st.color || '#000000ff') : sdk().F.FillDescriptor.createNone());

  function shapeOf(s) {
    const { S } = sdk();
    if (s.type === 'rect') {
      const r = S.ShapeRectangle.create();
      if (s.cornerRadius) setCorners(r, s.cornerRadius, s.box);
      return r;
    }
    if (s.type === 'ellipse') return S.ShapeEllipse.create();
    const shape = s.type === 'star' ? S.ShapeStar.create() : S['Shape' + s.kind].create();
    reshape(shape, s);
    return shape;
  }

  // R-39: radius in pixels needs absolute sizes and the Round corner type.
  function setCorners(r, radius, box) {
    const { S } = sdk();
    r.setAbsoluteSizes(true, box[2], box[3]);
    for (const c of CORNERS) {
      r[c].cornerType = S.ShapeCornerType.Round;
      r[c].setRadius(radius, box[2], box[3]);
    }
  }

  function reshape(shape, s) {
    if (s.points !== undefined) shape.points = s.points;
    if (s.innerRadius !== undefined) shape.innerRadius = s.innerRadius;
    if (s.sides !== undefined) shape.sides = s.sides;
  }

  // Resolves every family and style named by the specs (FR-312); {fail} when one is missing without fallback.
  function resolveFonts(specs, fallback) {
    const key = (family, style) => lower(family) + '\u0000' + lower(style || '');
    const wanted = new Map();
    for (const s of specs) {
      for (const st of [s].concat(s.runs || [])) {
        const family = st.family || s.family;
        if (family) wanted.set(key(family, st.style || s.style), { family, style: st.style || s.style });
      }
    }
    const faces = new Map();
    const warnings = [];
    const families = wanted.size ? require('/fonts.js').FontFamily.all : [];
    for (const [k, r] of wanted) {
      const hit = matchFont(families, r.family, r.style);
      if (!hit.missing) {
        faces.set(k, hit);
        continue;
      }
      const reason =
        hit.missing === 'family'
          ? 'Font family "' + r.family + '" is not installed; the closest installed families are ' + hit.suggestions.join(', ') + '.'
          : 'Style "' + r.style + '" of "' + hit.family + '" is not installed; its styles are ' + hit.styles.join(', ') + '.';
      if (!fallback) return { fail: reason + ' Choose one with list_fonts, or set fontFallback to let Affinity substitute it. Nothing was changed.' };
      warnings.push(reason + ' Affinity substitutes it.');
    }
    return { warnings, face: (family, style) => faces.get(key(family, style)) || null };
  }

  // One composite glyph delta for a style; null when it sets nothing (R-30, R-36).
  function glyphDelta(st, dpi, scale, fonts) {
    const { SD, GA } = sdk();
    const parts = [];
    if (st.family) {
      const face = fonts.face(st.family, st.style);
      parts.push(face ? SD.StoryDelta.createPostscriptName(face.postscriptName) : SD.StoryDelta.createFamilyName(st.family));
    }
    if (st.size !== undefined) parts.push(SD.StoryDelta.createGlyphDouble(GA.Height, (st.size * dpi) / 72 / scale));
    if (st.color) parts.push(SD.StoryDelta.createBrushFill(solidFill(st.color)));
    return parts.length ? SD.StoryDelta.createComposite(parts) : null;
  }

  const alignDelta = (name) => sdk().SD.StoryDelta.createAlignX(sdk().SD.ParagraphAlignXType[name]);
  const alignAt = (align, i) => (Array.isArray(align) ? align[i] : align);
  const runStyle = (s, r) => ({ family: r.family || s.family, style: r.style || s.style, size: r.size === undefined ? s.size : r.size, color: r.color || s.color });

  function story(s, dpi, fonts) {
    const sb = sdk().SB.create();
    if (s.kind === 'frame') sb.setToFrameTextDefaultStyle(dpi);
    else sb.setToArtisticTextDefaultStyle(dpi);
    let paragraph = 0;
    const align = () => {
      const a = alignAt(s.align, paragraph);
      if (a) sb.applyParagraphDelta(alignDelta(a));
    };
    align();
    for (const r of s.runs || [{ text: s.text }]) {
      const d = glyphDelta(runStyle(s, r), dpi, 1, fonts);
      if (d) sb.applyGlyphDelta(d);
      r.text.split('\n').forEach((part, i) => {
        if (i > 0) {
          sb.addParagraphBreak();
          paragraph++;
          align();
        }
        if (part) sb.addText(part);
      });
    }
    return sb;
  }

  function definition(s, dpi, fonts) {
    const { N, G, F } = sdk();
    let def;
    let pivot;
    let place;
    if (s.type === 'layer') {
      def = N.ContainerNodeDefinition.create(s.name || null);
    } else if (s.type === 'path') {
      const curves = G.PolyCurve.create();
      for (const sub of s.segments) {
        if (!sub.segments.length) continue;
        const cb = G.CurveBuilder.create();
        cb.beginXY(sub.start[0], sub.start[1]);
        for (const g of sub.segments) {
          if (g[0] === 'L') cb.lineToXY(g[1], g[2]);
          else cb.addBezierXY(g[1], g[2], g[3], g[4], g[5], g[6]);
        }
        if (sub.closed) cb.close();
        curves.addCurve(cb.createCurve());
      }
      const bb = curves.boundingBox; // R-40
      const box = [bb.x, bb.y, bb.width, bb.height];
      def = N.PolyCurveNodeDefinition.create(curves, fillDescriptor(s.fill, box), penFill(s.stroke), lineStyle(s.stroke), F.FillDescriptor.createNone());
      pivot = centre(box);
    } else if (s.type === 'text') {
      const sb = story(s, dpi, fonts);
      if (s.kind === 'frame') {
        def = N.FrameTextNodeDefinition.createFromStoryBuilder(rectangle(s.box), sb);
        pivot = centre(s.box);
      } else {
        def = N.ArtTextNodeDefinition.createFromStoryBuilder({ x: s.at[0], y: s.at[1] }, sb); // R-43: the first baseline starts at `at`
        pivot = s.at;
      }
    } else if (s.type === 'image') {
      def = N.ImageNodeDefinition.create(require('/rasterobject.js').RasterFormat.RGBA8).setBitmap(s.bitmap); // R-54
      place = imageData(s.box, s.bitmap.width, s.bitmap.height, s.fit);
      pivot = centre(s.box);
    } else {
      def = N.ShapeNodeDefinition.create(shapeOf(s), rectangle(s.box), fillDescriptor(s.fill, s.box), penFill(s.stroke), lineStyle(s.stroke));
      pivot = centre(s.box);
    }
    if (s.name !== undefined) def.userDescription = s.name;
    if (s.rotation || place) def.transform = matrix(multiply(s.rotation ? rotationData(pivot[0], pivot[1], s.rotation) : IDENTITY, place || IDENTITY)); // R-33
    return def;
  }

  const EFFECTS = {
    OuterShadow: ['OuterShadowLayerEffect', 'createSetOuterShadowLayerEffect', true],
    InnerShadow: ['InnerShadowLayerEffect', 'createSetInnerShadowLayerEffect', true],
    OuterGlow: ['OuterGlowLayerEffect', 'createSetOuterGlowLayerEffect', false],
    GaussianBlur: ['GaussianBlurLayerEffect', 'createSetGaussianBlurLayerEffect', false],
  };

  // R-34: the shadows take an index, the glow and the blur do not.
  function effectCommand(sel, e) {
    const { C, FX, B } = sdk();
    const [cls, factory, indexed] = EFFECTS[e.type];
    const fx = FX[cls].create();
    fx.enabled = e.enabled !== false;
    if (e.opacity !== undefined) fx.opacity = e.opacity;
    if (e.blendMode) fx.blendMode = B[e.blendMode];
    if (e.radius !== undefined) fx.radius = e.radius;
    if (e.color && 'colour' in fx) fx.colour = hexColour(e.color);
    if (e.offset !== undefined && 'offset' in fx) fx.offset = e.offset;
    if (e.angle !== undefined && 'angle' in fx) fx.angle = e.angle * RAD;
    if (e.intensity !== undefined && 'intensity' in fx) fx.intensity = e.intensity;
    return indexed ? C.DocumentCommand[factory](sel, fx, 0) : C.DocumentCommand[factory](sel, fx);
  }

  // Settings that commands apply through the selection, null for the node just inserted (R-42).
  function settings(s, sel) {
    const { C, B, G } = sdk();
    const D = C.DocumentCommand;
    const out = [];
    if (s.opacity !== undefined) out.push(D.createSetOpacity(sel, s.opacity));
    if (s.blendMode !== undefined) out.push(D.createSetBlendMode(sel, B[s.blendMode]));
    if (s.fillRule !== undefined) out.push(D.createSetWindingMode(sel, s.fillRule === 'evenodd' ? G.WindingOrder.OddEven : G.WindingOrder.NonZero));
    for (const e of s.effects || []) out.push(effectCommand(sel, e));
    return out;
  }

  function insert(cb, s, target, dpi, fonts) {
    const { C, N } = sdk();
    const b = C.AddChildNodesCommandBuilder.create();
    b.addNode(definition(s, dpi, fonts));
    if (target) {
      b.setInsertionTarget(target);
      b.setInsertionMode(C.InsertionMode.Inside_AtBack); // R-32: appends in front
    }
    cb.addCommand(b.createCommand(true, N.NodeChildType.Main));
    cb.addCommand(C.DocumentCommand.createSetTagValueForKey(null, TAG, s.id));
    for (const c of settings(s, null)) cb.addCommand(c);
  }

  const flat = (specs) => specs.flatMap((s) => [s].concat(flat(s.children || [])));

  // Finds nodes and the spread top level by ID; collects every tag. A string of digits names the top level of that spread.
  function scan(doc, ids) {
    const wanted = new Set(ids);
    const found = new Map();
    const used = new Set();
    const spreads = doc.spreads.toArray();
    for (const id of ids) if (/^\d+$/.test(id) && +id < spreads.length) found.set(id, { node: spreads[+id], v: { spread: +id, path: id, id, top: true } });
    walk(doc, (node, v) => {
      if (v.tag !== null) used.add(v.tag);
      for (const k of [v.path, v.id]) if (wanted.has(k) && !found.has(k)) found.set(k, { node, v });
    });
    const unknown = ids.filter((id) => !found.has(id));
    return { found, used, spreads, here: Math.max(0, spreads.findIndex((s) => s.isSameNode(doc.currentSpread))), unknown: unknown.filter((x, i) => unknown.indexOf(x) === i) };
  }

  const nothing = ' Nothing was changed.';
  const unknownIds = (ids) => ({ fail: 'No node has the ID ' + ids.map((x) => '"' + x + '"').join(', ') + '.' + nothing });
  const twoSpreads = { fail: 'The nodes lie on more than one spread; change each spread in its own call.' + nothing };
  const switchTo = (cb, at) => at.spread !== at.here && cb.addCommand(sdk().C.DocumentCommand.createSetCurrentSpread(at.spreads[at.spread])); // R-42

  // create_nodes (plan 3.4).
  function createNodes(o) {
    const doc = current();
    if (!doc) return null;
    const { C } = sdk();
    const { found, used, spreads, here, unknown } = scan(doc, o.parentId === undefined ? [] : [o.parentId]);
    if (unknown.length) return { fail: 'The parent "' + o.parentId + '" was not found.' + nothing };
    const parentHit = o.parentId === undefined ? null : found.get(o.parentId);
    const spread = parentHit ? parentHit.v.spread : o.spreadIndex === undefined ? here : o.spreadIndex;
    if (spread >= spreads.length) return { fail: 'Spread ' + spread + ' does not exist; the document has ' + spreads.length + ' spread(s), indexed from 0.' + nothing };
    const parent = parentHit ? parentHit.node : spreads[spread];
    const all = flat(o.nodes);
    const taken = all.find((s) => s.id !== undefined && used.has(s.id));
    if (taken) return { fail: 'The ID "' + taken.id + '" is already used in the document.' + nothing };
    for (const s of all) if (s.id !== undefined) used.add(s.id);
    for (const s of all) if (s.id === undefined) s.id = nextId(s.type, used);
    const fonts = resolveFonts(all.filter((s) => s.type === 'text'), o.fontFallback);
    if (fonts.fail) return fonts;
    for (const s of all) {
      if (s.type !== 'image') continue;
      try {
        s.bitmap = require('/rasterobject.js').Bitmap.loadFromFile(s.staged); // R-54: NOT_SUPPORTED or ERROR
      } catch (e) {
        return { fail: 'The image ' + s.src + ' is not a PNG, JPEG, WebP, TIFF or GIF file Affinity can read.' + nothing };
      }
    }
    const waves = plan(o.nodes);
    return atomic(doc, () => {
      waves.forEach((wave, w) => {
        const cb = C.CompoundCommandBuilder.create();
        if (w === 0) switchTo(cb, { spread, here, spreads });
        const parents = w === 0 ? null : scan(doc, wave.map((g) => g.parent)).found;
        for (const g of wave) {
          const target = g.parent === null ? parent : parents.get(g.parent).node;
          for (const item of g.items) {
            insert(cb, item.spec, target, doc.dpi, fonts);
            for (const child of item.inline) insert(cb, child, null, doc.dpi, fonts); // R-32: into the selected new layer, then in front of each other
          }
        }
        doc.executeCommand(cb.createCommand());
      });
      const names = new Map();
      walk(doc, (node, v) => v.tag !== null && !names.has(v.tag) && names.set(v.tag, node.description));
      const mirror = (specs) => specs.map((s) => Object.assign({ id: s.id, name: names.get(s.id) }, s.children ? { children: mirror(s.children) } : {}));
      const out = { created: mirror(o.nodes), undoSteps: waves.length };
      if (fonts.warnings.length) out.warnings = fonts.warnings;
      if (spread !== here) out.spread = spread;
      return out;
    });
  }

  function strokeCommands(st, sel) {
    const { C, L } = sdk();
    const D = C.DocumentCommand;
    const M = L.LineStyleMask;
    const out = [];
    if (st.color) out.push(D.createSetPenFill(sel, solidFill(st.color)));
    const ls = L.LineStyle.createDefaultWithWeight(st.width === undefined ? 1 : st.width);
    let mask = st.width === undefined ? 0 : M.Weight.value;
    if (st.cap) {
      ls.cap = L.LineCap[st.cap];
      mask |= M.Cap.value;
    }
    if (st.join) {
      ls.join = L.LineJoin[st.join];
      mask |= M.Join.value;
    }
    if (st.dash) {
      ls.type = st.dash.length ? L.LineType.Dash : L.LineType.Solid;
      ls.dashPattern = st.dash;
      mask |= M.DashPattern.value | M.Type.value;
    }
    if (mask) out.push(D.createSetLineStyle(sel, ls, { lineStyleMask: mask })); // R-37: a numeric mask of the fields given
    if (st.align) out.push(D.createSetStrokeAlignment(sel, L.StrokeAlignment[st.align]));
    return out;
  }

  // Text content and style (FR-320, R-38): ranges count code points from the start of the node's story.
  function textCommands(add, doc, node, s, fonts) {
    const { C, Sel } = sdk();
    const D = C.DocumentCommand;
    const base = node.storyRange.begin;
    const select = (range) => {
      const sel = Sel.Selection.create(doc, node);
      sel.addSubSelectionForNode(node, Sel.TextSelection.create(range));
      return sel;
    };
    const span = (b, e) => select([{ begin: base + b, end: base + e }]);
    const content = s.runs ? s.runs.map((r) => r.text).join('') : s.text;
    if (content !== undefined) add(D.createSetText(select(node.storyRange), content));
    const text = content === undefined ? node.text : content;
    const length = [...text].length;
    const scale = Math.abs(node.transform.decompose().scaleY) || 1;
    const whole = glyphDelta(s, doc.dpi, scale, fonts);
    if (whole && length) add(D.createFormatText(span(0, length), whole));
    let at = 0;
    for (const r of s.runs || []) {
      const n = [...r.text].length;
      const d = glyphDelta(runStyle(s, r), doc.dpi, scale, fonts);
      if (d && n) add(D.createFormatText(span(at, at + n), d));
      at += n;
    }
    if (s.align !== undefined) {
      paragraphRanges(text).forEach(([b, e], i) => {
        const a = alignAt(s.align, i);
        if (a && e > b) add(D.createFormatText(span(b, e), alignDelta(a)));
      });
    }
  }

  // R-35: Before a sibling to land at `index`, After the last child, or Inside an empty parent.
  function moveCommand(node, mv, found) {
    const { C } = sdk();
    const T = C.NodeMoveType;
    const parent = mv.parentId === undefined ? node.parent : found.get(mv.parentId).node;
    const others = parent.children.toArray().filter((c) => !c.isSameNode(node));
    const sel = node.selfSelection;
    if (mv.index !== undefined && mv.index < others.length) return C.DocumentCommand.createMoveNodes(sel, others[mv.index], T.Before);
    if (others.length) return C.DocumentCommand.createMoveNodes(sel, others[others.length - 1], T.After);
    return C.DocumentCommand.createMoveNodes(sel, parent, T.Inside);
  }

  // Why a `set` field cannot apply to a node, or null.
  function misfit(node, t, s) {
    const has = (k) => s[k] !== undefined;
    if ((has('fill') || has('stroke')) && !FILLED.includes(t)) return 'fill and stroke do not apply to ' + t + ' nodes.';
    if (has('cornerRadius') && t !== 'rect') return 'cornerRadius applies only to rect nodes.';
    if ((has('points') || has('innerRadius')) && t !== 'star') return 'points and innerRadius apply only to star nodes.';
    if (has('sides') && String(node.shapeType) !== 'Polygon') return 'sides applies only to shapes of kind Polygon.';
    const textFields = ['text', 'runs', 'family', 'style', 'size', 'color', 'align'].filter(has);
    if (textFields.length && t !== 'text') return textFields.join(', ') + ' apply only to text nodes.';
    if (has('box') && t === 'text') {
      const b = node.spreadBaseBox;
      if (Math.abs(s.box[2] - b.width) > 0.01 || Math.abs(s.box[3] - b.height) > 0.01) return 'a text node can only be moved: keep its box size ' + r2(b.width) + ' x ' + r2(b.height) + ' and change the text size with size (R-38).';
    }
    return null;
  }

  // update_nodes (plan 3.5).
  function updateNodes(o) {
    const doc = current();
    if (!doc) return null;
    const { C } = sdk();
    const D = C.DocumentCommand;
    const ids = [];
    for (const u of o.updates) ids.push(u.id, ...(u.move && u.move.parentId !== undefined ? [u.move.parentId] : []));
    const at = scan(doc, ids);
    if (at.unknown.length) return unknownIds(at.unknown);
    const spreadsHit = new Set(ids.map((id) => at.found.get(id).v.spread));
    if (spreadsHit.size > 1) return twoSpreads;
    at.spread = [...spreadsHit][0];
    for (const u of o.updates) {
      const hit = at.found.get(u.id);
      if (hit.v.top) return { fail: '"' + u.id + '" is a spread, not a node.' + nothing };
      const problem = misfit(hit.node, typeOf(hit.node).type, u.set || {});
      if (problem) return { fail: 'Node "' + u.id + '": ' + problem + nothing };
    }
    const fonts = resolveFonts(o.updates.filter((u) => u.set && (u.set.family || u.set.runs)).map((u) => u.set), o.fontFallback);
    if (fonts.fail) return fonts;
    return atomic(doc, () => {
      const cb = C.CompoundCommandBuilder.create();
      const add = (c) => cb.addCommand(c);
      switchTo(cb, at);
      const retagged = new Map();
      const updated = o.updates.map((u) => {
        const { node, v } = at.found.get(u.id);
        const s = u.set || {};
        const sel = node.selfSelection;
        if (s.name !== undefined) add(D.createSetDescription(sel, s.name));
        const b0 = node.spreadBaseBox;
        let box = [b0.x, b0.y, b0.width, b0.height];
        if (s.box) {
          add(D.createTransform(sel, matrix(boxData(box, s.box))));
          box = s.box;
        }
        if (s.rotation !== undefined) {
          const turn = s.rotation - node.transform.decompose().rotation / RAD;
          if (Math.abs(turn) > 1e-9) add(D.createTransform(sel, matrix(rotationData(box[0] + box[2] / 2, box[1] + box[3] / 2, turn))));
        }
        if (s.fill !== undefined) add(D.createSetBrushFill(sel, fillDescriptor(s.fill, box)));
        if (s.stroke === null) add(D.createSetPenFill(sel, sdk().F.FillDescriptor.createNone()));
        else if (s.stroke) strokeCommands(s.stroke, sel).forEach(add);
        settings({ opacity: s.opacity, blendMode: s.blendMode }, sel).forEach(add);
        if (s.effects) {
          add(D.createRemoveAllLayerEffects(sel));
          for (const e of s.effects) add(effectCommand(sel, e));
        }
        if (s.cornerRadius !== undefined || s.points !== undefined || s.innerRadius !== undefined || s.sides !== undefined) {
          const shape = node.shape.clone();
          if (s.cornerRadius !== undefined) setCorners(shape, s.cornerRadius, box);
          reshape(shape, s);
          add(D.createSetShape(sel, shape));
        }
        if (['text', 'runs', 'family', 'style', 'size', 'color', 'align'].some((k) => s[k] !== undefined)) textCommands(add, doc, node, s, fonts);
        if (u.move) add(moveCommand(node, u.move, at.found));
        if (s.hidden !== undefined) add(D.createSetVisibility(sel, !s.hidden));
        if (s.locked !== undefined) add(D.createSetEditable(sel, !s.locked));
        if (v.id !== v.path) return { id: v.id };
        if (!retagged.has(v.path)) {
          retagged.set(v.path, nextId(typeOf(node).type, at.used));
          add(D.createSetTagValueForKey(sel, TAG, retagged.get(v.path))); // FR-306, R-41: also replaces a duplicated tag
        }
        return { id: retagged.get(v.path), was: v.path };
      });
      doc.executeCommand(cb.createCommand());
      const out = { updated, undoSteps: 1 };
      if (fonts.warnings.length) out.warnings = fonts.warnings;
      if (at.spread !== at.here) out.spread = at.spread;
      return out;
    });
  }

  // delete_nodes (plan 3.6).
  function deleteNodes(o) {
    const doc = current();
    if (!doc) return null;
    const { C, Sel } = sdk();
    const at = scan(doc, o.ids);
    if (at.unknown.length) return unknownIds(at.unknown);
    const hits = [...new Map(o.ids.map((id) => [at.found.get(id).v.path, at.found.get(id)])).values()];
    if (hits.some((h) => h.v.top)) return { fail: 'Spreads cannot be deleted with delete_nodes.' + nothing };
    const spreadsHit = new Set(hits.map((h) => h.v.spread));
    if (spreadsHit.size > 1) return twoSpreads;
    at.spread = [...spreadsHit][0];
    return atomic(doc, () => {
      const cb = C.CompoundCommandBuilder.create();
      switchTo(cb, at);
      cb.addCommand(C.DocumentCommand.createDeleteSelection(Sel.Selection.create(doc, hits.map((h) => h.node), true)));
      doc.executeCommand(cb.createCommand());
      const out = { deleted: hits.length, undoSteps: 1 };
      if (at.spread !== at.here) out.spread = at.spread;
      return out;
    });
  }

  // undo (plan 3.6): the description getters throw at position 0, history items do not (R-06, R-45).
  function undo(o) {
    const doc = current();
    if (!doc) return null;
    const h = doc.history;
    let done = 0;
    while (done < o.steps && (o.redo ? h.canRedo : h.canUndo)) {
      if (o.redo) doc.redo();
      else doc.undo();
      done++;
    }
    const item = (i) => {
      try {
        const it = h.getItem(i);
        return it ? it.description : null;
      } catch (e) {
        return null;
      }
    };
    return { done, position: h.position, size: h.size, undo: h.canUndo ? item(h.position - 1) : null, redo: h.canRedo ? item(h.position) : null };
  }

  // ---- Files and export (specs/004-files-export/plan.md section 3) ----

  const DIR = 'talk-to-affinity';
  const app = () => require('/application.js').app;

  // FR-402, FR-403 (plan 3.2): access, Affinity's Desktop, and the probe file in its staging folder.
  function fileAccess(probe) {
    const desktop = app().userDesktopPath;
    const access = !!require('/environment.js').Environment.permissions.fileSystem;
    if (access && probe) {
      const { FileSystemApi, File } = require('/fs.js');
      FileSystemApi.createDirectories(desktop + '/' + DIR); // R-51
      const f = File.create(desktop + '/' + DIR + '/' + probe, 'w');
      f.writeString('ttam-probe');
      f.close();
    }
    return { access, desktop };
  }

  // FR-412 (plan 3.5): the current document and the paths of all open ones (R-13 item 6).
  function documentInfo() {
    const d = current();
    const all = app().documents.all;
    return {
      document: d && { title: d.title, path: d.path || null, dirty: d.isDirty, spreads: d.spreads.toArray().length, width: r2(d.widthPixels), height: r2(d.heightPixels), dpi: d.dpi, units: String(d.units) },
      open: all.map((x) => x.path || ''),
      count: all.length,
    };
  }

  // FR-406, R-53: units first, then the size in those units.
  function createDocument(o) {
    const { Document, NewDocumentOptions } = require('/document.js');
    const opt = NewDocumentOptions.createDefault();
    opt.units = require('/units.js').UnitType[o.units];
    opt.width = o.width;
    opt.height = o.height;
    opt.dpi = o.dpi;
    if (o.pages > 1) {
      opt.isMultiPage = true;
      opt.isFacing = false;
      opt.pageCount = o.pages;
    }
    if (o.transparent) opt.isTransparentBackground = true;
    Document.create(opt);
    return { created: true };
  }

  // FR-407, R-52: the loaded document becomes current.
  function openDocument(path) {
    require('/document.js').Document.load(path);
    return { opened: true };
  }

  // FR-408, FR-409, R-52.
  function saveDocument(o) {
    const d = current();
    if (!d) return null;
    if (o.as) d.saveAs(o.as);
    else if (d.mustSaveAs) return { fail: 'This document has never been saved as an Affinity file (new, or imported from another format). Use action saveAs with a path ending in .af.' };
    else d.save();
    return { path: d.path };
  }

  // FR-410, R-46: this script changes nothing but the close.
  function closeDocument(discard) {
    const d = current();
    if (!d) return null;
    if (d.isDirty && !discard) return { fail: 'The document "' + d.title + '" has unsaved changes. Save it first, or set discardChanges: true to close it anyway.' };
    d.close();
    return { closed: true };
  }

  // FR-416 (plan 3.6 item 3): the pixel size for an area of w x h document pixels.
  function exportSize(w, h, o) {
    let k = 1;
    if (o.scale !== undefined) k = o.scale;
    else if (o.width !== undefined) k = o.width / w;
    else if (o.height !== undefined) k = o.height / h;
    else if (o.longest !== undefined) k = o.longest / Math.max(w, h);
    const size = { width: o.width !== undefined ? o.width : Math.max(1, Math.round(w * k)), height: o.height !== undefined ? o.height : Math.max(1, Math.round(h * k)) };
    if (size.width > 32768 || size.height > 32768) return { fail: 'The export would be ' + size.width + ' x ' + size.height + ' px; a side can be at most 32,768 px. Nothing was written.' };
    return size;
  }

  // Union of visible boxes widened to whole pixels (R-48 item 4); the base box for nodes without a visible extent (R-21).
  function area(nodes) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      const v = n.spreadVisibleBox;
      const b = v.x <= -1e300 ? n.spreadBaseBox : v;
      if (b.x <= -1e300) continue;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    return x0 === Infinity ? null : [Math.floor(x0), Math.floor(y0), Math.ceil(x1) - Math.floor(x0), Math.ceil(y1) - Math.floor(y0)];
  }

  // export and render (plan 3.6): each export goes to <dir>/s<n>/<name>; the host renames and copies.
  function exportFiles(o) {
    const doc = current();
    if (!doc) return null;
    const { FileExportOptions, FileExportArea } = require('/document.js');
    const names = FileExportOptions.allPresetNames;
    if (names.indexOf(o.preset) < 0) return { fail: 'Unknown export preset "' + o.preset + '". The closest presets are ' + closest(names, o.preset).map((n) => '"' + n + '"').join(', ') + '.' };
    const options = FileExportOptions.createWithPresetName(o.preset);
    const spreads = doc.spreads.toArray();
    const page = [0, 0, doc.widthPixels, doc.heightPixels]; // the page starts at the spread origin (plan 005 risk 1)
    const jobs = [];
    let nodes = null;
    if (o.target === 'spread') {
      const i = o.spreadIndex === undefined ? Math.max(0, spreads.findIndex((s) => s.isSameNode(doc.currentSpread))) : o.spreadIndex;
      if (i >= spreads.length) return { fail: 'Spread ' + i + ' does not exist; the document has ' + spreads.length + ' spread(s), indexed from 0.' };
      jobs.push({ area: FileExportArea.createForSpreads(String(i + 1)), box: page }); // R-48 item 2: counted from 1
    } else if (o.target === 'document') {
      if (/^PDF/.test(o.preset)) jobs.push({ area: FileExportArea.createForWholeDocument(), box: page });
      else spreads.forEach((s, i) => jobs.push({ area: FileExportArea.createForSpreads(String(i + 1)), box: page, n: i + 1 }));
    } else {
      if (o.target === 'nodes') {
        const at = scan(doc, o.ids);
        if (at.unknown.length) return { fail: 'No node has the ID ' + at.unknown.map((x) => '"' + x + '"').join(', ') + '.' };
        const hits = o.ids.map((id) => at.found.get(id));
        if (hits.some((h) => h.v.top)) return { fail: 'Spreads are exported with target spread, not as nodes.' };
        if (new Set(hits.map((h) => h.v.spread)).size > 1) return { fail: 'The nodes lie on more than one spread; export each spread in its own call.' };
        nodes = hits.map((h) => h.node);
      } else {
        nodes = doc.selection.nodes.toArray();
        if (!nodes.length) return { fail: 'Nothing is selected in the current document.' };
      }
      const box = area(nodes);
      if (!box) return { fail: 'The nodes have no visible extent to export.' };
      jobs.push({ area: FileExportArea.createForSelection(null), box }); // R-48 item 3: the current selection
    }
    const sized = jobs.map((j) => exportSize(j.box[2], j.box[3], o.size));
    const bad = sized.find((s) => s.fail);
    if (bad) return bad;
    const before = o.target === 'nodes' ? doc.selection : null;
    const preview = (sel) => doc.executeCommand(require('/commands.js').DocumentCommand.createSetSelection(sel), true); // R-49: no history step
    if (before) preview(require('/selections.js').Selection.create(doc, nodes));
    try {
      jobs.forEach((j, k) => doc.export(o.dir + '/s' + k + '/' + o.name, options, j.area, sized[k])); // R-47: vector presets ignore the size
    } catch (e) {
      if (before) preview(before);
      throw e;
    }
    return { files: jobs.map((j, k) => Object.assign({ sub: 's' + k, area: j.box }, j.n ? { n: j.n } : {}, sized[k])) };
  }

  return { getDocument, getNodes, listFonts, createNodes, updateNodes, deleteNodes, undo, plan, nextId, matchFont, gradientData, rotationData, boxData, paragraphRanges, atomic, fileAccess, documentInfo, createDocument, openDocument, saveDocument, closeDocument, exportSize, exportFiles, imageData, multiply };
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
    if (before && after && before.id === after.id && after.position > before.position) error.undoSteps = after.position - before.position;
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
