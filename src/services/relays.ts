import { defaultRelayUrls } from 'trystero/nostr';

/**
 * Well-known, high-availability Nostr relays. Trystero's own default list is
 * long and skews towards small community relays, and it slices that list down
 * per room — so two clients can easily end up with no *working* relay in common
 * and never exchange WebRTC offers, which shows up as peers that join a room but
 * never see each other. Pinning an explicit list gives every client the same
 * rendezvous points.
 */
const PREFERRED_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplerelay.com',
  'wss://relay.snort.social',
];

/** Fixed slice of Trystero's defaults, kept as breadth behind the preferred set. */
const FALLBACK_RELAYS = defaultRelayUrls.slice(0, 6);

const ALL_RELAYS = Array.from(new Set([...PREFERRED_RELAYS, ...FALLBACK_RELAYS]));

/** Relays used for WebRTC signalling. Identical for every client, by design. */
export const SIGNALING_RELAY_URLS = ALL_RELAYS.slice(0, 10);

/** Relays used for the public room directory and presence announcements. */
export const DIRECTORY_RELAY_URLS = ALL_RELAYS.slice(0, 8);
