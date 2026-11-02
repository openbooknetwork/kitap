// Helpers shared by the story page and the site index. The build inlines this file into both.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Per browser preferences. Storage can be missing or blocked, so every access is guarded.
const pref = (key, allowed, fallback) => { try { const v = localStorage.getItem(key); return allowed.includes(v) ? v : fallback; } catch { return fallback; } };
const savePref = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
// the saved language, else the first browser language on offer, matched whole or by its base such as pt for pt-BR
const preferredLang = (langs, fallback) => {
  const saved = pref('lang', langs, null); if (saved) return saved;
  for (const l of navigator.languages ?? []) { const hit = langs.find(x => x.toLowerCase() === l.toLowerCase()) ?? langs.find(x => x === l.split('-')[0]); if (hit) return hit; }
  return fallback;
};

// A translatable field for the current language, falling back to the default language. A plain string, such as an
// engine's map data credit, reads the same in every language.
const pick = (field, lang, defaultLang, fallback = '') =>
  typeof field === 'string' ? field : field?.[lang] ?? field?.[defaultLang] ?? fallback;

function fillSelect(sel, items, current, label) {
  sel.setAttribute('aria-label', label); sel.innerHTML = '';
  for (const { value, text } of items) { const o = document.createElement('option'); o.value = value; o.textContent = text; o.selected = value === current; sel.appendChild(o); }
}

// a web server resolves a folder to its index.html, a file:// URL shows a listing instead
const isFile = location.protocol === 'file:';
const folder = (...parts) => parts.join('/') + '/' + (isFile ? 'index.html' : '');
// links from the site root, where a main page's <base> points, and from a story folder, where a story page's points
const storyLink = (id, lang) => folder(id, lang);
const siteLink = lang => folder('..', lang);
// The route is the path under the folder the page's <base> names, such as en/cannae on a story page. pushState
// refuses another path on file://, so there the address stays on the page first opened.
const pathParts = () => {
  const base = new URL(document.baseURI).pathname, p = decodeURIComponent(location.pathname);
  return p.startsWith(base) ? p.slice(base.length).split('/').filter(s => s && s !== 'index.html') : [];
};
function setRoute(parts, push) {
  if (isFile) return;
  const url = new URL(parts.map(encodeURIComponent).join('/') + '/', document.baseURI).href;
  if (url !== location.href) (push ? history.pushState : history.replaceState).call(history, null, '', url);
}

// The footer note on every page; the build fills in the repository URL from package.json
const REPO = '/*__REPO__*/';
const credit = ui => ui.generated_by.replace('{kitap}', `<a href="${REPO}" target="_blank" rel="noopener">kitap</a>`);

const applyPalette = id => { document.documentElement.dataset.palette = id; savePref('palette', id); };

// The story page layouts on wide screens: the picture in the middle, or the contents and the text together at one side.
// Every page offers the choice in its settings, and story pages apply it.
const LAYOUTS = ['center', 'left', 'right'];
// a small drawing of a layout: the map filled, the chronology and the text as outlines, in their order on the screen
function layoutIcon(l) {
  const cols = { center: ['nav', 'map', 'text'], left: ['nav', 'text', 'map'], right: ['map', 'text', 'nav'] }[l], w = { nav: 12, text: 16, map: 28 };
  let x = 1;
  const parts = cols.map(c => { const r = c === 'map' ? `<rect x="${x}" y="1" width="${w[c]}" height="30" rx="1.5" fill="currentColor" opacity=".55"/>` : `<rect x="${x + .5}" y="1.5" width="${w[c] - 1}" height="29" rx="1.5" fill="none" stroke="currentColor"/>`; x += w[c] + 2; return r; });
  return `<svg viewBox="0 0 61 32" aria-hidden="true">${parts.join('')}</svg>`;
}
const layoutButtons = (ui, current) => LAYOUTS.map(l => `<button type="button" role="radio" data-layout="${l}" aria-checked="${l === current}">${layoutIcon(l)}<span>${esc(ui['layout_' + l])}</span></button>`).join('');
function saveLayout(l) {
  savePref('layout', l); document.documentElement.dataset.layout = l;
  $('layouts').querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.layout === l));
}
const toggleLabel = (ui, allOpen) => allOpen ? ui.collapse_all : ui.expand_all;
