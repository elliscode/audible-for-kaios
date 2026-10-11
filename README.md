# audible-for-kaios

Listen to Audible on a KaiOS 3.x flip phone (Gecko 84). The Mac Mini plays the book in a normal Chrome window, and the phone acts as its speaker and remote.

```
Chrome (Audible web player) --sound--> BlackHole 2ch --ffmpeg--> MP3 stream
                                                                    |
KaiOS browser --HTTPS--> Caddy (:443, audible.elliscode.com) --> Node server (127.0.0.1:8090)
                                                                    |
                                     play/pause/seek --DevTools (127.0.0.1:9222)--> Chrome
```

- **Audible does all the real work:** library, resume position, chapters, account. Pick the book in the Chrome window on the Mac (by screen sharing or at the Mac). The phone just hears what Chrome plays.
- **Nothing touches Audible's files or DRM.** The server only captures the Mac's decoded sound output, the same way a recording of the speakers would.
- **The stream:** a small Swift recorder (`capture/capture.swift`) reads BlackHole, and ffmpeg encodes it to mono 64 kbps MP3, about 29 MB per hour.
  - ffmpeg's built-in macOS capture dropped about 10% of the audio as tiny gaps, heard as constant pops. The recorder keeps several buffers queued and drops nothing.
  - It runs only while a phone is listening, and stops 30 s after the last one leaves.
- **Controls press Audible's own buttons through Chrome DevTools:**
  - play/pause
  - skip back/forward 30 s
  - If Audible shows "Another device is active" (the Audible app took over), play presses "Listen on this device".
- **Auto-pause:** if Audible plays for 60 s with no phone listening, it's paused, so a dropped connection (or Audible starting by itself) doesn't play the book on for hours.
- **Player refresh:** about 24 h after its page loads, Audible's web player restarts the book from the very beginning by itself ("This is Audible"), and that position is saved over the real one. So the server reloads the page first: after 12 h whenever Audible has been paused for a minute, or at 23 h even while playing (pause, reload, play: a gap of about 7 s). The reloaded player resumes from the saved position. If it comes back in a different chapter, it's left paused.

## Phone keys

**Player screen.** Every action also has an on-screen button (−30, PLAY, +30, LIBRARY) for the browser cursor.

| Key | Action |
| --- | --- |
| **5** / Enter | **Play:** presses play in Audible and starts the phone. With `BUFFER_SECONDS` set (in `server/config.js`), the phone first counts down that long while it buffers audio, which smooths over a poor connection. **Pause:** stops both. The server holds the stream (no data used), and the next play resumes from the phone's buffer with nothing skipped. |
| **4** / **6** | Skip back / forward 30 s. Quick presses add up (3× = 90 s). While playing, the phone drops its buffer and restarts (after a countdown of up to 2 s if `BUFFER_SECONDS` is set), so the skip is heard right away. |
| **1** | Library |
| **2** / **8** | Phone volume up / down |
| **0** | Reconnect the audio stream |

**Library screen.** It lists every book in the account, started ones first with time left; ▶ marks the open one.

