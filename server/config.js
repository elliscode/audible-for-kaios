// Settings for the server and the phone page. Edit, then restart the server (npm start) and
// reload the page on the phone.
//
// For a one-off test, an environment variable with the same name overrides a setting here,
// e.g.  PORT=8093 npm start
const path = require('path');

const settings = {
  // --- Phone ----------------------------------------------------------------------------------

  // Seconds the phone buffers (with an on-screen countdown) before it starts playing, so it has
  // audio in hand for network hiccups. 0 plays at once. Skips rebuffer for at most 2 s of this.
  BUFFER_SECONDS: 4,

  // Seconds between the phone's status readings (title, chapter, times, playing). In between,
  // the phone counts the time itself while playing. It also reads right after every action and
  // at each chapter's end, so this mainly affects how soon changes made on the Mac itself show.
  STATUS_POLL_SECONDS: 60,

  // --- Playback -------------------------------------------------------------------------------

  // Pause Audible after this many seconds with no phone listening (e.g. it dropped off Wi-Fi).
  AUTO_PAUSE_SECONDS: 60,

  // The capture device (the Mac's sound output must be set to it; scripts/start-chrome.sh does).
  AUDIO_DEVICE: 'BlackHole 2ch',

  // MP3 bitrate of the stream (mono). 64k is about 29 MB per hour.
  AUDIO_BITRATE: '64k',

  // --- Server ---------------------------------------------------------------------------------

  // Where the server listens. Only Caddy on this Mac should reach it.
  HOST: '127.0.0.1',
  PORT: 8090,

  // The site's public name. Whatever it resolves to counts as "home" for logging in.
  PUBLIC_HOST: 'audible.elliscode.com',

  // Chrome's DevTools address (scripts/start-chrome.sh opens it on this port).
  CDP_URL: 'http://127.0.0.1:9222',

  // --- Login ----------------------------------------------------------------------------------

  // Code attempts allowed per rolling window, in total.
  LOGIN_MAX_ATTEMPTS: 2,
  LOGIN_WINDOW_MINUTES: 60,

  // --- Testing --------------------------------------------------------------------------------

  // 'off' skips the login entirely; only allowed with HOST 127.0.0.1 (for testing on this Mac).
  AUTH: 'on',

  // The programs that record and encode the audio.
  CAPTURE: path.join(__dirname, '..', 'capture', 'audio-capture'),
  FFMPEG: 'ffmpeg',
};

for (const key of Object.keys(settings)) {
  const value = process.env[key];
  if (value === undefined || value === '') continue;
  settings[key] = typeof settings[key] === 'number' ? Number(value) : value;
}

module.exports = settings;
