// Prints what's on Audible's player page, to fill in selectors.js. With a book open (and ideally
// playing) in the Chrome from scripts/start-chrome.sh, run:  node server/dump-player.js [--all]
//
// Lists the open tabs, then for the player tab: the page title, the media element, and every
// visible control-like or text element, including those inside web components' shadow DOM (which
// is where Audible's play/skip buttons live). Repeats (like the chapter list) are collapsed into
// one line with a count. --all includes hidden elements.
const { chromium } = require('playwright-core');
const sel = require('./selectors');
const config = require('./config');

const CDP_URL = config.CDP_URL;
const SHOW_HIDDEN = process.argv.includes('--all');

function describePage(showHidden) {
  const INTERESTING = /play|pause|skip|jump|forward|back|rewind|title|chapter|time|author|cover/i;
  const rows = new Map(); // key -> row

  function classOf(el) {
    const c = el.getAttribute('class');
    return c ? c.replace(/\s+/g, ' ').trim() : '';
  }

  function consider(el, host) {
    const tag = el.tagName.toLowerCase();
    const cls = classOf(el);
    const aria = el.getAttribute('aria-label') || '';
    const role = el.getAttribute('role') || '';
    const custom = tag.indexOf('-') > 0;
    if (!(tag === 'button' || tag === 'input' || custom || aria || role === 'button' ||
          INTERESTING.test(cls) || INTERESTING.test(el.id || '') || INTERESTING.test(el.getAttribute('data-testid') || ''))) return;
    const visible = el.getClientRects().length > 0;
    if (!visible && !showHidden) return;
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const row = {
      tag,
      in: host || undefined,
      id: el.id || undefined,
      class: cls || undefined,
      ariaLabel: aria || undefined,
      role: role || undefined,
      title: el.getAttribute('title') || undefined,
      testid: el.getAttribute('data-testid') || undefined,
      text: text || undefined,
      visible,
    };
    const key = [tag, host, cls, aria, role].join('|');
    const existing = rows.get(key);
    if (existing) existing.count = (existing.count || 1) + 1;
    else rows.set(key, row);
  }

  (function walk(root, host) {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      consider(all[i], host);
      if (all[i].shadowRoot) walk(all[i].shadowRoot, (host ? host + ' > ' : '') + all[i].tagName.toLowerCase() + '#shadow');
    }
  })(document, '');

  const media = [];
  (function walk(root) {
    media.push.apply(media, root.querySelectorAll('audio, video'));
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) walk(all[i].shadowRoot);
  })(document);

  return {
    documentTitle: document.title,
    media: media.map((m) => ({ tag: m.tagName, paused: m.paused, currentTime: m.currentTime, duration: m.duration })),
    elements: Array.from(rows.values()),
  };
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  let player = null;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const isPlayer = sel.playerUrl.test(page.url());
      console.log((isPlayer ? '* ' : '  ') + page.url());
      if (isPlayer && !player) player = page;
    }
  }
  if (!player) {
    console.log('\nNo tab matches selectors.playerUrl (' + sel.playerUrl + '). Open a book in the player.');
  } else {
    const result = await player.evaluate(describePage, SHOW_HIDDEN);
    console.log('\ndocument.title: ' + JSON.stringify(result.documentTitle));
    console.log('media: ' + JSON.stringify(result.media));
    console.log('\n' + result.elements.length + ' elements:');
    for (const r of result.elements) {
      // One compact line per element: drop empty fields.
      console.log(JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))));
    }
  }
  // Exit without browser.close(), which could close the Chrome itself.
  process.exit(0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
