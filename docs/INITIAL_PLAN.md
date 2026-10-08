# Audible Flip Phone — Project Handoff

## Goal

Build `audible.elliscode.com`, a personal Audible playback bridge running entirely on my home Mac Mini.

The purpose is to let me use Audible on a KaiOS flip phone that cannot natively run Audible.

The Mac Mini does the heavy lifting:

- Runs a normal Audible web session
- I log into Audible normally
- Audible handles my library, playback, resume position, chapters, etc.
- The Mac captures the audio produced by the Audible browser
- The Mac streams that audio to my KaiOS phone
- The phone acts as a thin client / remote speaker

This is for my personal use only. It should not download, decrypt, extract, or redistribute Audible content. Do not attempt to bypass DRM.

---

# Existing Environment

I already run several personal services from a Mac Mini, including:

- `iphone.elliscode.com`
- `kalshi.elliscode.com`

The Mac Mini is the server. I am comfortable with Python, Node, AWS, Docker, etc., but this project should **not use AWS/cloud infrastructure**.

The service should run locally on the Mac Mini.

The flip phone is KaiOS and has a small screen, so the client should be extremely lightweight.

---

# Core Idea

I don't want to recreate Audible's library.

Instead, let Audible's own website do all of that.

The Mac should run Chromium with Audible open at a fixed viewport, approximately:

`960 x 1104`

I should be able to interact with Audible normally:

1. Open Audible
2. See my library
3. Select an audiobook
4. Audible resumes where I left off
5. Select chapters
6. Start playback
7. The Mac captures whatever audio Audible is producing

The bridge doesn't need to understand the audiobook initially.

If Audible is playing audio, the bridge streams that audio to the flip phone.

Conceptually:

```text
                 Mac Mini
        ┌─────────────────────────┐
        │ Chromium                │
        │                         │
        │ Audible.com             │
        │                         │
        │ Library                 │
        │ Audiobook               │
        │ Chapters                │
        │ Playback                │
        └───────────┬─────────────┘
                    │
                    ▼
             Audio output
                    │
                    ▼
          Virtual audio device
                    │
                    ▼
             Audio capture
                    │
                    ▼
              Audio encoder
                    │
                    ▼
          audible.elliscode.com
                    │
                    ▼
              KaiOS phone
```

---

# Recommended Initial Stack

Use:

- Python
- FastAPI
- Chromium
- Playwright if useful for launching/managing the browser
- SQLite only if/when playback state needs to be tracked
- A macOS virtual audio device such as BlackHole
- Vanilla HTML/CSS/JS for the KaiOS client

Do NOT use React/Next/etc. for the phone UI.

Keep the client extremely lightweight.

---

# Important Architectural Principle

**Do not reverse engineer Audible's player or extract Audible's underlying media stream.**

The desired boundary is:

```text
Audible browser
      ↓
normal decoded audio output
      ↓
macOS audio routing
      ↓
our audio capture
      ↓
our network stream
      ↓
KaiOS
```

We are effectively making the Mac Mini a remote Audible player.

The Mac's Audible browser is the Audible client.

The KaiOS phone is just the remote audio endpoint.

---

# Phase 1 — Prove Audio Capture

Before building the web application, prove this works:

```text
Chrome playing Audible
        ↓
BlackHole / virtual audio device
        ↓
Python
        ↓
captured PCM/audio
```

The first milestone should simply be:

> I can play Audible on the Mac and capture the resulting browser/system audio in Python.

Do not worry about KaiOS yet.

Investigate the best way to capture audio on macOS without interfering with the normal Audible playback.

---

# Phase 2 — Stream Audio Locally

Once audio capture works:

```text
Audible
   ↓
BlackHole
   ↓
Python
   ↓
encoder
   ↓
localhost
   ↓
browser
```

Build a trivial test webpage on the Mac that can listen to the captured stream.

Prefer a codec/format that KaiOS handles reliably.

MP3 is a reasonable initial compatibility target, but investigate whether Opus/AAC would provide a better result if KaiOS supports it reliably.

The priority is:

1. Reliable playback
2. Low latency
3. Low CPU usage
4. Low bandwidth

