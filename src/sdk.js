// Envelope that runs inside Affinity's script engine (specs/001-foundation/plan.md section 3.3).
// src/affinity.ts fills in the two double-underscore placeholders below before sending.
// The body is defined first, at top level, so it cannot see the envelope's variables.
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
