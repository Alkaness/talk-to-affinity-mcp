// R-09: Desktop path, staging folder, probe file, PNG export of the current spread. Writes only to <Desktop>/.talk-to-affinity/.
const { app } = require('/application.js');
const { FileExportOptions, FileExportArea } = require('/document.js');
const { File, FileSystemApi } = require('/fs.js');
const log = (k, v) => console.log(JSON.stringify({ [k]: v }));
const safe = (f) => { try { const r = f(); return r === undefined ? 'ok' : r; } catch (e) { return 'THROWN ' + e; } };

const desk = app.userDesktopPath;
const sep = desk.includes('\\') ? '\\' : '/';
const dir = desk + sep + '.talk-to-affinity';
log('desktop', { desk, dir });
log('mkdir', safe(() => FileSystemApi.createDirectories(dir)));
log('probe', safe(() => { const f = File.create(dir + sep + 'probe.txt', 'w'); f.writeString('ttam-probe'); f.close(); }));
const names = safe(() => [...FileExportOptions.allPresetNames]);
log('presets', names);
const png = Array.isArray(names) ? names.find((n) => /png/i.test(n)) : undefined;
const doc = app.documents.current;
log('export', safe(() => {
  const recs = doc.export(dir + sep + 'probe.png', FileExportOptions.createWithPresetName(png), FileExportArea.createForCurrentSpread());
  return { preset: png, records: String(recs), list: safe(() => [...recs].map((r) => ({ path: r.path, warn: r.hasWarnings && r.warningMessage }))) };
}));
