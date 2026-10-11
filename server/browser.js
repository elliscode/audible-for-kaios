// Remote control for the Audible tab in the Chrome started by scripts/start-chrome.sh.
//
// - Attaches over the Chrome DevTools Protocol (127.0.0.1:9222), so the server can restart without
//   touching Chrome or playback, and Chrome itself is a normal Chrome with Widevine.
// - Controls press Audible's own buttons (selectors.js). Nothing here changes the media element;
//   it's only read for status (playing / position) when the page's text isn't found.
// - Actions run one at a time.
// - The library is read from Audible's own library page (fetched inside an Audible tab, so it uses
//   the logged-in session), and a book is opened by pointing the player tab at the same player URL
//   that the library's "Listen now" button opens.
const { chromium } = require('playwright-core');
const sel = require('./selectors');
const config = require('./config');

const CDP_URL = config.CDP_URL;
const CLICK_TIMEOUT_MS = 3000;
const SKIP_SECONDS = 30;
const PLAYER_LOAD_TIMEOUT_MS = 30000;
const LIBRARY_PAGE_SIZE = 50;
const LIBRARY_MAX_PAGES = 20;
const HOUR_MS = 60 * 60 * 1000;
const RELOAD_MS = config.PLAYER_RELOAD_HOURS * HOUR_MS;
const MAX_AGE_MS = config.PLAYER_MAX_HOURS * HOUR_MS;
// A reload while paused waits until Audible has been paused this long, so its position is saved.
const PAUSED_BEFORE_RELOAD_MS = 60 * 1000;
// After pausing to reload a playing book, time for Audible to save the position.
const SAVE_WAIT_MS = 5000;
// A freshly loaded player shows its chapter a moment after its controls, and starts playing by
// itself a few seconds later. How long to wait for the one and watch for the other.
const SETTLE_MS = 15000;

let browser = null;
let connecting = null;
let queue = Promise.resolve();

function connect() {
  if (browser && browser.isConnected()) return Promise.resolve(browser);
  if (!connecting) {
    connecting = chromium.connectOverCDP(CDP_URL).then((b) => {
      browser = b;
      console.log('[browser] connected to Chrome at ' + CDP_URL);
      b.on('disconnected', () => {
        if (browser === b) browser = null;
        console.log('[browser] Chrome disconnected');
      });
      return b;
    }, (err) => {
      // Playwright's message includes a multi-line call log; keep the reason only.
      throw new Error('Chrome not reachable at ' + CDP_URL + ' (run scripts/start-chrome.sh): ' +
        err.message.split('\n')[0].replace(/^browserType\.connectOverCDP: /, ''));
    }).finally(() => { connecting = null; });
  }
  return connecting;
}

// The player tab, or null if Audible's player isn't open.
async function playerPage() {
  const b = await connect();
  for (const context of b.contexts()) {
    for (const page of context.pages()) {
      if (sel.playerUrl.test(page.url())) return page;
    }
  }
  return null;
}

// Any tab on Audible's site (the player, or else e.g. the library), or null.
async function audiblePage() {
  const player = await playerPage();
  if (player) return player;
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (sel.audibleUrl.test(page.url())) return page;
    }
  }
  return null;
}

// Runs fn() after any earlier action finishes.
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

// Like serial, with the player tab. Throws if Chrome or the player isn't there.
function act(fn) {
  return serial(async () => {
    const page = await playerPage();
    if (!page) throw new Error('Audible player is not open');
    return fn(page);
  });
}

// Clicks the first visible element matching any selector in the list.
async function clickFirst(page, selectors, name) {
  for (const s of selectors) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: CLICK_TIMEOUT_MS });
      return;
    }
  }
  throw new Error('No ' + name + ' button found (update server/selectors.js)');
}

// Runs inside the page: text of the first visible match per field, plus media element state.
// Audible's player is built from web components, so this looks inside open shadow roots too.
function readPage(lists) {
  function deepAll(selector) {
    const out = [];
    (function walk(root) {
      out.push.apply(out, root.querySelectorAll(selector));
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) walk(all[i].shadowRoot);
    })(document);
    return out;
  }
  function text(selectors) {
    for (const s of selectors) {
      for (const el of deepAll(s)) {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && el.getClientRects().length) return t.split('\n')[0].slice(0, 200);
      }
    }
    return null;
  }
  const media = deepAll('audio, video');
  const active = media.filter((m) => m.currentSrc || m.src)[0] || media[0] || null;
  return {
    playing: media.some((m) => !m.paused && !m.ended),
    title: text(lists.title),
    chapter: text(lists.chapter),
    elapsed: text(lists.elapsed),
    remaining: text(lists.remaining),
    bookLeft: text(lists.bookLeft),
    mediaTime: active && isFinite(active.currentTime) ? active.currentTime : null,
    mediaDuration: active && isFinite(active.duration) ? active.duration : null,
    rate: active ? active.playbackRate : 1, // narration speed, so the phone's clock can keep pace
  };
}

