// The command line of kitap and of every engine: the book's commands with the options they take. An engine's binary
// calls run with its engine and its own commands, which are tried first.
import { parseArgs } from 'util';
import { build, check, dev, i18n, image, imageCandidates, rehash, upload, deploy } from './index.mjs';

export const USAGE = (name = 'kitap', extra = '') => `usage: ${name} build [--strict] [--local-assets] [--only <story> ...] [--story <id>] [--out <dir>] | ${name} check <story> [page id ...] [--places] | ${name} dev [--story <id>] [--out <dir>] [--port <n>] | ${name} i18n <lang> [--story id] | ${name} image <file or url> <name> --caption <text> [--credit <text>] [--source <url>] [--story <id>] | ${name} image-candidates <story> --queries <file> [--limit <n>] [--pages <id,id>] [--out <name>] | ${name} rehash | ${name} upload [--story <id>] [--dry-run] | ${name} deploy [--dry-run]${extra}`;

// argv are the arguments after the command name. engine is the engine module to build with, else site.yaml names it.
// own(cmd, positionals, options) runs an engine's own command and returns true when it took it. options adds flags.
export async function run(argv, { name = 'kitap', engine = null, enginePath = null, own = null, options = {}, usage = '' } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { strict: { type: 'boolean' }, 'local-assets': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, places: { type: 'boolean' }, story: { type: 'string' }, caption: { type: 'string' }, credit: { type: 'string' }, source: { type: 'string' }, only: { type: 'string', multiple: true }, out: { type: 'string' }, port: { type: 'string' }, queries: { type: 'string' }, limit: { type: 'string' }, pages: { type: 'string' }, engine: { type: 'string' }, ...options } });
  } catch (err) { // an unknown or incomplete flag
    console.error(`${err.message}\n${USAGE(name, usage)}`);
    process.exit(2);
  }
  const { positionals: [cmd, lang, ...rest], values: opt } = args;
  // --engine names the engine module's path, as kitap dev hands it to each build; an engine's binary hands its own
  const e = engine ?? (opt.engine ? (await import('./engine.mjs')).loadEngine(process.cwd(), opt.engine) : null);
  try {
    if (own && await own(cmd, [lang, ...rest].filter(x => x !== undefined), opt)) return;
    if (cmd === 'build') await build({ strict: opt.strict, localAssets: opt['local-assets'], only: opt.only, story: opt.story, out: opt.out, engine: e });
    else if (cmd === 'check' && lang) {
      const problems = check({ story: lang, pages: rest, places: opt.places, engine: e });
      for (const m of problems) console.log(m);
      console.log(problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}` : 'ok');
      process.exitCode = problems.length ? 1 : 0;
    }
    else if (cmd === 'i18n' && lang) i18n({ lang, story: opt.story, engine: e });
    else if (cmd === 'image' && lang) await image({ file: lang, name: rest[0], caption: opt.caption, credit: opt.credit, source: opt.source, story: opt.story });
    else if (cmd === 'image-candidates' && lang) await imageCandidates({ story: lang, queries: opt.queries, limit: Number(opt.limit) || 6, pages: opt.pages?.split(',') ?? null, out: opt.out ?? '' });
    else if (cmd === 'rehash') rehash();
    else if (cmd === 'upload') await upload({ story: opt.story, dryRun: opt['dry-run'], engine: e });
    else if (cmd === 'deploy') await deploy({ dryRun: opt['dry-run'] });
    else if (cmd === 'dev') dev({ story: opt.story, out: opt.out, engine: enginePath ?? opt.engine ?? null, ...(opt.port ? { port: Number(opt.port) } : {}) });
    else { console.error(USAGE(name, usage)); process.exit(2); }
  } catch (err) { // content errors are expected, print them without a stack trace
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
