import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChatMessage,
  FavoriteRoomRecord,
  Friend,
  FriendPresence,
  Participant,
  PendingInviteRecord,
  PendingJoinRequest,
  PublicRoomDescriptorPacket,
  QuickMessagePayload,
  RelayHealth,
  RoomInvitePayload,
  RoomInviteResponsePayload,
  RoomMode,
  RoomTab,
  UserProfile,
} from '../types';
import {
  getParticipantId,
  getPublicKeyFingerprint,
  importSigningPrivateKeyFromJwk,
  normalizePublicKey,
} from '../services/crypto';
import { getOrInitChannelTitle, getRandomChannelTitle } from '../utils/channelNameGenerator';
import { db } from '../services/v3/db';
import { relayPool } from '../services/nostr/relayPool';
import { RoomSession, outbox } from '../services/v3/roomSession';
import { presenceService } from '../services/v3/presence';
import { directoryService } from '../services/v3/directory';
import {
  derivePublicRoomId,
  generateRoomSecret,
} from '../services/v3/keys';
import {
  buildInviteResponse,
  buildPublicRoomDescriptor,
  buildRoomInvite,
} from '../services/v3/packets';
import { loadSettings, saveRelayUrls, saveWebrtcEnabled } from '../services/v3/relayConfig';
import type { AccelerationStatus } from '../services/v3/types';

const STORAGE_KEY_TABS = 'aircomic_open_tabs';

export interface QuickMessageTarget {
  participantId: string;
  screenName: string;
  avatarName?: string;
  publicKey?: string;
  signingPublicKey?: string;
  /** Transport label only; never an identity [W-06][O-13]. */
  peerId?: string;
}

export interface ChatContextType {
  // Profile and contacts
  profile: UserProfile | null;
  friends: Friend[];
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;
  regenerateKeypair: () => Promise<void>;
  importProfileFromJson: (jsonStr: string) => Promise<boolean>;
  exportProfileAsJson: () => string;
  addFriend: (friend: Omit<Friend, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateFriend: (friend: Friend) => Promise<void>;
  deleteFriend: (id: string) => Promise<void>;
  fingerprint: string;

  // Presence and invitations
  friendPresence: Map<string, FriendPresence>;
  isFriendOnline: (participantId: string) => boolean;
  /** False when a contact has never issued us a presence capability. */
  isPresenceShared: (participantId: string) => boolean;
  pendingInvites: PendingInviteRecord[];
  inviteFriendToRoom: (friend: Friend) => Promise<'sent' | 'queued' | 'error'>;
  cancelPendingInvite: (inviteId: string) => Promise<void>;
  incomingInvites: RoomInvitePayload[];
  acceptIncomingInvite: (invite: RoomInvitePayload) => Promise<void>;
  declineIncomingInvite: (invite: RoomInvitePayload) => Promise<void>;

  // Quick messages
  incomingQuickMessage: QuickMessagePayload | null;
  quickMessageTarget: QuickMessageTarget | null;
  openQuickMessage: (target: QuickMessageTarget) => void;
  closeQuickMessage: () => void;
  dismissIncomingQuickMessage: () => void;
  replyToIncomingQuickMessage: () => void;
  sendQuickMessage: (text: string, emotion: number, intensity: number) => Promise<boolean>;

  // Tabs
  tabs: RoomTab[];
  activeTabId: string;
  openTab: (config: {
    convId?: string;
    roomMode?: RoomMode;
    roomSecret?: string;
    publicJoinToken?: string;
    channelTitle?: string;
    isInitialCreator?: boolean;
  }) => string;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  createPrivateRoomTab: (title?: string) => string;
  joinRoomByUrlOrSecret: (input: string) => string | null;
  joinPublicRoomTab: (descriptor: PublicRoomDescriptorPacket) => string;

  // Active room
  convId: string;
  roomMode: RoomMode;
  roomSecret: string;
  publicJoinToken: string | null;
  publicRoomId: string | null;
  isInitialCreator: boolean;
  channelTitle: string;
  updateChannelTitle: (newTitle: string) => Promise<boolean>;
  /** Nostr connectivity only. Acceleration is reported separately [W-04]. */
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
  accelerationStatus: AccelerationStatus;
  connectedPeersCount: number;
  relayStatuses: RelayHealth[];
  participantsMap: Map<string, Participant>;
  participants: Participant[];
  messages: ChatMessage[];
  sendMessage: (
    text: string,
    options?: {
      emotion?: number;
      emotionIntensity?: number;
      balloonMode?: 'say' | 'whisper' | 'think' | 'action';
    }
  ) => Promise<boolean>;
  activeKeyId: string;
  activeEpoch: number;
  isApproved: boolean;
  isRekeying: boolean;
  roomFingerprint: string;
  memberCount: number;
  capabilityGeneration: number;
  pendingSendCount: number;
  failedSendCount: number;
  approximateOccupancy: string | null;
  pendingJoinRequests: PendingJoinRequest[];
  sendJoinRequest: () => Promise<boolean>;
  approveJoinRequest: (requestOrId: PendingJoinRequest | string) => Promise<boolean>;
  declineJoinRequest: (requestId: string) => void;
  removeParticipant: (participantId: string, screenName?: string) => Promise<boolean>;
  rekeyConversation: () => Promise<boolean>;
  clearHistory: () => Promise<void>;
  isSecretMissing: boolean;
  provideRoomSecret: (input: string) => void;
  inviteUrl: string;
  refreshRelays: () => void;
  reconnectRelays: () => Promise<void>;

  // Relay configuration [U-03][T-01]
  relayUrls: string[];
  setRelayUrls: (urls: string[]) => Promise<void>;
  webrtcEnabled: boolean;
  setWebrtcEnabled: (enabled: boolean) => Promise<void>;

  // View
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;

  // Favourites
  favoriteRooms: FavoriteRoomRecord[];
  isFavoriteRoom: boolean;
  toggleFavoriteRoom: () => Promise<void>;
  removeFavoriteRoom: (id: string) => Promise<void>;
  openFavoriteRoom: (record: FavoriteRoomRecord) => void;

  // Public directory
  publicRoomsList: PublicRoomDescriptorPacket[];
  refreshPublicRoomsList: () => Promise<PublicRoomDescriptorPacket[]>;
  createPublicRoom: (
    name: string,
    description?: string,
    tags?: string[],
    language?: string
  ) => Promise<string>;
  joinPublicRoom: (descriptor: PublicRoomDescriptorPacket) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export const useChat = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error('useChat must be used within a ChatProvider');
  return context;
};

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [fingerprint, setFingerprint] = useState('');
  const [tabs, setTabs] = useState<RoomTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [, forceRender] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [favoriteRooms, setFavoriteRooms] = useState<FavoriteRoomRecord[]>([]);
  const [publicRoomsList, setPublicRoomsList] = useState<PublicRoomDescriptorPacket[]>([]);
  const [friendPresence, setFriendPresence] = useState<Map<string, FriendPresence>>(new Map());
  const [pendingInvites, setPendingInvites] = useState<PendingInviteRecord[]>([]);
  const [incomingInvites, setIncomingInvites] = useState<RoomInvitePayload[]>([]);
  const [incomingQuickMessage, setIncomingQuickMessage] = useState<QuickMessagePayload | null>(null);
  const [quickMessageTarget, setQuickMessageTarget] = useState<QuickMessageTarget | null>(null);
  const [relayUrls, setRelayUrlsState] = useState<string[]>([]);
  const [webrtcEnabled, setWebrtcEnabledState] = useState(true);

