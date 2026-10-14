// R-14: geometry units in a millimetre document at 300 DPI. Creates its own document.
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { ShapeNodeDefinition, NodeChildType } = require('/nodes.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { ShapeRectangle } = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');
const safe = (f) => { try { return f(); } catch (e) { return 'THROWN ' + e; } };

const o = NewDocumentOptions.createDefault();
o.units = UnitType.Millimetre ?? UnitType.Millimeter; o.width = 210; o.height = 297; o.dpi = 300;
const doc = Document.create(o);
const b = AddChildNodesCommandBuilder.create();
b.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), new Rectangle(0, 0, 100, 100), Colour.createRGBA8({ r: 0, g: 0, b: 0, alpha: 255 })));
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(true, NodeChildType.Main));
const n = doc.selection.nodes.toArray()[0];
console.log(JSON.stringify({
  unitKeys: safe(() => UnitType.keys),
  doc: { dpi: doc.dpi, units: String(doc.units), w: doc.widthPixels, h: doc.heightPixels, size: safe(() => doc.sizePixels) },
  box: safe(() => n.spreadBaseBox), exact: safe(() => n.exactSpreadBaseBox),
  session: doc.sessionUuid,
}));
