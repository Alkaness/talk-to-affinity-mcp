// R-06, R-07 (partial), R-14 (px): tags, undo steps, boxes. Creates its own document.
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { ShapeNodeDefinition, NodeChildType } = require('/nodes.js');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder, DocumentCommand } = require('/commands.js');
const { ShapeRectangle } = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');
const log = (k, v) => console.log(JSON.stringify({ [k]: v }));
const safe = (f) => { try { return f(); } catch (e) { return 'THROWN ' + e; } };

const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 800; o.height = 600; o.dpi = 72;
const doc = Document.create(o);
const hist = () => [doc.history.position, doc.history.size, safe(() => doc.history.undoDescription)];
log('doc', { title: doc.title, dpi: doc.dpi, units: String(doc.units), w: doc.widthPixels, h: doc.heightPixels, hist: hist(), dirty: doc.isDirty });

const rect = (x, colour) => ShapeNodeDefinition.create(ShapeRectangle.create(), new Rectangle(x, 20, 100, 50), Colour.createRGBA8(colour));

// A: insert, then tag in a separate command
const b = AddChildNodesCommandBuilder.create();
b.addNode(rect(10, { r: 255, g: 0, b: 0, alpha: 255 }));
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(true, NodeChildType.Main));
const n1 = doc.selection.nodes.toArray()[0];
log('A.added', { hist: hist(), box: safe(() => n1.spreadBaseBox), exact: safe(() => n1.exactSpreadBaseBox) });
doc.executeCommand(DocumentCommand.createSetTagValueForKey(n1.selfSelection, 'ttam-id', 'A1'));
log('A.tagged', { hist: hist(), has: n1.tagInterface.hasKey('ttam-id'), val: n1.tagInterface.getValueForKey('ttam-id'), dirty: doc.isDirty });
log('A.untagged', { has: safe(() => doc.currentSpread.children.toArray().length) });

// B: insert and tag (null selection) inside one compound command
const b2 = AddChildNodesCommandBuilder.create();
b2.addNode(rect(200, { r: 0, g: 0, b: 255, alpha: 255 }));
b2.setInsertionTarget(doc.currentSpread);
const cb = CompoundCommandBuilder.create();
cb.addCommand(b2.createCommand(true, NodeChildType.Main), true);
cb.addCommand(DocumentCommand.createSetTagValueForKey(null, 'ttam-id', 'B1'));
const before = doc.history.position;
safe(() => doc.executeCommand(cb.createCommand()));
const n2 = doc.selection.nodes.toArray()[0];
log('B.compound', { steps: doc.history.position - before, hist: hist(), tag: safe(() => n2.tagInterface.getValueForKey('ttam-id')), n1tag: n1.tagInterface.getValueForKey('ttam-id') });

// C: duplicate copies tags?
const dup = safe(() => n1.duplicate());
const kids = doc.currentSpread.children.toArray();
log('C.duplicate', { returned: String(dup), count: kids.length, tags: kids.map((k) => safe(() => k.tagInterface.hasKey('ttam-id') ? k.tagInterface.getValueForKey('ttam-id') : null)) });

// D: one undo
doc.undo();
log('D.undo', { hist: hist(), count: doc.currentSpread.children.toArray().length });
log('session', { uuid: doc.sessionUuid, title: doc.title });
