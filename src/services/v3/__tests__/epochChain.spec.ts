import { describe, it, expect, beforeEach } from 'vitest';
import {
  adoptGenesis,
  applyCapabilityRotation,
  applyRekey,
  chainHead,
  createChainState,
  currentMembers,
  deserializeChain,
  isMember,
  serializeChain,
  type ChainState,
} from '../epochChain';
import { MAX_PRIVATE_MEMBERS_HARD } from '../constants';
import type { CapabilityRotationPacket, RekeyPacket, RoomGenesisPacket } from '../types';

const CONV = 'conv-1';
const ALICE = 'alice';
const BOB = 'bob';
const CAROL = 'carol';

const genesis = {
  type: 'room_genesis',
  convId: CONV,
  packetId: 'gen-1',
  creatorId: ALICE,
} as RoomGenesisPacket;

function rekey(over: Partial<RekeyPacket>): RekeyPacket {
  const members = over.members ?? [ALICE];
  return {
    type: 'key',
    convId: CONV,
    packetId: 'pkt-' + Math.random().toString(36).slice(2, 8),
    keyId: 'epoch-x',
    epoch: 1,
    parentPacketId: 'gen-1',
    parentKeyId: 'root-v3',
    action: 'genesis_epoch',
    signerId: ALICE,
    timestamp: Date.now(),
    members,
    keys: Object.fromEntries(members.map((m) => [m, 'wrapped'])),
    ...over,
  } as RekeyPacket;
}

let state: ChainState;

function openChain(): RekeyPacket {
  const e1 = rekey({ packetId: 'e1', keyId: 'k1', epoch: 1, action: 'genesis_epoch' });
  expect(applyRekey(state, e1).accepted).toBe(true);
  return e1;
}

beforeEach(() => {
  state = createChainState(CONV);
  adoptGenesis(state, genesis);
});

describe('genesis', () => {
  it('refuses transitions before genesis is known', () => {
    const fresh = createChainState(CONV);
    expect(applyRekey(fresh, rekey({})).reason).toBe('no_genesis');
  });

  it('only the creator may open the chain -- clause (d)', () => {
    const bad = rekey({ signerId: BOB, members: [BOB], packetId: 'e1' });
    expect(applyRekey(state, bad).reason).toBe('signer_not_member');
  });

  it('epoch 1 must contain only the creator', () => {
    const bad = rekey({ members: [ALICE, BOB], packetId: 'e1' });
    expect(applyRekey(state, bad).reason).toBe('illegal_member_delta');
  });

  it('epoch 1 must be numbered 1', () => {
    expect(applyRekey(state, rekey({ epoch: 5, packetId: 'e1' })).reason).toBe('bad_epoch');
  });

  it('accepts a well-formed genesis epoch', () => {
    const r = applyRekey(state, rekey({ packetId: 'e1', keyId: 'k1' }));
    expect(r.accepted && r.isCanonicalHead).toBe(true);
    expect(currentMembers(state)).toEqual([ALICE]);
  });
});

describe('transition rules -- [X-07] clauses (b)-(h)', () => {
  beforeEach(() => openChain());

  it('(b) rejects an unknown parent', () => {
    const orphan = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'nope', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    expect(applyRekey(state, orphan).reason).toBe('unknown_parent');
  });

  it('(b) rejects a parent whose keyId does not match', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'WRONG',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    expect(applyRekey(state, bad).reason).toBe('unknown_parent');
  });

  it('(c) rejects a skipped epoch', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 7, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    expect(applyRekey(state, bad).reason).toBe('bad_epoch');
  });

  it('(d) rejects a signer who was not in the parent epoch -- closes v2 [O-04]', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1', signerId: CAROL,
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    expect(applyRekey(state, bad).reason).toBe('signer_not_member');
  });

  it('(e) an add must change membership by exactly the target', () => {
    const sneaky = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB, CAROL],
    });
    expect(applyRekey(state, sneaky).reason).toBe('illegal_member_delta');
  });

  it('(e) a rekey must not change membership at all', () => {
    const sneaky = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'rekey',
      parentPacketId: 'e1', parentKeyId: 'k1', members: [ALICE, BOB],
    });
    expect(applyRekey(state, sneaky).reason).toBe('illegal_member_delta');
  });

  it('(e) a remove must drop exactly the target', () => {
    const add = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    applyRekey(state, add);
    const bad = rekey({
      packetId: 'e3', keyId: 'k3', epoch: 3, action: 'remove',
      parentPacketId: 'e2', parentKeyId: 'k2',
      targetParticipantId: BOB, members: [CAROL],
    });
    expect(applyRekey(state, bad).reason).toBe('illegal_member_delta');
  });

  it('(f) rejects duplicates in the member list', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB, BOB],
    });
    expect(applyRekey(state, bad).reason).toBe('duplicate_members');
  });

  it('(g) rejects a member with no wrapped key slot', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    delete bad.keys[BOB];
    expect(applyRekey(state, bad).reason).toBe('missing_key_slot');
  });

  it('(g) rejects a key slot for a non-member', () => {
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
    bad.keys[CAROL] = 'wrapped';
    expect(applyRekey(state, bad).reason).toBe('extra_key_slot');
  });

  it('(h) reshare does not advance the epoch and needs an existing member', () => {
    const ok = rekey({
      packetId: 'e2', keyId: 'k1', epoch: 1, action: 'reshare',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: ALICE, members: [ALICE],
    });
    const r = applyRekey(state, ok);
    expect(r.accepted).toBe(true);
    expect(r.isCanonicalHead).toBe(false);
    expect(chainHead(state)!.packetId).toBe('e1');

    const bad = rekey({
      packetId: 'e3', keyId: 'k1', epoch: 1, action: 'reshare',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: CAROL, members: [ALICE],
    });
    expect(applyRekey(state, bad).reason).toBe('reshare_not_member');
  });
});

