// Captures whatever macOS plays into BlackHole and serves it as one endless MP3 stream.
//
// - capture/audio-capture (an AudioQueue recorder) writes raw 48 kHz stereo PCM, and ffmpeg
//   encodes it to mono MP3. ffmpeg's own avfoundation input isn't used: it dropped about 10% of
//   the audio as tiny gaps, heard as pops (see capture/capture.swift).
// - That pipeline is shared by every listener. It starts with the first listener and stops
//   STOP_AFTER_MS after the last one leaves.
// - BlackHole delivers silence while nothing plays, so the stream doesn't stall when Audible is
//   paused from the Mac itself.
// - A listener whose unsent backlog grows past MAX_BACKLOG_BYTES is dropped rather than slowing
//   everyone else down. MP3 frames resync by themselves, so a client can join mid-stream.
// - hold() stops sending (while Audible is paused from the phone) without closing connections:
//   the phone keeps the few seconds it had buffered, and resumes from exactly there after
//   release(), instead of receiving minutes of silence.
//
// Emits 'listeners' (count) whenever someone connects or disconnects.
const { spawn } = require('child_process');
const EventEmitter = require('events');
const config = require('./config');

const CAPTURE = config.CAPTURE;
const FFMPEG = config.FFMPEG;
const DEVICE = config.AUDIO_DEVICE;
const BITRATE = config.AUDIO_BITRATE;
const STOP_AFTER_MS = 30 * 1000;
const RESTART_DELAY_MS = 2000;
const MAX_BACKLOG_BYTES = 256 * 1024;

const events = new EventEmitter();
const listeners = new Set(); // express responses
let pipeline = null; // { capture, ffmpeg } child processes
let stopTimer = null;
let restartTimer = null;
let held = false;

function start() {
  if (pipeline || restartTimer) return;
  console.log('[audio] starting capture (' + DEVICE + ') -> ffmpeg (mp3 ' + BITRATE + ')');
  const capture = spawn(CAPTURE, [DEVICE], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'warning',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-ac', '1', '-ar', '44100',
    '-c:a', 'libmp3lame', '-b:a', BITRATE,
    '-flush_packets', '1', '-f', 'mp3', 'pipe:1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const p = { capture, ffmpeg };
  pipeline = p;

  capture.stdout.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', () => {}); // ffmpeg gone: handled by its 'close'
  ffmpeg.stdout.on('data', broadcast);
  capture.stderr.on('data', (d) => process.stdout.write('[capture] ' + d));
  ffmpeg.stderr.on('data', (d) => process.stdout.write('[ffmpeg] ' + d));

  // Either process ending ends the pipeline; restart it if people are still listening.
  for (const [name, proc] of Object.entries(p)) {
    proc.on('error', (err) => console.log('[audio] ' + name + ' failed to start: ' + err.message +
      (name === 'capture' ? ' (run scripts/build-capture.sh)' : '')));
    proc.on('close', (code, signal) => {
      if (pipeline !== p) return;
      console.log('[audio] ' + name + ' exited (' + (signal || code) + ')');
      kill(p);
      pipeline = null;
      if (listeners.size > 0) {
        restartTimer = setTimeout(() => { restartTimer = null; if (listeners.size > 0) start(); }, RESTART_DELAY_MS);
      }
    });
  }
}

function kill(p) {
  for (const proc of [p.capture, p.ffmpeg]) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  }
}

function stop() {
  if (!pipeline) return;
  console.log('[audio] no listeners, stopping capture');
  const p = pipeline;
  pipeline = null;
  kill(p);
}

function broadcast(chunk) {
  if (held) return;
  for (const res of listeners) {
    if (res.writableLength > MAX_BACKLOG_BYTES) {
      console.log('[audio] dropping a listener that fell behind');
      res.destroy();
      continue;
    }
    res.write(chunk);
  }
}

// GET /stream.mp3: keeps the response open and adds it to the broadcast until the client leaves.
function serve(req, res) {
  res.status(200).set({
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);
  listeners.add(res);
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  start();
  console.log('[audio] listener connected from ' + req.ip + ' (' + listeners.size + ' total)');
  events.emit('listeners', listeners.size);

  res.on('close', () => {
    if (!listeners.delete(res)) return;
    console.log('[audio] listener disconnected (' + listeners.size + ' left)');
    events.emit('listeners', listeners.size);
    if (listeners.size === 0) held = false;
    if (listeners.size === 0 && !stopTimer) {
      stopTimer = setTimeout(() => { stopTimer = null; if (listeners.size === 0) stop(); }, STOP_AFTER_MS);
    }
  });
}

function listenerCount() {
  return listeners.size;
}

function hold() {
  if (!held && listeners.size > 0) console.log('[audio] holding the stream (paused)');
  held = listeners.size > 0;
}

function release() {
  if (held) console.log('[audio] releasing the stream');
  held = false;
}

function isHeld() {
  return held;
}

module.exports = { serve, listenerCount, events, hold, release, isHeld };
