/**
 * @vitest-environment jsdom
 *
 * Tests for exporting and importing user data, rooms, favorites, and friends,
 * ensuring a complete reconstruction of the UI while providing a blank slate
 * (clearing out cached messages) so users can immediately pick up with new messages.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { installFakeWebSocket, registerRelay, closeAllSockets } from './fakeRelay';
import { generateRoomSecret } from '../services/v3/keys';
import { db } from '../services/v3/db';
import type { ChatMessage } from '../types';

installFakeWebSocket();

const errors: unknown[] = [];

beforeAll(() => {
  [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://purplerelay.com',
    'wss://relay.snort.social',
  ].forEach(registerRelay);

  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
    configurable: true,
  });
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
      configurable: true,
    });
  }
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));
});

afterAll(() => {
  cleanup();
  closeAllSockets();
});

beforeEach(async () => {
  errors.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  await db.clearAll();
  window.history.replaceState(null, '', '/');
});

afterEach(async () => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  await db.clearAll();
  vi.restoreAllMocks();
});

describe('Export and Import Functionality', () => {
  it('exports user information, favorites, current rooms, and friends, omitting cached messages', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    let chat: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      chat = useChat();
      return null;
    };

    await act(async () => {
      render(
        <ChatProvider>
          <Probe />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(chat).not.toBeNull();

    // 1. Set user profile with biography
    await act(async () => {
      await chat!.updateProfile({
        screenName: 'ComicMaster',
        contactInfo: {
          info: 'Creating comics since 1995',
        },
      });
    });

    // 2. Add a friend
    const friendKeys = await (await import('../services/crypto')).generateUserKeyPair();
    await act(async () => {
      await chat!.addFriend({
        participantId: friendKeys.participantId,
        screenName: 'BuddyBob',
        publicKey: friendKeys.publicKeyBase64,
        signingPublicKey: friendKeys.signingPublicKeyBase64,
        contactInfo: { info: 'Best friend' },
      });
    });

    // 3. Add a second tab/room
    let secondTabId = '';
    await act(async () => {
      secondTabId = chat!.createPrivateRoomTab('Secret Club', 'Exclusive room');
    });

    // 4. Add a favorite room
    await act(async () => {
      await chat!.toggleFavoriteRoom();
    });

    // 5. Save an old, closed room directly into the database (not open in tabs, not a favorite)
    const closedConvId = crypto.randomUUID();
    await db.saveConversation({
      convId: closedConvId,
      roomMode: 'private',
      routingTag: 'closed-routing-tag',
      capabilityGeneration: 1,
      previousRoutingTags: [],
      activeEpoch: 1,
      activeKeyId: 'closed-key-1',
      isCreator: false,
      channelTitle: 'Old Closed Room From Database',
      historyPolicy: 'from_admission',
      metadataPolicy: 'members',
      updatedAt: Date.now() - 100000,
    });
    await db.saveEpochKey({
      convId: closedConvId,
      keyId: 'closed-key-1',
      epoch: 1,
      rawBase64Url: 'fake-closed-epoch-key',
      members: ['someone-else'],
    });

    // 6. Store a cached message in the database for the active room
    const testMsg: ChatMessage = {
      id: 'msg-cached-999',
      convId: chat!.convId,
      senderId: chat!.profile!.participantId,
      sender: { screenName: 'ComicMaster' },
      timestamp: Date.now() - 10000,
      text: 'This is a cached history message that should not be exported',
      keyId: chat!.activeKeyId || 'test-key',
      isSelf: true,
      sendState: 'relayed',
    };
    await db.saveMessage(testMsg);
    const messagesBefore = await db.getMessages(chat!.convId);
    expect(messagesBefore.length).toBeGreaterThan(0);

    // 7. Perform Export
    let exportedJson = '';
    await act(async () => {
      exportedJson = await chat!.exportProfileAsJson();
    });

    expect(exportedJson).toBeTruthy();
    const parsed = JSON.parse(exportedJson);

    // Check exported user info
    expect(parsed.participantId).toBe(chat!.profile!.participantId);
    expect(parsed.screenName).toBe('ComicMaster');
    expect(parsed.info).toBe('Creating comics since 1995');
    expect(parsed.profile).toBeDefined();
    expect(parsed.profile.signingPublicKeyBase64).toBe(chat!.profile!.signingPublicKeyBase64);
    expect(parsed.profile.signingPrivateKeyJwk).toBeDefined();

    // Check exported friends
    expect(parsed.friends).toBeInstanceOf(Array);
    expect(parsed.friends.length).toBe(1);
    expect(parsed.friends[0].screenName).toBe('BuddyBob');

    // Check exported current rooms (tabs)
    expect(parsed.currentRooms).toBeInstanceOf(Array);
    expect(parsed.currentRooms.length).toBe(2);
    expect(parsed.currentRooms.some((r: any) => r.channelTitle === 'Secret Club')).toBe(true);

    // Check exported favorite rooms
    expect(parsed.favoriteRooms).toBeInstanceOf(Array);
    expect(parsed.favoriteRooms.length).toBe(1);

    // Verify closed rooms from the database are NOT exported
    expect(parsed.currentRooms.some((r: any) => r.convId === closedConvId)).toBe(false);
    expect(parsed.favoriteRooms.some((r: any) => r.convId === closedConvId)).toBe(false);
    expect(parsed.conversations.some((c: any) => c.convId === closedConvId)).toBe(false);
    expect(parsed.epochKeys.some((k: any) => k.convId === closedConvId)).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('Old Closed Room From Database');

    // Verify messages are NOT exported anywhere
    expect(parsed.messages).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain('This is a cached history message');
  });

  it('imports data by clearing out everything and restoring details into a blank slate', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    let chat: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      chat = useChat();
      return null;
    };

    await act(async () => {
      render(
        <ChatProvider>
          <Probe />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Populate old state with old friends, old rooms, and old messages
    const oldConv = chat!.convId;
    await db.saveMessage({
      id: 'old-msg-1',
      convId: oldConv,
      senderId: 'someone-else',
      sender: { screenName: 'OldUser' },
      timestamp: Date.now() - 50000,
      text: 'Old message that should be cleared on import',
      keyId: 'old-key',
      isSelf: false,
      sendState: 'relayed',
    });

    // Create backup payload to import (belonging to a new persona: "RestoredHero")
    const newKeys = await (await import('../services/crypto')).generateUserKeyPair();
    const restoredConvId = crypto.randomUUID();
    const restoredSecret = generateRoomSecret();

    const backupPayload = {
      version: 3,
      exportedAt: Date.now(),
      participantId: newKeys.participantId,
      screenName: 'RestoredHero',
      info: 'Adventurer and artist',
      contactInfo: { info: 'Adventurer and artist' },
      profile: {
        id: 'current_user',
        participantId: newKeys.participantId,
        screenName: 'RestoredHero',
        avatarName: 'Connor',
        backdropName: 'room.bgb',
        publicKeyBase64: newKeys.publicKeyBase64,
        publicKeyPem: newKeys.publicKeyPem,
        privateKeyJwk: newKeys.privateKeyJwk,
        privateKeyPem: newKeys.privateKeyPem,
        signingPublicKeyBase64: newKeys.signingPublicKeyBase64,
        signingPublicKeyPem: newKeys.signingPublicKeyPem,
        signingPrivateKeyJwk: newKeys.signingPrivateKeyJwk,
        signingPrivateKeyPem: newKeys.signingPrivateKeyPem,
        contactInfo: { info: 'Adventurer and artist' },
        createdAt: Date.now() - 100000,
        updatedAt: Date.now() - 100000,
      },
      friends: [
        {
          id: 'imported-friend-1',
          participantId: 'imported-friend-pid',
          screenName: 'SidekickSam',
          publicKey: newKeys.publicKeyBase64,
          signingPublicKey: newKeys.signingPublicKeyBase64,
          contactInfo: { info: 'Sidekick' },
        },
      ],
      favoriteRooms: [
        {
          id: 'fav-room-1',
          convId: restoredConvId,
          roomMode: 'private',
          roomSecret: restoredSecret,
          name: 'Hero Headquarters',
          members: [],
          savedAt: Date.now(),
        },
      ],
      currentRooms: [
        {
          tabId: 'tab-hero-1',
          convId: restoredConvId,
          roomMode: 'private',
          roomSecret: restoredSecret,
          channelTitle: 'Hero Headquarters',
          isInitialCreator: true,
          unreadCount: 0,
        },
      ],
      activeTabId: 'tab-hero-1',
    };

    // Run import
    let success = false;
    await act(async () => {
      success = await chat!.importProfileFromJson(JSON.stringify(backupPayload));
    });

    expect(success).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // 1. Verify User Information is restored
    expect(chat!.profile?.participantId).toBe(newKeys.participantId);
    expect(chat!.profile?.screenName).toBe('RestoredHero');
    expect(chat!.profile?.contactInfo?.info).toBe('Adventurer and artist');
    expect(chat!.profile?.avatarName).toBe('Connor');

    // 2. Verify Friends are restored
    expect(chat!.friends.length).toBe(1);
    expect(chat!.friends[0].screenName).toBe('SidekickSam');

    // 3. Verify Favorite Rooms are restored
    expect(chat!.favoriteRooms.length).toBe(1);
    expect(chat!.favoriteRooms[0].name).toBe('Hero Headquarters');

    // 4. Verify Current Rooms are restored
    expect(chat!.tabs.length).toBe(1);
    expect(chat!.tabs[0].convId).toBe(restoredConvId);
    expect(chat!.tabs[0].channelTitle).toBe('Hero Headquarters');
    expect(chat!.convId).toBe(restoredConvId);

    // 5. Verify "Blank Slate": all messages are cleared
    const messagesInDb = await db.getMessages(restoredConvId);
    expect(messagesInDb).toEqual([]);
    const oldMessagesInDb = await db.getMessages(oldConv);
    expect(oldMessagesInDb).toEqual([]);
    expect(chat!.messages).toEqual([]);

    // 6. Verify user can pick right up with new messages:
    // Sending a new message in the restored room works smoothly
    let sendResult = false;
    await act(async () => {
      sendResult = await chat!.sendMessage('Hello new world from restored hero!');
    });
    expect(sendResult).toBe(true);
    expect(chat!.messages.length).toBe(1);
    expect(chat!.messages[0].text).toBe('Hello new world from restored hero!');
  });

  it('imports legacy profile-only JSON files as a blank slate with a fresh room', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    let chat: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      chat = useChat();
      return null;
    };

    await act(async () => {
      render(
        <ChatProvider>
          <Probe />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    const legacyKeys = await (await import('../services/crypto')).generateUserKeyPair();
    const legacyJson = JSON.stringify({
      id: 'current_user',
      participantId: legacyKeys.participantId,
      screenName: 'LegacyUser',
      avatarName: 'Dan',
      publicKeyBase64: legacyKeys.publicKeyBase64,
      publicKeyPem: legacyKeys.publicKeyPem,
      privateKeyJwk: legacyKeys.privateKeyJwk,
      privateKeyPem: legacyKeys.privateKeyPem,
      signingPublicKeyBase64: legacyKeys.signingPublicKeyBase64,
      signingPublicKeyPem: legacyKeys.signingPublicKeyPem,
      signingPrivateKeyJwk: legacyKeys.signingPrivateKeyJwk,
      signingPrivateKeyPem: legacyKeys.signingPrivateKeyPem,
      contactInfo: { info: 'Legacy account' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let success = false;
    await act(async () => {
      success = await chat!.importProfileFromJson(legacyJson);
    });

    expect(success).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(chat!.profile?.participantId).toBe(legacyKeys.participantId);
    expect(chat!.profile?.screenName).toBe('LegacyUser');
    expect(chat!.profile?.contactInfo?.info).toBe('Legacy account');
    // Fallback creates a clean room tab
    expect(chat!.tabs.length).toBe(1);
    expect(chat!.messages).toEqual([]);
  });

  it('rejects invalid JSON or JSON missing signing keys', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    let chat: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      chat = useChat();
      return null;
    };

    await act(async () => {
      render(
        <ChatProvider>
          <Probe />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Malformed JSON
    expect(await chat!.importProfileFromJson('invalid-json')).toBe(false);

    // Missing keys
    expect(await chat!.importProfileFromJson(JSON.stringify({ screenName: 'NoKeys' }))).toBe(false);
  });
});
