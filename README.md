<div align="center">

<img src="logo.png" alt="AirComic Logo" width="160" height="160" />

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="title-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="title-light.png">
  <img alt="AirComic" src="title.png" height="54">
</picture>

### Multi-User Comic Strip Chat Client
*Decentralized P2P • End-to-End Encrypted • Microsoft Comic Chat Modernized*

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
- **View Mode Switcher**: Seamlessly switch between the dynamic Comic Strip view and classic transcript text view with smooth auto-scrolling and high-DPI scaling.
- **Light Mode by Default**: Modern clean theme with light mode default and dark mode support.

---

## 🔒 Security & Peer-to-Peer Encryption

- **P2P Mesh WebRTC (Trystero)**: Ephemeral decentralized networking over WebRTC with Nostr/BitTorrent relay signaling.
- **Dual Cryptographic Keypair Architecture**:
  - **RSA-OAEP 2048-bit**: Asymmetric public-key encryption for AES-256-GCM conversation keys.
  - **ECDSA P-256**: Digital signatures for authenticating identity hellos, rekeys, join requests, and room actions.
- **Channel Governance & Rekeying**:
  - Entry requests are gossiped to every member, so the prompt appears for all of them; whoever accepts first rekeys the room and clears the prompt everywhere else.
  - Direct room invitations: invite a friend and they get a "would you like to join" prompt instead of a link. Accepting runs the normal join handshake, auto-approved by the inviter. Invitations for offline friends are held in IndexedDB and delivered when they next appear online.
  - Group participant removal with instant rekey exclusion.
- **Presence & Gossip Mesh**:
  - Friends directory shows who is currently online, driven by low-rate replaceable Nostr announcements rather than per-peer heartbeats.
  - Signed hellos, control packets and messages are relayed peer-to-peer with packet-id de-duplication, so a room stays consistent even when some peer pairs cannot form a direct WebRTC link.
  - Newly joined peers back-fill recent history from whichever peers they can reach.
- **IndexedDB Persistence**: Local storage for user profiles, keypairs, friends directory, and conversation logs.

---

## 📱 Install as an App (PWA)

AirComic ships as an installable PWA. Launched from its icon it opens standalone -- no address bar, no browser toolbar -- respects display cutouts and the software keyboard, and starts from cache even with no connection.

- **Android / Chromium**: use **Install App...** in the AirComic menu, or the browser's own install action.
- **iPhone / iPad**: in Safari, tap **Share → Add to Home Screen**. (Safari has no install prompt; the in-app dialog spells out the steps.)
- **Desktop Chrome/Edge**: same **Install App...** menu item, which opens AirComic in its own window.

The install option hides itself once you are already running the installed app.

Offline means *the app starts*, not *chat works*: AirComic is peer-to-peer, so with no network there are no peers. The status dot in the toolbar distinguishes the two -- red for no network connection, amber for a network but no relay mesh, green for connected (with the peer count).

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
