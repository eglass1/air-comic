import { describe, it, expect } from 'vitest';
import { isValidRelayUrl, normalizeRelayUrls } from '../relayConfig';

describe('relay url handling -- [U-03][T-01]', () => {
  it('accepts wss and rejects everything else', () => {
    expect(isValidRelayUrl('wss://relay.damus.io')).toBe(true);
    expect(isValidRelayUrl('ws://insecure.example')).toBe(false);
    expect(isValidRelayUrl('https://not-a-relay.example')).toBe(false);
    expect(isValidRelayUrl('javascript:alert(1)')).toBe(false);
    expect(isValidRelayUrl('')).toBe(false);
  });

  it('deduplicates, trims and strips trailing slashes', () => {
    expect(
      normalizeRelayUrls([' wss://a.example/ ', 'wss://a.example', 'wss://b.example', 'nope'])
    ).toEqual(['wss://a.example', 'wss://b.example']);
  });
});
