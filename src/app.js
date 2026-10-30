// The story page. The build writes this file after common.js into dist/kitap.js. The page defines ROUTE, the
// language and page its URL names, and story.js defines BUNDLE. The engine's script, loaded before this one, sets
// window.KITAP_ENGINE, which the shell mounts into the viewport with a host object once the page is drawn.

// ---------- state ----------
const B = BUNDLE;
const ICONS = B.icons;
const PAGES = B.pages;
const ENGINE = B.engine;
// cur -1 is the overview: the story's title, span and summary, with the viewport as the engine opens it
let cur = -1;
const OVERVIEW = { id: null, overview: true, date: B.span, title: B.title, html: {}, sources: {}, credits: {}, card: null, [ENGINE]: B[ENGINE]?.overview ?? null };
const here = () => cur < 0 ? OVERVIEW : PAGES[cur];
let lang = preferredLang(B.languages, B.defaultLanguage);
let palette = pref('palette', B.themes.map(t => t.id), B.defaultTheme);
document.documentElement.dataset.palette = palette;
let layout = pref('layout', LAYOUTS, 'center');
document.documentElement.dataset.layout = layout;
const T = () => B.ui[lang];
const L = field => pick(field, lang, B.defaultLanguage);

// ---------- routing: <lang>/<page>/ and the overview <lang>/ under the story folder ----------
const pageIndex = id => PAGES.findIndex(p => p.id === id);
const pageLink = i => i < 0 ? folder(lang) : folder(lang, PAGES[i].id);
const writeRoute = push => setRoute(cur < 0 ? [lang] : [lang, PAGES[cur].id], push);
// the page the URL names; the bare story folder has no ROUTE and opens the overview in the reader's language
if (ROUTE) { lang = ROUTE.lang; if (ROUTE.page) cur = pageIndex(ROUTE.page); }
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// a family's colour token, as the build wrote it for every family the engine's bundle names
const colorVar = family => family ? `--z-${family}` : '--accent';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover)');
const phone = matchMedia('(max-width:900px)');

// ---------- images ----------
function openImage(id){
  const im = B.images[id];
  $('lb-img').src = im.src; $('lb-img').alt = L(im.caption);
  $('lb-cap').innerHTML = `${esc(L(im.caption))}<small>${esc(L(im.credit))}</small>`;
  $('lightbox').hidden = false; $('lb-close').focus();
}
function closeImage(){ $('lightbox').hidden = true; }

