<div align="center">

<img src="logo.png" alt="AirComic Logo" width="160" height="160" />

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="title-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="title-light.png">
  <img alt="AirComic" src="title.png" height="54">
</picture>

### Multi-User Comic Strip Chat Client
*Relay-Backed • End-to-End Encrypted • Microsoft Comic Chat Modernized*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![Distribution](https://img.shields.io/badge/Distribution-Single--File%20HTML-0070f3.svg)](docs/index.html)

</div>

---

AirComic is a multi-user, peer-coordinated, end-to-end encrypted chat application built with **React**, **HTML5 Canvas**, and **Material Design (MUI)**. It recreates and modernizes the classic **Microsoft Comic Chat** engine, automatically generating dynamic comic strips with characters, speech/thought/whisper balloons, and emotional poses directly from conversation streams.

Everything gets bundled into a single `index.html` file that you can drop on any static web server and pull up in your browser. It also installs as a Progressive Web App, so it runs from a phone home screen in its own window. You can try it out here:

[https://eglass1.github.io/air-comic/](https://eglass1.github.io/air-comic/)


---

## 📜 History

This is a small, fun side project. I was experimenting with peer-to-peer web messaging and looking for something I could test drive Google Antigravity CLI with. I started out with "AirThread", just a regular text-based web chat thing, but saw that Microsoft Comic Chat was open sourced about a month ago, and figured I could incorporate that. Go check it out:

[https://microsoft.github.io/comic-chat/](https://microsoft.github.io/comic-chat/)

I used Antigravity to "port" the comic stuff in (really, reimplement as TypeScript based on source code examination); it took maybe half an hour to get a rough initial thing working, then a few hours of back-and-forth tweaking (correcting color mapping for the non-monochrome items, balloon placement etc.). I found a similar project (more faithful to the original) which provided a lot of guidance on accurate rendering:

[https://github.com/comicchat/comicchat](https://github.com/comicchat/comicchat)

---

## 🎨 Microsoft Comic Chat Features

- **Automated Comic Strip Generation**: Real-time generation of multi-panel comic book layouts with speech balloons, thought clouds, whisper dashes, and narrative action boxes (`/me`, `/think`, `/whisper`, `/shout`).
- **Authentic Artwork & Binary Parser**:
  - Full TypeScript parser for Microsoft Comic Chat `.avb` (Avatar Binary) and `.bgb` (Backdrop Binary) formats.
  - Decompresses zlib deflate streams (`pako`) and decodes 1-bit, 2-bit masked monochrome (with aura knockout halos), 4/8-bit paletted, and 24/32-bit DIB bitmaps.
  - Dynamically composites complex avatars (matching torso and facial expression deltas with origin offsets and layering flags) and simple avatars.
  - Includes all 31 original MS Comic Chat characters (Armando, Susan, Tux, Connor, Denise, Hugh, Jordan, Kirby, Lance, Lynnea, Mike, Tiki, Veronica, Xeno, etc.) and 9 backdrops.
- **Emotion Wheel & Live Pose Preview**:
  - Interactive 8-sector emotion wheel (Happy, Coy, Bored, Scared, Sad, Angry, Shout, Laugh) with variable intensity and neutral center.
  - Gesture quick-pick bar (Wave, Point at Other, Point at Self, Shrug).
  - Real-time facial expression and pose canvas preview as you adjust the wheel.
- **Natural Language Emotion Heuristics**: Automatic emotion detection based on text sentiment, smileys, exclamation marks, all-caps shouts, laughs, greetings, and pronouns.
- **Comic Strip Presentation**: Dynamic comic book layout with high-DPI canvas scaling, automatic speech balloons, thought clouds, and authentic visual narrative.
- **Light Mode by Default**: Modern clean theme with light mode default and dark mode support.

---

## 🔒 Security, Networking & Encryption

AirComic speaks **airthread/3**. Nostr relays are the authoritative transport for
every room; WebRTC is an optional accelerator, never a requirement.

- **Nostr-authoritative transport**: every message, membership change, room
  setting, invitation and presence record travels through a shared pool of Nostr
  relays. A room keeps working when no peer connection can be established at all.
  A send counts as delivered only when a quorum of relays actually acknowledges
  it, and pending sends are queued locally and retried across reloads.
- **Optional direct acceleration**: the foreground private room may also form a
  WebRTC mesh, which carries the byte-identical packet for lower latency. Its
  rendezvous is derived from the room secret, so a conversation id alone reveals
  nothing. If it fails, the room simply runs on relays. The status dot reports
  relay connectivity and direct acceleration separately -- "connected" never
  means "a peer was found".
- **Identity**: RSA-OAEP 2048 for key transport and ECDSA P-256 for signatures.
  Your identity is the SHA-256 of your signing key, so names are self-certifying;
  there is no account and no registry.
- **Private rooms**: content is end-to-end encrypted under a per-epoch AES-256-GCM
  key, wrapped individually to each member. Every message and control packet is
  signed, so one member cannot forge another's messages. Membership is a
  validated chain: each transition must name the epoch it descends from, be
  signed by a member of that epoch, and change the roster by exactly what it
  claims. Competing transitions resolve deterministically.
- **Removal actually removes**: removing someone rotates the room secret as well
  as the key, so the room moves to a routing tag the removed member cannot
  compute. The new capability is sealed to each remaining member and published
  where offline members will still find it.
- **Public rooms**: signed but **not encrypted**. Public means world-readable:
  anything said there is stored on public relays in the clear. They need no
  invitation or approval, are discoverable in the directory, and report
  approximate occupancy from short-lived pseudonymous beacons. Being *in* one is
  not private either: joining announces your name and avatar to that room, so the
  participant list shows everyone present rather than only those who have spoken.
  The directory's occupancy figure stays anonymous and separate from it.
- **Presence is opt-in**: contacts see each other only after exchanging a random
  presence capability. Removing a contact rotates it. Knowing someone's identity
  is not enough to track when they are online.
- **Room size**: private rooms have no member cap. Above 20 members direct
  acceleration stops being attempted and the room runs on relays alone.

### What this does not protect

End-to-end encryption covers content, not metadata. Relays can see your IP
address, when you are active, how much you send, and which per-room pseudonym you
publish under; WebRTC peers learn each other's network addresses. Keys, room
secrets and message history are stored unencrypted in the browser profile,
protected only by your operating-system account.

## 📱 Install as an App (PWA)

AirComic ships as an installable PWA. Launched from its icon it opens standalone -- no address bar, no browser toolbar -- respects display cutouts and the software keyboard, and starts from cache even with no connection.

- **Android / Chromium**: use **Install App...** in the AirComic menu, or the browser's own install action.
- **iPhone / iPad**: in Safari, tap **Share → Add to Home Screen**. (Safari has no install prompt; the in-app dialog spells out the steps.)
- **Desktop Chrome/Edge**: same **Install App...** menu item, which opens AirComic in its own window.

The install option hides itself once you are already running the installed app.

Offline means *the app starts*, not *chat works*: with no network there are no relays to reach. The status dot in the toolbar distinguishes the two -- red for no network connection, amber for a network but no relay, green for connected. Direct peer acceleration is reported separately, because it is an optimisation rather than a requirement.

When a new version is deployed, the running app keeps working from its cached build and offers a **Reload** prompt; nothing swaps out mid-conversation, and nobody is stranded on an old build.

## 📦 Building and Running

```bash
# Install dependencies
npm install

# Build standalone HTML bundle + PWA files (output: docs/)
npm run build

# Start development server
npm run dev

# Serve the real production output (needed to exercise the PWA)
npm run preview
```

The build writes to `docs/`, which is what GitHub Pages publishes:

```
docs/
├── index.html              the entire application, self-contained
├── manifest.webmanifest    name, icons, standalone display mode
├── sw.js                   app-shell cache, update flow, push handlers
└── icons/                  192/512 any + maskable, apple-touch-icon
```

`docs/index.html` remains a genuine single file: open it directly, e-mail it, or drop it on any static host and it runs as an ordinary web page. The companion files are what make it *installable* -- a manifest in a `data:` URL cannot declare a scope, and a service worker cannot be registered from one at all, so they are deliberately kept as separate same-origin files rather than inlined.

All paths are relative, so the same output works at a domain root or under a project subpath such as `/air-comic/`. PWA features need a secure context: `https://`, or `http://localhost` for testing. Opening `docs/index.html` over `file://` still runs the app, but registers no service worker and cannot be installed.

The icon set in `pwa/icons/` is generated from `logo.png` and committed, so a normal build needs no extra tooling. Regenerate it only when the logo changes:

```bash
python3 scripts/generate-icons.py   # requires Pillow
```