| Key | Action |
| --- | --- |
| **2** / **8** | Move up / down |
| **5** / Enter | Open the book on the Mac (Audible resumes where it was left off) and play it |
| **1** / Back | Back to the player |
| **0** | Reload the library from Audible (it's otherwise kept for 10 minutes) |

Number keys are used because the KaiOS browser's D-pad moves its cursor.

## Setup (on the Mac Mini)

```sh
brew install blackhole-2ch switchaudio-osx ffmpeg caddy node   # BlackHole needs a reboot or `sudo killall coreaudiod`
cd server && npm install && cd ..
./scripts/build-capture.sh    # builds capture/audio-capture, the BlackHole recorder (needs Xcode command line tools)
```

1. **Chrome:** `./scripts/start-chrome.sh`.
   - It switches the sound output to BlackHole, then opens Chrome (960x1104) with its own profile in `~/audible-browser-profile` and DevTools on 127.0.0.1:9222.
   - Log into Audible by hand once. The profile keeps the login, and no password is stored anywhere here.
   - To check that sound reaches the speakers at all, switch the output back for a moment: `SwitchAudioSource -t output -s "Mac mini Speakers"`.
2. **Check the capture:**
   - Play a book, then run `./scripts/test-audio.sh`. It records 10 s from BlackHole to `capture.wav` and prints the loudness: around −91 dB means silence.
   - macOS asks for **Microphone** permission the first time. Allow it.
3. **Server:**
   - `cd server && npm start`.
   - To test the stream on the Mac only, before login and HTTPS are set up: `AUTH=off npm start`, then `ffplay http://127.0.0.1:8090/stream.mp3`.
4. **Fit the selectors to Audible's player:**
   - Open a book in the player, then run `node server/dump-player.js`. It lists the player's buttons (aria-labels, classes) and its title/chapter/time elements.
   - The selectors that ship were checked against the live player in Oct 2026. Run this again and adjust `server/selectors.js` if Audible changes its page and play/pause, skip or status stop working.
   - Audible's controls are web components, so the useful attributes (aria-labels, `data-testid`) are often inside shadow DOM. The dump shows where each element sits (`in: adbl-icon-button#shadow`).
5. **HTTPS + DNS:**
   - `caddy run --config Caddyfile`, or copy its `audible.elliscode.com` block into the Caddyfile that already owns port 443 on this Mac. Only one Caddy can listen on 443.
   - Add an `A` record for `audible.elliscode.com` pointing at the home public IP. The router already forwards TCP 443 to this Mac for the other sites.
6. **On the phone,** open `https://audible.elliscode.com` from home Wi-Fi and enter the code from the server log.

### Starting everything automatically

`./scripts/install-autostart.sh` registers Chrome, the server and Caddy as launchd agents that restart if they exit. Logs go to `logs/`, and login codes appear in `logs/server.log` (`tail -f logs/server.log`).
- `NO_CADDY=1 ./scripts/install-autostart.sh` leaves Caddy out, for when the shared Caddy already serves this site.
- `--uninstall` removes them.
- **Needs:**
  - Automatic login (System Settings → Users & Groups).
  - The Mac never sleeping (System Settings → Energy, or `sudo pmset -a sleep 0`).
- **Microphone permission** for capture started by launchd: if `logs/server.log` shows the capture failing, or the stream is silent, check System Settings → Privacy & Security → Microphone. Allow the entry for `node` or `audio-capture`, or run `npm start` from Terminal once to trigger the prompt.

## Login

This is the same scheme as android-on-kaios (`server/auth.js`):
- **The code:** each page load without a session prints a new 8-digit code in the server log: `[login] code 12345678 for 192.168.0.57 (home)`.
- **Home only:** codes are only issued, and only accepted, from the home network. That means private LAN addresses, or the home's own public IP, which is whatever `audible.elliscode.com` resolves to.
- **Attempt limit:** 2 attempts per rolling hour, and one guess per code.
- **After login:** a 128-character session cookie plus a 128-character CSRF token. Both last 4 months and work from anywhere, cellular included.
- **The audio stream** can't send the CSRF header, because `<audio>` makes its own request. Instead the page gets a single-use ticket that expires in 30 s (`POST /api/stream-ticket`), and the stream needs that ticket **and** the session cookie.
- **To log everyone out:** `node server/auth.js --revoke-all`, then restart the server.

If the router can't loop the public address back (the site doesn't open from home Wi-Fi), use the commented LAN block in `Caddyfile`.

## API

All endpoints except `GET /`, `GET /login.js` and `POST /login` need the session cookie. The `/api/*` endpoints also need the `X-CSRF-Token` header.

| Endpoint | Description |
| --- | --- |
| `POST /login {code}` | Exchanges the current code for a session (home network only; 2 per hour) |
| `POST /api/stream-ticket` | `{ticket}`, single use, valid 30 s |
| `GET /stream.mp3?ticket=` | Endless MP3 of whatever the Mac is playing |
| `GET /api/status` | `{browser, player, asin, playing, title, chapter, elapsed, remaining, bookLeft, mediaTime, mediaDuration, listeners}` |
| `POST /api/play`, `/api/pause`, `/api/toggle` | Presses Audible's play/pause button (play/pause only if needed) |
| `POST /api/seek {delta}` | Skips back (negative) or forward in 30 s steps |
| `GET /api/library[?refresh=1]` | `{fetchedAt, books: [{asin, title, author, left}]}`. Read from Audible's library page, kept 10 min |
| `POST /api/open {asin}` | Opens a library book in the player tab (resumes its position). Only ASINs from the library are accepted |

Control endpoints answer `204`, or `502 {error}` when Chrome or the player tab isn't open, or a button isn't found.

## Configuration

All settings are in [`server/config.js`](server/config.js), each with a comment. Edit it, restart the server, and reload the page on the phone. The main ones:

| Setting | Value | |
| --- | --- | --- |
| `BUFFER_SECONDS` | `4` | Seconds the phone buffers (with an on-screen countdown) before playing. `0` plays at once |
| `STATUS_POLL_SECONDS` | `60` | Seconds between the phone's status readings. In between, the phone counts the time itself while playing. It also reads after every action and at each chapter's end |
| `AUTO_PAUSE_SECONDS` | `60` | Pause Audible after it plays this long with no phone listening |
| `PLAYER_RELOAD_HOURS` / `PLAYER_MAX_HOURS` | `12` / `23` | Reload the player page once it's this old: while paused / even while playing |
| `AUDIO_DEVICE` / `AUDIO_BITRATE` | `BlackHole 2ch` / `64k` | Capture device and MP3 bitrate (mono) |
| `HOST` / `PORT` | `127.0.0.1` / `8090` | Server address (Caddy forwards to it) |
| `PUBLIC_HOST` | `audible.elliscode.com` | Its IP counts as "home" for login |
| `AUTH` | `on` | `off` disables login; only allowed with `HOST` `127.0.0.1` |

For a one-off test, an environment variable with a setting's name overrides it, e.g. `AUTH=off npm start`.

## Not done yet

- Not yet tested whether the KaiOS browser keeps playing with the screen off or the browser in the background. If not, package the client as a KaiOS app.
- Ogg/Opus instead of MP3, for lower bandwidth. New listeners would need the Ogg header pages replayed, so it isn't a one-line switch.
