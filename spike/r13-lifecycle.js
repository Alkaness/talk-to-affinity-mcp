// R-13: create, saveAs, close, load, switch current document. Writes only <Desktop>/ttam-r13.<ext>.
const { app } = require('/application.js');
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const log = (k, v) => console.log(JSON.stringify({ [k]: v }));
const safe = (f) => { try { const r = f(); return r === undefined ? 'ok' : r; } catch (e) { return 'THROWN ' + e; } };

const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 400; o.height = 300; o.dpi = 72;
const doc = Document.create(o);
const p = app.userDesktopPath + '\\ttam-r13.' + app.productPrimaryFileExtension;
log('created', { current: app.documents.current.sessionUuid === doc.sessionUuid, count: app.documents.all.length, ext: app.productPrimaryFileExtension });
log('saveAs', safe(() => String(doc.saveAs(p))));
log('afterSave', { path: doc.path, title: doc.title, dirty: doc.isDirty });
const uuid = doc.sessionUuid;
log('close', safe(() => String(doc.close())));
log('afterClose', { count: app.documents.all.length, stillListed: app.documents.all.some((d) => d.sessionUuid === uuid) });
const d2 = safe(() => Document.load(p));
log('load', { title: safe(() => d2.title), path: safe(() => d2.path), current: safe(() => app.documents.current.sessionUuid === d2.sessionUuid), sameSession: safe(() => d2.sessionUuid === uuid) });
const first = app.documents.all[0];
log('switchAttempt', safe(() => { Document.current = first; return app.documents.current.sessionUuid === first.sessionUuid; }));
log('close2', safe(() => String(d2.close())));
