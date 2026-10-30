// The engine that fills the viewport: a package or a plugin that exports the engine module as its default. site.yaml
// names it, a build may hand one in, and a command of the engine's own hands in its own. Node 22.12+ loads an ES
// module through require synchronously, which keeps the build synchronous.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// Resolves an engine to its module: a path to a module file, else an id looked up in the project's packages, under
// the organisation's scope or bare, then in plugins/engines/<id>.mjs of the project. Fails naming both places.
export function loadEngine(root, id) {
  const require = createRequire(path.join(root, 'package.json'));
  if (id.endsWith('.mjs') || id.endsWith('.js')) return checkEngine(require(path.resolve(root, id)).default, id);
  for (const name of [`@openbooknetwork/${id}`, `@openhistoryatlas/${id}`, id]) {
    let mod;
    try { mod = require(name); } catch (err) { if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(name)) continue; throw err; }
    return checkEngine(mod.default ?? mod.engine, name);
  }
  const plugin = path.join(root, 'plugins', 'engines', `${id}.mjs`);
  if (fs.existsSync(plugin)) return checkEngine(require(plugin).default, plugin);
  throw new Error(`site.yaml: engine "${id}" is not installed: npm install @openbooknetwork/${id}, or add plugins/engines/${id}.mjs`);
}

// An engine module has an id and the hooks the build calls; what it leaves out is filled with no-ops.
export function checkEngine(e, from) {
  if (!e || typeof e !== 'object' || !e.id) throw new Error(`${from}: an engine module exports an object with an id and its hooks`);
  if (e.checked) return e;
  const read = e.read ?? {};
  return {
    checked: true, id: e.id, schemas: e.schemas ?? {}, ui: e.ui ?? null, client: e.client ?? {}, vendor: e.vendor ?? null, dir: e.dir ?? null,
    read: { story: read.story ?? (() => ({})), folder: read.folder ?? (() => {}), include: read.include ?? null, prepare: read.prepare ?? null, page: read.page ?? (() => ({ data: {} })), finish: read.finish ?? (() => ({})) },
    bundle: e.bundle ?? (() => ({ data: {} })), objects: e.objects ?? (() => ({ groups: {} })), site: e.site ?? (() => {}), make: e.make ?? null, describeObjects: e.describeObjects ?? null,
  };
}
