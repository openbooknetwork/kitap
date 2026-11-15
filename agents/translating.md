# Translating a story

For whoever is asked to translate a story or to update its translations. The work goes to two agents of the book's
`.claude/agents/`: `translator`, then `translation-reviewer`, each given the story id and the language code.

Commands are written here as `kitap <args>`. Run each from the repo root with the book's binary, which its
`AGENTS.md` names.

## A first translation

1. A request that names no language means every language of `site.yaml`'s `languages` other than `en`. Set the
   story's `languages` in `story.yaml` to `en` and the targets.
2. Dispatch one `translator` per language. Any number run at once, one agent per story and language, since two
   agents on the same story and language save the same catalogue.
3. When a translator reports, dispatch the `translation-reviewer` for that story and language.
4. When the reviewer reports, run `kitap i18n <lang> --story <story> --stamp`.

A stamp is the hash of the English behind a translated paragraph or string, kept in `i18n/stamps/<lang>.yaml` of the
story and of each folder it shows, committed with the translation. Stamps are written after the review, so an
unstamped paragraph is one that awaits a reviewer. A story translated before it had stamps gets them from one run of
step 4.

## An update

A story already in a language is updated from its stamps. `kitap i18n <lang> --story <story> --stale` writes
`.cache/kitap/stale/<story>/<lang>.yaml`: the paragraphs and strings whose English changed since the stamp, each with
the new English and the current translation, and what has no translation yet. Dispatch the `translator`, then the
`translation-reviewer`, with the story id, the language code and the word `stale`: each reads that list in place of
the story and edits the files it names. Then stamp the story. A request to update a story in every language runs one
pair of agents per language, as a first translation does.

## A few strings

`kitap i18n <lang> --story <story>` adds an empty key for every new English string to the story's `i18n/<lang>.yaml`
and to the catalogue of each folder the story shows, with the English as a comment above it. Fill each one, then run
`kitap i18n <lang> --story <story> --check`.
