/**
 * Foreground private-room WebRTC accelerator -- implementation plan [X-14].
 *
 * WebRTC is an optimisation, never a requirement [R-02]. It carries the
 * byte-identical RoomEnvelope that went to the relays [P-03], so dedup makes
 * dual delivery free. Failure is never fatal: the room keeps working on Nostr
 * and the UI reports acceleration separately from connectivity [W-04].
 *
 * Differences from v2's transport layer:
 *   - the Trystero roomId and password are derived from the room secret, so a
 *     convId alone reveals no rendezvous topic [W-02][O-01]
 *   - at most one room is accelerated at a time [R-03]
 *   - envelopes are sent once per peer with no re-flooding [W-05]
 *   - peerId is never treated as an identity [W-06][O-13]
 */

import { joinRoom, type MessageAction, type Room } from 'trystero/nostr';
import {
  MAX_WEBRTC_PEERS,
  TRYSTERO_APP_ID,
  WEBRTC_MEMBER_THRESHOLD,
} from './constants';
import { deriveWebrtcPassword, deriveWebrtcRoomId } from './keys';
import { getRelayUrls, getWebrtcEnabled } from './relayConfig';
import { buildHello, verifyHello } from './packets';
import { safeParse } from './validate';
import { MAX_ENVELOPE_BYTES } from './constants';
import type { AccelerationStatus, IdentityHelloPacket } from './types';
import type { UserProfile } from './db';

export interface AcceleratorTarget {
  tabId: string;
  convId: string;
  roomSecret: string;
  roomMode: 'private' | 'public';
  isApproved: boolean;
  memberCount: number;
  receive(serialized: string): Promise<void>;
  onStatus(status: AccelerationStatus, peerCount: number): void;
}

/**
 * Owns at most one Trystero room for the whole application [R-03].
 *
 * Trystero opens its own sockets and cannot be pointed at the shared RelayPool
 * without forking it. That is acceptable precisely because this layer is
 * optional and single-room [L-15].
 */
class ForegroundPrivateAccelerator {
  private room: Room | null = null;
  private target: AcceleratorTarget | null = null;
  private profile: UserProfile | null = null;
  private signingPrivateKey: CryptoKey | null = null;
  private envelopeAction: MessageAction<string> | null = null;
  private helloAction: MessageAction<string> | null = null;
  private peers = new Set<string>();
  private status: AccelerationStatus = 'unavailable';
  private activeTabId: string | null = null;

  getStatus(): AccelerationStatus {
    return this.status;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  private setStatus(status: AccelerationStatus) {
    this.status = status;
    this.target?.onStatus(status, this.peers.size);
  }

  /**
   * Attaches the accelerator to one room. Any previously accelerated room is
   * left first, so only one mesh exists at a time [W-03].
   */
  async activate(
    target: AcceleratorTarget,
    profile: UserProfile,
    signingPrivateKey: CryptoKey
  ): Promise<void> {
    if (this.activeTabId === target.tabId && this.room) {
      this.target = target;
      return;
    }
    this.deactivate();

    this.target = target;
    this.profile = profile;
    this.signingPrivateKey = signingPrivateKey;

    if (!this.eligible(target)) {
      this.setStatus(getWebrtcEnabled() ? 'unavailable' : 'disabled');
      return;
    }

    try {
      const roomId = await deriveWebrtcRoomId(target.roomSecret, target.convId);
      const password = await deriveWebrtcPassword(target.roomSecret, target.convId);

      const room = joinRoom(
        {
          appId: TRYSTERO_APP_ID,
          password,
          relayConfig: { urls: getRelayUrls() },
        },
        roomId,
        { onJoinError: () => this.setStatus('unavailable') }
      );

      this.room = room;
      this.activeTabId = target.tabId;

      // Exactly two actions: the envelope and the signed hello [X-14].
      this.envelopeAction = room.makeAction<string>('env');
      this.envelopeAction.onMessage = (data) => void this.handleEnvelope(data);

      this.helloAction = room.makeAction<string>('hello');
      this.helloAction.onMessage = (data) => void this.handleHello(data);

      room.onPeerJoin = (peerId: string) => {
        if (this.peers.size >= MAX_WEBRTC_PEERS) return;
        this.peers.add(peerId);
        void this.greet(peerId);
        this.setStatus('active');
      };
      room.onPeerLeave = (peerId: string) => {
        this.peers.delete(peerId);
        this.setStatus(this.peers.size > 0 ? 'active' : 'unavailable');
      };

      this.setStatus('unavailable');
    } catch {
      // ICE failure, signalling failure, missing TURN, password mismatch: none
      // of these may prevent room use [W-04].
      this.setStatus('unavailable');
    }
  }

  private eligible(target: AcceleratorTarget): boolean {
    return (
      getWebrtcEnabled() &&
      target.roomMode === 'private' &&
      target.isApproved &&
      !!target.roomSecret &&
      // Above the threshold the room simply runs on Nostr. It is never
      // blocked, because 20 is a WebRTC limit and not a room cap [L-17].
      target.memberCount <= WEBRTC_MEMBER_THRESHOLD &&
      this.peers.size < MAX_WEBRTC_PEERS
    );
  }

  private async greet(peerId: string): Promise<void> {
    if (!this.profile || !this.signingPrivateKey || !this.target || !this.helloAction) return;
    const hello = await buildHello({
      convId: this.target.convId,
      peerId,
      participantId: this.profile.participantId,
      screenName: this.profile.screenName,
      avatarName: this.profile.avatarName,
      publicKey: this.profile.publicKeyBase64,
      signingPublicKey: this.profile.signingPublicKeyBase64,
      contactInfo: this.profile.contactInfo,
      capabilities: ['airthread/3-nostr-transport'],
      signingPrivateKey: this.signingPrivateKey,
    });
    void this.helloAction.send(JSON.stringify(hello), { target: peerId }).catch(() => {
      /* a peer that vanished mid-greeting is not an error [W-04] */
    });
  }

  /** A hello is identity evidence; the transport peerId never is [W-06][O-13]. */
  private async handleHello(data: unknown): Promise<void> {
    if (typeof data !== 'string') return;
    const parsed = safeParse(data, MAX_ENVELOPE_BYTES) as IdentityHelloPacket | null;
    if (!parsed || parsed.convId !== this.target?.convId) return;
    await verifyHello(parsed);
  }

  /**
   * Inbound envelopes go through the room's normal receive pipeline, so an
   * accelerated packet is verified exactly as a relayed one is [P-03].
   */
  private async handleEnvelope(data: unknown): Promise<void> {
    if (!this.target) return;
    const serialized = typeof data === 'string' ? data : null;
    if (!serialized) return;
    if (safeParse(serialized, MAX_ENVELOPE_BYTES) === null) return;
    await this.target.receive(serialized);
  }

  /**
   * One direct send per connected peer. No re-flooding: Nostr already supplies
   * the convergence path, and a partial mesh is acceptable [W-05].
   */
  send(serialized: string): void {
    if (!this.envelopeAction || this.peers.size === 0) return;
    for (const peerId of this.peers) {
      void this.envelopeAction.send(serialized, { target: peerId }).catch(() => {
        /* a failed peer send is never fatal [W-04] */
      });
    }
  }

  deactivate(): void {
    if (this.room) {
      try {
        void this.room.leave();
      } catch {
        /* leaving a dead room is not an error */
      }
    }
    this.room = null;
    this.target = null;
    this.envelopeAction = null;
    this.helloAction = null;
    this.peers.clear();
    this.activeTabId = null;
    this.status = 'unavailable';
  }
}

export const accelerator = new ForegroundPrivateAccelerator();
