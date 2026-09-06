/**
 * Live relay probe. Skipped unless LIVE_RELAY=1, because it talks to real
 * public relays and [G-02] warns against hammering them.
 *
 *   LIVE_RELAY=1 npx vitest run src/services/nostr/__tests__/relayProbe.spec.ts
 *
 * This is the phase-2 gate for risk [G-01]: whether public relays will accept
 * one NIP-33 parameterized-replaceable event per packet with a unique `d` tag.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { RelayPool } from '../relayPool';
import { buildNostrEvent, roomPacketTags, verifyNostrEvent } from '../nostrEvent';
import { deriveScopedNostrSecretKey } from '../../v3/keys';
import { generateUserKeyPair } from '../../crypto';
import { DEFAULT_RELAY_URLS } from '../../v3/relayConfig';
import { NOSTR_KIND, T_ROOM_PACKET } from '../../v3/constants';

const live = process.env.LIVE_RELAY === '1';
const pool = new RelayPool();

afterAll(() => pool.close());

describe.skipIf(!live)('live relay behaviour', () => {
  it(
    'accepts unique-d room packets and returns them by routing tag -- [G-01]',
    async () => {
      pool.configure([...DEFAULT_RELAY_URLS, 'wss://this-relay-does-not-exist.invalid']);
      await new Promise((r) => setTimeout(r, 4000));

      const health = pool.getHealth();
      console.log('relay health:', health.map((h) => `${h.url} connected=${h.connected}`));
      expect(health.some((h) => h.connected)).toBe(true);

      const identity = await generateUserKeyPair();
      const routingTag = 'probe-' + crypto.randomUUID();
      const secretKey = await deriveScopedNostrSecretKey(
        identity.signingPrivateKeyJwk,
        routingTag
      );

      // Three distinct packets on one routing tag, each with its own `d` tag.
      const packetIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      const results = [];
      for (const packetId of packetIds) {
        const event = await buildNostrEvent({
          secretKey,
          tags: roomPacketTags({
            packetId,
            routingTag,
            roomMode: 'private',
            topic: T_ROOM_PACKET,
            expirationSec: 3600,
          }),
          content: JSON.stringify({ probe: true, packetId }),
        });
        expect(await verifyNostrEvent(event)).toBe(true);
        const result = await pool.publish(event);
        results.push(result);
        console.log(
          `publish ${packetId.slice(0, 8)}: accepted=${result.accepted.length}`,
          `rejected=${JSON.stringify(result.rejected)} failed=${result.failed.length}`
        );
      }

      // The bad URL must show up as a failure, never as an acceptance [O-12].
      for (const r of results) {
        expect(r.accepted).not.toContain('wss://this-relay-does-not-exist.invalid');
      }
      expect(results.every((r) => r.quorumMet)).toBe(true);

      // Read them all back by routing tag: this is what proves unique-d works.
      await new Promise((r) => setTimeout(r, 1500));
      const found = await pool.query(
        [{ kinds: [NOSTR_KIND], '#r': [routingTag] }],
        { timeoutMs: 8000 }
      );
      const foundIds = new Set(
        found.map((e) => e.tags.find((t) => t[0] === 'd')?.[1]).filter(Boolean)
      );
      console.log(`read back ${foundIds.size} of ${packetIds.length} packets`);
      for (const id of packetIds) expect(foundIds.has(id)).toBe(true);
    },
    60000
  );
});
