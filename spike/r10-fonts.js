// R-10: installed fonts under Wine and behavior for a missing font. Read-only.
const fonts = require('/fonts.js');
const log = (k, v) => console.log(JSON.stringify({ [k]: v }));
const safe = (f) => { try { return f(); } catch (e) { return 'THROWN ' + e; } };

log('exports', Object.keys(fonts));
const families = safe(() => [...fonts.FontFamily.all]);
log('familyCount', Array.isArray(families) ? families.length : families);
if (Array.isArray(families)) log('sample', families.slice(0, 15).map((f) => safe(() => String(f.name ?? f.familyName ?? f))));
log('fontAllCount', safe(() => [...fonts.Font.all].length));
log('weights', safe(() => fonts.FontWeight.keys));
log('missing', safe(() => {
  const f = fonts.Font.create('No Such Family 12345', fonts.FontWeight.Normal, false, undefined);
  return { str: String(f), keys: Object.keys(Object.getPrototypeOf(f) ?? {}) };
}));