---

# Phase 3 — KaiOS Client

Create a minimal mobile webpage.

Example:

```text
AUDIBLE
────────────────

CONNECTED

Currently playing:
Count of Monte Cristo

16:42:31

[ PLAY / PAUSE ]

[ << 30 ] [ 30 >> ]

[ VOL- ] [ VOL+ ]
```

The first version can be even simpler:

```text
[ CONNECT ]

[ PLAY ]
[ PAUSE ]
```

The phone should receive the audio stream and play it through the phone's speaker/headphones.

Design for KaiOS's small screen and limited browser capabilities.

No unnecessary JavaScript libraries.

---

# Phase 4 — Remote Controls

Once audio streaming is reliable, add remote controls.

Potential API:

```text
POST /api/play
POST /api/pause
POST /api/seek

POST /api/volume

GET /api/status
```

The phone should be able to control the Audible browser session on the Mac.

There are two possible approaches:

### Preferred initial approach

Use Playwright/browser automation to interact with Audible's actual controls.

For example:

```text
Phone → POST /api/play
              ↓
          Mac server
              ↓
          Playwright
              ↓
        Audible Play button
```

Similarly:

```text
Phone → POST /api/seek
              ↓
          Playwright
              ↓
        Audible seek control
```

Do not attempt to recreate Audible's playback engine.

---

# Phase 5 — Browser Automation

Run Chromium with a persistent profile.

Something conceptually like:

```text
~/audible-browser-profile/
```

I should manually log into Audible.

The application should NOT store my Audible password.

The persistent Chromium profile should retain the authenticated session/cookies.

The application can launch the browser automatically and navigate to Audible.

Potential browser size:

```text
960 x 1104
```

The goal is that I can visually interact with Audible if necessary.

Eventually the Mac Mini could simply boot and have Audible ready to go.

---

# Phase 6 — Phone "Library" / Status

Only after the basic system works should we consider exposing information to the phone.

Possible status:

```text
Currently Playing

The Count of Monte Cristo

Chapter 45

16:42:31 / 32:39:00
```

Potentially the Mac could inspect the Audible page to determine:

- Current title
- Current chapter
- Current playback position
- Duration
- Playing/paused state

But this is secondary.

The first goal is:

> Whatever Audible is playing on the Mac should be audible on the flip phone.

---

# Security

This is a personal service.

It should NOT be publicly accessible.

Initially bind the server to the LAN only.

If a reverse proxy is used, it should still only be reachable from my home network.

Do not expose Audible credentials or session cookies through the API.

Do not create public audiobook sharing functionality.

---

# Suggested Project Structure

Something approximately like:

```text
audible/
├── server/
│   ├── main.py
│   ├── audio.py
│   ├── browser.py
│   └── api.py
│
├── client/
│   ├── index.html
│   ├── app.js
│   └── style.css
│
├── scripts/
│   ├── start_browser.py
│   └── test_audio.py
│
├── requirements.txt
└── README.md
```

This can change if a better structure emerges.

---

# Most Important MVP

Do NOT start by building the complete system.

Build this in tiny milestones:

### Milestone 1

```text
Audible → Mac speakers
```

already works normally.

### Milestone 2

```text
Audible → BlackHole → Python
```

Python successfully captures audio.

### Milestone 3

```text
Audible → BlackHole → Python → localhost stream → browser
```

A second browser window can listen to the captured audio.

### Milestone 4

```text
Audible → Mac → network → KaiOS
```

Flip phone can listen.

### Milestone 5

Phone can:

- Play
- Pause
- Seek ±30 seconds

### Milestone 6

Phone can show:

- Current audiobook
- Chapter
- Position
- Duration

### Milestone 7

Make it polished and persistent.

---

# Key Design Philosophy

This project should be a **thin bridge around Audible**, not a replacement for Audible.

Audible already knows:

- what books I own
- where I left off
- chapters
- metadata
- playback
- bookmarks
- account state

Let Audible do all of that.

The Mac Mini simply provides the missing capability:

**"My KaiOS phone needs to hear what Audible is playing on my computer."**

That's the entire point of the project.