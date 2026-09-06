/**
 * Relay selection -- implementation plan [U-03], required to be
 * user-configurable by [T-01].
 *
 * The shipped default is the same five well-known relays v2 preferred. v2's
 * trystero fallback slice is gone: WebRTC signalling now derives its own relay
 * set from this list, and the pool is no longer shared with Trystero [L-15].
 */

import { db } from './db';

export const DEFAULT_RELAY_URLS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplerelay.com',
  'wss://relay.snort.social',
];

let cached: string[] | null = null;
let webrtcEnabledCache: boolean | null = null;

export function isValidRelayUrl(url: string): boolean {
  return /^wss:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());
}

export function normalizeRelayUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = raw.trim().replace(/\/+$/, '');
    if (!isValidRelayUrl(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export async function loadSettings(): Promise<{ relayUrls: string[]; webrtcEnabled: boolean }> {
  const stored = await db.getSettings();
  const relayUrls =
    stored?.relayUrls && stored.relayUrls.length > 0
      ? normalizeRelayUrls(stored.relayUrls)
      : [...DEFAULT_RELAY_URLS];
  const webrtcEnabled = stored?.webrtcEnabled ?? true;
  cached = relayUrls;
  webrtcEnabledCache = webrtcEnabled;
  return { relayUrls, webrtcEnabled };
}

export function getRelayUrls(): string[] {
  return cached ?? [...DEFAULT_RELAY_URLS];
}

export function getWebrtcEnabled(): boolean {
  return webrtcEnabledCache ?? true;
}

export async function saveRelayUrls(urls: string[]): Promise<string[]> {
  const normalized = normalizeRelayUrls(urls);
  const relayUrls = normalized.length > 0 ? normalized : [...DEFAULT_RELAY_URLS];
  cached = relayUrls;
  await db.saveSettings({
    relayUrls,
    webrtcEnabled: getWebrtcEnabled(),
    storageMode: 'convenience',
  });
  return relayUrls;
}

export async function saveWebrtcEnabled(enabled: boolean): Promise<void> {
  webrtcEnabledCache = enabled;
  await db.saveSettings({
    relayUrls: getRelayUrls(),
    webrtcEnabled: enabled,
    storageMode: 'convenience',
  });
}

/**
 * Merges signed relay suggestions from a public room descriptor with the user's
 * own list [A-06]. A descriptor can add, never remove or downgrade: insecure
 * endpoints are dropped and the user's relays always come first [T-01].
 */
export function mergeSuggestedRelays(suggested: string[] | undefined): string[] {
  const mine = getRelayUrls();
  if (!suggested?.length) return mine;
  const extra = normalizeRelayUrls(suggested).filter((u) => !mine.includes(u));
  return [...mine, ...extra.slice(0, 3)];
}