// ---------- panes ----------
const navEl = $('nav'), story = $('story'), legend = $('legend');
// phones show either the viewport or the text; every step lands on the viewport, with a dot on Text until it is read
// the text opens at the top the first time it is shown for a page; going back and forth on the same page keeps the place
let textPage = -1;
function setTab(tab){
  document.body.dataset.tab = tab;
  $('tab-map').setAttribute('aria-selected', tab === 'map'); $('tab-text').setAttribute('aria-selected', tab === 'text');
  if (tab === 'text' && textPage !== cur) { textPage = cur; story.scrollTop = 0; requestAnimationFrame(() => { story.scrollTop = 0; }); }
}
function renderChrome(){
  $('tab-map').textContent = T().tab_map; $('tab-text').textContent = T().tab_text;
  document.documentElement.lang = lang; document.documentElement.dir = T().dir === 'rtl' ? 'rtl' : 'ltr';
  $('title').textContent = L(B.title);
  $('back').textContent = L(B.site.title);
  $('back').href = siteLink(lang);
  $('hint').textContent = T().hint;
  if (B.site.source) { $('src').href = B.site.source; $('src').innerHTML = `${ICONS['external-link']} ${esc(T().story_source)}`; $('src').hidden = false; }
  $('made').innerHTML = credit(T());
  $('mapdata').innerHTML = `${ICONS.info}<span>${esc(T().map_data)}</span>`; $('mapdata').setAttribute('aria-label', T().map_data);
  $('mapdata').hidden = !B.credits.length;
  $('othersrc').innerHTML = `${ICONS['external-link']}<span>${esc(T().other_sources)}</span>`; $('othersrc').setAttribute('aria-label', T().other_sources);
  $('ask').innerHTML = `${ICONS['message-circle']}<span>${esc(T().ask)}</span>`; $('ask').setAttribute('aria-label', T().ask); $('ask').hidden = !B.site.ask.length;
  $('credits').innerHTML = `<p class="made">${credit(T())}</p><h4>${esc(T().map_data)}</h4><ul>${B.credits.map(c => `<li>${esc(L(c))}</li>`).join('')}</ul>`;
  $('prev').innerHTML = `${ICONS['chevron-left']} ${esc(T().prev)}`;
  $('next').innerHTML = `${esc(T().next)} ${ICONS['chevron-right']}`;
  $('lb-close').textContent = T().close;
  navEl.setAttribute('aria-label', T().chronology);
  fillSelect($('lang'), B.languages.map(l => ({ value: l, text: B.ui[l].name ?? l })), lang, T().language);
  $('lang-icon').innerHTML = ICONS.languages; $('langpick').title = T().language; $('langpick').hidden = B.languages.length < 2;
  fillSelect($('theme'), B.themes.map(t => ({ value: t.id, text: L(t.name) })), palette, T().theme);
  $('settings-btn').innerHTML = `${ICONS.settings} ${esc(T().settings)}`;
  $('settings').setAttribute('aria-label', T().settings);
  $('layout-label').textContent = T().layout; $('theme-label').textContent = T().theme;
  $('layouts').setAttribute('aria-label', T().layout);
  $('layouts').innerHTML = layoutButtons(T(), layout);
  $('legend-btn').textContent = T().legend;
}
function setLayout(l){
  layout = l; saveLayout(l);
  // the viewport has changed size, so the engine frames the page again
  V.resize?.();
}
const closedGroups = new Set(); // groups the reader folded; navigating to a page opens the groups above it
const holds = (node, index) => node.type === 'page' ? node.index === index : node.children.some(c => holds(c, index));
const groupKeys = (nodes, key = '') => nodes.flatMap(n => n.type === 'group' ? [key + '/' + n.id, ...groupKeys(n.children, key + '/' + n.id)] : []);
const ALL_GROUPS = groupKeys(B.tree);
const allGroupsOpen = () => ALL_GROUPS.every(k => !closedGroups.has(k));
function renderNav(reveal = true){
  navEl.innerHTML = '';
  const head = document.createElement('div'); head.className = 'sheet-head';
  head.innerHTML = `<h2>${esc(T().contents)}</h2><button type="button" class="sheet-close">${esc(T().close)}</button>`;
  head.querySelector('button').onclick = closeSheet;
  navEl.appendChild(head);
  if (ALL_GROUPS.length) {
    const t = document.createElement('button'); t.type = 'button'; t.className = 'toggle-all';
    t.textContent = toggleLabel(T(), allGroupsOpen());
    t.onclick = () => { allGroupsOpen() ? ALL_GROUPS.forEach(k => closedGroups.add(k)) : closedGroups.clear(); renderNav(false); };
    navEl.appendChild(t);
  }
  const build = (nodes, depth, key) => {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      if (n.type === 'page') {
        const p = PAGES[n.index]; const a = document.createElement('a');
        a.className = 'pg'; a.href = pageLink(n.index); a.dataset.page = n.index;
        a.style.setProperty('--depth', depth); if (n.index === cur) a.setAttribute('aria-current', 'page');
        a.innerHTML = `${L(p.date) ? `<span class="d">${esc(L(p.date))}</span>` : ''}${esc(L(p.title))}`; frag.appendChild(a);
      } else {
        const k = key + '/' + n.id; const d = document.createElement('details');
        if (reveal && holds(n, cur)) closedGroups.delete(k);
        d.open = !closedGroups.has(k);
        d.addEventListener('toggle', () => { if (d.open) closedGroups.delete(k); else closedGroups.add(k); const btn = navEl.querySelector('.toggle-all'); if (btn) btn.textContent = toggleLabel(T(), allGroupsOpen()); });
        const s = document.createElement('summary'); s.style.setProperty('--depth', depth); s.textContent = L(n.title);
        d.appendChild(s); d.appendChild(build(n.children, depth + 1, k)); frag.appendChild(d);
      }
    }
    return frag;
  };
  navEl.appendChild(build(B.tree, 0, ''));
}
// phones: the group path to the current page, and the page itself
const pathTo = (nodes, index) => { for (const n of nodes) { if (n.type === 'page' && n.index === index) return []; if (n.type === 'group') { const r = pathTo(n.children, index); if (r) return [n, ...r]; } } return null; };
function renderWhere(p){
  $('crumbs').textContent = (pathTo(B.tree, cur) ?? []).map(g => L(g.title)).join(' › ');
  $('here').innerHTML = p === OVERVIEW ? `<small>${esc(L(B.span))}</small>${esc(L(B.title))}` : `<small>${esc(L(p.date))}</small>${esc(L(p.title))}`;
  $('contents').innerHTML = `${ICONS.list} ${esc(T().contents)}`;
}
function openSheet(){ document.body.classList.add('sheet'); requestAnimationFrame(() => { const b = navEl.querySelector('.pg[aria-current="page"]'); if (b) b.scrollIntoView({ block: 'center' }); }); }
function closeSheet(){ document.body.classList.remove('sheet'); }
// the padding an engine keeps clear round the page's frame: on a phone the peek card covers the bottom of the viewport
function fitPadding(){
  const peek = $('peek'), pad = 40;
  return phone.matches && !peek.hidden ? { top: pad, left: pad, right: pad, bottom: peek.offsetHeight + 24 } : pad;
}
function renderPeek(){
  const first = story.querySelector('p');
  $('peek-text').textContent = first ? first.textContent : '';
  $('peek-more').textContent = T().read_more;
  $('peek-close').setAttribute('aria-label', T().hide);
  $('peek').hidden = !first;
}
// credits this page's picture carries beyond the story's, behind an "Other sources" button beside the data credit
function renderCredits(p){
  const list = p.credits?.[lang] ?? [];
  $('othersrc').hidden = !list.length; $('othercredits').hidden = true; $('othersrc').setAttribute('aria-expanded', false);
  $('othercredits').innerHTML = list.length ? `<h4>${esc(T().other_sources)}</h4><ul>${list.map(s => `<li>${s.url
    ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.text)}</a>` : esc(s.text)}</li>`).join('')}</ul>` : '';
}
function renderStory(p){
  renderWhere(p);
  if (p === OVERVIEW) {
    story.innerHTML = `<div class="date">${esc(L(B.span))}</div><h2>${esc(L(B.title))}</h2>${B.summary ? `<p>${esc(L(B.summary))}</p>` : ''}`
      + `<p><a class="start" href="${esc(pageLink(0))}" data-page="0">${esc(T().start)} ${ICONS['chevron-right']}</a></p>`;
    document.title = L(B.title);
  } else {
    const sources = p.sources[lang].length ? `<h3>${esc(T().sources)}</h3><ol>${p.sources[lang].map(x => `<li>${esc(x)}</li>`).join('')}</ol>` : '';
    story.innerHTML = `${L(p.date) ? `<div class="date">${esc(L(p.date))}</div>` : ''}<h2>${esc(L(p.title))}</h2>${p.html[lang]}${sources}`;
    document.title = `${L(p.title)} - ${L(B.title)}`;
  }
  renderCredits(p);
  story.scrollTop = 0;
  legend.hidden = true; $('legend-btn').hidden = true; // the engine fills the legend and shows the button for a page that has one
  renderPeek();
  $('stepno').textContent = cur < 0 ? '' : `${cur + 1} / ${PAGES.length}`;
  $('prev').disabled = cur < 0; $('next').disabled = cur === PAGES.length - 1;
}
// reveal centres the current page in the contents; a click in the contents itself leaves the scroll alone
function go(i, fromRoute, reveal = true){ cur = i; closeImage(); setTab('map'); document.body.classList.remove('legend-open'); renderNav(); if (reveal) revealCurrent(); renderStory(here()); V.show?.(here(), false); if (!fromRoute) writeRoute(true); }
function revealCurrent(){
  const b = navEl.querySelector('.pg[aria-current="page"]'); if (!b) return;
  const n = navEl.getBoundingClientRect(), r = b.getBoundingClientRect();
  navEl.scrollTo({ top: navEl.scrollTop + r.top - n.top - (n.height - r.height) / 2, left: navEl.scrollLeft + r.left - n.left - (n.width - r.width) / 2, behavior: reduced ? 'auto' : 'smooth' });
}
function setLang(l, fromRoute){
  lang = l; savePref('lang', l);
  renderChrome(); renderNav(); renderStory(here()); V.lang?.(l); if (!fromRoute) writeRoute(false);
}
function setPalette(id){ palette = id; applyPalette(id); $('theme').value = id; V.theme?.(); }
// the back and forward buttons: the path names a language and a page, or a language alone for the overview
addEventListener('popstate', () => {
  const [l, page] = pathParts(), i = page ? pageIndex(page) : -1;
  if (B.languages.includes(l) && l !== lang) setLang(l, true);
  if (i !== cur && (i >= 0 || !page)) go(i, true);
});
// links to a page step to it in place; a modified click opens the link as the browser does
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-page]');
  if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault(); const inNav = !!a.closest('#nav'); if (inNav) closeSheet(); go(Number(a.dataset.page), false, !inNav);
});
$('contents').onclick = openSheet;
$('tab-map').onclick = () => setTab('map');
$('tab-text').onclick = () => setTab('text');
setTab('map');
// the peek card: tap anywhere on it for the text; × hides it until the next page
$('peek').onclick = () => setTab('text');
$('peek').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab('text'); } };
$('peek-close').onclick = e => { e.stopPropagation(); $('peek').hidden = true; };
$('legend-btn').onclick = () => document.body.classList.toggle('legend-open');
// the data credit popup and the page's other sources popup share the credit bar, one open at a time
const CREDIT_POPUPS = { mapdata: 'credits', othersrc: 'othercredits', ask: 'askmenu' };
const showCredits = (open, btn = 'mapdata') => { for (const [b, p] of Object.entries(CREDIT_POPUPS)) { const on = open && b === btn; $(p).hidden = !on; $(b).setAttribute('aria-expanded', on); } };
$('mapdata').onclick = () => showCredits($('credits').hidden, 'mapdata');
$('othersrc').onclick = () => showCredits($('othercredits').hidden, 'othersrc');
// the assistants of site.yaml, each opened in a new tab with the page's text as the prompt; the reader's own account answers
const ASSISTANTS = { chatgpt: { name: 'ChatGPT', url: q => `https://chatgpt.com/?q=${q}` }, claude: { name: 'Claude', url: q => `https://claude.ai/new?q=${q}` } };
function askPrompt(p){
  const d = document.createElement('div'); d.innerHTML = p === OVERVIEW ? `<p>${esc(L(B.summary))}</p>` : p.html[lang];
  d.querySelectorAll('figure').forEach(f => f.remove()); // the prose only, without the image captions and credits
  const text = d.textContent.replace(/\s+/g, ' ').trim().slice(0, 2500);
  return `${T().ask_prompt.replace('{title}', L(p.title)).replace('{url}', location.href)}\n\n${text}`;
}
$('ask').onclick = () => {
  const q = encodeURIComponent(askPrompt(here()));
  $('askmenu').innerHTML = `<h4>${esc(T().ask_title)}</h4><div class="ask-list">${B.site.ask.map(id => `<a href="${esc(ASSISTANTS[id].url(q))}" target="_blank" rel="noopener">${esc(ASSISTANTS[id].name)} ${ICONS['external-link']}</a>`).join('')}</div><p class="note">${esc(T().ask_note)}</p>`;
  showCredits($('askmenu').hidden, 'ask');
};
document.addEventListener('click', e => { if (!e.target.closest('.corner')) showCredits(false); });
const showSettings = open => { $('settings').hidden = !open; $('settings-btn').setAttribute('aria-expanded', open); };
$('settings-btn').onclick = () => showSettings($('settings').hidden);
document.addEventListener('click', e => { if (!$('settings').hidden && !e.target.closest('.prefs')) showSettings(false); });
$('layouts').onclick = e => { const b = e.target.closest('button[data-layout]'); if (b) setLayout(b.dataset.layout); };
document.addEventListener('click', e => { const t = e.target.closest('[data-img]'); if (t) { e.stopPropagation(); openImage(t.dataset.img); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-img]')) openImage(e.target.dataset.img);
  if (e.key === 'Escape') { closeImage(); V.escape?.(); closeSheet(); showCredits(false); showSettings(false); }
  if (e.target.closest?.('input,textarea,select')) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); // at either end the key does nothing, rather than scrolling the page or the viewport
    const step = (e.key === 'ArrowRight') === (T().dir !== 'rtl') ? 1 : -1; // right to left text reads forward to the left
    if (cur + step >= -1 && cur + step < PAGES.length) go(cur + step);
  }
});
// pointing at a place the text links, or tabbing to it, shows it in the viewport. A phone shows the text or the
// viewport, so there the places are plain text.
const placeId = el => el.dataset.marker ?? el.dataset.ref;
const placeOf = e => phone.matches ? null : e.target.closest?.('.place');
story.addEventListener('mouseover', e => { const p = placeOf(e); if (p && canHover.matches) V.point?.(placeId(p), true); });
story.addEventListener('mouseout', e => { const p = placeOf(e); if (p && canHover.matches && !p.contains(e.relatedTarget)) V.point?.(placeId(p), false); });
story.addEventListener('focusin', e => { const p = placeOf(e); if (p?.matches(':focus-visible')) V.point?.(placeId(p), true); });
story.addEventListener('focusout', e => { const p = placeOf(e); if (p) V.point?.(placeId(p), false); });
$('lb-close').onclick = closeImage;
$('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeImage(); });
$('lang').onchange = e => setLang(e.target.value);
$('theme').onchange = e => setPalette(e.target.value);
$('prev').onclick = () => go(cur - 1);
$('next').onclick = () => go(cur + 1);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => V.theme?.());
new MutationObserver(() => V.theme?.()).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });

// ---------- the engine ----------
// What the engine's client gets: the bundle, the elements it owns inside the stage, the current page and language,
// and the shell's helpers. It returns the calls the shell makes as the reader moves: show(page, first), lang(l),
// theme(), resize(), escape(), point(id, on) and highlight(kind, id).
const host = {
  B, engine: ENGINE, el: { map: $('map'), legend, story, label: $('hl-label'), view: $('view'), tools: document.querySelector('.maptools'), legendButton: $('legend-btn') },
  here, isOverview: () => cur < 0, lang: () => lang, L, T, css, colorVar, esc, $, pref, savePref, reduced, canHover, phone, padding: fitPadding, openImage, closeImage, placeId,
};
let V = {};
renderChrome(); renderNav(); renderStory(here());
// a classic engine script has set KITAP_ENGINE already; a module one sets it after this script and says so
const mount = () => { V = window.KITAP_ENGINE(host); V.show?.(here(), true); };
if (window.KITAP_ENGINE) mount(); else addEventListener('kitap-engine', mount, { once: true });
writeRoute(false);
