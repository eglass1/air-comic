import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import type {
  UserProfile,
  Friend,
  Participant,
  ChatMessage,
  KeyRecord,
  PendingJoinRequest,
  RelaySocketStatus,
  RoomMode,
  RoomTab,
  PublicRoomDescriptorPacket,
  FriendPresence,
  PendingInviteRecord,
  RoomInvitePayload,
  RoomInviteResponsePayload,
} from '../types';
import {
  generateRandomRoomSecret,
  derivePublicRoomId,
  createSignedPublicRoomDescriptor,
  importPrivateKeyFromJwk,
  importSigningPrivateKeyFromJwk,
  normalizePublicKey,
  generateUserKeyPair,
  getParticipantId,
  getPublicKeyFingerprint,
  createSignedRoomInvite,
  createSignedInviteResponse,
} from '../services/crypto';
import { getRandomChannelTitle, getOrInitChannelTitle } from '../utils/channelNameGenerator';
import { dbService } from '../services/db';
import { publicDirectoryService } from '../services/publicDirectory';
import { presenceService } from '../services/presence';
import { RoomSession } from '../services/roomSession';

export interface ChatContextType {
  // Profile & Friends
  profile: UserProfile | null;
  friends: Friend[];
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;
  regenerateKeypair: () => Promise<void>;
  importProfileFromJson: (jsonStr: string) => Promise<boolean>;
  exportProfileAsJson: () => string;
  addFriend: (friend: Omit<Friend, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateFriend: (friend: Friend) => Promise<void>;
  deleteFriend: (id: string) => Promise<void>;

  // Friend presence & direct invites
  friendPresence: Map<string, FriendPresence>;
  isFriendOnline: (participantId: string) => boolean;
  pendingInvites: PendingInviteRecord[];
  inviteFriendToRoom: (friend: Friend) => Promise<'sent' | 'queued' | 'error'>;
  cancelPendingInvite: (inviteId: string) => Promise<void>;
  incomingInvites: RoomInvitePayload[];
  acceptIncomingInvite: (invite: RoomInvitePayload) => Promise<void>;
  declineIncomingInvite: (invite: RoomInvitePayload) => Promise<void>;

  // Multi-Tab Conversations
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
  createPublicRoomTab: (
    name: string,
    description?: string,
    tags?: string[],
    language?: string
  ) => Promise<string>;

  // Active Room State (proxied from active room session)
  convId: string;
  roomMode: RoomMode;
  roomSecret: string;
  publicJoinToken: string | null;
  publicRoomId: string | null;
  isInitialCreator: boolean;
  channelTitle: string;
  updateChannelTitle: (newTitle: string) => Promise<boolean>;
  connectionStatus: 'connected' | 'connecting' | 'disconnected' | 'error';
  connectedPeersCount: number;
  relayStatuses: RelaySocketStatus[];
  participantsMap: Map<string, Participant>;
  participants: Participant[];
  messages: ChatMessage[];
  sendMessage: (
    text: string,
    options?: { emotion?: number; emotionIntensity?: number; balloonMode?: 'say' | 'whisper' | 'think' | 'action' }
  ) => Promise<boolean>;
  activeKeyId: string;
  activeEpoch: number;
  isApproved: boolean;
  isRekeying: boolean;
  rootFingerprint: string;
  channelOwnerName: string | null;
  pendingJoinRequests: PendingJoinRequest[];
  sendJoinRequest: () => Promise<boolean>;
  approveJoinRequest: (requestOrId: PendingJoinRequest | string) => Promise<boolean>;
  declineJoinRequest: (requestId: string) => void;
  removeParticipant: (participantId: string, screenName?: string) => Promise<boolean>;
  rekeyConversation: () => Promise<boolean>;
  claimConversation: () => Promise<boolean>;
  clearHistory: () => Promise<void>;
  isSecretMissing: boolean;
  provideRoomSecret: (input: string) => void;
  inviteUrl: string;
  switchConversation: (newId: string, newSecret?: string) => void;
  refreshRelays: () => void;
  reconnectRelays: () => Promise<void>;

  // Comic Strip Zoom Level
  zoomLevel: number;
  setZoomLevel: React.Dispatch<React.SetStateAction<number>>;

  // Public Directory
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
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
};

const STORAGE_KEY_TABS = 'aircomic_open_tabs';

export const ChatProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [publicRoomsList, setPublicRoomsList] = useState<PublicRoomDescriptorPacket[]>([]);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);

  const [friendPresence, setFriendPresence] = useState<Map<string, FriendPresence>>(new Map());
  const [pendingInvites, setPendingInvites] = useState<PendingInviteRecord[]>([]);
  const [incomingInvites, setIncomingInvites] = useState<RoomInvitePayload[]>([]);
  const pendingInvitesRef = useRef<PendingInviteRecord[]>([]);
  pendingInvitesRef.current = pendingInvites;

  const privateKeyRef = useRef<CryptoKey | null>(null);
  const signingPrivateKeyRef = useRef<CryptoKey | null>(null);
  const profileRef = useRef<UserProfile | null>(null);
  profileRef.current = profile;

  // Multi-tab state
  const [tabs, setTabs] = useState<RoomTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const sessionsMapRef = useRef<Map<string, RoomSession>>(new Map());
  const activeTabIdRef = useRef<string>('');
  activeTabIdRef.current = activeTabId;

  // State tick to trigger re-renders when active session state changes
  const [sessionTick, setSessionTick] = useState<number>(0);
  const refreshActiveSessionView = useCallback(() => {
    setSessionTick((t) => (t + 1) % 1000000);
  }, []);

  // Update browser URL query/hash to reflect active tab
  const syncBrowserUrl = useCallback((tab: RoomTab) => {
    if (typeof window === 'undefined') return;
    try {
      if (tab.roomMode === 'public') {
        const newSearch = `?id=${encodeURIComponent(tab.convId)}&public=1&join=${encodeURIComponent(tab.publicJoinToken || '')}`;
        window.history.replaceState(null, '', newSearch);
      } else {
        const newSearch = `?id=${encodeURIComponent(tab.convId)}`;
        const newHash = tab.roomSecret ? `#secret=${encodeURIComponent(tab.roomSecret)}` : '';
        window.history.replaceState(null, '', `${newSearch}${newHash}`);
      }
    } catch (err) {
      console.warn('Failed to sync browser URL:', err);
    }
  }, []);

  // Initialize or attach a RoomSession
  const getOrCreateSession = useCallback(
    (tab: RoomTab): RoomSession => {
      const existing = sessionsMapRef.current.get(tab.tabId);
      if (existing) return existing;

      const session = new RoomSession(
        {
          tabId: tab.tabId,
          convId: tab.convId,
          roomMode: tab.roomMode,
          roomSecret: tab.roomSecret,
          publicJoinToken: tab.publicJoinToken,
          publicRoomId: tab.publicRoomId,
          isInitialCreator: tab.isInitialCreator,
          channelTitle: tab.channelTitle,
        },
        (updatedSession) => {
          // Sync channel title back to tab if changed
          if (updatedSession.channelTitle !== tab.channelTitle) {
            tab.channelTitle = updatedSession.channelTitle;
            setTabs((prev) =>
              prev.map((t) => (t.tabId === tab.tabId ? { ...t, channelTitle: updatedSession.channelTitle } : t))
            );
          }
          if (updatedSession.tabId === activeTabIdRef.current) {
            refreshActiveSessionView();
          }
        },
        (msgSession, msg) => {
          // If background tab, increment unread count
          if (msgSession.tabId !== activeTabIdRef.current && !msg.isSelf) {
            setTabs((prev) =>
              prev.map((t) => (t.tabId === msgSession.tabId ? { ...t, unreadCount: t.unreadCount + 1 } : t))
            );
          }
          if (msgSession.tabId === activeTabIdRef.current) {
            refreshActiveSessionView();
          }
        }
      );

      sessionsMapRef.current.set(tab.tabId, session);

      // Anyone we already invited into this room is admitted without prompting,
      // including across a page reload where the queue is reloaded from IndexedDB.
      pendingInvitesRef.current
        .filter((invite) => invite.convId === tab.convId && invite.status !== 'declined')
        .forEach((invite) => session.setAutoApprove(invite.recipientParticipantId));

      // If keys and profile are already loaded, init session
      if (profileRef.current && privateKeyRef.current && signingPrivateKeyRef.current) {
        session.init(profileRef.current, privateKeyRef.current, signingPrivateKeyRef.current).then(() => {
          refreshActiveSessionView();
        });
      }

      return session;
    },
    [refreshActiveSessionView]
  );

  // Switch active tab
  const switchTab = useCallback(
    (tabId: string) => {
      const target = tabs.find((t) => t.tabId === tabId);
      if (!target) return;

      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;

      // Clear unread count for activated tab
      setTabs((prev) =>
        prev.map((t) => (t.tabId === tabId ? { ...t, unreadCount: 0 } : t))
      );

      syncBrowserUrl(target);
      refreshActiveSessionView();
    },
    [tabs, syncBrowserUrl, refreshActiveSessionView]
  );

  // Open a new or existing tab
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
      const cId = config.convId && config.convId.trim() ? config.convId.trim() : crypto.randomUUID();

      // Check if already open
      const existing = tabs.find(
        (t) => t.convId === cId && (mode === 'private' || t.publicJoinToken === config.publicJoinToken)
      );
      if (existing) {
        switchTab(existing.tabId);
        return existing.tabId;
      }

      const tabId = crypto.randomUUID();
      const secret = mode === 'private' ? (config.roomSecret !== undefined ? config.roomSecret : generateRandomRoomSecret()) : '';
      const joinToken = mode === 'public' ? (config.publicJoinToken || generateRandomRoomSecret()) : undefined;
      const title = config.channelTitle || getOrInitChannelTitle(cId);
      const isCreator = config.isInitialCreator ?? (!config.convId || config.convId.length === 0);

      const newTab: RoomTab = {
        tabId,
        convId: cId,
        roomMode: mode,
        roomSecret: secret,
        publicJoinToken: joinToken,
        isInitialCreator: isCreator,
        channelTitle: title,
        unreadCount: 0,
      };

      const session = getOrCreateSession(newTab);
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      syncBrowserUrl(newTab);

      // Save tabs in session storage
      try {
        const currentTabs = [...tabs, newTab];
        sessionStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(currentTabs));
      } catch {}

      refreshActiveSessionView();
      return tabId;
    },
    [tabs, switchTab, getOrCreateSession, syncBrowserUrl, refreshActiveSessionView]
  );

  // openTab is recreated on every tab change; callbacks below reach it via this ref.
  const openTabRef = useRef<typeof openTab | null>(null);
  openTabRef.current = openTab;

  // Close a tab
  const closeTab = useCallback(
    (tabId: string) => {
      const session = sessionsMapRef.current.get(tabId);
      if (session) {
        session.destroy();
        sessionsMapRef.current.delete(tabId);
      }

      const remaining = tabs.filter((t) => t.tabId !== tabId);
      if (remaining.length === 0) {
        // Automatically create a fresh tab if all closed
        setTabs([]);
        const freshTabId = openTab({ roomMode: 'private' });
        return;
      }

      setTabs(remaining);
      try {
        sessionStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(remaining));
      } catch {}

      if (activeTabId === tabId) {
        const nextTab = remaining[remaining.length - 1];
        switchTab(nextTab.tabId);
      }
    },
    [tabs, activeTabId, openTab, switchTab]
  );

  // Convenience tab creators
  const createPrivateRoomTab = useCallback(
    (title?: string): string => {
      const newConvId = crypto.randomUUID();
      const newSecret = generateRandomRoomSecret();
      const generatedTitle = title?.trim() || getRandomChannelTitle();
      localStorage.setItem(`aircomic_channel_title_${newConvId}`, generatedTitle);

      return openTab({
        convId: newConvId,
        roomSecret: newSecret,
        roomMode: 'private',
        channelTitle: generatedTitle,
        isInitialCreator: true,
      });
    },
    [openTab]
  );

  const joinRoomByUrlOrSecret = useCallback(
    (input: string): string | null => {
      const trimmed = input.trim();
      if (!trimmed) return null;

      let convId = '';
      let roomSecret = '';
      let roomMode: RoomMode = 'private';
      let publicJoinToken = '';

      try {
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          const url = new URL(trimmed);
          const params = url.searchParams;
          convId = params.get('id') || '';
          if (params.get('public') === '1' || params.get('public') === 'true') {
            roomMode = 'public';
            publicJoinToken = params.get('join') || '';
          } else {
            const hash = url.hash;
            const match = hash.match(/secret=([A-Za-z0-9_-]+)/);
            if (match && match[1]) roomSecret = match[1];
            if (!roomSecret && params.get('secret')) roomSecret = params.get('secret') || '';
          }
        } else if (trimmed.includes('?id=') || trimmed.includes('&id=')) {
          const searchPart = trimmed.includes('?') ? trimmed.split('?')[1] : trimmed;
          const params = new URLSearchParams(searchPart);
          convId = params.get('id') || '';
          if (params.get('public') === '1' || params.get('public') === 'true') {
            roomMode = 'public';
            publicJoinToken = params.get('join') || '';
          } else {
            const match = trimmed.match(/secret=([A-Za-z0-9_-]+)/);
            if (match && match[1]) roomSecret = match[1];
          }
        } else if (trimmed.includes('#secret=') || trimmed.includes('secret=')) {
          const match = trimmed.match(/secret=([A-Za-z0-9_-]+)/);
          if (match && match[1]) roomSecret = match[1];
        } else {
          // Assume ID or raw secret
          convId = trimmed;
        }

        if (convId || roomSecret || publicJoinToken) {
          return openTab({
            convId: convId || crypto.randomUUID(),
            roomMode,
            roomSecret,
            publicJoinToken,
            isInitialCreator: false,
          });
        }
      } catch (err) {
        console.warn('Failed to parse join URL or secret:', err);
      }
      return null;
    },
    [openTab]
  );

  const joinPublicRoomTab = useCallback(
    (descriptor: PublicRoomDescriptorPacket): string => {
      return openTab({
        convId: descriptor.convId,
        roomMode: 'public',
        publicJoinToken: descriptor.publicJoinToken,
        channelTitle: descriptor.name,
        isInitialCreator: false,
      });
    },
    [openTab]
  );

  const createPublicRoomTab = useCallback(
    async (
      name: string,
      description?: string,
      tags?: string[],
      language?: string
    ): Promise<string> => {
      const currentProfile = profileRef.current;
      const signPrivKey = signingPrivateKeyRef.current;
      if (!currentProfile || !signPrivKey) throw new Error('Profile not initialized');

      const newConvId = crypto.randomUUID();
      const newJoinToken = generateRandomRoomSecret();

      const descriptor = await createSignedPublicRoomDescriptor(
        newConvId,
        newJoinToken,
        name.trim(),
        description || '',
        currentProfile.participantId,
        currentProfile.screenName,
        currentProfile.signingPublicKeyBase64,
        signPrivKey,
        {
          tags,
          language: language || 'en',
          historyPolicy: 'peer_sync',
        }
      );

      localStorage.setItem(`aircomic_channel_title_${newConvId}`, name.trim());
      await publicDirectoryService.publishDescriptor(descriptor);

      const tabId = openTab({
        convId: newConvId,
        roomMode: 'public',
        publicJoinToken: newJoinToken,
        channelTitle: name.trim(),
        isInitialCreator: true,
      });

      return tabId;
    },
    [openTab]
  );

  // Initialize DB, Profile, Keys, and Initial Tab
  useEffect(() => {
    let isMounted = true;

    async function initGlobal() {
      try {
        const loadedProfile = await dbService.getOrInitProfile();
        if (!isMounted) return;
        setProfile(loadedProfile);
        profileRef.current = loadedProfile;

        const privKey = await importPrivateKeyFromJwk(loadedProfile.privateKeyJwk);
        privateKeyRef.current = privKey;

        const signPrivKey = await importSigningPrivateKeyFromJwk(loadedProfile.signingPrivateKeyJwk);
        signingPrivateKeyRef.current = signPrivKey;

        const loadedFriends = await dbService.getFriends();
        setFriends(loadedFriends);

        // Restore the outgoing invite queue before any session is built, so
        // auto-approval is re-armed for people we invited in a previous session.
        const loadedInvites = await dbService.getPendingInvites();
        pendingInvitesRef.current = loadedInvites;
        setPendingInvites(loadedInvites);

        // Parse initial room from URL params
        const params = new URLSearchParams(window.location.search);
        const urlConvId = params.get('id');
        const isPublic = params.get('public') === '1' || params.get('public') === 'true';
        const urlJoinToken = isPublic ? params.get('join') || generateRandomRoomSecret() : '';
        let urlSecret = '';
        if (!isPublic) {
          const hash = window.location.hash;
          const hashMatch = hash.match(/secret=([A-Za-z0-9_-]+)/);
          if (hashMatch && hashMatch[1]) urlSecret = hashMatch[1];
          else if (params.get('secret')) urlSecret = params.get('secret') || '';
          else if (!urlConvId) urlSecret = generateRandomRoomSecret();
        }

        const initialConvId = urlConvId && urlConvId.trim() ? urlConvId.trim() : crypto.randomUUID();
        const initialTabId = crypto.randomUUID();
        const initialTitle = getOrInitChannelTitle(initialConvId);

        const initialTab: RoomTab = {
          tabId: initialTabId,
          convId: initialConvId,
          roomMode: isPublic ? 'public' : 'private',
          roomSecret: urlSecret,
          publicJoinToken: isPublic ? urlJoinToken : undefined,
          isInitialCreator: !urlConvId,
          channelTitle: initialTitle,
          unreadCount: 0,
        };

        const session = getOrCreateSession(initialTab);
        setTabs([initialTab]);
        setActiveTabId(initialTabId);
        activeTabIdRef.current = initialTabId;
        syncBrowserUrl(initialTab);

        await session.init(loadedProfile, privKey, signPrivKey);
        refreshActiveSessionView();

        presenceService
          .start(loadedProfile, privKey, signPrivKey)
          .catch((err) => console.warn('Failed to start presence service:', err));
      } catch (err) {
        console.error('Failed to initialize Chat context:', err);
      }
    }

    initGlobal();

    return () => {
      isMounted = false;
      presenceService.stop().catch(() => {});
      sessionsMapRef.current.forEach((s) => s.destroy());
      sessionsMapRef.current.clear();
    };
  }, [getOrCreateSession, syncBrowserUrl, refreshActiveSessionView]);

  // Profile operations
  const updateProfile = useCallback(
    async (updates: Partial<UserProfile>) => {
      if (!profile) return;
      const updated: UserProfile = {
        ...profile,
        ...updates,
        updatedAt: Date.now(),
      };
      await dbService.saveProfile(updated);
      setProfile(updated);
      profileRef.current = updated;

      // Update self participant in all active room sessions
      sessionsMapRef.current.forEach((session) => {
        session.updateProfile(updated);
      });
      refreshActiveSessionView();
    },
    [profile, refreshActiveSessionView]
  );

  const regenerateKeypair = useCallback(async () => {
    if (!profile) return;
    const identity = await generateUserKeyPair();

    const updated: UserProfile = {
      ...profile,
      participantId: identity.participantId,
      publicKeyBase64: identity.publicKeyBase64,
      publicKeyPem: identity.publicKeyPem,
      privateKeyJwk: identity.privateKeyJwk,
      privateKeyPem: identity.privateKeyPem,
      signingPublicKeyBase64: identity.signingPublicKeyBase64,
      signingPublicKeyPem: identity.signingPublicKeyPem,
      signingPrivateKeyJwk: identity.signingPrivateKeyJwk,
      signingPrivateKeyPem: identity.signingPrivateKeyPem,
      updatedAt: Date.now(),
    };

    await dbService.saveProfile(updated);
    setProfile(updated);
    profileRef.current = updated;

    privateKeyRef.current = identity.privateKey;
    signingPrivateKeyRef.current = identity.signingPrivateKey;

    sessionsMapRef.current.forEach((session) => {
      session.updateProfile(updated);
    });

    refreshActiveSessionView();
  }, [profile, refreshActiveSessionView]);

  const importProfileFromJson = useCallback(async (jsonStr: string): Promise<boolean> => {
    try {
      const parsed = JSON.parse(jsonStr) as UserProfile;
      if (!parsed.participantId || !parsed.screenName || !parsed.privateKeyJwk || !parsed.signingPrivateKeyJwk) {
        return false;
      }
      await dbService.saveProfile(parsed);
      setProfile(parsed);
      profileRef.current = parsed;

      const privKey = await importPrivateKeyFromJwk(parsed.privateKeyJwk);
      privateKeyRef.current = privKey;
      const signPrivKey = await importSigningPrivateKeyFromJwk(parsed.signingPrivateKeyJwk);
      signingPrivateKeyRef.current = signPrivKey;

      sessionsMapRef.current.forEach((session) => {
        session.updateProfile(parsed);
      });

      refreshActiveSessionView();
      return true;
    } catch {
      return false;
    }
  }, [refreshActiveSessionView]);

  const exportProfileAsJson = useCallback((): string => {
    return profile ? JSON.stringify(profile, null, 2) : '';
  }, [profile]);

  // Friends operations
  const addFriend = useCallback(async (friend: Omit<Friend, 'id' | 'createdAt' | 'updatedAt'>) => {
    const newFriend: Friend = {
      ...friend,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbService.saveFriend(newFriend);
    const updated = await dbService.getFriends();
    setFriends(updated);
  }, []);

  const updateFriend = useCallback(async (friend: Friend) => {
    await dbService.saveFriend({ ...friend, updatedAt: Date.now() });
    const updated = await dbService.getFriends();
    setFriends(updated);
  }, []);

  const deleteFriend = useCallback(async (id: string) => {
    await dbService.deleteFriend(id);
    const updated = await dbService.getFriends();
    setFriends(updated);
  }, []);

  // --------------------------------------------------------------------------
  // Presence & direct room invites
  // --------------------------------------------------------------------------

  const refreshPendingInvites = useCallback(async () => {
    const invites = await dbService.getPendingInvites();
    pendingInvitesRef.current = invites;
    setPendingInvites(invites);
    return invites;
  }, []);

  const isFriendOnline = useCallback(
    (participantId: string) => {
      const presence = friendPresence.get(participantId);
      return Boolean(presence && presence.status !== 'offline');
    },
    [friendPresence]
  );

  /**
   * Publishes every queued invite for one recipient as a single sealed bundle.
   * Called when we create an invite and again whenever that person comes online.
   */
  const dispatchInvitesFor = useCallback(
    async (participantId: string): Promise<boolean> => {
      const currentProfile = profileRef.current;
      const signPrivKey = signingPrivateKeyRef.current;
      if (!currentProfile || !signPrivKey) return false;
      if (!presenceService.isOnline(participantId)) return false;

      const queued = pendingInvitesRef.current.filter(
        (invite) => invite.recipientParticipantId === participantId && invite.status !== 'declined'
      );
      if (queued.length === 0) return false;

      try {
        const payloads = await Promise.all(
          queued.map((invite) =>
            createSignedRoomInvite(
              invite.inviteId,
              invite.convId,
              invite.roomMode,
              invite.channelTitle,
              invite.recipientParticipantId,
              {
                participantId: currentProfile.participantId,
                screenName: currentProfile.screenName,
                avatarName: currentProfile.avatarName,
                publicKey: currentProfile.publicKeyBase64,
                signingPublicKey: currentProfile.signingPublicKeyBase64,
                contactInfo: currentProfile.contactInfo,
              },
              signPrivKey,
              { roomSecret: invite.roomSecret, publicJoinToken: invite.publicJoinToken }
            )
          )
        );

        const delivered = await presenceService.publishInviteBundle(
          participantId,
          queued[0].recipientPublicKey,
          payloads
        );
        if (!delivered) return false;

        for (const invite of queued) {
          await dbService.savePendingInvite({ ...invite, status: 'sent', lastAttemptAt: Date.now() });
        }
        await refreshPendingInvites();
        return true;
      } catch (err) {
        console.warn('Failed to dispatch room invites:', err);
        return false;
      }
    },
    [refreshPendingInvites]
  );

  const inviteFriendToRoom = useCallback(
    async (friend: Friend): Promise<'sent' | 'queued' | 'error'> => {
      const session = sessionsMapRef.current.get(activeTabIdRef.current);
      if (!session || !friend.participantId || !friend.publicKey) return 'error';

      const record: PendingInviteRecord = {
        inviteId: crypto.randomUUID(),
        recipientParticipantId: friend.participantId,
        recipientScreenName: friend.screenName,
        recipientPublicKey: normalizePublicKey(friend.publicKey),
        convId: session.convId,
        roomMode: session.roomMode,
        roomSecret: session.roomMode === 'private' ? session.roomSecret : undefined,
        publicJoinToken: session.roomMode === 'public' ? session.publicJoinToken || undefined : undefined,
        channelTitle: session.channelTitle,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      try {
        await dbService.savePendingInvite(record);
        await refreshPendingInvites();
        // Their entry request is granted on arrival because we asked for them.
        session.setAutoApprove(friend.participantId);

        const delivered = await dispatchInvitesFor(friend.participantId);
        return delivered ? 'sent' : 'queued';
      } catch (err) {
        console.warn('Failed to queue room invite:', err);
        return 'error';
      }
    },
    [dispatchInvitesFor, refreshPendingInvites]
  );

  const cancelPendingInvite = useCallback(
    async (inviteId: string) => {
      const record = pendingInvitesRef.current.find((invite) => invite.inviteId === inviteId);
      await dbService.deletePendingInvite(inviteId);
      const remaining = await refreshPendingInvites();
      if (!record) return;

      sessionsMapRef.current.forEach((session) => {
        if (session.convId === record.convId) session.clearAutoApprove(record.recipientParticipantId);
      });

      // Retract or shrink whatever we published for this recipient.
      const stillQueued = remaining.filter(
        (invite) => invite.recipientParticipantId === record.recipientParticipantId
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

  const acceptIncomingInvite = useCallback(
    async (invite: RoomInvitePayload) => {
      presenceService.markInviteHandled(invite.inviteId);
      setIncomingInvites((prev) => prev.filter((i) => i.inviteId !== invite.inviteId));

      // Opening the room performs the normal join handshake; the inviter has
      // pre-approved us, so their side grants entry without a second prompt.
      openTabRef.current?.({
        convId: invite.convId,
        roomMode: invite.roomMode,
        roomSecret: invite.roomSecret,
        publicJoinToken: invite.publicJoinToken,
        channelTitle: invite.channelTitle,
        isInitialCreator: false,
      });

      const currentProfile = profileRef.current;
      const signPrivKey = signingPrivateKeyRef.current;
      if (!currentProfile || !signPrivKey) return;

      // Remember the inviter so they show up in the friends directory too.
      const known = await dbService.getFriends();
      if (!known.some((f) => f.participantId === invite.inviter.participantId)) {
        await dbService.saveFriend({
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
        setFriends(await dbService.getFriends());
      }

      try {
        const response = await createSignedInviteResponse(
          invite.inviteId,
          invite.convId,
          'accepted',
          currentProfile.participantId,
          currentProfile.screenName,
          currentProfile.signingPublicKeyBase64,
          signPrivKey
        );
        await presenceService.publishInviteResponse(
          invite.inviter.participantId,
          invite.inviter.publicKey,
          response
        );
      } catch (err) {
        console.warn('Failed to acknowledge room invite:', err);
      }
    },
    []
  );

  const declineIncomingInvite = useCallback(async (invite: RoomInvitePayload) => {
    presenceService.markInviteHandled(invite.inviteId);
    setIncomingInvites((prev) => prev.filter((i) => i.inviteId !== invite.inviteId));

    const currentProfile = profileRef.current;
    const signPrivKey = signingPrivateKeyRef.current;
    if (!currentProfile || !signPrivKey) return;

    try {
      const response = await createSignedInviteResponse(
        invite.inviteId,
        invite.convId,
        'declined',
        currentProfile.participantId,
        currentProfile.screenName,
        currentProfile.signingPublicKeyBase64,
        signPrivKey
      );
      await presenceService.publishInviteResponse(
        invite.inviter.participantId,
        invite.inviter.publicKey,
        response
      );
    } catch (err) {
      console.warn('Failed to decline room invite:', err);
    }
  }, []);

  const handleInviteResponse = useCallback(
    async (response: RoomInviteResponsePayload) => {
      const record = pendingInvitesRef.current.find((invite) => invite.inviteId === response.inviteId);
      if (!record) return;

      if (response.decision === 'declined') {
        sessionsMapRef.current.forEach((session) => {
          if (session.convId === record.convId) session.clearAutoApprove(record.recipientParticipantId);
        });
      }

      await dbService.deletePendingInvite(record.inviteId);
      const remaining = await refreshPendingInvites();

      // Replace the published bundle with whatever is still outstanding.
      const stillQueued = remaining.filter(
        (invite) => invite.recipientParticipantId === record.recipientParticipantId
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

  // Keep presence callbacks pointing at the latest closures.
  const dispatchInvitesRef = useRef(dispatchInvitesFor);
  dispatchInvitesRef.current = dispatchInvitesFor;
  const inviteResponseRef = useRef(handleInviteResponse);
  inviteResponseRef.current = handleInviteResponse;

  useEffect(() => {
    presenceService.setCallbacks({
      onPresenceChange: (presence) => {
        setFriendPresence((prev) => {
          const next = new Map(prev);
          next.set(presence.participantId, presence);
          return next;
        });
        // A friend just appeared: hand over anything we parked for them.
        if (presence.status !== 'offline') {
          dispatchInvitesRef.current(presence.participantId).catch(() => {});
        }
      },
      onInvite: (invite) => {
        setIncomingInvites((prev) =>
          prev.some((existing) => existing.inviteId === invite.inviteId) ? prev : [...prev, invite]
        );
      },
      onInviteResponse: (response) => {
        inviteResponseRef.current(response).catch(() => {});
      },
    });
  }, []);

  // Track exactly the friends currently in the directory.
  useEffect(() => {
    presenceService.watchFriends(friends.map((f) => f.participantId)).catch(() => {});
  }, [friends]);

  // Backstop for invites queued while we ourselves were offline, or whose
  // recipient came online before the presence callbacks were attached.
  useEffect(() => {
    const timer = setInterval(() => {
      const recipients = new Set(pendingInvitesRef.current.map((i) => i.recipientParticipantId));
      recipients.forEach((participantId) => {
        if (presenceService.isOnline(participantId)) {
          dispatchInvitesRef.current(participantId).catch(() => {});
        }
      });
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  const refreshPublicRoomsList = useCallback(async (): Promise<PublicRoomDescriptorPacket[]> => {
    try {
      const rooms = await publicDirectoryService.fetchPublicRooms();
      setPublicRoomsList(rooms);
      return rooms;
    } catch (err) {
      console.warn('Failed to fetch public rooms:', err);
      return [];
    }
  }, []);

  // Active room proxy
  const activeSession = sessionsMapRef.current.get(activeTabId);
  const activeTab = tabs.find((t) => t.tabId === activeTabId);

  const convId = activeSession?.convId || activeTab?.convId || '';
  const roomMode = activeSession?.roomMode || activeTab?.roomMode || 'private';
  const roomSecret = activeSession?.roomSecret || activeTab?.roomSecret || '';
  const publicJoinToken = activeSession?.publicJoinToken || activeTab?.publicJoinToken || null;
  const publicRoomId = activeSession?.publicRoomId || activeTab?.publicRoomId || null;
  const isInitialCreator = activeSession?.isInitialCreator ?? activeTab?.isInitialCreator ?? false;
  const channelTitle = activeSession?.channelTitle || activeTab?.channelTitle || 'AirComic';
  const connectionStatus = activeSession?.connectionStatus || 'connecting';
  const connectedPeersCount = activeSession?.connectedPeersCount || 0;
  const relayStatuses = useMemo(() => [...(activeSession?.relayStatuses || [])], [activeSession, sessionTick]);
  const participantsMap = useMemo(
    () => new Map(activeSession?.participantsMap || []),
    [activeSession, sessionTick]
  );
  const participants = useMemo(() => Array.from(participantsMap.values()), [participantsMap]);
  const messages = useMemo(() => [...(activeSession?.messages || [])], [activeSession, sessionTick]);
  const activeKeyId = activeSession?.activeKeyId || 'root-v2';
  const activeEpoch = activeSession?.activeEpoch || 0;
  const isApproved = activeSession?.isApproved ?? true;
  const isRekeying = activeSession?.isRekeying ?? false;
  const rootFingerprint = activeSession?.rootFingerprint || '';
  const channelOwnerName = activeSession?.channelOwnerName || null;
  const pendingJoinRequests = useMemo(
    () => [...(activeSession?.pendingJoinRequests || [])],
    [activeSession, sessionTick]
  );
  const isSecretMissing = activeSession?.isSecretMissing ?? false;
  const inviteUrl = activeSession?.inviteUrl || '';

  const sendMessage = useCallback(
    async (text: string, options?: any) => {
      if (!activeSession) return false;
      return activeSession.sendMessage(text, options);
    },
    [activeSession]
  );

  const updateChannelTitle = useCallback(
    async (newTitle: string) => {
      if (!activeSession) return false;
      return activeSession.updateChannelTitle(newTitle);
    },
    [activeSession]
  );

  const sendJoinRequest = useCallback(async () => {
    if (!activeSession) return false;
    return activeSession.sendJoinRequest();
  }, [activeSession]);

  const approveJoinRequest = useCallback(
    async (requestOrId: PendingJoinRequest | string) => {
      if (!activeSession) return false;
      const reqId = typeof requestOrId === 'string' ? requestOrId : requestOrId.requestId;
      return activeSession.approveJoinRequest(reqId);
    },
    [activeSession]
  );

  const declineJoinRequest = useCallback(
    (requestId: string) => {
      if (activeSession) activeSession.declineJoinRequest(requestId);
    },
    [activeSession]
  );

  const removeParticipant = useCallback(
    async (participantId: string, screenName?: string): Promise<boolean> => {
      if (activeSession) {
        return activeSession.removeParticipant(participantId, screenName);
      }
      return false;
    },
    [activeSession]
  );

  const rekeyConversation = useCallback(async () => {
    if (!activeSession) return false;
    return activeSession.rekeyConversation();
  }, [activeSession]);

  const clearHistory = useCallback(async () => {
    if (activeSession) await activeSession.clearHistory();
  }, [activeSession]);

  const provideRoomSecret = useCallback(
    (input: string) => {
      if (activeSession) activeSession.provideRoomSecret(input);
    },
    [activeSession]
  );

  const switchConversation = useCallback(
    (newId: string, newSecret?: string) => {
      openTab({ convId: newId, roomSecret: newSecret, roomMode: 'private' });
    },
    [openTab]
  );

  const createPublicRoom = useCallback(
    async (name: string, description?: string, tags?: string[], language?: string) => {
      return createPublicRoomTab(name, description, tags, language);
    },
    [createPublicRoomTab]
  );

  const joinPublicRoom = useCallback(
    (descriptor: PublicRoomDescriptorPacket) => {
      joinPublicRoomTab(descriptor);
    },
    [joinPublicRoomTab]
  );

  const refreshRelays = useCallback(() => {
    if (activeSession) {
      activeSession.refreshRelayStatuses();
      refreshActiveSessionView();
    }
  }, [activeSession, refreshActiveSessionView]);

  const reconnectRelays = useCallback(async () => {
    if (activeSession) {
      await activeSession.reconnectSignaling();
      refreshActiveSessionView();
    }
  }, [activeSession, refreshActiveSessionView]);

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
    friendPresence,
    isFriendOnline,
    pendingInvites,
    inviteFriendToRoom,
    cancelPendingInvite,
    incomingInvites,
    acceptIncomingInvite,
    declineIncomingInvite,
    tabs,
    activeTabId,
    openTab,
    closeTab,
    switchTab,
    createPrivateRoomTab,
    joinRoomByUrlOrSecret,
    joinPublicRoomTab,
    createPublicRoomTab,
    convId,
    roomMode,
    roomSecret,
    publicJoinToken,
    publicRoomId,
    isInitialCreator,
    channelTitle,
    updateChannelTitle,
    connectionStatus,
    connectedPeersCount,
    relayStatuses,
    refreshRelays,
    reconnectRelays,
    participantsMap,
    participants,
    messages,
    sendMessage,
    activeKeyId,
    activeEpoch,
    isApproved,
    isRekeying,
    rootFingerprint,
    channelOwnerName,
    pendingJoinRequests,
    sendJoinRequest,
    approveJoinRequest,
    declineJoinRequest,
    removeParticipant,
    rekeyConversation,
    claimConversation: rekeyConversation,
    clearHistory,
    isSecretMissing,
    provideRoomSecret,
    inviteUrl,
    switchConversation,
    zoomLevel,
    setZoomLevel,
    publicRoomsList,
    refreshPublicRoomsList,
    createPublicRoom,
    joinPublicRoom,
  };

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};