  const sessionsRef = useRef<Map<string, RoomSession>>(new Map());
  const profileRef = useRef<UserProfile | null>(null);
  const friendsRef = useRef<Friend[]>([]);
  const activeTabIdRef = useRef('');
  const tabsRef = useRef<RoomTab[]>([]);
  const pendingInvitesRef = useRef<PendingInviteRecord[]>([]);

  profileRef.current = profile;
  friendsRef.current = friends;
  activeTabIdRef.current = activeTabId;
  tabsRef.current = tabs;
  pendingInvitesRef.current = pendingInvites;

  const rerender = useCallback(() => forceRender((n) => n + 1), []);

  // --------------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------------

  const getOrCreateSession = useCallback(
    (tab: RoomTab): RoomSession => {
      const existing = sessionsRef.current.get(tab.tabId);
      if (existing) return existing;

      const session = new RoomSession(
        {
          tabId: tab.tabId,
          convId: tab.convId,
          roomMode: tab.roomMode,
          roomSecret: tab.roomSecret,
          publicJoinToken: tab.publicJoinToken,
          isInitialCreator: tab.isInitialCreator,
          channelTitle: tab.channelTitle,
        },
        {
          onStateChange: () => rerender(),
          onNewMessage: (s) => {
            if (s.tabId !== activeTabIdRef.current) {
              setTabs((prev) =>
                prev.map((t) =>
                  t.tabId === s.tabId ? { ...t, unreadCount: t.unreadCount + 1 } : t
                )
              );
            }
            rerender();
          },
        }
      );
      sessionsRef.current.set(tab.tabId, session);

      if (profileRef.current) {
        void session.init(profileRef.current).then(async () => {
          // Honour invitations we issued that are still within their window.
          const preapprovals = await db.getPreapprovals();
          preapprovals
            .filter((p) => p.convId === tab.convId)
            .forEach((p) => session.setAutoApprove(p.participantId));
          if (tab.tabId === activeTabIdRef.current) session.setForeground(true);
          rerender();
        });
      }
      return session;
    },
    [rerender]
  );

  const activeSession = sessionsRef.current.get(activeTabId) ?? null;
  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  const syncBrowserUrl = useCallback((tab: RoomTab) => {
    if (typeof window === 'undefined') return;
    if (tab.roomMode === 'public') {
      window.history.replaceState(
        null,
        '',
        `?id=${encodeURIComponent(tab.convId)}&public=1&join=${encodeURIComponent(
          tab.publicJoinToken || ''
        )}`
      );
    } else {
      const search = `?id=${encodeURIComponent(tab.convId)}`;
      const hash = tab.roomSecret ? `#secret=${encodeURIComponent(tab.roomSecret)}` : '';
      window.history.replaceState(null, '', `${search}${hash}`);
    }
  }, []);

