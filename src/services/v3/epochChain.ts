/**
 * Membership epoch chain -- implementation plan [X-07], closing v2 [O-04].
 *
 * v2 recorded parentKeyId and epoch but validated neither: any member could
 * rewrite the roster arbitrarily and a stale rekey could be replayed by anyone
 * holding the root key. v3 validates every transition against a locally
 * validated parent and resolves forks deterministically.
 */

import { MAX_PRIVATE_MEMBERS_HARD } from './constants';
import type { CapabilityRotationPacket, RekeyPacket, RoomGenesisPacket } from './types';

export interface EpochNode {
  packetId: string;
  keyId: string;
  epoch: number;
  parentPacketId: string;
  parentKeyId: string;
  members: string[];
  signerId: string;
  timestamp: number;
  action: RekeyPacket['action'] | 'capability_rotation';
}

export interface ChainState {
  convId: string;
  genesis: { packetId: string; creatorId: string } | null;
  /** packetId -> validated node. */
  nodes: Map<string, EpochNode>;
  /** The canonical head packetId, or null before genesis+epoch 1 are known. */
  headPacketId: string | null;
  /** Valid transitions that lost a fork race; retained for audit [PR-05]. */
  forks: EpochNode[];
}

export function createChainState(convId: string): ChainState {
  return { convId, genesis: null, nodes: new Map(), headPacketId: null, forks: [] };
}

export function chainHead(state: ChainState): EpochNode | null {
  return state.headPacketId ? state.nodes.get(state.headPacketId) ?? null : null;
}

export function currentMembers(state: ChainState): string[] {
  return chainHead(state)?.members ?? [];
}

export function isMember(state: ChainState, participantId: string): boolean {
  return currentMembers(state).includes(participantId);
}

/**
 * Membership as it stood at a given time, for authorization checks on packets
 * that arrive out of order [M-02].
 */
export function membersAt(state: ChainState, timestamp: number): string[] {
  let best: EpochNode | null = null;
  for (const node of state.nodes.values()) {
    if (node.timestamp <= timestamp && (!best || node.epoch > best.epoch)) best = node;
  }
  return best ? best.members : currentMembers(state);
}

export type ChainRejection =
  | 'no_genesis'
  | 'unknown_parent'
  | 'bad_epoch'
  | 'signer_not_member'
  | 'illegal_member_delta'
  | 'member_bounds'
  | 'missing_key_slot'
  | 'extra_key_slot'
  | 'duplicate_members'
  | 'reshare_not_member';

export interface ChainResult {
  accepted: boolean;
  reason?: ChainRejection;
  /** True when this transition became the canonical head. */
  isCanonicalHead?: boolean;
  /** True when the transition was valid but lost a fork race [PR-05]. */
  isFork?: boolean;
}

