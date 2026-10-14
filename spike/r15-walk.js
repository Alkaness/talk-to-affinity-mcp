// R-15: insert 1,000 nodes in one builder, then time a full tree walk with serialization. Creates its own document.
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { ShapeNodeDefinition, NodeChildType } = require('/nodes.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { ShapeRectangle } = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');

const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 2000; o.height = 2000; o.dpi = 72;
const doc = Document.create(o);
let t = Date.now();
const b = AddChildNodesCommandBuilder.create();
for (let i = 0; i < 1000; i++) {
  b.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), new Rectangle((i % 40) * 50, Math.floor(i / 40) * 50, 40, 40), Colour.createRGBA8({ r: i % 256, g: 100, b: 150, alpha: 255 })));
}
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(false, NodeChildType.Main));
const insertMs = Date.now() - t;

t = Date.now();
const out = [];
const walk = (node, depth) => {
  for (const c of node.children) {
    const bx = c.spreadBaseBox;
    out.push({ d: depth, t: String(c), n: c.description, b: [bx.x, bx.y, bx.width, bx.height], v: c.isVisible });
    walk(c, depth + 1);
  }
};
walk(doc.currentSpread, 0);
const json = JSON.stringify(out);
console.log(JSON.stringify({ insertMs, walkMs: Date.now() - t, nodes: out.length, jsonChars: json.length, undoSteps: doc.history.position, first: out[0] }));
