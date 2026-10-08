// Login gate for public access (https://audible.elliscode.com via Caddy).
//
// - Opening the site without a session shows the login page. For requests from the home network, a
//   fresh 8-digit code is generated per page load and printed in the server log.
// - Codes can only be used (and are only generated) from home: private LAN addresses, or the home's
//   own public IP (whatever PUBLIC_HOST resolves to, since its A record points home).
// - At most LOGIN_MAX_ATTEMPTS code submissions per LOGIN_WINDOW_MS (default 2 per hour), total.
// - Success sets a 128-char session cookie and issues a 128-char CSRF token, both valid for
//   4 months. API requests must carry both. The audio stream uses a single-use ticket instead of
//   the CSRF header (see streamTicket below).
//
// Revoke all sessions: node server/auth.js --revoke-all   (then restart the server)
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');

const config = require('./config');

const PUBLIC_HOST = config.PUBLIC_HOST;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const TOKEN_LENGTH = 128;
const SESSION_MONTHS = 4;
const CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = config.LOGIN_MAX_ATTEMPTS;
const LOGIN_WINDOW_MS = config.LOGIN_WINDOW_MINUTES * 60 * 1000;
const HOME_IP_REFRESH_MS = 5 * 60 * 1000;
const MAX_PENDING_ATTEMPTS = 100;

