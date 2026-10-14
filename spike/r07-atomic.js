// R-07: does a script that throws after a committed command leave the change? Runs on the current document.
const { app } = require('/application.js');
const { ShapeNodeDefinition, NodeChildType } = require('/nodes.js');
const { AddChildNodesCommandBuilder } = require('/commands.js');
const { ShapeEllipse } = require('/shapes.js');
const { Rectangle } = require('/geometry.js');
const { Colour } = require('/colours.js');

const doc = app.documents.current;
console.log(JSON.stringify({ before: { pos: doc.history.position, count: doc.currentSpread.children.toArray().length } }));
const b = AddChildNodesCommandBuilder.create();
b.addNode(ShapeNodeDefinition.create(ShapeEllipse.create(), new Rectangle(400, 200, 80, 80), Colour.createRGBA8({ r: 0, g: 200, b: 0, alpha: 255 })));
b.setInsertionTarget(doc.currentSpread);
doc.executeCommand(b.createCommand(false, NodeChildType.Main));
console.log(JSON.stringify({ afterAdd: { pos: doc.history.position, count: doc.currentSpread.children.toArray().length } }));
throw new Error('deliberate failure after a committed command');