async function isPlaying(page) {
  return page.evaluate(() =>
    Array.prototype.some.call(document.querySelectorAll('audio, video'), (m) => !m.paused && !m.ended));
}

function toggle() {
  return act((page) => clickFirst(page, sel.playPause, 'play/pause'));
}

// Starts playback. If another device took over, Audible shows a dialog instead; its button also
// starts playback.
async function pressPlay(page) {
  if (await isPlaying(page)) return;
  for (const s of sel.takeOver) {
    const loc = page.locator(s).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: CLICK_TIMEOUT_MS });
      await page.waitForTimeout(1500);
      if (await isPlaying(page)) return;
      break;
    }
  }
  await clickFirst(page, sel.playPause, 'play/pause');
}

function play() {
  return act(pressPlay);
}

function pause() {
  return act(async (page) => {
    if (await isPlaying(page)) await clickFirst(page, sel.playPause, 'play/pause');
  });
}

// Seeks by whole 30 s skips using Audible's skip buttons.
function seek(deltaSeconds) {
  const steps = Math.min(20, Math.round(Math.abs(deltaSeconds) / SKIP_SECONDS));
  const list = deltaSeconds < 0 ? sel.back30 : sel.forward30;
  return act(async (page) => {
    for (let i = 0; i < steps; i++) await clickFirst(page, list, deltaSeconds < 0 ? 'skip back' : 'skip forward');
  });
}

// Runs inside an Audible tab: reads every page of the library. Returns
// [{ asin, title, author, left, deliveryType }], where left is e.g. "32h 8m left" for started books.
async function readLibrary(opts) {
  const books = [];
  for (let page = 1; page <= opts.maxPages; page++) {
    const res = await fetch('/library/titles?pageSize=' + opts.pageSize + '&page=' + page, { credentials: 'include' });
    if (!res.ok) throw new Error('Library page ' + page + ': HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const rows = doc.querySelectorAll(opts.row);
    for (const row of rows) {
      const asin = row.id.slice(opts.rowIdPrefix.length);
      const titleEl = row.querySelector(opts.title);
      const authors = Array.from(row.querySelectorAll(opts.author)).map((a) => a.textContent.trim());
      const left = row.textContent.replace(/\s+/g, ' ').match(/(\d+h )?\d+m left/);
      const asinInput = doc.querySelector('input[name="asin"][value="' + asin + '"]');
      const typeInput = asinInput && asinInput.parentElement.querySelector('input[name="contentDeliveryType"]');
      books.push({
        asin,
        title: titleEl ? titleEl.textContent.trim() : asin,
        author: authors.join(', '),
        left: left ? left[0] : null,
        deliveryType: typeInput ? typeInput.value : null,
      });
    }
    if (rows.length < opts.pageSize) break;
  }
  return books;
}

// The whole library, books already started first (each group in Audible's "date added" order).
function library() {
  return serial(async () => {
    await connect();
    const page = await audiblePage();
    if (!page) throw new Error('No Audible tab open in Chrome');
    const books = await page.evaluate(readLibrary, {
      pageSize: LIBRARY_PAGE_SIZE, maxPages: LIBRARY_MAX_PAGES,
      row: sel.library.row, rowIdPrefix: sel.library.rowIdPrefix, title: sel.library.title, author: sel.library.author,
    });
    return books.filter((b) => b.left).concat(books.filter((b) => !b.left));
  });
}

// Opens a book in the player tab (or a new tab if there's none). Audible resumes it where it was
// left off. Resolves once the player's play/pause button is showing.
function openBook(asin, deliveryType) {
  return serial(async () => {
    await connect();
    let page = await playerPage();
    const base = page || await audiblePage();
    if (!base) throw new Error('No Audible tab open in Chrome');
    const url = new URL(base.url()).origin + '/webplayer?asin=' + encodeURIComponent(asin) +
      '&contentDeliveryType=' + encodeURIComponent(deliveryType || 'SinglePartBook') +
      '&isSample=false&overrideLph=false&initialCPLaunch=true';
    if (page) {
      // Pause first, so Audible saves the current book's position.
      if (await isPlaying(page)) await clickFirst(page, sel.playPause, 'play/pause').catch(() => {});
    } else {
      page = await base.context().newPage();
    }
    await loadPlayer(page, url);
    console.log('[browser] opened ' + asin);
  });
}

// Points the tab at a player URL, accepting any "Leave site?" prompt, and waits until the
// play/pause button shows.
async function loadPlayer(page, url) {
  const acceptLeave = (dialog) => dialog.accept().catch(() => {});
  page.on('dialog', acceptLeave);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PLAYER_LOAD_TIMEOUT_MS });
  } finally {
    page.off('dialog', acceptLeave);
  }
  await page.locator(sel.playPause.join(', ')).first().waitFor({ state: 'visible', timeout: PLAYER_LOAD_TIMEOUT_MS });
}

