/**
 * Filter construction and batching -- implementation plan [X-09], [T-08].
 *
 * Routing tags are combined into as few REQ filters as relay limits allow, and
 * split into bounded batches otherwise.
 */

import { NOSTR_KIND, SUBSCRIPTION_OVERLAP_MS } from '../v3/constants';
import type { NostrFilter } from './nostrEvent';

/** Conservative ceiling on values in one tag filter; relays vary. */
const MAX_TAG_VALUES_PER_FILTER = 40;

export function batch<T>(items: T[], size = MAX_TAG_VALUES_PER_FILTER): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Live room traffic, filtered by routing tag. */
export function roomFilters(routingTags: string[], sinceMs?: number): NostrFilter[] {
  if (routingTags.length === 0) return [];
  const since =
    sinceMs !== undefined
      ? Math.floor(Math.max(0, sinceMs - SUBSCRIPTION_OVERLAP_MS) / 1000)
      : undefined;
  return batch(routingTags).map((chunk) => ({
    kinds: [NOSTR_KIND],
    '#r': chunk,
    ...(since !== undefined ? { since } : {}),
  }));
}

/** Replaceable records addressed by their stable `d` tag. */
export function dTagFilters(dTags: string[], limit?: number): NostrFilter[] {
  if (dTags.length === 0) return [];
  return batch(dTags).map((chunk) => ({
    kinds: [NOSTR_KIND],
    '#d': chunk,
    ...(limit !== undefined ? { limit } : {}),
  }));
}

/** Topic-wide query, used by the public directory. */
export function topicFilters(topic: string, limit = 150): NostrFilter[] {
  return [{ kinds: [NOSTR_KIND], '#t': [topic], limit }];
}

/** Targeted recovery of individual packets by packetId [H-02]. */
export function packetIdFilters(packetIds: string[]): NostrFilter[] {
  return dTagFilters(packetIds);
}

/** Paginates backwards through a room's history [H-01]. */
export function historyFilters(
  routingTag: string,
  untilMs: number,
  limit = 200
): NostrFilter[] {
  return [
    {
      kinds: [NOSTR_KIND],
      '#r': [routingTag],
      until: Math.floor(untilMs / 1000),
      limit,
    },
  ];
}
