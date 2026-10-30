// The scripts and fonts the pages load, copied from the packages of kitap and of the engine into dist/vendor/, so a
// page loads nothing from another host. A package's folder names its version, so a browser can keep its files for good.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// a package's folder and version, found up from its main file, since some packages export no package.json. resolve is
// the require of the package that depends on it: kitap's for the fonts, the engine's for its libraries.
function pkg(name, resolve = require.resolve) {
  for (let dir = path.dirname(resolve(name)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) { const meta = JSON.parse(fs.readFileSync(file, 'utf8')); if (meta.name === name && meta.version) return { dir, version: meta.version }; }
  }
  throw new Error(`the package ${name} is missing, reinstall the engine`);
}
const folder = (name, resolve) => `${name.split('/').pop()}@${pkg(name, resolve).version}`;

// the subsets the pages need: Latin, and Latin Extended for Turkish and the other languages written in Latin letters
const FONTS = [
  { family: 'Fraunces', name: '@fontsource-variable/fraunces', css: 'opsz.css', files: /^fraunces-latin(-ext)?-opsz-normal$/ },
  { family: 'Public Sans', name: '@fontsource-variable/public-sans', css: 'index.css', files: /^public-sans-latin(-ext)?-wght-normal$/ },
];
const licence = dir => ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map(f => path.join(dir, f)).find(f => fs.existsSync(f));

// Writes dist/vendor/: the engine's libraries, each [package, file] of engine.client.libraries resolved from the
// engine's own package, the fonts, and whatever the engine's vendor hook copies. Returns the libraries' paths under
// dist/ in order, for the story page's <script> tags.
export function writeVendor(dist, engine = null) {
  const out = path.join(dist, 'vendor');
  fs.rmSync(out, { recursive: true, force: true });
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  const paths = [];
  const resolve = engine?.dir ? createRequire(path.join(engine.dir, 'package.json')).resolve : require.resolve;
  // a library is [package, file] for a script the page loads, or [package, folder] for a folder a module engine imports from
  const imports = {};
  const vendored = (name, file) => {
    const { dir } = pkg(name, resolve), to = path.join(out, folder(name, resolve)), from = path.join(dir, file), base = path.basename(file.replace(/\/$/, ''));
    const isDir = fs.statSync(from).isDirectory();
    if (isDir) fs.cpSync(from, path.join(to, base), { recursive: true }); else copy(from, path.join(to, base));
    const lic = licence(dir) ?? licence(path.join(dir, path.dirname(file)));
    if (lic) copy(lic, path.join(to, path.basename(lic)));
    return `vendor/${folder(name, resolve)}/${base}${isDir ? '/' : ''}`;
  };
  for (const [name, file] of engine?.client?.libraries ?? []) paths.push(vendored(name, file));
  // an import is [package, file], or [package, folder, file] when the file imports its siblings
  for (const [spec, [name, file, entry]] of Object.entries(engine?.client?.imports ?? {})) imports[spec] = entry ? `${vendored(name, file)}${entry}` : vendored(name, file);
  // the packages' @font-face rules for the subsets above, under the family names the pages use
  const rules = [];
  for (const f of FONTS) {
    const { dir } = pkg(f.name), to = folder(f.name);
    for (const block of fs.readFileSync(path.join(dir, f.css), 'utf8').split('/* ').slice(1)) {
      const id = block.slice(0, block.indexOf(' */'));
      if (!f.files.test(id)) continue;
      copy(path.join(dir, 'files', `${id}.woff2`), path.join(out, to, `${id}.woff2`));
      rules.push(block.slice(block.indexOf('@font-face')).trim()
        .replace(/font-family: '[^']*'/, `font-family: '${f.family}'`).replace(/url\(\.\/files\//, `url(${to}/`));
    }
    copy(licence(dir), path.join(out, to, 'LICENSE'));
  }
  fs.writeFileSync(path.join(out, 'fonts.css'), rules.join('\n') + '\n');
  engine?.vendor?.(out);
  return { paths: paths.filter(p => !p.endsWith('/')), imports };
}
