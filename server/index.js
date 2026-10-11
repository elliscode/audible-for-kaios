const fs = require('fs');
const path = require('path');
const express = require('express');
const auth = require('./auth');
const audio = require('./audio');
const browser = require('./browser');
const config = require('./config');

// Only Caddy (on this Mac) talks to the server; it provides HTTPS for audible.elliscode.com.
const HOST = config.HOST;
const PORT = config.PORT;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUTO_PAUSE_MS = config.AUTO_PAUSE_SECONDS * 1000;
// Seconds the phone buffers before it starts playing (a countdown on screen). 0 plays at once.
const BUFFER_SECONDS = Math.max(0, Math.min(30, config.BUFFER_SECONDS || 0));
// Seconds between the phone's status readings. In between, the phone counts the time itself.
const STATUS_POLL_SECONDS = Math.max(1, Math.min(3600, config.STATUS_POLL_SECONDS || 60));
// AUTH=off skips the login entirely, for testing the stream on this Mac only (milestone 3).
const AUTH_OFF = config.AUTH === 'off';

if (AUTH_OFF && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.error('AUTH=off is only allowed with HOST=127.0.0.1');
  process.exit(1);
}

// --- Auto-pause: Audible playing with nobody listening for a while -> pause it, so a dropped phone
// (or Audible starting by itself) doesn't leave the book playing for hours. ------------------------

const WATCH_MS = 15 * 1000;
let unheardSince = null;
let lastWatchError = null; // logged once, not every 15 s while Chrome is down

setInterval(() => {
  if (audio.listenerCount() > 0) { unheardSince = null; return; }
  browser.playing().then((playing) => {
    if (!playing || audio.listenerCount() > 0) { unheardSince = null; return; }
    if (!unheardSince) unheardSince = Date.now();
    if (Date.now() - unheardSince < AUTO_PAUSE_MS) return;
    unheardSince = null;
    return browser.pause()
      .then(() => console.log('[auto-pause] playing with no phone listening for ' + AUTO_PAUSE_MS / 1000 + ' s, paused Audible'));
  }).then(() => { lastWatchError = null; }, (err) => {
    if (err.message !== lastWatchError) console.log('[auto-pause] ' + err.message);
    lastWatchError = err.message;
  });
}, WATCH_MS);

// Reloads the player page well before Audible's own 24 h restart (browser.refreshIfOld).
setInterval(() => {
  browser.refreshIfOld().catch((err) => console.log('[browser] player reload: ' + err.message));
}, 60 * 1000);

// --- App ---------------------------------------------------------------------------------------

const app = express();
app.set('trust proxy', 'loopback'); // client IP from Caddy's X-Forwarded-For, trusted only from 127.0.0.1
app.use(express.json({ limit: '16kb' }));

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

// The app page with the session's CSRF token, the phone settings and style.css / app.js inlined.
function appPage(csrf) {
  return readPublic('index.html')
    .replace('<!--CSRF-->', () => '<meta name="csrf" content="' + csrf + '">\n' +
      '<meta name="buffer-seconds" content="' + BUFFER_SECONDS + '">\n' +
      '<meta name="status-poll-seconds" content="' + STATUS_POLL_SECONDS + '">')
    .replace('<!--STYLE-->', () => '<style>\n' + readPublic('style.css') + '</style>')
    .replace('<!--SCRIPT-->', () => '<script>\n' + readPublic('app.js') + '</script>');
}

// Logged in: the app. Otherwise: the login page (and, from home, a new code in the log).
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (AUTH_OFF) return res.type('html').send(appPage(''));
  const s = auth.session(req);
  if (s) return res.type('html').send(appPage(s.csrf));
  const issued = auth.startAttempt(req, res);
  res.type('html').send(readPublic('login.html')
    .replace('<!--NOTICE-->', () => issued ? '' : 'Login is only available from the home network'));
});

app.get('/login.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('js').send(readPublic('login.js'));
});

app.post('/login', auth.login);

