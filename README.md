# Kitap

The book under the Open Book Network sites. A book is a set of stories, a story is a run of pages, and a page is a
text beside a picture that changes as the reader steps. Kitap reads the stories, builds a static site with a page
per step in every language, and hands the picture to an engine: [harita](https://github.com/openbooknetwork/harita)
draws maps, [beden](https://github.com/openbooknetwork/beden) bodies, [makina](https://github.com/openbooknetwork/makina)
mechanisms, [hesap](https://github.com/openbooknetwork/hesap) algorithms.

## A content project

```
site.yaml                       the main page, the engine, the languages, the theme, the store
content/<story>/story.yaml      id, title, summary, span, cover, languages, and the engine's fields under its key
content/<story>/pages/          a folder per page or group, numbered to order them
  010-<group>/group.yaml        the group's title
  010-<group>/010-<page>/page.yaml, text/<lang>.md
content/<story>/shared/images/<name>-<six hex digits>/   image.yaml, the original, i18n/<lang>.yaml
content/<story>/shared/<kind>s/<id>/                     the engine's items: battles, zones, models, ...
content/shared/images/, content/shared/<kind>s/          what several stories share
content/<story>/i18n/<lang>.yaml, i18n/<lang>.yaml       the translations; the default language is inline
```

```yaml
# site.yaml
title: Open Body Book
engine: beden
languages: [en, tr]
assets: { url: https://assets.example.org/, bucket: body-assets, endpoint: https://... }
ask: [chatgpt, claude]               # optional: an Ask button on every page opens the assistant with the page's text
```

```yaml
# page.yaml: the book's fields, then the engine's under its key
title: "The aorta"
date: "1628"                       # optional, shown above the title and in the contents
sources: ["Gray's Anatomy, ch. 58."]
beden:
  look: aorta
  parts: { highlight: [aorta] }
```

A text is Markdown. `@image <id>` on a line of its own shows an image folder, and `[word](@id)` links a word to
something the engine shows on the page, a marker on a map or a part of a model.
[writing/](writing/README.md) has the rules for the English of a story and for its translations, with a file per target language.

## Commands

```
kitap build [--strict] [--local-assets] [--only <story>] [--story <id>] [--out <dir>]
kitap check <story> [page id ...] [--places]
kitap dev [--story <id>] [--out <dir>] [--port <n>]
kitap i18n [<lang>] [--story <id>] [--stale | --stamp]
kitap image <file or url> <name> --caption <text> [--credit <text>] [--source <url>] [--story <id>]
kitap image-candidates <story> --queries <file> [--limit <n>] [--pages <id,id>] [--out <name>]
kitap rehash | kitap upload [--story <id>] [--dry-run] | kitap deploy [--dry-run]
```

An engine's own binary runs the same commands with its engine, `harita build` for instance, and adds its own.
A page without a text in a language shows the default language's text. `--strict` fails on a missing translation,
a page text included, or an object the store lacks; `--local-assets` shows the files on this machine before they are
uploaded.

`i18n` writes a language's catalogues with the source text above each key. `--stale` then writes
`.cache/kitap/stale/<story>/<lang>.yaml` per story: the paragraphs and strings whose source changed since the last
stamp, each with the new source and the current translation, and what has no translation yet. A translator sent to
update a story reads that list in place of the story. `--stamp` records the hash of the source behind every
translated paragraph and string in `i18n/stamps/<lang>.yaml` of the story, of each folder it uses and of the site.
Run it after a review. Without a language, either flag covers every language from one build.

`image-candidates` searches Wikimedia Commons for each page of a story and downloads what it finds to
`<story>/.candidates/<page>/`, listed with author, license and source in `.candidates/index.yaml`. The queries file
is keyed by story, then page: `{ queries: [search terms], articles: [Wikipedia titles or URLs], files: [Commons
files] }`. A file the book holds already is listed with `held: <id>`. `kitap image <url>` adds a chosen one.

## An engine

An engine is a package whose default export is a module with an id and hooks. Kitap resolves `engine: <id>` of
site.yaml to `@openbooknetwork/<id>` in the project's packages, else to `plugins/engines/<id>.mjs`.

```js
export default {
  id: 'beden',
  dir: PKG,                                        // the package folder, where its libraries resolve from
  schemas: { story: StoryBody, page: PageBody },   // zod objects for the fields under the engine's key
  ui: new URL('./i18n/', import.meta.url),         // strings laid over kitap's: hint, tab_map, map_data, ...
  client: { script: URL, styles: URL, module: true, libraries: [[pkg, file]], imports: { three: [pkg, folder, file] } },
  read: {
    story(story, ctx) {},              // the story's own files; returns the state the other hooks read as ctx.state
    folder(dir, scope, ctx) {},        // files in shared/ and in a page's folder
    include(dir, scope, ctx) {},       // an include.yaml in the page tree: returns a page or group node, or null
    prepare(ctx) {},                   // after every folder is read, before the pages
    page(fields, { dir, at, own, pid, scope, core }, ctx) {}, // returns { data, links, credits }
    finish({ story, pages, texts, images, coverImage }, ctx) {}, // returns { images, warnings, folders }
  },
  bundle(content, ctx) {},             // returns { data, families, credits }: data goes to the viewport under the id
  objects(content, ctx) {},            // returns { groups: { dir: [keys] }, ... }: what the store must hold
  make({ stories, cache, out, log }) {}, // writes each object to out/<key>, for --local-assets and upload
  site({ root, cache, strict, log, stories, fail }) {}, // checks across the stories before the build
  describeObjects(keys) {},            // the objects in words, for messages
};
```

`ctx` carries the project's readers (`readYaml`, `readJson`, `library`, `resolveImage`, `translatorFor`), the
story's translator `T`, `fail`, `attempt`, `warn`, the `scope` factory and the `storyScope`, and for an engine that
includes pages, `walk`, `pagesIn` and `readPage`. A `links` object answers the text's `[word](@id)` links:
`has(id)`, `attr(id)`, `missing(name, id)` and `names(lang)`.

The client script sets `window.KITAP_ENGINE = host => ({ show, lang, theme, resize, escape, point, highlight })`
and, as a module, dispatches `kitap-engine` once set. `host` carries the bundle `B`, the stage's elements under
`el`, `here()`, `lang()`, `L`, `T`, `css`, `pref` and the shell's other helpers. The engine owns everything inside
`el.map`, the legend and the view group; the shell owns the contents, the text, the tabs and the lightbox.
`el.extra` is a box at the top of the text, under the page's title, that phones show: an engine puts there what
belongs with the text, such as a battle's card. `showText(el)` switches a phone to the text and scrolls to `el`.
The shell styles callouts an engine draws in `el.map`: a `.callouts` layer of `.co` name boxes over an SVG of lines,
with `.callouts-on` on `el.map` hiding the markers' own names.

The test engine in `test/engines/plain.mjs` shows the least an engine needs.

## Deploy

A book serves from Cloudflare: the images and the engine's objects from an R2 bucket behind `assets.<zone>`, the
pages from a second bucket through a Worker on the zone. `site.yaml` names them in `url`, `assets` and `pages`, and
one script sets them up from a content project:

```
CF_TOKEN=<token> node node_modules/@openbooknetwork/kitap/scripts/cloudflare-book.mjs [--lock]
```

It adds the zone and prints its nameservers for the registrar, creates both buckets, attaches the assets domain,
sets CORS, the cache rule, the SVG header rule, tiered cache and https only, and with `--lock` the bucket lock on
`images/`. Run it again once the zone is active. Then three tokens by hand: an R2 token on the assets bucket for `kitap
upload`, one on the site bucket as the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets of the deploy
workflow, and a wrangler token with Workers Scripts Edit and Workers Routes Edit as `CLOUDFLARE_API_TOKEN` with
the account id as `CLOUDFLARE_ACCOUNT_ID`. `scripts/cloudflare-redirect.mjs <old zone> <new zone>` sends a
retired domain to the new one.

## Work on it

```
npm install
npm test
```
