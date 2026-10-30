#!/usr/bin/env node
// kitap build | check | dev | i18n | image | rehash | upload | deploy, run from a content project folder. An engine's
// own binary runs the same commands with its engine, and adds its own.
import { run } from '../src/cli.mjs';
await run(process.argv.slice(2));