// --- Player refresh ------------------------------------------------------------------------------
// About 24 h after its page loads, Audible's web player starts the book over by itself: it plays
// the "This is Audible" intro from the very start, and that position is then saved over the real
// one (seen twice, 8-10 s after the 24 h mark, playing or paused). So the page is reloaded before
// then: once it's PLAYER_RELOAD_HOURS old, whenever Audible has been paused for a minute; if it's
// still playing at PLAYER_MAX_HOURS, by pausing, reloading and playing again. Audible saves the
// position on pause, and the reloaded player resumes from it.

let pausedSince = null;

// Chapter and time, for the log.
async function where(page) {
  const s = await page.evaluate(readPage,
    { title: [], chapter: sel.chapter, elapsed: sel.elapsed, remaining: [], bookLeft: [] });
  return { chapter: s.chapter, text: (s.chapter || '?') + ' ' + (s.elapsed || '?') };
}

// Waits (up to SETTLE_MS) for a freshly loaded player to show its chapter.
async function settled(page) {
  const end = Date.now() + SETTLE_MS;
  let w = await where(page);
  while (!w.chapter && Date.now() < end) {
    await page.waitForTimeout(500);
    w = await where(page);
  }
  return w;
}

// Pauses any playback the player starts by itself during the next SETTLE_MS.
async function keepPaused(page) {
  const end = Date.now() + SETTLE_MS;
  while (Date.now() < end) {
    if (await isPlaying(page)) await clickFirst(page, sel.playPause, 'play/pause');
    await page.waitForTimeout(500);
  }
}

// Called every minute. Never throws for a missing Chrome or player.
function refreshIfOld() {
  return serial(async () => {
    const page = await playerPage().catch(() => null);
    if (!page) return;
    const playing = await isPlaying(page);
    if (playing) pausedSince = null;
    else if (!pausedSince) pausedSince = Date.now();

    // The page's own load time, so a page opened by hand or before a server restart counts too.
    const ageMs = Date.now() - await page.evaluate(() => performance.timeOrigin);
    if (ageMs < RELOAD_MS) return;
    if (playing ? ageMs < MAX_AGE_MS : Date.now() - pausedSince < PAUSED_BEFORE_RELOAD_MS) return;

    const before = await where(page);
    if (playing) {
      await clickFirst(page, sel.playPause, 'play/pause');
      await page.waitForTimeout(SAVE_WAIT_MS);
    }
    await loadPlayer(page, page.url());
    pausedSince = null;
    const after = await settled(page);
    const ageText = (ageMs / HOUR_MS).toFixed(1) + ' h';
    console.log('[browser] reloaded the player (page was ' + ageText + ' old): ' + before.text + ' -> ' + after.text);

    // Only a book that was playing, and came back in the same chapter, plays again. Anything else
    // (a different chapter means the position didn't carry over) is held paused, so the wrong
    // position isn't played and saved.
    if (playing && before.chapter && before.chapter === after.chapter) {
      await pressPlay(page);
    } else {
      if (playing) console.log('[browser] not resuming: the reloaded player shows a different chapter');
      await keepPaused(page);
    }
  });
}

// Whether Audible is playing (false with no player open). Throws if Chrome isn't reachable.
async function playing() {
  const page = await playerPage();
  return page ? isPlaying(page) : false;
}

// Never throws: reports what's reachable.
async function status() {
  try {
    const page = await playerPage();
    if (!page) return { browser: true, player: false };
    const s = await page.evaluate(readPage,
      { title: sel.title, chapter: sel.chapter, elapsed: sel.elapsed, remaining: sel.remaining, bookLeft: sel.bookLeft });
    const asin = new URL(page.url()).searchParams.get('asin');
    return Object.assign({ browser: true, player: true, asin }, s);
  } catch (err) {
    return { browser: !!(browser && browser.isConnected()), player: false, error: err.message };
  }
}

module.exports = { connect, playerPage, toggle, play, pause, seek, status, library, openBook, refreshIfOld, playing };