  const persistTabs = useCallback((next: RoomTab[]) => {
    try {
      sessionStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(next));
    } catch {
      /* session storage is a convenience only */
    }
  }, []);

  /** Only one private room may hold the WebRTC mesh at a time [R-03]. */
  const switchTab = useCallback(
    (tabId: string) => {
      const target = tabsRef.current.find((t) => t.tabId === tabId);
      if (!target) return;

      sessionsRef.current.forEach((session, id) => session.setForeground(id === tabId));

      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, unreadCount: 0 } : t)));
      syncBrowserUrl(target);
      rerender();
    },
    [syncBrowserUrl, rerender]
  );

  const openTab = useCallback(
    (config: {
      convId?: string;
      roomMode?: RoomMode;
      roomSecret?: string;
      publicJoinToken?: string;
      channelTitle?: string;
      isInitialCreator?: boolean;
    }): string => {
      const mode = config.roomMode || 'private';
      const convId = config.convId?.trim() || crypto.randomUUID();

      const existing = tabsRef.current.find(
        (t) =>
          t.convId === convId &&
          (mode === 'private' || t.publicJoinToken === config.publicJoinToken)
      );
      if (existing) {
        switchTab(existing.tabId);
        return existing.tabId;
      }

      const tabId = crypto.randomUUID();
      const tab: RoomTab = {
        tabId,
        convId,
        roomMode: mode,
        roomSecret:
          mode === 'private'
            ? config.roomSecret !== undefined
              ? config.roomSecret
              : generateRoomSecret()
            : undefined,
        publicJoinToken:
          mode === 'public' ? config.publicJoinToken || generateRoomSecret() : undefined,
        isInitialCreator: config.isInitialCreator ?? !config.convId,
        channelTitle: config.channelTitle || getOrInitChannelTitle(convId),
        unreadCount: 0,
      };

      getOrCreateSession(tab);
      const next = [...tabsRef.current, tab];
      tabsRef.current = next;
      setTabs(next);
      persistTabs(next);
      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      sessionsRef.current.forEach((session, id) => session.setForeground(id === tabId));
      syncBrowserUrl(tab);
      rerender();
      return tabId;
    },
    [getOrCreateSession, persistTabs, switchTab, syncBrowserUrl, rerender]
  );

  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;

  const closeTab = useCallback(
    (tabId: string) => {
      sessionsRef.current.get(tabId)?.destroy();
      sessionsRef.current.delete(tabId);

      const remaining = tabsRef.current.filter((t) => t.tabId !== tabId);
      tabsRef.current = remaining;
      setTabs(remaining);
      persistTabs(remaining);

      if (remaining.length === 0) {
        openTabRef.current({ roomMode: 'private' });
        return;
      }
      if (activeTabIdRef.current === tabId) switchTab(remaining[remaining.length - 1].tabId);
    },
    [persistTabs, switchTab]
  );

  const createPrivateRoomTab = useCallback(
    (title?: string) =>
      openTabRef.current({
        roomMode: 'private',
        channelTitle: title || getRandomChannelTitle(),
        isInitialCreator: true,
      }),
    []
  );

  const joinRoomByUrlOrSecret = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    if (!trimmed) return null;

    let convId = '';
    let roomSecret = '';
    let roomMode: RoomMode = 'private';
    let publicJoinToken = '';

    try {
      const parseParams = (search: string, whole: string) => {
        const params = new URLSearchParams(search);
        convId = params.get('id') || '';
        if (params.get('public') === '1' || params.get('public') === 'true') {
          roomMode = 'public';
          publicJoinToken = params.get('join') || '';
        } else {
          const match = whole.match(/secret=([A-Za-z0-9_-]+)/);
          if (match?.[1]) roomSecret = match[1];
        }
      };

      if (/^https?:\/\//.test(trimmed)) {
        const url = new URL(trimmed);
        parseParams(url.search, trimmed);
      } else if (trimmed.includes('?id=') || trimmed.includes('&id=')) {
        parseParams(trimmed.includes('?') ? trimmed.split('?')[1] : trimmed, trimmed);
      } else if (trimmed.includes('secret=')) {
        const match = trimmed.match(/secret=([A-Za-z0-9_-]+)/);
        if (match?.[1]) roomSecret = match[1];
      } else {
        convId = trimmed;
      }

      if (convId || roomSecret || publicJoinToken) {
        return openTabRef.current({
          convId: convId || crypto.randomUUID(),
          roomMode,
          roomSecret,
          publicJoinToken,
          isInitialCreator: false,
        });
      }
    } catch {
      /* an unparseable link simply does not open a room */
    }
    return null;
  }, []);

  const joinPublicRoomTab = useCallback(
    (descriptor: PublicRoomDescriptorPacket) =>
      openTabRef.current({
        convId: descriptor.convId,
        roomMode: 'public',
        publicJoinToken: descriptor.publicJoinToken,
        channelTitle: descriptor.name,
        isInitialCreator: false,
      }),
    []
  );

  // --------------------------------------------------------------------------
  // Startup
  // --------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const settings = await loadSettings();
      if (cancelled) return;
      setRelayUrlsState(settings.relayUrls);
      setWebrtcEnabledState(settings.webrtcEnabled);
      relayPool.configure(settings.relayUrls);

      const loaded = await db.getOrCreateProfile('Anonymous');
      if (cancelled) return;
      setProfile(loaded);
      profileRef.current = loaded;
      setFingerprint(await getPublicKeyFingerprint(loaded.signingPublicKeyBase64));
      setFriends(await db.getFriends());
      setFavoriteRooms(await db.getFavorites());
      setPendingInvites(await db.getPendingInvites());

      await presenceService.start(loaded);

      // Restore open tabs, or derive the first one from the URL.
      let restored: RoomTab[] = [];
      try {
        restored = JSON.parse(sessionStorage.getItem(STORAGE_KEY_TABS) || '[]');
      } catch {
        restored = [];
      }

      if (restored.length > 0) {
        tabsRef.current = restored;
        setTabs(restored);
        restored.forEach(getOrCreateSession);
        setActiveTabId(restored[0].tabId);
        activeTabIdRef.current = restored[0].tabId;
        sessionsRef.current.get(restored[0].tabId)?.setForeground(true);
      } else {
        const params = new URLSearchParams(window.location.search);
        const urlConvId = params.get('id') || '';
        const isPublic = params.get('public') === '1' || params.get('public') === 'true';
        const hashMatch = window.location.hash.match(/secret=([A-Za-z0-9_-]+)/);

        openTabRef.current({
          convId: urlConvId || undefined,
          roomMode: isPublic ? 'public' : 'private',
          publicJoinToken: isPublic ? params.get('join') || undefined : undefined,
          // No secret in the URL of an existing room means we genuinely cannot
          // compute its routing tag, which the missing-secret dialog explains.
          roomSecret: isPublic ? undefined : hashMatch?.[1] ?? (urlConvId ? '' : undefined),
          isInitialCreator: !urlConvId,
        });
      }
      rerender();
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------------------------------------------------------
  // Presence wiring
  // --------------------------------------------------------------------------

  useEffect(() => {
    presenceService.setCallbacks({
      onPresenceChange: (presence) => {
        setFriendPresence((prev) => {
          const next = new Map(prev);
          next.set(presence.participantId, presence);
          return next;
        });
        if (presence.status !== 'offline') void dispatchInvitesRef.current(presence.participantId);
      },
      onInvite: (invite) => setIncomingInvites((prev) => [...prev, invite]),
      onInviteResponse: (response) => void inviteResponseRef.current(response),
      onQuickMessage: (message) => setIncomingQuickMessage(message),
      onCapabilityReceived: async (packet) => {
        // A contact shared their presence capability with us [X-11].
        const known = friendsRef.current.find((f) => f.participantId === packet.issuerId);
        if (!known) return;
        if ((known.theirCapabilityGeneration ?? 0) >= packet.generation) return;
        const updated: Friend = {
          ...known,
          theirPresenceCapability: packet.capability,
          theirCapabilityGeneration: packet.generation,
        };
        await db.saveFriend(updated);
        const all = await db.getFriends();
        setFriends(all);
        await presenceService.watchContacts(all);
      },
    });
  }, []);

  useEffect(() => {
    void presenceService.watchContacts(friends);
  }, [friends]);

  // --------------------------------------------------------------------------
  // Profile and contacts
  // --------------------------------------------------------------------------

  const updateProfile = useCallback(async (updates: Partial<UserProfile>) => {
    const current = profileRef.current;
    if (!current) return;
    const next = { ...current, ...updates, updatedAt: Date.now() };
    await db.saveProfile(next);
    setProfile(next);
    profileRef.current = next;
  }, []);

  const regenerateKeypair = useCallback(async () => {
    const current = profileRef.current;
    if (!current) return;
    const next = await db.replaceIdentity(current);
    setProfile(next);
    profileRef.current = next;
    setFingerprint(await getPublicKeyFingerprint(next.signingPublicKeyBase64));
  }, []);

  const exportProfileAsJson = useCallback(
    () => (profileRef.current ? JSON.stringify(profileRef.current, null, 2) : ''),
    []
  );

  const importProfileFromJson = useCallback(async (jsonStr: string) => {
    try {
      const parsed = JSON.parse(jsonStr) as UserProfile;
      if (!parsed?.signingPublicKeyBase64 || !parsed?.signingPrivateKeyJwk) return false;
      // Trust the key material, not the claimed id.
      const participantId = await getParticipantId(parsed.signingPublicKeyBase64);
      const next: UserProfile = { ...parsed, id: 'current_user', participantId };
      await db.saveProfile(next);
      setProfile(next);
      profileRef.current = next;
      setFingerprint(await getPublicKeyFingerprint(next.signingPublicKeyBase64));
      return true;
    } catch {
      return false;
    }
  }, []);

  const refreshFriends = useCallback(async () => {
    const all = await db.getFriends();
    setFriends(all);
    await presenceService.watchContacts(all);
    return all;
  }, []);

  const addFriend = useCallback(
    async (friend: Omit<Friend, 'id' | 'createdAt' | 'updatedAt'>) => {
      const record: Friend = {
        ...friend,
        publicKey: normalizePublicKey(friend.publicKey),
        signingPublicKey: normalizePublicKey(friend.signingPublicKey),
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await db.saveFriend(record);
      const all = await refreshFriends();
      // Accepting a contact is what authorises them to see our presence [N-01].
      const saved = all.find((f) => f.participantId === record.participantId);
      if (saved) await presenceService.issueCapability(saved);
    },
    [refreshFriends]
  );

  const updateFriend = useCallback(
    async (friend: Friend) => {
      await db.saveFriend(friend);
      await refreshFriends();
    },
    [refreshFriends]
  );

  /** Removing a contact rotates our capability so they stop seeing us [N-01]. */
  const deleteFriend = useCallback(
    async (id: string) => {
      await db.deleteFriend(id);
      const remaining = await refreshFriends();
      await presenceService.rotateCapability(remaining);
    },
    [refreshFriends]
  );

  const isFriendOnline = useCallback(
    (participantId: string) => presenceService.isOnline(participantId),
    []
  );

  const isPresenceShared = useCallback(
    (participantId: string) =>
      !!friendsRef.current.find((f) => f.participantId === participantId)?.theirPresenceCapability,
    []
  );

  // --------------------------------------------------------------------------
  // Invitations
  // --------------------------------------------------------------------------

  const refreshPendingInvites = useCallback(async () => {
    const all = await db.getPendingInvites();
    setPendingInvites(all);
    pendingInvitesRef.current = all;
    return all;
  }, []);

  const dispatchInvitesFor = useCallback(
    async (participantId: string): Promise<boolean> => {
      const current = profileRef.current;
      if (!current) return false;
      const queued = pendingInvitesRef.current.filter(
        (i) => i.recipientParticipantId === participantId && i.status !== 'declined'
      );
      if (queued.length === 0) return false;

      const signingPrivateKey = await importSigningPrivateKeyFromJwk(current.signingPrivateKeyJwk);
      const payloads: RoomInvitePayload[] = [];
      for (const record of queued) {
        payloads.push(
          await buildRoomInvite({
            inviteId: record.inviteId,
            convId: record.convId,
            roomMode: record.roomMode,
            roomSecret: record.roomSecret,
            publicJoinToken: record.publicJoinToken,
            capabilityGeneration: record.capabilityGeneration,
            channelTitle: record.channelTitle,
            recipientParticipantId: record.recipientParticipantId,
            inviter: {
              participantId: current.participantId,
              screenName: current.screenName,
              avatarName: current.avatarName,
              publicKey: current.publicKeyBase64,
              signingPublicKey: current.signingPublicKeyBase64,
              contactInfo: current.contactInfo,
            },
            signingPrivateKey,
          })
        );
      }

      const delivered = await presenceService.sendInviteBundle(
        participantId,
        queued[0].recipientPublicKey,
        payloads
      );
      if (!delivered) return false;

      for (const record of queued) {
        await db.savePendingInvite({ ...record, status: 'sent', lastAttemptAt: Date.now() });
      }
      await refreshPendingInvites();
      return true;
    },
    [refreshPendingInvites]
  );

  const dispatchInvitesRef = useRef(dispatchInvitesFor);
  dispatchInvitesRef.current = dispatchInvitesFor;

  const inviteFriendToRoom = useCallback(
    async (friend: Friend): Promise<'sent' | 'queued' | 'error'> => {
      const session = sessionsRef.current.get(activeTabIdRef.current);
      if (!session || !friend.participantId || !friend.publicKey) return 'error';

      const record: PendingInviteRecord = {
        inviteId: crypto.randomUUID(),
        recipientParticipantId: friend.participantId,
        recipientScreenName: friend.screenName,
        recipientPublicKey: normalizePublicKey(friend.publicKey),
        convId: session.convId,
        roomMode: session.roomMode,
        roomSecret: session.roomMode === 'private' ? session.roomSecret : undefined,
        publicJoinToken:
          session.roomMode === 'public' ? session.publicJoinToken || undefined : undefined,
        capabilityGeneration: session.capabilityGeneration,
        channelTitle: session.channelTitle,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      try {
        await db.savePendingInvite(record);
        await refreshPendingInvites();
        await db.savePreapproval(session.convId, friend.participantId, friend.screenName);
        session.setAutoApprove(friend.participantId);
        return (await dispatchInvitesFor(friend.participantId)) ? 'sent' : 'queued';
      } catch {
        return 'error';
      }
    },
    [dispatchInvitesFor, refreshPendingInvites]
  );

  const cancelPendingInvite = useCallback(
    async (inviteId: string) => {
      const record = pendingInvitesRef.current.find((i) => i.inviteId === inviteId);
      await db.deletePendingInvite(inviteId);
      const remaining = await refreshPendingInvites();
      if (!record) return;

      await db.deletePreapproval(record.convId, record.recipientParticipantId);
      sessionsRef.current.forEach((s) => {
        if (s.convId === record.convId) s.clearAutoApprove(record.recipientParticipantId);
      });

      const stillQueued = remaining.filter(
        (i) => i.recipientParticipantId === record.recipientParticipantId
      );
      if (stillQueued.length === 0) {
        await presenceService
          .clearInviteBundle(record.recipientParticipantId, record.recipientPublicKey)
          .catch(() => {});
      } else {
        await dispatchInvitesFor(record.recipientParticipantId);
      }
    },
    [dispatchInvitesFor, refreshPendingInvites]
  );

  const acceptIncomingInvite = useCallback(async (invite: RoomInvitePayload) => {
    presenceService.markInviteHandled(invite.inviteId);
    setIncomingInvites((prev) => prev.filter((i) => i.inviteId !== invite.inviteId));

    openTabRef.current({
      convId: invite.convId,
      roomMode: invite.roomMode,
      roomSecret: invite.roomSecret,
      publicJoinToken: invite.publicJoinToken,
      channelTitle: invite.channelTitle,
      isInitialCreator: false,
    });

    const current = profileRef.current;
    if (!current) return;

    const known = await db.getFriends();
    if (!known.some((f) => f.participantId === invite.inviter.participantId)) {
      await db.saveFriend({
        id: crypto.randomUUID(),
        participantId: invite.inviter.participantId,
        screenName: invite.inviter.screenName,
        avatarName: invite.inviter.avatarName,
        publicKey: normalizePublicKey(invite.inviter.publicKey),
        signingPublicKey: normalizePublicKey(invite.inviter.signingPublicKey),
        contactInfo: invite.inviter.contactInfo,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const all = await refreshFriends();
      const added = all.find((f) => f.participantId === invite.inviter.participantId);
      if (added) await presenceService.issueCapability(added);
    }

    try {
      const signingPrivateKey = await importSigningPrivateKeyFromJwk(current.signingPrivateKeyJwk);
      const response = await buildInviteResponse({
        inviteId: invite.inviteId,
        convId: invite.convId,
        decision: 'accepted',
        responderParticipantId: current.participantId,
        responderScreenName: current.screenName,
        responderSigningPublicKey: current.signingPublicKeyBase64,
        signingPrivateKey,
      });
      await presenceService.sendInviteResponse(
        invite.inviter.participantId,
        invite.inviter.publicKey,
        response
      );
    } catch {
      /* the join handshake still proceeds without an acknowledgement */
    }
  }, [refreshFriends]);

  const declineIncomingInvite = useCallback(async (invite: RoomInvitePayload) => {
    presenceService.markInviteHandled(invite.inviteId);
    setIncomingInvites((prev) => prev.filter((i) => i.inviteId !== invite.inviteId));

    const current = profileRef.current;
    if (!current) return;
    try {
      const signingPrivateKey = await importSigningPrivateKeyFromJwk(current.signingPrivateKeyJwk);
      const response = await buildInviteResponse({
        inviteId: invite.inviteId,
        convId: invite.convId,
        decision: 'declined',
        responderParticipantId: current.participantId,
        responderScreenName: current.screenName,
        responderSigningPublicKey: current.signingPublicKeyBase64,
        signingPrivateKey,
      });
      await presenceService.sendInviteResponse(
        invite.inviter.participantId,
        invite.inviter.publicKey,
        response
      );
    } catch {
      /* declining is best effort */
    }
  }, []);

  const handleInviteResponse = useCallback(
    async (response: RoomInviteResponsePayload) => {
      const record = pendingInvitesRef.current.find((i) => i.inviteId === response.inviteId);
      if (!record) return;

      if (response.decision === 'declined') {
        await db.deletePreapproval(record.convId, record.recipientParticipantId);
      } else {
        // Acceptance only starts the handshake; re-stamp so the window runs
        // from here, and arm every session on this room.
        await db.savePreapproval(
          record.convId,
          record.recipientParticipantId,
          record.recipientScreenName
        );
        sessionsRef.current.forEach((s) => {
          if (s.convId === record.convId) s.setAutoApprove(record.recipientParticipantId);
        });
      }

      await db.deletePendingInvite(record.inviteId);
      const remaining = await refreshPendingInvites();
      const stillQueued = remaining.filter(
        (i) => i.recipientParticipantId === record.recipientParticipantId
      );
      if (stillQueued.length === 0) {
        await presenceService
          .clearInviteBundle(record.recipientParticipantId, record.recipientPublicKey)
          .catch(() => {});
      } else {
        await dispatchInvitesFor(record.recipientParticipantId);
      }
    },
    [dispatchInvitesFor, refreshPendingInvites]
  );

  const inviteResponseRef = useRef(handleInviteResponse);
  inviteResponseRef.current = handleInviteResponse;

  // --------------------------------------------------------------------------
  // Quick messages
  // --------------------------------------------------------------------------

  const openQuickMessage = useCallback((target: QuickMessageTarget) => setQuickMessageTarget(target), []);
  const closeQuickMessage = useCallback(() => setQuickMessageTarget(null), []);
  const dismissIncomingQuickMessage = useCallback(() => {
    setIncomingQuickMessage((current) => {
      if (current) void db.ackQuickMessage(current.id, current.senderParticipantId);
      return null;
    });
  }, []);
  const replyToIncomingQuickMessage = useCallback(() => {
    setIncomingQuickMessage((current) => {
      if (current) {
        void db.ackQuickMessage(current.id, current.senderParticipantId);
        setQuickMessageTarget({
          participantId: current.senderParticipantId,
          screenName: current.senderScreenName,
          publicKey: current.senderPublicKey,
        });
      }
      return null;
    });
  }, []);

  const sendQuickMessage = useCallback(
    async (text: string, emotion: number, intensity: number) => {
      const current = profileRef.current;
      if (!current || !quickMessageTarget) return false;
      const trimmed = text.trim();
      if (!trimmed) return false;

      let recipientPublicKey = quickMessageTarget.publicKey;
      if (!recipientPublicKey) {
        recipientPublicKey = friendsRef.current.find(
          (f) => f.participantId === quickMessageTarget.participantId
        )?.publicKey;
      }
      if (!recipientPublicKey) {
        for (const session of sessionsRef.current.values()) {
          const participant = session.participantsMap.get(quickMessageTarget.participantId);
          if (participant?.publicKey) {
            recipientPublicKey = participant.publicKey;
            break;
          }
        }
      }
      if (!recipientPublicKey) return false;

      const { buildQuickMessage } = await import('../services/v3/packets');
      const signingPrivateKey = await importSigningPrivateKeyFromJwk(current.signingPrivateKeyJwk);
      const message = await buildQuickMessage({
        senderParticipantId: current.participantId,
        senderScreenName: current.screenName,
        senderAvatarName: current.avatarName || 'Armando',
        senderPublicKey: current.publicKeyBase64,
        senderSigningPublicKey: current.signingPublicKeyBase64,
        recipientParticipantId: quickMessageTarget.participantId,
        text: trimmed,
        emotion,
        intensity,
        signingPrivateKey,
      });

      // One signed message through the sealed inbox [N-03].
      return presenceService.sendQuickMessage(
        quickMessageTarget.participantId,
        recipientPublicKey,
        message
      );
    },
    [quickMessageTarget]
  );

  // --------------------------------------------------------------------------
  // Favourites and directory
  // --------------------------------------------------------------------------

  const favoriteId = activeTab
    ? `${activeTab.roomMode}::${activeTab.convId}`
    : '';
  const isFavoriteRoom = favoriteRooms.some((r) => r.id === favoriteId);

  const toggleFavoriteRoom = useCallback(async () => {
    const session = sessionsRef.current.get(activeTabIdRef.current);
    if (!session) return;
    const id = `${session.roomMode}::${session.convId}`;
    if (favoriteRooms.some((r) => r.id === id)) {
      await db.deleteFavorite(id);
    } else {
      await db.saveFavorite({
        id,
        convId: session.convId,
        roomMode: session.roomMode,
        roomSecret: session.roomMode === 'private' ? session.roomSecret : undefined,
        publicJoinToken: session.publicJoinToken ?? undefined,
        capabilityGeneration: session.capabilityGeneration,
        name: session.channelTitle,
        members: Array.from(session.participantsMap.values()).map((p) => ({
          participantId: p.participantId,
          screenName: p.screenName,
          avatarName: p.avatarName,
        })),
        membersUpdatedAt: Date.now(),
        savedAt: Date.now(),
      });
    }
    setFavoriteRooms(await db.getFavorites());
  }, [favoriteRooms]);

  const removeFavoriteRoom = useCallback(async (id: string) => {
    await db.deleteFavorite(id);
    setFavoriteRooms(await db.getFavorites());
  }, []);

  const openFavoriteRoom = useCallback((record: FavoriteRoomRecord) => {
    openTabRef.current({
      convId: record.convId,
      roomMode: record.roomMode,
      roomSecret: record.roomSecret,
      publicJoinToken: record.publicJoinToken,
      channelTitle: record.name,
      isInitialCreator: false,
    });
  }, []);

  const refreshPublicRoomsList = useCallback(async () => {
    const rooms = await directoryService.fetchRooms();
    setPublicRoomsList(rooms);
    return rooms;
  }, []);

  const createPublicRoom = useCallback(
    async (name: string, description?: string, tags?: string[], language?: string) => {
      const current = profileRef.current;
      if (!current) throw new Error('Profile not initialised');

      const convId = crypto.randomUUID();
      const joinToken = generateRoomSecret();
      const publicRoomId = await derivePublicRoomId(convId, joinToken);
      const signingPrivateKey = await importSigningPrivateKeyFromJwk(current.signingPrivateKeyJwk);

      const descriptor = await buildPublicRoomDescriptor({
        publicRoomId,
        convId,
        publicJoinToken: joinToken,
        name: name.trim(),
        description: description || '',
        creatorId: current.participantId,
        creatorScreenName: current.screenName,
        creatorSigningPublicKey: current.signingPublicKeyBase64,
        signingPrivateKey,
        tags,
        language,
      });

      await directoryService.publishDescriptor({
        descriptor,
        signingPrivateKeyJwk: current.signingPrivateKeyJwk,
      });

      localStorage.setItem(`aircomic_channel_title_${convId}`, name.trim());
      return openTabRef.current({
        convId,
        roomMode: 'public',
        publicJoinToken: joinToken,
        channelTitle: name.trim(),
        isInitialCreator: true,
      });
    },
    []
  );

  // --------------------------------------------------------------------------
  // Relay configuration
  // --------------------------------------------------------------------------

  const setRelayUrls = useCallback(async (urls: string[]) => {
    const saved = await saveRelayUrls(urls);
    setRelayUrlsState(saved);
    relayPool.configure(saved);
  }, []);

  const setWebrtcEnabled = useCallback(async (enabled: boolean) => {
    await saveWebrtcEnabled(enabled);
    setWebrtcEnabledState(enabled);
  }, []);

  const refreshRelays = useCallback(() => rerender(), [rerender]);
  const reconnectRelays = useCallback(async () => {
    relayPool.configure(relayUrls);
    await outbox.drain();
    rerender();
  }, [relayUrls, rerender]);

  // --------------------------------------------------------------------------
  // Active-room passthroughs
  // --------------------------------------------------------------------------

  const participants = useMemo(
    () => (activeSession ? Array.from(activeSession.participantsMap.values()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeSession, activeSession?.participantsMap.size, activeTabId]
  );

  const approveJoinRequest = useCallback(async (requestOrId: PendingJoinRequest | string) => {
    const session = sessionsRef.current.get(activeTabIdRef.current);
    if (!session) return false;
    const id = typeof requestOrId === 'string' ? requestOrId : requestOrId.requestId;
    return session.approveJoinRequest(id);
  }, []);

  const value: ChatContextType = {
    profile,
    friends,
    updateProfile,
    regenerateKeypair,
    importProfileFromJson,
    exportProfileAsJson,
    addFriend,
    updateFriend,
    deleteFriend,
    fingerprint,

    friendPresence,
    isFriendOnline,
    isPresenceShared,
    pendingInvites,
    inviteFriendToRoom,
    cancelPendingInvite,
    incomingInvites,
    acceptIncomingInvite,
    declineIncomingInvite,

    incomingQuickMessage,
    quickMessageTarget,
    openQuickMessage,
    closeQuickMessage,
    dismissIncomingQuickMessage,
    replyToIncomingQuickMessage,
    sendQuickMessage,

    tabs,
    activeTabId,
    openTab,
    closeTab,
    switchTab,
    createPrivateRoomTab,
    joinRoomByUrlOrSecret,
    joinPublicRoomTab,

    convId: activeSession?.convId ?? activeTab?.convId ?? '',
    roomMode: activeSession?.roomMode ?? activeTab?.roomMode ?? 'private',
    roomSecret: activeSession?.roomSecret ?? '',
    publicJoinToken: activeSession?.publicJoinToken ?? null,
    publicRoomId: activeSession?.publicRoomId ?? null,
    isInitialCreator: activeSession?.isInitialCreator ?? false,
    channelTitle: activeSession?.channelTitle ?? activeTab?.channelTitle ?? '',
    updateChannelTitle: async (title) => (await activeSession?.updateChannelTitle(title)) ?? false,
    connectionStatus: activeSession?.connectionStatus ?? 'connecting',
    accelerationStatus: activeSession?.accelerationStatus ?? 'unavailable',
    connectedPeersCount: activeSession?.connectedPeersCount ?? 0,
    relayStatuses: relayPool.getHealth(),
    participantsMap: activeSession?.participantsMap ?? new Map(),
    participants,
    messages: activeSession?.messages ?? [],
    sendMessage: async (text, options) =>
      (await activeSession?.sendMessage(text, options)) ?? false,
    activeKeyId: activeSession?.activeKeyId ?? '',
    activeEpoch: activeSession?.activeEpoch ?? 0,
    isApproved: activeSession?.isApproved ?? false,
    isRekeying: activeSession?.isRekeying ?? false,
    roomFingerprint: activeSession?.roomFingerprint ?? '',
    memberCount: activeSession?.memberCount ?? 0,
    capabilityGeneration: activeSession?.capabilityGeneration ?? 0,
    pendingSendCount: activeSession?.pendingSendCount ?? 0,
    failedSendCount: activeSession?.failedSendCount ?? 0,
    approximateOccupancy: activeSession?.approximateOccupancy ?? null,
    pendingJoinRequests: activeSession?.pendingJoinRequests ?? [],
    sendJoinRequest: async () => (await activeSession?.retryJoinRequest()) ?? false,
    approveJoinRequest,
    declineJoinRequest: (requestId) => activeSession?.declineJoinRequest(requestId),
    removeParticipant: async (participantId) =>
      (await activeSession?.removeParticipant(participantId)) ?? false,
    rekeyConversation: async () => (await activeSession?.rekeyConversation()) ?? false,
    clearHistory: async () => {
      await activeSession?.clearHistory();
    },
    isSecretMissing: activeSession?.isSecretMissing ?? false,
    provideRoomSecret: (input) => void activeSession?.provideRoomSecret(input),
    inviteUrl: activeSession?.inviteUrl ?? '',
    refreshRelays,
    reconnectRelays,

    relayUrls,
    setRelayUrls,
    webrtcEnabled,
    setWebrtcEnabled,

    zoomLevel,
    setZoomLevel,

    favoriteRooms,
    isFavoriteRoom,
    toggleFavoriteRoom,
    removeFavoriteRoom,
    openFavoriteRoom,

    publicRoomsList,
    refreshPublicRoomsList,
    createPublicRoom,
    joinPublicRoom: joinPublicRoomTab,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