describe('membership size -- [L-17] soft limit, hard structural bound', () => {
  it('accepts a 21st member: 20 is a WebRTC threshold, not a cap', () => {
    openChain();
    let parent = { id: 'e1', key: 'k1', epoch: 1 };
    let members = [ALICE];
    for (let i = 0; i < 25; i++) {
      const target = `member-${i}`;
      members = [...members, target];
      const packet = rekey({
        packetId: `e${i + 2}`, keyId: `k${i + 2}`, epoch: parent.epoch + 1,
        action: 'add', parentPacketId: parent.id, parentKeyId: parent.key,
        targetParticipantId: target, members,
      });
      const r = applyRekey(state, packet);
      expect(r.accepted).toBe(true);
      parent = { id: packet.packetId, key: packet.keyId, epoch: packet.epoch };
    }
    expect(currentMembers(state).length).toBe(26);
  });

  it('rejects membership beyond the structural bound of 128', () => {
    openChain();
    const tooMany = Array.from({ length: MAX_PRIVATE_MEMBERS_HARD + 1 }, (_, i) => `m${i}`);
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'rekey',
      parentPacketId: 'e1', parentKeyId: 'k1', members: tooMany,
    });
    expect(applyRekey(state, bad).reason).toBe('member_bounds');
  });

  it('rejects an empty member list', () => {
    openChain();
    const bad = rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'rekey',
      parentPacketId: 'e1', parentKeyId: 'k1', members: [],
    });
    expect(applyRekey(state, bad).reason).toBe('member_bounds');
  });
});

describe('fork resolution -- [PR-05]', () => {
  beforeEach(() => openChain());

  function sibling(packetId: string) {
    return rekey({
      packetId, keyId: 'k-' + packetId, epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    });
  }

  it('the greatest packetId wins, whichever order they arrive in', () => {
    applyRekey(state, sibling('aaa'));
    const second = applyRekey(state, sibling('zzz'));
    expect(second.isCanonicalHead).toBe(true);
    expect(chainHead(state)!.packetId).toBe('zzz');

    const other = createChainState(CONV);
    adoptGenesis(other, genesis);
    applyRekey(other, rekey({ packetId: 'e1', keyId: 'k1', epoch: 1 }));
    applyRekey(other, sibling('zzz'));
    const loser = applyRekey(other, sibling('aaa'));
    expect(loser.accepted).toBe(true);
    expect(loser.isFork).toBe(true);
    expect(chainHead(other)!.packetId).toBe('zzz');
  });

  it('retains the losing branch for audit', () => {
    applyRekey(state, sibling('aaa'));
    applyRekey(state, sibling('zzz'));
    expect(state.forks.map((f) => f.packetId)).toContain('aaa');
  });

  it('is idempotent when the same packet arrives twice', () => {
    const packet = sibling('aaa');
    applyRekey(state, packet);
    const again = applyRekey(state, packet);
    expect(again.accepted).toBe(true);
    expect(state.nodes.size).toBe(2);
  });
});

describe('capability rotation -- [X-08]', () => {
  function rotation(over: Partial<CapabilityRotationPacket> = {}): CapabilityRotationPacket {
    const members = over.members ?? [ALICE];
    return {
      type: 'capability_rotation',
      convId: CONV,
      packetId: 'rot-1',
      generation: 1,
      newEpoch: 3,
      newKeyId: 'k3',
      parentPacketId: 'e2',
      parentKeyId: 'k2',
      removedParticipantId: BOB,
      members,
      wrapped: Object.fromEntries(members.map((m) => [m, 'sealed'])),
      signerId: ALICE,
      timestamp: Date.now(),
      ...over,
    } as CapabilityRotationPacket;
  }

  beforeEach(() => {
    openChain();
    applyRekey(state, rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    }));
  });

  it('removes exactly the target and advances the chain', () => {
    const r = applyCapabilityRotation(state, rotation());
    expect(r.accepted && r.isCanonicalHead).toBe(true);
    expect(isMember(state, BOB)).toBe(false);
    expect(isMember(state, ALICE)).toBe(true);
  });

  it('rejects a rotation that removes more than the target', () => {
    const bad = rotation({ members: [], removedParticipantId: BOB });
    expect(applyCapabilityRotation(state, bad).reason).toBe('member_bounds');
  });

  it('rejects a rotation signed by a non-member', () => {
    expect(applyCapabilityRotation(state, rotation({ signerId: CAROL })).reason).toBe(
      'signer_not_member'
    );
  });

  it('rejects a rotation with no slot for a remaining member', () => {
    const bad = rotation();
    delete bad.wrapped[ALICE];
    expect(applyCapabilityRotation(state, bad).reason).toBe('missing_key_slot');
  });
});

describe('persistence', () => {
  it('survives a serialize/deserialize round trip', () => {
    openChain();
    applyRekey(state, rekey({
      packetId: 'e2', keyId: 'k2', epoch: 2, action: 'add',
      parentPacketId: 'e1', parentKeyId: 'k1',
      targetParticipantId: BOB, members: [ALICE, BOB],
    }));
    const restored = deserializeChain(JSON.parse(JSON.stringify(serializeChain(state))));
    expect(chainHead(restored)!.packetId).toBe('e2');
    expect(currentMembers(restored)).toEqual([ALICE, BOB]);
    expect(restored.genesis!.creatorId).toBe(ALICE);
  });
});
