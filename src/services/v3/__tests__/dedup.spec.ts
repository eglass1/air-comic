import { describe, it, expect } from 'vitest';
import { DedupLedger, dedupKey, type ProcessedPacket } from '../dedup';

function memoryStore() {
  const map = new Map<string, ProcessedPacket>();
  return {
    map,
    get: async (id: string) => map.get(id),
    put: async (r: ProcessedPacket) => void map.set(r.id, r),
  };
}

const base = {
  convId: 'c1',
  packetId: 'p1',
  contentHash: 'hash-a',
  senderId: 'alice',
  packetTimestamp: 1000,
  retentionClass: 'chat' as const,
};

describe('dedup ledger -- closes v2 [O-10]', () => {
  it('accepts a packet once', async () => {
    const led = new DedupLedger(memoryStore());
    expect(await led.check(base)).toBe('new');
    expect(await led.check(base)).toBe('duplicate');
  });

  it('flags a collision when the same id carries different bytes -- [D-02]', async () => {
    const led = new DedupLedger(memoryStore());
    expect(await led.check(base)).toBe('new');
    expect(await led.check({ ...base, contentHash: 'hash-b' })).toBe('collision');
    expect(led.collisions).toBe(1);
  });

  it('keeps the first packet after a collision', async () => {
    const store = memoryStore();
    const led = new DedupLedger(store);
    await led.check(base);
    await led.check({ ...base, contentHash: 'hash-b', senderId: 'mallory' });
    expect(store.map.get(dedupKey('c1', 'p1'))!.senderId).toBe('alice');
  });

  it('scopes ids by conversation', async () => {
    const led = new DedupLedger(memoryStore());
    await led.check(base);
    expect(await led.check({ ...base, convId: 'c2' })).toBe('new');
  });

  it('survives eviction from the in-memory window via the store -- [O-10]', async () => {
    const store = memoryStore();
    const led = new DedupLedger(store);
    await led.check(base);
    // Push far more than the in-memory LRU holds.
    for (let i = 0; i < 5000; i++) {
      await led.check({ ...base, packetId: `filler-${i}`, contentHash: `h${i}` });
    }
    // v2's FIFO ledger would have forgotten this and re-accepted the replay.
    expect(await led.check(base)).toBe('duplicate');
  });

  it('claims locally sent packets so the echo is a duplicate', async () => {
    const led = new DedupLedger(memoryStore());
    await led.claim(base);
    expect(await led.check(base)).toBe('duplicate');
  });

  it('reports membership and forgets a cleared conversation', async () => {
    const led = new DedupLedger(null);
    await led.check(base);
    expect(await led.has('c1', 'p1')).toBe(true);
    led.forgetConversation('c1');
    expect(await led.has('c1', 'p1')).toBe(false);
  });

  it('works with no persistent store', async () => {
    const led = new DedupLedger(null);
    expect(await led.check(base)).toBe('new');
    expect(await led.check(base)).toBe('duplicate');
  });
});