export function adoptGenesis(state: ChainState, genesis: RoomGenesisPacket): boolean {
  if (genesis.convId !== state.convId) return false;
  if (state.genesis && state.genesis.packetId !== genesis.packetId) {
    // Two genesis packets for one convId: keep the first we validated. A second
    // one is either a replay or a different room reusing the id.
    return false;
  }
  state.genesis = { packetId: genesis.packetId, creatorId: genesis.creatorId };
  return true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

function deltaIsExactly(
  parent: string[],
  next: string[],
  added: string[],
  removed: string[]
): boolean {
  const expected = new Set(parent);
  for (const r of removed) {
    if (!expected.delete(r)) return false;
  }
  for (const a of added) {
    if (expected.has(a)) return false;
    expected.add(a);
  }
  return sameSet(Array.from(expected), next);
}

/**
 * Validates one rekey transition against the chain. All clauses (a)-(h) of
 * [X-07] must hold; the signature and identity binding (clause a) are the
 * caller's responsibility and must already have passed.
 */
export function applyRekey(state: ChainState, packet: RekeyPacket): ChainResult {
  if (!state.genesis) return { accepted: false, reason: 'no_genesis' };

  const members = packet.members ?? [];

  // (f) structural bounds -- not a membership policy, see [L-17]
  if (members.length < 1 || members.length > MAX_PRIVATE_MEMBERS_HARD) {
    return { accepted: false, reason: 'member_bounds' };
  }
  if (new Set(members).size !== members.length) {
    return { accepted: false, reason: 'duplicate_members' };
  }

  // (g) exactly one wrapped key slot per member, and no extras
  const slots = Object.keys(packet.keys ?? {});
  for (const m of members) {
    if (!packet.keys?.[m]) return { accepted: false, reason: 'missing_key_slot' };
  }
  if (slots.length !== members.length) return { accepted: false, reason: 'extra_key_slot' };

  // (b) parent must be a locally validated head, or genesis for the first epoch
  if (packet.action === 'genesis_epoch') {
    if (packet.parentPacketId !== state.genesis.packetId) {
      return { accepted: false, reason: 'unknown_parent' };
    }
    if (packet.epoch !== 1) return { accepted: false, reason: 'bad_epoch' };
    // (d) only the creator may open the chain
    if (packet.signerId !== state.genesis.creatorId) {
      return { accepted: false, reason: 'signer_not_member' };
    }
    if (!sameSet(members, [packet.signerId])) {
      return { accepted: false, reason: 'illegal_member_delta' };
    }
    return commit(state, toNode(packet));
  }

  const parent = state.nodes.get(packet.parentPacketId);
  if (!parent || parent.keyId !== packet.parentKeyId) {
    return { accepted: false, reason: 'unknown_parent' };
  }

  // (d) signer must have been a member of the parent epoch
  if (!parent.members.includes(packet.signerId)) {
    return { accepted: false, reason: 'signer_not_member' };
  }

  // (c) epoch increment, except reshare which does not advance
  if (packet.action === 'reshare') {
    if (packet.epoch !== parent.epoch || packet.keyId !== parent.keyId) {
      return { accepted: false, reason: 'bad_epoch' };
    }
    // (h) reshare only re-delivers to someone already in that epoch
    const target = packet.targetParticipantId;
    if (!target || !parent.members.includes(target)) {
      return { accepted: false, reason: 'reshare_not_member' };
    }
    if (!sameSet(members, parent.members)) {
      return { accepted: false, reason: 'illegal_member_delta' };
    }
    // A reshare does not create a new head; it only re-delivers key material.
    return { accepted: true, isCanonicalHead: false };
  }

  if (packet.epoch !== parent.epoch + 1) return { accepted: false, reason: 'bad_epoch' };

  // (e) the member delta must be exactly what the action claims
  const target = packet.targetParticipantId;
  let legal = false;
  if (packet.action === 'add') {
    legal = !!target && deltaIsExactly(parent.members, members, [target], []);
  } else if (packet.action === 'remove') {
    legal = !!target && deltaIsExactly(parent.members, members, [], [target]);
  } else if (packet.action === 'rekey') {
    legal = sameSet(members, parent.members);
  }
  if (!legal) return { accepted: false, reason: 'illegal_member_delta' };

  return commit(state, toNode(packet));
}

/**
 * Validates a capability rotation as a 'remove' transition that additionally
 * rotates the room secret [X-08]. The wrapped payload is opened by the caller.
 */
export function applyCapabilityRotation(
  state: ChainState,
  packet: CapabilityRotationPacket
): ChainResult {
  if (!state.genesis) return { accepted: false, reason: 'no_genesis' };

  const parent = state.nodes.get(packet.parentPacketId);
  if (!parent || parent.keyId !== packet.parentKeyId) {
    return { accepted: false, reason: 'unknown_parent' };
  }
  if (!parent.members.includes(packet.signerId)) {
    return { accepted: false, reason: 'signer_not_member' };
  }
  if (packet.newEpoch !== parent.epoch + 1) return { accepted: false, reason: 'bad_epoch' };

  const members = packet.members ?? [];
  if (members.length < 1 || members.length > MAX_PRIVATE_MEMBERS_HARD) {
    return { accepted: false, reason: 'member_bounds' };
  }
  if (new Set(members).size !== members.length) {
    return { accepted: false, reason: 'duplicate_members' };
  }
  if (!deltaIsExactly(parent.members, members, [], [packet.removedParticipantId])) {
    return { accepted: false, reason: 'illegal_member_delta' };
  }
  for (const m of members) {
    if (!packet.wrapped?.[m]) return { accepted: false, reason: 'missing_key_slot' };
  }
  if (Object.keys(packet.wrapped ?? {}).length !== members.length) {
    return { accepted: false, reason: 'extra_key_slot' };
  }

  return commit(state, {
    packetId: packet.packetId,
    keyId: packet.newKeyId,
    epoch: packet.newEpoch,
    parentPacketId: packet.parentPacketId,
    parentKeyId: packet.parentKeyId,
    members,
    signerId: packet.signerId,
    timestamp: packet.timestamp,
    action: 'capability_rotation',
  });
}

function toNode(packet: RekeyPacket): EpochNode {
  return {
    packetId: packet.packetId,
    keyId: packet.keyId,
    epoch: packet.epoch,
    parentPacketId: packet.parentPacketId,
    parentKeyId: packet.parentKeyId,
    members: Array.from(packet.members).sort(),
    signerId: packet.signerId,
    timestamp: packet.timestamp,
    action: packet.action,
  };
}

/**
 * Records a validated node and resolves forks: competing valid children of one
 * parent are ordered by packetId, greatest wins [PR-05].
 */
function commit(state: ChainState, node: EpochNode): ChainResult {
  if (state.nodes.has(node.packetId)) {
    return { accepted: true, isCanonicalHead: state.headPacketId === node.packetId };
  }

  const head = chainHead(state);

  // Extending the canonical head, or opening the chain.
  if (!head || node.parentPacketId === head.packetId) {
    state.nodes.set(node.packetId, node);
    state.headPacketId = node.packetId;
    return { accepted: true, isCanonicalHead: true };
  }

  // A sibling of the current head: deterministic tie-break by packetId.
  if (node.parentPacketId === head.parentPacketId && node.epoch === head.epoch) {
    state.nodes.set(node.packetId, node);
    if (node.packetId > head.packetId) {
      state.forks.push(head);
      state.headPacketId = node.packetId;
      return { accepted: true, isCanonicalHead: true };
    }
    state.forks.push(node);
    return { accepted: true, isCanonicalHead: false, isFork: true };
  }

  // A valid transition on a branch we are not following, or one that arrived
  // ahead of its parent. Keep it so a later packet can link it up.
  state.nodes.set(node.packetId, node);
  if (node.epoch > head.epoch && isDescendantOf(state, node, head)) {
    state.headPacketId = node.packetId;
    return { accepted: true, isCanonicalHead: true };
  }
  state.forks.push(node);
  return { accepted: true, isCanonicalHead: false, isFork: true };
}

function isDescendantOf(state: ChainState, node: EpochNode, ancestor: EpochNode): boolean {
  let cursor: EpochNode | undefined = node;
  for (let i = 0; i < MAX_PRIVATE_MEMBERS_HARD * 8 && cursor; i++) {
    if (cursor.parentPacketId === ancestor.packetId) return true;
    cursor = state.nodes.get(cursor.parentPacketId);
  }
  return false;
}

// ----------------------------------------------------------------------------
// Serialisation for the membershipHeads store
// ----------------------------------------------------------------------------

export interface StoredChain {
  convId: string;
  genesis: ChainState['genesis'];
  nodes: EpochNode[];
  headPacketId: string | null;
  forks: EpochNode[];
}

export function serializeChain(state: ChainState): StoredChain {
  return {
    convId: state.convId,
    genesis: state.genesis,
    nodes: Array.from(state.nodes.values()),
    headPacketId: state.headPacketId,
    forks: state.forks,
  };
}

export function deserializeChain(stored: StoredChain): ChainState {
  return {
    convId: stored.convId,
    genesis: stored.genesis ?? null,
    nodes: new Map((stored.nodes ?? []).map((n) => [n.packetId, n])),
    headPacketId: stored.headPacketId ?? null,
    forks: stored.forks ?? [],
  };
}
