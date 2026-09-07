import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import {
  UNTITLED_CHANNEL_TITLE,
  getOrInitChannelTitle,
  getRandomChannelTitle,
  getStoredChannelDescription,
  getStoredChannelTitle,
  rememberChannelDescription,
  rememberChannelTitle,
} from '../utils/channelNameGenerator';
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
import { deserializeChain, wasRemoved } from '../services/v3/epochChain';

const STORAGE_KEY_TABS = 'aircomic_open_tabs';
const STORAGE_KEY_ACTIVE_TAB = 'aircomic_active_tab';

/** Shared so a room-less render does not hand consumers a new array each time. */
const EMPTY_PARTICIPANTS: Participant[] = [];

interface OpenTabConfig {
  convId?: string;
  roomMode?: RoomMode;
  roomSecret?: string;
  publicJoinToken?: string;
  channelTitle?: string;
  channelDescription?: string;
  isInitialCreator?: boolean;
}

/**
 * The room named by the current address, or null when the address names none.
 * A join link is a normal URL, so it must work pasted into the address bar and
 * not only through the join dialog.
 */
function readRoomFromLocation(): OpenTabConfig | null {
  if (typeof window === 'undefined') return null;

  const params = new URLSearchParams(window.location.search);
  const convId = params.get('id')?.trim();
  if (!convId) return null;

  if (params.get('public') === '1' || params.get('public') === 'true') {
    return {
      convId,
      roomMode: 'public',
      publicJoinToken: params.get('join') || undefined,
      isInitialCreator: false,
    };
  }

  // An empty secret is deliberate: it means we genuinely cannot compute the
  // routing tag, which is what the missing-secret dialog explains. Leaving it
  // undefined would silently mint a new secret and a room nobody else is in.
  return {
    convId,
    roomMode: 'private',
    roomSecret: window.location.hash.match(/secret=([A-Za-z0-9_-]+)/)?.[1] ?? '',
    isInitialCreator: false,
  };
}

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
  hideIncomingQuickMessage: () => void;
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
    channelDescription?: string;
    isInitialCreator?: boolean;
  }) => string;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  createPrivateRoomTab: (title?: string, description?: string) => string;
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
  channelDescription: string;
  updateChannelTitle: (newTitle: string, newDescription?: string) => Promise<boolean>;
  /** False when this identity may not rename the room, e.g. a public room
   *  they did not create [PU-02]. */
  canRenameRoom: boolean;
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
      const payload = JSON.stringify(next);
      localStorage.setItem(STORAGE_KEY_TABS, payload);
      sessionStorage.setItem(STORAGE_KEY_TABS, payload);
    } catch {
      /* storage is a convenience only */
    }
  }, []);

  const persistActiveTab = useCallback((tabId: string, convId?: string) => {
    try {
      const payload = JSON.stringify({ tabId, convId });
      localStorage.setItem(STORAGE_KEY_ACTIVE_TAB, payload);
      sessionStorage.setItem(STORAGE_KEY_ACTIVE_TAB, payload);
    } catch {
      /* storage is a convenience only */
    }
  }, []);

  const omitRoomRef = useRef<(tabId: string) => void>(() => {});

  /**
   * A room's name and its secret are decided by the room, not by the tab that
   * happens to display it: the title arrives in a room_metadata packet and the
   * secret is replaced by every capability rotation. Push both back into the
   * tab record so the tab strip, the restored session and the address bar all
   * agree with what the session actually holds.
   */
  const syncTabFromSession = useCallback(
    (session: RoomSession) => {
      const current = tabsRef.current.find((t) => t.tabId === session.tabId);
      if (!current) return;

      const channelTitle = session.channelTitle?.trim() || current.channelTitle;
      const channelDescription = session.channelDescription !== undefined ? session.channelDescription : (current.channelDescription || '');
      const roomSecret =
        session.roomMode === 'private' && session.roomSecret
          ? session.roomSecret
          : current.roomSecret;
      const isInitialCreator = session.isInitialCreator || current.isInitialCreator;
      if (
        channelTitle === current.channelTitle &&
        channelDescription === current.channelDescription &&
        roomSecret === current.roomSecret &&
        isInitialCreator === current.isInitialCreator
      ) {
        return;
      }

      const updated = { ...current, channelTitle, channelDescription, roomSecret, isInitialCreator };
      const next = tabsRef.current.map((t) => (t.tabId === session.tabId ? updated : t));
      tabsRef.current = next;
      setTabs(next);
      persistTabs(next);
      rememberChannelTitle(updated.convId, channelTitle);
      if (channelDescription) rememberChannelDescription(updated.convId, channelDescription);
      if (session.tabId === activeTabIdRef.current) syncBrowserUrl(updated);
    },
    [persistTabs, syncBrowserUrl]
  );

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
          channelDescription: tab.channelDescription,
        },
        {
          onStateChange: (s) => {
            if (s.isRemoved || s.isGone) {
              omitRoomRef.current(s.tabId);
              return;
            }
            syncTabFromSession(s);
            rerender();
          },
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
          onRemoved: (s) => {
            omitRoomRef.current(s.tabId);
          },
          onRoomGone: (s) => {
            omitRoomRef.current(s.tabId);
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
    [rerender, syncTabFromSession]
  );

  const activeSession = sessionsRef.current.get(activeTabId) ?? null;
  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  /** Only one private room may hold the WebRTC mesh at a time [R-03]. */
  const switchTab = useCallback(
    (tabId: string) => {
      const target = tabsRef.current.find((t) => t.tabId === tabId);
      if (!target) return;

      sessionsRef.current.forEach((session, id) => session.setForeground(id === tabId));

      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      persistActiveTab(tabId, target.convId);
      setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, unreadCount: 0 } : t)));
      syncBrowserUrl(target);
      rerender();
    },
    [persistActiveTab, syncBrowserUrl, rerender]
  );

  const openTab = useCallback(
    (config: OpenTabConfig): string => {
      const mode = config.roomMode || 'private';
      const convId = config.convId?.trim() || crypto.randomUUID();
      const isInitialCreator = config.isInitialCreator ?? !config.convId;

      const existing = tabsRef.current.find(
        (t) =>
          t.convId === convId &&
          (mode === 'private' || t.publicJoinToken === config.publicJoinToken)
      );
      if (existing) {
        // A link that carries the secret repairs a room opened without one,
        // rather than dropping the user back into the missing-secret dialog.
        if (mode === 'private' && config.roomSecret && !existing.roomSecret) {
          const repaired = { ...existing, roomSecret: config.roomSecret };
          const next = tabsRef.current.map((t) => (t.tabId === existing.tabId ? repaired : t));
          tabsRef.current = next;
          setTabs(next);
          persistTabs(next);
          void sessionsRef.current.get(existing.tabId)?.provideRoomSecret(config.roomSecret);
        }
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
        isInitialCreator,
        // Only a creator names a room. A joiner waits for the room's own
        // metadata instead of generating a title nobody else can see [M-01].
        channelTitle:
          config.channelTitle?.trim() ||
          getStoredChannelTitle(convId) ||
          (isInitialCreator ? getOrInitChannelTitle(convId) : UNTITLED_CHANNEL_TITLE),
        channelDescription:
          config.channelDescription !== undefined
            ? config.channelDescription
            : (getStoredChannelDescription(convId) || ''),
        unreadCount: 0,
      };

      getOrCreateSession(tab);
      const next = [...tabsRef.current, tab];
      tabsRef.current = next;
      setTabs(next);
      persistTabs(next);
      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      persistActiveTab(tabId, tab.convId);
      sessionsRef.current.forEach((session, id) => session.setForeground(id === tabId));
      syncBrowserUrl(tab);
      rerender();
      return tabId;
    },
    [getOrCreateSession, persistTabs, persistActiveTab, switchTab, syncBrowserUrl, rerender]
  );

  const openTabRef = useRef(openTab);
  openTabRef.current = openTab;

  const omitRoom = useCallback(
    (tabId: string) => {
      sessionsRef.current.get(tabId)?.destroy();
      sessionsRef.current.delete(tabId);

      const remaining = tabsRef.current.filter((t) => t.tabId !== tabId);
      tabsRef.current = remaining;
      setTabs(remaining);
      persistTabs(remaining);

      if (remaining.length === 0) {
        openTabRef.current({ roomMode: 'private', isInitialCreator: true });
        return;
      }
      if (activeTabIdRef.current === tabId) {
        switchTab(remaining[remaining.length - 1].tabId);
      } else {
        const currentActive = remaining.find((t) => t.tabId === activeTabIdRef.current);
        if (currentActive) persistActiveTab(currentActive.tabId, currentActive.convId);
        rerender();
      }
    },
    [persistTabs, persistActiveTab, switchTab, rerender]
  );
  omitRoomRef.current = omitRoom;

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
      if (activeTabIdRef.current === tabId) {
        switchTab(remaining[remaining.length - 1].tabId);
      } else {
        const currentActive = remaining.find((t) => t.tabId === activeTabIdRef.current);
        if (currentActive) persistActiveTab(currentActive.tabId, currentActive.convId);
      }
    },
    [persistTabs, persistActiveTab, switchTab]
  );

  const createPrivateRoomTab = useCallback(
    (title?: string, description?: string) => {
      const convId = crypto.randomUUID();
      const effTitle = title || getRandomChannelTitle();
      const effDesc = description || '';
      rememberChannelTitle(convId, effTitle);
      if (effDesc) rememberChannelDescription(convId, effDesc);
      return openTabRef.current({
        convId,
        roomMode: 'private',
        channelTitle: effTitle,
        channelDescription: effDesc,
        isInitialCreator: true,
      });
    },
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
        const rawTabs =
          sessionStorage.getItem(STORAGE_KEY_TABS) || localStorage.getItem(STORAGE_KEY_TABS);
        restored = JSON.parse(rawTabs || '[]');
      } catch {
        restored = [];
      }

      // Filter out invalid tabs or private rooms without secrets
      restored = restored.filter((tab) => {
        if (!tab || !tab.convId || !tab.tabId) return false;
        if (tab.roomMode === 'private' && !tab.roomSecret?.trim()) return false;
        return true;
      });

      // Filter out private rooms where stored local chain already records that the user was removed
      const validRestored: RoomTab[] = [];
      for (const tab of restored) {
        if (tab.roomMode === 'private') {
          const storedChain = await db.getChain(tab.convId);
          if (storedChain) {
            const chain = deserializeChain(storedChain);
            if (wasRemoved(chain, loaded.participantId)) {
              continue; // Omitted! User was removed
            }
          }
        }
        validRestored.push(tab);
      }
      restored = validRestored;

      let savedActive: { tabId?: string; convId?: string } | null = null;
      try {
        const rawActive =
          sessionStorage.getItem(STORAGE_KEY_ACTIVE_TAB) || localStorage.getItem(STORAGE_KEY_ACTIVE_TAB);
        if (rawActive) savedActive = JSON.parse(rawActive);
      } catch {
        savedActive = null;
      }

      const urlRoom = readRoomFromLocation();

      if (restored.length > 0) {
        tabsRef.current = restored;
        setTabs(restored);
        persistTabs(restored);
        restored.forEach(getOrCreateSession);

        const activeTabToSelect =
          (savedActive &&
            (restored.find((t) => t.tabId === savedActive?.tabId) ||
             restored.find((t) => t.convId === savedActive?.convId))) ||
          restored[0];

        setActiveTabId(activeTabToSelect.tabId);
        activeTabIdRef.current = activeTabToSelect.tabId;
        persistActiveTab(activeTabToSelect.tabId, activeTabToSelect.convId);
        sessionsRef.current.get(activeTabToSelect.tabId)?.setForeground(true);

        // A link pasted into the address bar of a window that already has rooms
        // open is still a request to open that room: restoring the session must
        // not swallow it. openTab switches to the room if it is already here.
        if (urlRoom) openTabRef.current(urlRoom);
        else syncBrowserUrl(activeTabToSelect);
      } else {
        openTabRef.current(urlRoom ?? { roomMode: 'private', isInitialCreator: true });
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

  /**
   * The sessions and the presence service each hold their own copy of the
   * profile, taken when they started. Nothing else tells them a name or an
   * avatar changed, so an edit has to be handed to them here.
   */
  const propagateProfile = useCallback(async (next: UserProfile) => {
    await presenceService.applyProfile(next);
    await Promise.all(
      Array.from(sessionsRef.current.values()).map((session) => session.applyProfile(next))
    );
    rerender();
  }, [rerender]);

  const updateProfile = useCallback(async (updates: Partial<UserProfile>) => {
    const current = profileRef.current;
    if (!current) return;
    const next = { ...current, ...updates, updatedAt: Date.now() };
    await db.saveProfile(next);
    setProfile(next);
    profileRef.current = next;
    await propagateProfile(next);
  }, [propagateProfile]);

  const regenerateKeypair = useCallback(async () => {
    const current = profileRef.current;
    if (!current) return;
    const next = await db.replaceIdentity(current);
    setProfile(next);
    profileRef.current = next;
    setFingerprint(await getPublicKeyFingerprint(next.signingPublicKeyBase64));
    await propagateProfile(next);
  }, [propagateProfile]);

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
      await propagateProfile(next);
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
  /**
   * Acknowledged for good: the popup does not come back after a reload.
   * Reserved for gestures that say the user actually read it.
   */
  const dismissIncomingQuickMessage = useCallback(() => {
    setIncomingQuickMessage((current) => {
      if (current) {
        void presenceService.ackQuickMessage(current.id, current.senderParticipantId);
      }
      return null;
    });
  }, []);
  /**
   * Taken off the screen without acknowledging it. A click that lands anywhere
   * else may well have been aimed at the page underneath, so the message is
   * left unread and shown again on the next visit.
   */
  const hideIncomingQuickMessage = useCallback(() => setIncomingQuickMessage(null), []);
  const replyToIncomingQuickMessage = useCallback(() => {
    setIncomingQuickMessage((current) => {
      if (current) {
        void presenceService.ackQuickMessage(current.id, current.senderParticipantId);
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
        description: session.channelDescription || undefined,
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
      channelDescription: record.description,
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
      if (description) {
        rememberChannelDescription(convId, description.trim());
      }
      return openTabRef.current({
        convId,
        roomMode: 'public',
        publicJoinToken: joinToken,
        channelTitle: name.trim(),
        channelDescription: description?.trim() || '',
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

  // `RoomSession` replaces this array on every roster change, so no memo is
  // needed and none may be used: keying one on the map's size would miss a
  // rename, a new avatar or a status flip.
  const participants = activeSession?.participants ?? EMPTY_PARTICIPANTS;

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
    hideIncomingQuickMessage,
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
    channelDescription: activeSession?.channelDescription ?? activeTab?.channelDescription ?? '',
    updateChannelTitle: async (title, description) => {
      if (!activeSession) return false;
      const ok = await activeSession.updateChannelTitle(title, description);
      if (ok && activeSession.convId) {
        rememberChannelTitle(activeSession.convId, title);
        if (description !== undefined) {
          rememberChannelDescription(activeSession.convId, description);
        }
      }
      return ok;
    },
    canRenameRoom: activeSession?.canRenameRoom ?? false,
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
