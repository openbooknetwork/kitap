// The test engine: a viewport that prints the page id. Every book feature is tested through it, with no map.
import { schema } from '../../src/index.mjs';
const { z } = schema;
export default {
  id: 'plain',
  schemas: { story: z.object({ tint: z.string().optional() }).strict(), page: z.object({ note: z.string().optional(), things: z.array(z.string()).default([]) }).strict() },
  ui: new URL('./plain-i18n/', import.meta.url),
  client: { script: new URL('./plain-client.js', import.meta.url) },
  read: {
    story: story => ({ tint: story.plain?.tint ?? null }),
    page: (p, { pid }) => ({ data: { note: p.note ?? null, things: p.things },
      links: { has: id => p.things.includes(id), attr: id => ` data-thing="${id}"`, missing: (name, id) => `[${name}](@${id}) links to "${id}", which the page's things do not hold`, names: () => p.things.map(t => [t, t]) } }),
    finish: () => ({ images: [], folders: [] }),
  },
  bundle: content => ({ data: { tint: content.state.tint, count: content.pages.length }, families: {}, credits: ['The plain engine'] }),
};
