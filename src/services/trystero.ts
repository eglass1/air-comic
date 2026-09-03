import { joinRoom, selfId, getRelaySockets, defaultRelayUrls } from 'trystero/nostr';
import type {
  IdentityHelloPacket,
  EncryptedNetworkEnvelope,
  StateSummaryPacket,
  StateRequestPacket,
  StateChunkPacket,
  RelaySocketStatus,
} from '../types';

export class TrysteroService {
  public selfPeerId: string;
  private room: any = null;
  private convId: string;
  private signalingPassword: string;
  private customRelays?: string[];

  // Actions
  private helloAction: any = null;
  private controlAction: any = null;
  private chatAction: any = null;
  private stateSummaryAction: any = null;
  private stateRequestAction: any = null;
  private stateChunkAction: any = null;

  // Callbacks
  private onPeerJoinCb: ((peerId: string) => void) | null = null;
  private onPeerLeaveCb: ((peerId: string) => void) | null = null;
  private onHelloCb: ((packet: IdentityHelloPacket, peerId: string) => void) | null = null;
  private onControlCb: ((envelope: EncryptedNetworkEnvelope, peerId: string) => void) | null = null;
  private onChatCb: ((envelope: EncryptedNetworkEnvelope, peerId: string) => void) | null = null;
  private onStateSummaryCb: ((packet: StateSummaryPacket, peerId: string) => void) | null = null;
  private onStateRequestCb: ((packet: StateRequestPacket, peerId: string) => void) | null = null;
  private onStateChunkCb: ((packet: StateChunkPacket, peerId: string) => void) | null = null;

  constructor(convId: string, signalingPassword: string, customRelays?: string[]) {
    this.selfPeerId = selfId;
    this.convId = convId;
    this.signalingPassword = signalingPassword;
    this.customRelays = customRelays;
  }

  public connect() {
    this.disconnect();

    const config: any = {
      appId: 'airthread-protocol-v2',
      password: this.signalingPassword,
      relayConfig: {
        redundancy: 12,
      },
    };

    if (this.customRelays && this.customRelays.length > 0) {
      config.relayConfig.urls = this.customRelays;
    }

    try {
      this.room = joinRoom(config, this.convId, {
        onJoinError: (err: any) => console.warn('[Trystero onJoinError]:', err),
      });

      // Setup actions (Trystero returns { send, onMessage } object)
      this.helloAction = this.room.makeAction('hello');
      this.helloAction.onMessage = (data: IdentityHelloPacket, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onHelloCb) this.onHelloCb(data, peerId);
      };

      this.controlAction = this.room.makeAction('control');
      this.controlAction.onMessage = (data: EncryptedNetworkEnvelope, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onControlCb) this.onControlCb(data, peerId);
      };

      this.chatAction = this.room.makeAction('chat');
      this.chatAction.onMessage = (data: EncryptedNetworkEnvelope, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onChatCb) this.onChatCb(data, peerId);
      };

      this.stateSummaryAction = this.room.makeAction('state_summary');
      this.stateSummaryAction.onMessage = (data: StateSummaryPacket, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onStateSummaryCb) this.onStateSummaryCb(data, peerId);
      };

      this.stateRequestAction = this.room.makeAction('state_request');
      this.stateRequestAction.onMessage = (data: StateRequestPacket, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onStateRequestCb) this.onStateRequestCb(data, peerId);
      };

      this.stateChunkAction = this.room.makeAction('state_chunk');
      this.stateChunkAction.onMessage = (data: StateChunkPacket, meta: any) => {
        const peerId = meta?.peerId || '';
        if (this.onStateChunkCb) this.onStateChunkCb(data, peerId);
      };

      // Peer lifecycle (setter properties)
      this.room.onPeerJoin = (peerId: string) => {
        if (this.onPeerJoinCb) this.onPeerJoinCb(peerId);
      };

      this.room.onPeerLeave = (peerId: string) => {
        if (this.onPeerLeaveCb) this.onPeerLeaveCb(peerId);
      };
    } catch (err) {
      console.error('Failed to initialize Trystero room:', err);
    }
  }

  // Action dispatchers
  public sendHello(packet: IdentityHelloPacket, targetPeerId?: string) {
    if (this.helloAction) {
      this.helloAction.send(packet, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  public sendControl(envelope: EncryptedNetworkEnvelope, targetPeerId?: string) {
    if (this.controlAction) {
      this.controlAction.send(envelope, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  public sendChat(envelope: EncryptedNetworkEnvelope, targetPeerId?: string) {
    if (this.chatAction) {
      this.chatAction.send(envelope, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  public sendStateSummary(packet: StateSummaryPacket, targetPeerId?: string) {
    if (this.stateSummaryAction) {
      this.stateSummaryAction.send(packet, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  public sendStateRequest(packet: StateRequestPacket, targetPeerId?: string) {
    if (this.stateRequestAction) {
      this.stateRequestAction.send(packet, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  public sendStateChunk(packet: StateChunkPacket, targetPeerId?: string) {
    if (this.stateChunkAction) {
      this.stateChunkAction.send(packet, targetPeerId ? { target: targetPeerId } : {});
    }
  }

  // Callback setters
  public setOnPeerJoin(cb: (peerId: string) => void) {
    this.onPeerJoinCb = cb;
  }

  public setOnPeerLeave(cb: (peerId: string) => void) {
    this.onPeerLeaveCb = cb;
  }

  public setOnHello(cb: (packet: IdentityHelloPacket, peerId: string) => void) {
    this.onHelloCb = cb;
  }

  public setOnControl(cb: (envelope: EncryptedNetworkEnvelope, peerId: string) => void) {
    this.onControlCb = cb;
  }

  public setOnChat(cb: (envelope: EncryptedNetworkEnvelope, peerId: string) => void) {
    this.onChatCb = cb;
  }

  public setOnStateSummary(cb: (packet: StateSummaryPacket, peerId: string) => void) {
    this.onStateSummaryCb = cb;
  }

  public setOnStateRequest(cb: (packet: StateRequestPacket, peerId: string) => void) {
    this.onStateRequestCb = cb;
  }

  public setOnStateChunk(cb: (packet: StateChunkPacket, peerId: string) => void) {
    this.onStateChunkCb = cb;
  }

  public getConnectedPeers(): string[] {
    if (!this.room || !this.room.getPeers) return [];
    try {
      return Object.keys(this.room.getPeers());
    } catch {
      return [];
    }
  }

  public getRelayStatuses(): RelaySocketStatus[] {
    try {
      const sockets = getRelaySockets ? getRelaySockets() : {};
      const results: RelaySocketStatus[] = [];
      for (const [url, ws] of Object.entries(sockets as Record<string, any>)) {
        let status: 'connected' | 'connecting' | 'disconnected' | 'error' = 'disconnected';
        if (ws && typeof ws.readyState === 'number') {
          if (ws.readyState === 1) status = 'connected';
          else if (ws.readyState === 0) status = 'connecting';
          else status = 'disconnected';
        }
        results.push({ url, status });
      }
      return results;
    } catch {
      return [];
    }
  }

  public disconnect() {
    if (this.room) {
      try {
        if (typeof this.room.leave === 'function') {
          this.room.leave();
        } else if (typeof this.room.leaveRoom === 'function') {
          this.room.leaveRoom();
        }
      } catch (err) {
        console.warn('Error leaving Trystero room:', err);
      }
      this.room = null;
    }
  }
}