// The icon, before the login gate so the login page shows it too. /favicon.ico is what browsers ask for
// when a page names no icon; a PNG under that name works everywhere.
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'favicon.svg'), { maxAge: '1d' }));
app.get(['/favicon.png', '/favicon.ico'], (req, res) =>
  res.type('png').sendFile(path.join(PUBLIC_DIR, 'favicon.png'), { maxAge: '1d' }));

// The audio itself: session cookie plus a single-use ticket (an <audio> element can't send the
// CSRF header).
app.get('/stream.mp3', AUTH_OFF ? (req, res, next) => next() : auth.requireSessionAndTicket, audio.serve);

// Everything below requires a session cookie plus the X-CSRF-Token header.
if (!AUTH_OFF) app.use(auth.requireSessionAndCsrf);

app.post('/api/stream-ticket', AUTH_OFF ? (req, res) => res.json({ ticket: 'off' }) : auth.streamTicket);

app.get('/api/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = await browser.status();
  // Started from the Mac itself while held: send the audio again.
  if (s.playing && audio.isHeld()) audio.release();
  s.listeners = audio.listenerCount();
  res.json(s);
});

// Runs a browser action and answers 204, or 502 with the reason (Chrome/player missing, button
// not found).
function action(fn) {
  return (req, res) => {
    fn(req).then(() => res.status(204).end(), (err) => {
      console.log('[control] ' + req.path + ': ' + err.message);
      res.status(502).json({ error: err.message });
    });
  };
}

// --- Library -----------------------------------------------------------------------------------
// Reading it takes a few seconds (one page per 50 books), so it's kept for LIBRARY_TTL_MS.
// ?refresh=1 rereads it.

const LIBRARY_TTL_MS = 10 * 60 * 1000;
let libraryCache = null; // { books, fetchedAt }

async function getLibrary(refresh) {
  if (!refresh && libraryCache && Date.now() - libraryCache.fetchedAt < LIBRARY_TTL_MS) return libraryCache;
  libraryCache = { books: await browser.library(), fetchedAt: Date.now() };
  return libraryCache;
}

app.get('/api/library', (req, res) => {
  res.set('Cache-Control', 'no-store');
  getLibrary(req.query.refresh === '1').then((lib) => res.json({
    fetchedAt: lib.fetchedAt,
    books: lib.books.map((b) => ({ asin: b.asin, title: b.title, author: b.author, left: b.left })),
  }), (err) => {
    console.log('[library] ' + err.message);
    res.status(502).json({ error: err.message });
  });
});

// Opens a book from the library in the player (resumes where it was left off). Only ASINs from
// the library are accepted.
app.post('/api/open', (req, res, next) => {
  const asin = req.body && typeof req.body.asin === 'string' ? req.body.asin : '';
  getLibrary(false).then((lib) => {
    const book = lib.books.find((b) => b.asin === asin);
    if (!book) return res.status(404).json({ error: 'Not in the library' });
    audio.release();
    req.book = book;
    next();
  }, (err) => res.status(502).json({ error: err.message }));
}, action((req) => browser.openBook(req.book.asin, req.book.deliveryType)));

app.post('/api/toggle', action(() => browser.toggle()));
// Pausing holds the stream once Audible has stopped, so the phone keeps its unplayed buffer;
// playing releases it first, so nothing Audible plays is lost.
app.post('/api/play', action(() => { audio.release(); return browser.play(); }));
app.post('/api/pause', action(() => browser.pause().then(() => audio.hold())));
app.post('/api/seek', (req, res, next) => {
  const delta = Number(req.body && req.body.delta);
  if (!isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta must be a non-zero number of seconds' });
  next();
}, action((req) => browser.seek(Number(req.body.delta))));

app.listen(PORT, HOST, () => {
  console.log('Listening on http://' + HOST + ':' + PORT + (AUTH_OFF ? ' (AUTH=off)' : ''));
  browser.connect().catch((err) => console.log('[browser] ' + err.message));
});
