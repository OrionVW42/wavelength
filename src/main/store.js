// Tiny JSON-file store. Synchronous load (needed before app 'ready' for
// command-line switches), debounced atomic writes.
const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this._timer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = merge(structuredClone(defaults), raw);
    } catch { /* first run or unreadable: keep defaults */ }
  }
  get(key) { return key ? this.data[key] : this.data; }
  set(patch) {
    this.data = merge(this.data, patch);
    this.save();
    return this.data;
  }
  replace(key, value) { this.data[key] = value; this.save(); }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] write failed', this.file, e.message); }
  }
}

// Deep-merge plain objects; arrays and scalars are replaced.
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(out[k], v) : v;
  }
  return out;
}

module.exports = { JsonStore };
