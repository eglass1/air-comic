/**
 * @vitest-environment jsdom
 *
 * Tests for saving and restoring open rooms and active viewing state across app
 * reopens, as well as silently omitting removed or non-existent rooms.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { installFakeWebSocket, registerRelay, closeAllSockets } from './fakeRelay';
import { generateRoomSecret, derivePublicRoomId } from '../services/v3/keys';
import { db } from '../services/v3/db';
import {
  serializeChain,
  createChainState,
  adoptGenesis,
  applyRekey,
} from '../services/v3/epochChain';
import type { GenesisPacket, RekeyPacket } from '../services/v3/packets';
import { directoryService } from '../services/v3/directory';

installFakeWebSocket();

const errors: unknown[] = [];

const isPreexistingNestingWarning = (entry: unknown) =>
  Array.isArray(entry) &&
  typeof entry[0] === 'string' &&
  (entry[0].includes('cannot be a descendant of') ||
    entry[0].includes('cannot contain a nested'));

const realErrors = () => errors.filter((e) => !isPreexistingNestingWarning(e));

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

beforeEach(() => {
  errors.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('reopen and restore rooms', () => {
  it('restores open rooms and active viewing tab from localStorage on reopen', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    const convA = crypto.randomUUID();
    const convB = crypto.randomUUID();
    const tabIdA = crypto.randomUUID();
    const tabIdB = crypto.randomUUID();

    const savedTabs = [
      {
        tabId: tabIdA,
        convId: convA,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: true,
        channelTitle: 'Room Alpha',
        unreadCount: 0,
      },
      {
        tabId: tabIdB,
        convId: convB,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: true,
        channelTitle: 'Room Beta',
        unreadCount: 0,
      },
    ];

    // Saved to localStorage; sessionStorage is empty simulating a closed browser session
    localStorage.setItem('aircomic_open_tabs', JSON.stringify(savedTabs));
    localStorage.setItem(
      'aircomic_active_tab',
      JSON.stringify({ tabId: tabIdB, convId: convB })
    );

    let snapshot: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      snapshot = useChat();
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
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(snapshot).not.toBeNull();
    const chat = snapshot!;

    // Both rooms are restored
    expect(chat.tabs.length).toBe(2);
    expect(chat.tabs.some((t) => t.convId === convA)).toBe(true);
    expect(chat.tabs.some((t) => t.convId === convB)).toBe(true);

    // Active viewing tab was restored to Room Beta
    expect(chat.activeTabId).toBe(tabIdB);
    expect(chat.convId).toBe(convB);
    expect(chat.channelTitle).toBe('Room Beta');

    // Both localStorage and sessionStorage now hold the restored state
    expect(localStorage.getItem('aircomic_open_tabs')).toContain(convA);
    expect(sessionStorage.getItem('aircomic_open_tabs')).toContain(convB);
    expect(realErrors()).toEqual([]);
  }, 30000);

  it('omits a private room with missing secret on reopen without error', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    const validConv = crypto.randomUUID();
    const validTabId = crypto.randomUUID();
    const invalidConv = crypto.randomUUID();
    const invalidTabId = crypto.randomUUID();

    const savedTabs = [
      {
        tabId: validTabId,
        convId: validConv,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: true,
        channelTitle: 'Valid Room',
        unreadCount: 0,
      },
      {
        tabId: invalidTabId,
        convId: invalidConv,
        roomMode: 'private',
        roomSecret: '', // Missing secret
        isInitialCreator: false,
        channelTitle: 'Missing Secret Room',
        unreadCount: 0,
      },
    ];

    localStorage.setItem('aircomic_open_tabs', JSON.stringify(savedTabs));
    localStorage.setItem(
      'aircomic_active_tab',
      JSON.stringify({ tabId: invalidTabId, convId: invalidConv })
    );

    let snapshot: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      snapshot = useChat();
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
      await new Promise((r) => setTimeout(r, 500));
    });

    const chat = snapshot!;
    // Invalid room without secret is omitted cleanly
    expect(chat.tabs.length).toBe(1);
    expect(chat.tabs[0].convId).toBe(validConv);
    expect(chat.tabs.some((t) => t.convId === invalidConv)).toBe(false);

    // Active tab fell back to the remaining valid room
    expect(chat.activeTabId).toBe(validTabId);
    expect(chat.convId).toBe(validConv);
    expect(chat.isSecretMissing).toBe(false);
    expect(realErrors()).toEqual([]);
  }, 30000);

  it('omits a room where the user was removed on reopen', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    const profile = await db.getOrCreateProfile('Anonymous');
    const myId = profile.participantId;
    const creatorId = 'creator-' + crypto.randomUUID();

    // Prepare a room where the user was removed
    const removedConv = crypto.randomUUID();
    const removedTabId = crypto.randomUUID();
    const chain = createChainState(removedConv);

    const genesis: GenesisPacket = {
      type: 'genesis',
      convId: removedConv,
      packetId: 'gen-1',
      roomMode: 'private',
      creatorId,
      members: [creatorId],
      creatorSigningPublicKey: 'creator-key',
      historyPolicy: 'shared',
      metadataPolicy: 'unrestricted',
      epoch: 0,
      timestamp: Date.now() - 10000,
      protocol: 'airthread/3',
      extension: 'core',
      signerId: creatorId,
    };
    adoptGenesis(chain, genesis);

    const e1: RekeyPacket = {
      type: 'key',
      convId: removedConv,
      packetId: 'e1',
      keyId: 'k1',
      epoch: 1,
      parentPacketId: 'gen-1',
      parentKeyId: 'root-v3',
      action: 'genesis_epoch',
      signerId: creatorId,
      timestamp: Date.now() - 9000,
      members: [creatorId],
      keys: { [creatorId]: 'sealed' },
    };
    applyRekey(chain, e1);

    // Add me
    const e2: RekeyPacket = {
      type: 'key',
      convId: removedConv,
      packetId: 'e2',
      keyId: 'k2',
      epoch: 2,
      parentPacketId: 'e1',
      parentKeyId: 'k1',
      action: 'add',
      targetParticipantId: myId,
      signerId: creatorId,
      timestamp: Date.now() - 8000,
      members: [creatorId, myId],
      keys: { [creatorId]: 'sealed', [myId]: 'sealed' },
    };
    applyRekey(chain, e2);

    // Remove me
    const e3: RekeyPacket = {
      type: 'key',
      convId: removedConv,
      packetId: 'e3',
      keyId: 'k3',
      epoch: 3,
      parentPacketId: 'e2',
      parentKeyId: 'k2',
      action: 'remove',
      targetParticipantId: myId,
      signerId: creatorId,
      timestamp: Date.now() - 7000,
      members: [creatorId],
      keys: { [creatorId]: 'sealed' },
    };
    applyRekey(chain, e3);

    // Save chain in indexedDB
    await db.saveChain(serializeChain(chain));

    const validConv = crypto.randomUUID();
    const validTabId = crypto.randomUUID();

    const savedTabs = [
      {
        tabId: validTabId,
        convId: validConv,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: true,
        channelTitle: 'Remaining Room',
        unreadCount: 0,
      },
      {
        tabId: removedTabId,
        convId: removedConv,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: false,
        channelTitle: 'Removed Room',
        unreadCount: 0,
      },
    ];

    localStorage.setItem('aircomic_open_tabs', JSON.stringify(savedTabs));

    let snapshot: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      snapshot = useChat();
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
      await new Promise((r) => setTimeout(r, 500));
    });

    const chat = snapshot!;
    // The removed room is omitted
    expect(chat.tabs.length).toBe(1);
    expect(chat.tabs[0].convId).toBe(validConv);
    expect(chat.tabs.some((t) => t.convId === removedConv)).toBe(false);
    expect(realErrors()).toEqual([]);
  }, 30000);

  it('omits a tombstoned public room on reopen without error', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    const validConv = crypto.randomUUID();
    const validTabId = crypto.randomUUID();
    const publicConv = crypto.randomUUID();
    const publicTabId = crypto.randomUUID();
    const publicJoinToken = 'dead-pub-room';

    const expectedPublicRoomId = await derivePublicRoomId(publicConv, publicJoinToken);
    vi.spyOn(directoryService, 'fetchRoomStatus').mockImplementation(async (id) => {
      if (id === expectedPublicRoomId) {
        return { descriptor: null, isTombstoned: true };
      }
      return { descriptor: null, isTombstoned: false };
    });

    const savedTabs = [
      {
        tabId: validTabId,
        convId: validConv,
        roomMode: 'private',
        roomSecret: generateRoomSecret(),
        isInitialCreator: true,
        channelTitle: 'Private Sanctuary',
        unreadCount: 0,
      },
      {
        tabId: publicTabId,
        convId: publicConv,
        roomMode: 'public',
        publicJoinToken,
        isInitialCreator: false,
        channelTitle: 'Tombstoned Public Room',
        unreadCount: 0,
      },
    ];

    localStorage.setItem('aircomic_open_tabs', JSON.stringify(savedTabs));

    let snapshot: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      snapshot = useChat();
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
      await new Promise((r) => setTimeout(r, 600));
    });

    const chat = snapshot!;
    expect(chat.tabs.length).toBe(1);
    expect(chat.tabs[0].convId).toBe(validConv);
    expect(chat.tabs.some((t) => t.convId === publicConv)).toBe(false);
    expect(realErrors()).toEqual([]);
  }, 30000);

  it('falls back to a clean default room if all saved rooms were omitted', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

    // Only non-existent / invalid rooms saved
    const savedTabs = [
      {
        tabId: 'invalid-tab',
        convId: 'invalid-conv',
        roomMode: 'private',
        roomSecret: '', // Missing secret
        isInitialCreator: false,
        channelTitle: 'Ghost Room',
        unreadCount: 0,
      },
    ];

    localStorage.setItem('aircomic_open_tabs', JSON.stringify(savedTabs));

    let snapshot: ReturnType<typeof useChat> | null = null;
    const Probe = () => {
      snapshot = useChat();
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
      await new Promise((r) => setTimeout(r, 500));
    });

    const chat = snapshot!;
    // Clean default room created
    expect(chat.tabs.length).toBe(1);
    expect(chat.roomMode).toBe('private');
    expect(chat.convId).not.toBe('invalid-conv');
    expect(chat.isApproved).toBe(true);
    expect(chat.activeEpoch).toBe(1);
    expect(realErrors()).toEqual([]);
  }, 30000);
});
