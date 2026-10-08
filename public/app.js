// KaiOS 3.x / Gecko 84 client. XHR only (no fetch), ES5-style syntax, no build step.
//
// The phone is a speaker and remote for the Audible player running in Chrome on the Mac:
// - Play: connect the audio stream and press play in Audible. With a buffer set (BUFFER_SECONDS on
//   the server, 0 by default), the phone counts down that long before it starts playing, so it
//   has a few seconds of audio in hand for network hiccups.
// - Pause: stop the phone's audio and press pause in Audible. The server then holds the stream
//   (sends nothing, so no data is used), and the phone keeps the seconds it had buffered. The
//   next play resumes from exactly there, with no gap, no repeat and no new countdown. If the
//   connection dropped meanwhile, play starts over with a fresh countdown.
// - Skip -30/+30: presses within SEEK_SETTLE_MS add up into one skip. While playing, the phone
//   drops its buffer (audio from before the skip) and rebuffers for at most SEEK_BUFFER_SECONDS,
//   so the skip is heard almost at once instead of BUFFER_SECONDS late.
// - Library: the books in the Audible account, started ones first. Picking one opens it in the
//   player on the Mac (Audible resumes where it was left off) and starts playing.
// - Status (title, chapter, times, playing) is read from the Mac every STATUS_POLL_SECONDS and
//   after every action. In between, the phone advances the clock itself while Audible plays
//   (at Audible's narration speed), and reads again when the chapter's time runs out.
// Number keys are used because the D-pad drives the KaiOS browser's cursor; every action also has
// an on-screen button for the cursor.
(function () {
  'use strict';

  var RETRY_MS = 3000;
  var VOLUME_STEP = 0.1;
  var SEEK_SETTLE_MS = 800; // wait this long after the last skip press before skipping
  var SEEK_BUFFER_SECONDS = 2;
  var LIBRARY_STALE_MS = 10 * 60 * 1000;

  var audio = document.getElementById('audio');
  var stateEl = document.getElementById('state');
  var titleEl = document.getElementById('title');
  var chapterEl = document.getElementById('chapter');
  var timeEl = document.getElementById('time');
  var bookEl = document.getElementById('book');
  var toggleBtn = document.getElementById('toggle');
  var backBtn = document.getElementById('back');
  var fwdBtn = document.getElementById('fwd');
  var libraryBtn = document.getElementById('libraryBtn');
  var msgEl = document.getElementById('msg');
  var playerScreen = document.getElementById('player');
  var libraryScreen = document.getElementById('library');
  var libStateEl = document.getElementById('libState');
  var listEl = document.getElementById('list');

  var status = {};          // last /api/status reply
  var statusAt = 0;         // when it arrived (Date.now())
  var chapterEndPolled = false; // already asked for a fresh status at this chapter's end
  var listening = false;    // the user wants the stream connected
  var retryTimer = null;
  var msgTimer = null;
  var connection = 0;       // bumped on every connect/disconnect, so stale callbacks do nothing
  var countdown = 0;        // seconds left before playback starts (0 = not counting down)
  var countdownTimer = null;
  var held = false;         // paused from the phone, with the stream (and its buffer) kept open
  var pendingSeek = 0;      // seconds of skip presses not sent yet
  var seekTimer = null;
  var screen = 'player';    // 'player' or 'library'
  var books = [];           // library, from /api/library
  var booksAt = 0;          // when it was loaded (client clock)
  var selected = 0;         // highlighted book in the library list

  // Background playback on KaiOS (ignored where unsupported).
  try { audio.mozAudioChannelType = 'content'; } catch (e) { /* not KaiOS */ }

  // Session CSRF token, embedded in the page by the server. Sent with every request.
  var csrfMeta = document.querySelector('meta[name="csrf"]');
  var CSRF = csrfMeta ? csrfMeta.getAttribute('content') : '';

  // Seconds to buffer before playing (server setting BUFFER_SECONDS; 0 = play at once).
  var bufferMeta = document.querySelector('meta[name="buffer-seconds"]');
  var BUFFER_SECONDS = bufferMeta ? Number(bufferMeta.getAttribute('content')) || 0 : 0;

  // Seconds between status readings (server setting STATUS_POLL_SECONDS).
  var pollMeta = document.querySelector('meta[name="status-poll-seconds"]');
  var POLL_MS = (pollMeta ? Number(pollMeta.getAttribute('content')) || 60 : 60) * 1000;

  // Opens an XHR with the CSRF header. A 401 means the session is gone: reload to the login page.
  function request(method, path) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader('X-CSRF-Token', CSRF);
    xhr.responseType = 'json';
    xhr.addEventListener('load', function () {
      if (xhr.status === 401) location.reload();
    });
    return xhr;
  }

  // POSTs JSON; calls done(error message or null, response).
  function post(path, body, done) {
    var xhr = request('POST', path);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onloadend = function () {
      if (!done) return;
      if (xhr.status >= 200 && xhr.status < 300) return done(null, xhr.response);
      done((xhr.response && xhr.response.error) || 'Error ' + (xhr.status || 'offline'));
    };
    xhr.send(JSON.stringify(body || {}));
  }

  function say(text, ms) {
    msgEl.textContent = text;
    clearTimeout(msgTimer);
    if (ms) msgTimer = setTimeout(function () { msgEl.textContent = ''; }, ms);
  }

  // --- Stream ----------------------------------------------------------------------------------

  // Opens the stream but holds playback for bufferSeconds (default BUFFER_SECONDS) while it downloads, so the phone keeps
  // a few seconds of audio in hand and network hiccups don't cause pops and gaps. done(err) is
  // called as soon as the stream is open (before the countdown), so Audible can start right away:
  // the countdown then covers the book's first seconds instead of silence.
  function connect(done, bufferSeconds) {
    listening = true;
    held = false;
    connection++;
    var id = connection;
    clearTimeout(retryTimer);
    clearInterval(countdownTimer);
    countdown = 0;
    say('Connecting...');
    post('/api/stream-ticket', {}, function (err, res) {
      if (id !== connection) return; // disconnected or reconnected meanwhile
      if (err) {
        say(err);
        scheduleRetry();
        return done && done(err);
      }
      audio.preload = 'auto';
      audio.src = '/stream.mp3?ticket=' + encodeURIComponent(res.ticket);
      audio.load();
      startCountdown(id, bufferSeconds === undefined ? BUFFER_SECONDS : bufferSeconds);
      if (done) done(null);
    });
  }

  function startCountdown(id, seconds) {
    if (!(seconds > 0)) return startPlayback();
    countdown = seconds;
    showCountdown();
    countdownTimer = setInterval(function () {
      if (id !== connection) return clearInterval(countdownTimer);
      countdown--;
      if (countdown > 0) return showCountdown();
      clearInterval(countdownTimer);
      startPlayback();
    }, 1000);
  }

  function startPlayback() {
    say('');
    var p = audio.play();
    if (p && p.catch) p.catch(function (e) { say('Audio: ' + e.message + ' (press 0)'); });
    render();
  }

  // "Playback will start in 3... (2.1 s buffered)": how much audio the phone holds so far.
  function showCountdown() {
    var b = audio.buffered;
    var held = b.length ? b.end(b.length - 1) - audio.currentTime : 0;
    say('Playback will start in ' + countdown + '... (' + held.toFixed(1) + ' s buffered)');
    render();
  }

  function disconnect() {
    listening = false;
    held = false;
    connection++;
    clearTimeout(retryTimer);
    clearInterval(countdownTimer);
    countdown = 0;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    render();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!listening) return;
    retryTimer = setTimeout(function () { if (listening) connect(); }, RETRY_MS);
  }

  audio.addEventListener('playing', function () { say(''); render(); });
  // A dropped stream reconnects while playing; while paused, the next play reconnects instead.
  function streamLost() {
    if (!listening) return;
    if (held) return disconnect();
    say('Stream lost, retrying...');
    scheduleRetry();
  }
  audio.addEventListener('error', streamLost);
  audio.addEventListener('ended', streamLost);

  // --- Controls --------------------------------------------------------------------------------

  function toggle() {
    if (status.playing && !held) pause();
    else play();
  }

  function pause() {
    held = listening;
    clearInterval(countdownTimer);
    countdown = 0;
    audio.pause();
    say('Pausing...');
    post('/api/pause', {}, function (err) {
      say(err || '', err ? 0 : 1);
      poll();
    });
  }

  function play() {
    // Paused from the phone with the stream still open: resume Audible, then the phone's buffer.
    if (held && audio.getAttribute('src') && !audio.error) {
      held = false;
      say('Resuming...');
      post('/api/play', {}, function (err) {
        if (err) { held = true; return say(err); }
        say('', 1);
        var p = audio.play();
        if (p && p.catch) p.catch(function (e) { say('Audio: ' + e.message + ' (press 0)'); });
        poll();
      });
      return;
    }
    held = false;
    connect(function (err) {
      if (err) return;
      post('/api/play', {}, function (err2) {
        if (err2) say(err2);
        poll();
      });
    });
  }

  function seek(delta) {
    pendingSeek += delta;
    say('Skip ' + (pendingSeek > 0 ? '+' : '') + pendingSeek + ' s');
    clearTimeout(seekTimer);
    seekTimer = setTimeout(applySeek, SEEK_SETTLE_MS);
  }

  function applySeek() {
    var delta = pendingSeek;
    pendingSeek = 0;
    if (!delta) return;
    var live = listening && !held && !!status.playing;
    // Paused: the held buffer is from before the jump; drop it, so the next play starts there.
    if (held) disconnect();
    // Playing: stop the phone now (its buffer is from before the jump) and rebuffer after.
    if (live) {
      connection++; // cancels a countdown in progress
      clearInterval(countdownTimer);
      countdown = 0;
      audio.pause();
    }
    say('Skipping ' + (delta > 0 ? '+' : '') + delta + ' s...');
    post('/api/seek', { delta: delta }, function (err) {
      if (err) say(err);
      if (live) connect(null, Math.min(SEEK_BUFFER_SECONDS, BUFFER_SECONDS));
      else if (!err) say('', 1);
      poll();
    });
  }

  function volume(step) {
    audio.volume = Math.max(0, Math.min(1, Math.round((audio.volume + step) * 10) / 10));
    say('Volume ' + Math.round(audio.volume * 100) + '%', 1500);
  }

  // --- Library -------------------------------------------------------------------------------

  function showScreen(name) {
    screen = name;
    playerScreen.style.display = name === 'player' ? '' : 'none';
    libraryScreen.style.display = name === 'library' ? '' : 'none';
  }

  function openLibrary() {
    showScreen('library');
    if (!books.length || Date.now() - booksAt > LIBRARY_STALE_MS) loadLibrary(false);
    else renderLibrary();
  }

  function loadLibrary(refresh) {
    libStateEl.textContent = 'Loading...';
    var xhr = request('GET', '/api/library' + (refresh ? '?refresh=1' : ''));
    xhr.onloadend = function () {
      if (xhr.status !== 200 || !xhr.response) {
        libStateEl.textContent = (xhr.response && xhr.response.error) || 'Error ' + (xhr.status || 'offline');
        return;
      }
      books = xhr.response.books || [];
      booksAt = Date.now();
      selected = 0;
      for (var i = 0; i < books.length; i++) if (books[i].asin === status.asin) selected = i;
      renderLibrary();
    };
    xhr.send();
  }

  function renderLibrary() {
    libStateEl.textContent = books.length + ' books';
    listEl.innerHTML = '';
    books.forEach(function (b, i) {
      var item = document.createElement('div');
      item.className = 'item' + (i === selected ? ' sel' : '');
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = (b.asin === status.asin ? '\u25B6 ' : '') + b.title;
      var sub = document.createElement('div');
      sub.className = 's';
      sub.textContent = (b.author || '') + (b.left ? ' \u00B7 ' + b.left : '');
      item.appendChild(t);
      item.appendChild(sub);
      item.addEventListener('click', function () { selected = i; openSelected(); });
      listEl.appendChild(item);
    });
    scrollToSelected();
  }

  function moveSelection(step) {
    if (!books.length) return;
    var items = listEl.children;
    items[selected].className = 'item';
    selected = (selected + step + books.length) % books.length;
    items[selected].className = 'item sel';
    scrollToSelected();
  }

  function scrollToSelected() {
    var item = listEl.children[selected];
    if (!item) return;
    if (item.offsetTop < listEl.scrollTop) listEl.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > listEl.scrollTop + listEl.clientHeight) {
      listEl.scrollTop = item.offsetTop + item.offsetHeight - listEl.clientHeight;
    }
  }

  // Opens the highlighted book on the Mac, then plays it (with the usual countdown).
  function openSelected() {
    var book = books[selected];
    if (!book) return;
    showScreen('player');
    disconnect(); // anything buffered is from the previous book
    titleEl.textContent = book.title;
    chapterEl.textContent = '';
    timeEl.textContent = '';
    bookEl.textContent = '';
    say('Opening on the Mac...');
    post('/api/open', { asin: book.asin }, function (err) {
      if (err) return say(err);
      play();
    });
  }

  // --- Keys and buttons ------------------------------------------------------------------------

  toggleBtn.addEventListener('click', toggle);
  backBtn.addEventListener('click', function () { seek(-30); });
  fwdBtn.addEventListener('click', function () { seek(30); });
  libraryBtn.addEventListener('click', openLibrary);

  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var handled = true;
    if (screen === 'library') {
      if (k === '2' || k === 'ArrowUp') moveSelection(-1);
      else if (k === '8' || k === 'ArrowDown') moveSelection(1);
      else if (k === '5' || k === 'Enter') openSelected();
      else if (k === '1' || k === 'Backspace' || k === 'GoBack') showScreen('player');
      else if (k === '0') loadLibrary(true);
      else handled = false;
    } else {
      // Enter on a focused button already clicks it.
      if (k === '5' || (k === 'Enter' && e.target.tagName !== 'BUTTON')) toggle();
      else if (k === '4') seek(-30);
      else if (k === '6') seek(30);
      else if (k === '1') openLibrary();
      else if (k === '2') volume(VOLUME_STEP);
      else if (k === '8') volume(-VOLUME_STEP);
      else if (k === '0') connect();
      else handled = false;
    }
    if (handled) e.preventDefault();
  });

  // --- Status ----------------------------------------------------------------------------------

  function clock(seconds) {
    if (seconds == null) return '';
    seconds = Math.floor(seconds);
    var h = Math.floor(seconds / 3600);
    var m = Math.floor(seconds / 60) % 60;
    var s = seconds % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Audible's style: "4:09" under an hour, "1:02:03" from an hour.
  function shortClock(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    if (seconds >= 3600) return clock(seconds);
    var s = seconds % 60;
    return Math.floor(seconds / 60) + ':' + (s < 10 ? '0' : '') + s;
  }

  // "31:24", "1:02:03" or "-1:59" -> seconds (sign ignored), or null.
  function parseClock(text) {
    if (!text || !/^-?\d+(:\d\d){1,2}$/.test(text.trim())) return null;
    var parts = text.trim().replace('-', '').split(':');
    var total = 0;
    for (var i = 0; i < parts.length; i++) total = total * 60 + Number(parts[i]);
    return total;
  }

  function render() {
    var s = status;
    var state;
    if (s.browser === false) state = 'MAC OFFLINE';
    else if (s.player === false) state = 'NO PLAYER';
    else if (s.playing) state = listening ? 'PLAYING' : 'PLAYING (MUTED)';
    else state = 'PAUSED';
    stateEl.textContent = state;
    titleEl.textContent = s.player ? (s.title || '') : 'Open a book in Audible on the Mac';
    chapterEl.textContent = s.chapter || '';

    // Seconds of narration since the last reading, counted here while Audible plays.
    var ran = s.playing ? (Date.now() - statusAt) / 1000 * (s.rate || 1) : 0;
    var elapsed = parseClock(s.elapsed);
    var remaining = parseClock(s.remaining);
    if (remaining != null && remaining - ran <= 0 && s.playing && !chapterEndPolled) {
      // The chapter just ended: read the new chapter's name and times (Audible needs a moment).
      chapterEndPolled = true;
      setTimeout(poll, 1500);
    }

    // Chapter position like Audible's display ("29:14 -4:09"); the whole book underneath.
    var mediaTime = s.mediaTime == null ? null : s.mediaTime + ran;
    var overall = clock(mediaTime) + (s.mediaDuration ? ' / ' + clock(s.mediaDuration) : '');
    // Stop at the chapter's end until the next reading brings the new chapter.
    var chapterRan = remaining == null ? ran : Math.min(ran, remaining);
    var chapterTime = elapsed == null ? s.elapsed : shortClock(elapsed + chapterRan);
    var chapterLeft = remaining == null ? s.remaining : '-' + shortClock(remaining - chapterRan);
    timeEl.textContent = chapterTime ? chapterTime + (chapterLeft ? ' ' + chapterLeft : '') : overall;
    bookEl.textContent = chapterTime ? overall + (s.bookLeft ? ' (' + s.bookLeft + ')' : '') : (s.bookLeft || '');
    toggleBtn.textContent = countdown > 0 ? 'STARTING IN ' + countdown : (s.playing ? 'PAUSE' : 'PLAY');
  }

  function poll() {
    var xhr = request('GET', '/api/status');
    xhr.onloadend = function () {
      if (xhr.status === 200 && xhr.response) status = xhr.response;
      else status = { browser: false };
      statusAt = Date.now();
      chapterEndPolled = false;
      render();
    };
    xhr.send();
  }

  showScreen('player');
  poll();
  setInterval(poll, POLL_MS);
  setInterval(render, 1000); // the clock ticks here between readings
})();
