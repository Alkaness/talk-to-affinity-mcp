// R-09, R-13 (partial): runtime facts. Read-only.
const { app } = require('/application.js');
const { Environment } = require('/environment.js');
const log = (k, v) => console.log(JSON.stringify({ [k]: v }));
const safe = (f) => { try { return f(); } catch (e) { return 'THROWN ' + e; } };

log('app', {
  version: safe(() => app.version),
  shortVersion: safe(() => app.shortVersion),
  platform: safe(() => app.platformName),
  product: safe(() => app.productFullName),
  documentVersion: safe(() => app.documentVersion),
  desktop: safe(() => app.userDesktopPath),
});
log('env', {
  sdk: safe(() => Environment.sdkVersionStr),
  permissions: safe(() => Environment.permissions),
  roots: safe(() => Environment.fileSystemRoots),
});
log('documents', safe(() => app.documents.all.map((d) => ({
  title: d.title, path: d.path, dirty: d.isDirty, session: d.sessionUuid, persistent: d.persistentUuid,
  current: app.documents.current ? d.sessionUuid === app.documents.current.sessionUuid : false,
}))));
