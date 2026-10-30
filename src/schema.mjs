// Shapes of the book's content files. An engine adds its own fields to Story and Page under one key, its id, through
// storySchema and pageSchema. Cross references between files are checked in build.mjs.
import { z } from 'zod';
export { z };

// A plain string applies to every language; an object holds one string per language code.
export const Translatable = z.union([z.string(), z.record(z.string().min(2).max(8), z.string())]);
export const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only');
export const Lang = z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, 'a language code like en or pt-BR');
export const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a hex colour like #a06b1f');
// a year, a year-month, or a full date; YAML hands over a Date for the full form
export const When = z.union([z.number().int(), z.string(), z.date()]).transform(v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v))
  .refine(s => /^\d{4}(-\d{2})?(-\d{2})?$/.test(s), 'YYYY, YYYY-MM or YYYY-MM-DD');

// land: up to eight tints an engine may use for areas, neighbours get different ones; without it every area is paper2
const ThemeTokens = z.object({ paper: Hex, paper2: Hex, sea: Hex, ink: Hex, ink2: Hex, rule: Hex, accent: Hex, panel: Hex, route: Hex, border: Hex, land: z.array(Hex).min(2).max(8).optional() }).strict();
export const Theme = z.object({ name: Translatable.optional(), light: ThemeTokens, dark: ThemeTokens }).strict();
export const Themes = z.record(Id, Theme);

export const Site = z.object({
  title: Translatable.optional(),
  intro: Translatable.optional(),
  languages: z.array(Lang).min(1).optional(),
  default_language: Lang.optional(),
  stories: z.array(Id).optional(),
  engine: Id.optional(), // the engine that draws the stories' pictures, resolved from the project's packages or plugins/engines/
  theme: Id.optional(),
  themes: Themes.optional(),
  url: z.string().url().optional(), // where the site is published, for canonical links, sitemaps and llms.txt
  repository: z.string().url().optional(), // the content repository: a Contribute link on the main page, a source link per story
  branch: z.string().default('main'),
  // the object store that holds the images and the engine's objects: url serves them, bucket and endpoint take uploads
  assets: z.object({ url: z.string().url().refine(u => u.endsWith('/'), 'ends in /'), bucket: z.string().min(1), endpoint: z.string().url() }).strict().optional(),
  pages: z.object({ bucket: z.string().min(1) }).strict().optional(), // the bucket kitap deploy writes dist/ to, in the account of assets.endpoint
}).strict();

// The book's fields of story.yaml. storySchema(engine) adds the engine's under its id.
export const StoryCore = {
  id: Id,
  title: Translatable,
  summary: Translatable.optional(),
  span: Translatable.optional(),
  cover: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'the id of an image folder the story can show, kitap image <file> <name> --story <story> makes one').optional(), // the card on the main page
  languages: z.array(Lang).min(1),
  default_language: Lang.optional(),
  theme: Id.optional(),
};
export const storySchema = engine => z.object({ ...StoryCore, ...(engine ? { [engine.id]: (engine.schemas?.story ?? z.object({}).passthrough()).default({}) } : {}) }).strict();

export const Group = z.object({ title: Translatable.optional() }).strict();

// image.yaml in an image folder, content/shared/images/<id>/ or content/<story>/shared/images/<id>/. source: the page
// the original came from, such as its Commons file page. url: where the original downloads from. file and sha256: the
// original's name in the folder and its hash, which name its objects in the asset store.
export const ImageFolder = z.object({ caption: Translatable, credit: Translatable.optional(), default_language: Lang.default('en'),
  source: z.string().url().optional(), url: z.string().url().optional(),
  file: z.string().regex(/^image\.(jpe?g|png|webp|svg|gif)$/, 'image.<ext>, the original in this folder, kitap rehash writes it'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, '64 hex digits, kitap rehash writes it') }).strict();

// The book's fields of page.yaml. pageSchema(engine) adds the engine's under its id.
export const PageCore = {
  title: Translatable,
  date: Translatable.optional(), // shown above the title and in the contents, when the subject has dates
  when: z.union([When, z.object({ from: When, to: When.optional() }).strict()]).optional(),
  sources: z.array(Translatable).default([]),
  // a card beside the text drawn by plugins/cards/<kind>.mjs, with its parameters
  card: z.object({ kind: Id }).passthrough().optional(),
  images: z.unknown().optional().refine(v => v === undefined, 'images live in image folders, content/<story>/shared/images/<name>-<six hex digits>/, and kitap image <file> <name> makes one'),
};
export const pageSchema = engine => z.object({ ...PageCore, ...(engine ? { [engine.id]: (engine.schemas?.page ?? z.object({}).passthrough()).default({}) } : {}) }).strict();

// Parse or throw one error that names the file and every bad field.
export function check(schema, data, file) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const lines = r.error.issues.map(i => `  ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  throw new Error(`${file}:\n${lines.join('\n')}`);
}