const SESSION_COOKIE = 'audible_session';
const ATTEMPT_COOKIE = 'audible_attempt';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Uniform random [a-zA-Z0-9] string. Bytes >= 248 (the largest multiple of 62 below 256) are
// discarded so every character is equally likely.
function randomToken(length) {
  let out = '';
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 248) out += ALPHABET[b % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

function newCode() {
  return String(crypto.randomInt(0, 100000000)).padStart(8, '0');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// --- Home network check ----------------------------------------------------------------------

let homeIp = null;

function refreshHomeIp() {
  dns.promises.resolve4(PUBLIC_HOST).then((ips) => {
    if (ips[0] !== homeIp) console.log('[login] home public IP (' + PUBLIC_HOST + '): ' + ips[0]);
    homeIp = ips[0];
  }).catch(() => { /* not resolvable (yet): only LAN addresses count as home */ });
}
refreshHomeIp();
setInterval(refreshHomeIp, HOME_IP_REFRESH_MS).unref();

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

function isHome(rawIp) {
  const ip = normalizeIp(rawIp);
  if (homeIp && ip === homeIp) return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

// --- Cookies ---------------------------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append('Set-Cookie', name + '=' + value + '; Path=/; Max-Age=' + maxAgeSeconds +
    '; Secure; HttpOnly; SameSite=Strict');
}

// --- Login attempts (one per login page load) --------------------------------------------------

const attempts = new Map(); // attemptId -> { code, ip, createdAt }
let submissions = []; // timestamps of code submissions, for the rate limit

// Called when the login page is served. Returns true if a code was issued (home), false if not.
function startAttempt(req, res) {
  const ip = normalizeIp(req.ip);
  const previous = parseCookies(req)[ATTEMPT_COOKIE];
  if (previous) attempts.delete(previous); // each reload replaces the previous code
  if (!isHome(ip)) {
    console.log('[login] refused code request from ' + ip + ' (not home)');
    return false;
  }
  if (attempts.size >= MAX_PENDING_ATTEMPTS) attempts.delete(attempts.keys().next().value);
  const id = randomToken(32);
  const code = newCode();
  attempts.set(id, { code, ip, createdAt: Date.now() });
  setCookie(res, ATTEMPT_COOKIE, id, CODE_TTL_MS / 1000);
  console.log('[login] code ' + code + ' for ' + ip + ' (home)');
  return true;
}

// POST /login {code}
function login(req, res) {
  const ip = normalizeIp(req.ip);
  if (!isHome(ip)) {
    console.log('[login] refused attempt from ' + ip + ' (not home)');
    return res.status(403).json({ error: 'Login is only available from the home network' });
  }
  const id = parseCookies(req)[ATTEMPT_COOKIE];
  const attempt = id && attempts.get(id);
  if (!attempt || Date.now() - attempt.createdAt > CODE_TTL_MS) {
    if (id) attempts.delete(id);
    return res.status(400).json({ error: 'Code expired. Reload for a new one' });
  }
  const now = Date.now();
  submissions = submissions.filter((t) => now - t < LOGIN_WINDOW_MS);
  if (submissions.length >= LOGIN_MAX_ATTEMPTS) {
    const minutes = Math.ceil((submissions[0] + LOGIN_WINDOW_MS - now) / 60000);
    console.log('[login] rate limited attempt from ' + ip);
    return res.status(429).json({ error: 'Too many attempts. Try again in ' + minutes + ' min' });
  }
  submissions.push(now);
  attempts.delete(id); // one guess per code
  const code = req.body && typeof req.body.code === 'string' ? req.body.code : '';
  if (!safeEqual(code, attempt.code)) {
    console.log('[login] wrong code from ' + ip);
    return res.status(401).json({ error: 'Wrong code. Reload for a new one' });
  }
  const token = randomToken(TOKEN_LENGTH);
  const expires = new Date();
  expires.setMonth(expires.getMonth() + SESSION_MONTHS);
  sessions[sha256(token)] = { csrf: randomToken(TOKEN_LENGTH), createdAt: now, expiresAt: expires.getTime(), ip };
  saveSessions();
  setCookie(res, SESSION_COOKIE, token, Math.floor((expires.getTime() - now) / 1000));
  setCookie(res, ATTEMPT_COOKIE, '', 0);
  console.log('[login] session created for ' + ip + ', expires ' + expires.toISOString());
  res.json({ ok: true });
}

// --- Sessions --------------------------------------------------------------------------------

let sessions = loadSessions(); // sha256(session token) -> { csrf, createdAt, expiresAt, ip }

function loadSessions() {
  try {
    return pruned(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')));
  } catch (err) {
    return {};
  }
}

function pruned(all) {
  const now = Date.now();
  const out = {};
  for (const [k, s] of Object.entries(all)) if (s && s.expiresAt > now) out[k] = s;
  return out;
}

function saveSessions() {
  const tmp = SESSIONS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
  fs.renameSync(tmp, SESSIONS_FILE);
}

setInterval(() => {
  const before = Object.keys(sessions).length;
  sessions = pruned(sessions);
  if (Object.keys(sessions).length !== before) saveSessions();
}, 60 * 60 * 1000).unref();

// The session for this request's cookie, or null.
function session(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || token.length !== TOKEN_LENGTH) return null;
  const s = sessions[sha256(token)];
  return s && s.expiresAt > Date.now() ? s : null;
}

// For API routes: session cookie plus a matching X-CSRF-Token header.
function requireSessionAndCsrf(req, res, next) {
  const s = session(req);
  if (s && safeEqual(req.get('X-CSRF-Token') || '', s.csrf)) return next();
  console.log('[auth] rejected ' + req.method + ' ' + req.path + ' from ' + normalizeIp(req.ip) +
    (s ? ' (bad CSRF token)' : ' (no valid session)'));
  res.status(401).json({ error: 'login required' });
}

// --- Stream tickets ----------------------------------------------------------------------------
// <audio src> can't send the X-CSRF-Token header, so the client first asks for a single-use
// ticket (POST /api/stream-ticket, CSRF-checked) and puts it in the stream URL. The stream needs
// the session cookie too, and the ticket only works with the session it was issued to.

const TICKET_TTL_MS = 30 * 1000;
const tickets = new Map(); // ticket -> { session, createdAt }

// POST /api/stream-ticket (behind requireSessionAndCsrf)
function streamTicket(req, res) {
  const now = Date.now();
  for (const [t, v] of tickets) if (now - v.createdAt > TICKET_TTL_MS) tickets.delete(t);
  const ticket = randomToken(64);
  tickets.set(ticket, { session: session(req), createdAt: now });
  res.json({ ticket });
}

// For the stream route: session cookie plus a fresh ticket issued to that session (used up here).
function requireSessionAndTicket(req, res, next) {
  const s = session(req);
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
  const t = ticket && tickets.get(ticket);
  if (t) tickets.delete(ticket);
  if (s && t && t.session === s && Date.now() - t.createdAt <= TICKET_TTL_MS) return next();
  console.log('[auth] rejected ' + req.method + ' ' + req.path + ' from ' + normalizeIp(req.ip) +
    (s ? ' (bad stream ticket)' : ' (no valid session)'));
  res.status(401).json({ error: 'login required' });
}

module.exports = { startAttempt, login, session, requireSessionAndCsrf, streamTicket, requireSessionAndTicket };

if (require.main === module && process.argv.includes('--revoke-all')) {
  sessions = {};
  saveSessions();
  console.log('All sessions revoked. Restart the server for it to take effect.');
}
