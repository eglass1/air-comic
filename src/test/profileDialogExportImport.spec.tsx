/**
 * @vitest-environment jsdom
 *
 * Tests for ProfileDialog Backup & Restore UI:
 * - Export button downloads the JSON backup with user info, favorites, current rooms, and friends.
 * - Uploading an export file renders the preview details (screen name, participant ID, bio/info, room/friend chips).
 * - Clicking Restore restores the profile & data, clears messages, and updates the form.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installFakeWebSocket, registerRelay, closeAllSockets } from './fakeRelay';
import { generateRoomSecret } from '../services/v3/keys';
import { generateUserKeyPair } from '../services/crypto';
import { db } from '../services/v3/db';
import { ProfileDialog } from '../components/ProfileDialog';

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

describe('ProfileDialog Export & Import UI', () => {
  it('allows exporting and importing backup files through the dialog interface', async () => {
    const { ChatProvider } = await import('../context/ChatContext');

    // Mock URL.createObjectURL, URL.revokeObjectURL, and a.click()
    let exportedBlobContent = '';
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn((blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
        exportedBlobContent = reader.result as string;
      };
      reader.readAsText(blob);
      return 'blob:fake-export-url';
    });
    URL.revokeObjectURL = vi.fn();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await act(async () => {
      render(
        <ChatProvider>
          <ProfileDialog open={true} onClose={() => {}} />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // 1. Switch to Identity tab (Tab 1) and enter screen name & bio
    const tabs = screen.getAllByRole('tab');
    const identityTab = tabs.find((t) => t.textContent?.includes('Identity'));
    expect(identityTab).toBeDefined();

    await act(async () => {
      fireEvent.click(identityTab!);
    });

    const screenNameInput = screen.getByLabelText(/screen name/i);
    const bioInput = screen.getByLabelText(/biography/i);

    await act(async () => {
      fireEvent.change(screenNameInput, { target: { value: 'Captain Comic' } });
      fireEvent.change(bioInput, { target: { value: 'Defender of funny pages' } });
    });

    // Save profile
    const saveButton = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // 2. Switch to Backup & Restore tab (Tab 3)
    const backupTab = tabs.find((t) => t.textContent?.includes('Backup & Restore'));
    expect(backupTab).toBeDefined();

    await act(async () => {
      fireEvent.click(backupTab!);
    });

    // Click "Export File"
    const exportButton = screen.getByRole('button', { name: /export file/i });
    await act(async () => {
      fireEvent.click(exportButton);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    expect(clickSpy).toHaveBeenCalled();
    expect(exportedBlobContent).toBeTruthy();

    const exportedObj = JSON.parse(exportedBlobContent);
    expect(exportedObj.screenName).toBe('Captain Comic');
    expect(exportedObj.info).toBe('Defender of funny pages');
    expect(exportedObj.currentRooms.length).toBeGreaterThanOrEqual(1);

    // 3. Now simulate uploading a new backup file
    const importedKeys = await generateUserKeyPair();
    const mockBackup = {
      version: 3,
      exportedAt: Date.now(),
      participantId: importedKeys.participantId,
      screenName: 'Imported Voyager',
      info: 'Exploring the cosmos of panels',
      contactInfo: { info: 'Exploring the cosmos of panels' },
      profile: {
        id: 'current_user',
        participantId: importedKeys.participantId,
        screenName: 'Imported Voyager',
        avatarName: 'Glenda',
        backdropName: 'room.bgb',
        publicKeyBase64: importedKeys.publicKeyBase64,
        publicKeyPem: importedKeys.publicKeyPem,
        privateKeyJwk: importedKeys.privateKeyJwk,
        privateKeyPem: importedKeys.privateKeyPem,
        signingPublicKeyBase64: importedKeys.signingPublicKeyBase64,
        signingPublicKeyPem: importedKeys.signingPublicKeyPem,
        signingPrivateKeyJwk: importedKeys.signingPrivateKeyJwk,
        signingPrivateKeyPem: importedKeys.signingPrivateKeyPem,
        contactInfo: { info: 'Exploring the cosmos of panels' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      friends: [
        {
          id: 'friend-1',
          participantId: 'friend-pid-x',
          screenName: 'StarFriend',
          publicKey: importedKeys.publicKeyBase64,
          signingPublicKey: importedKeys.signingPublicKeyBase64,
        },
      ],
      favoriteRooms: [
        {
          id: 'fav-1',
          convId: crypto.randomUUID(),
          roomMode: 'private',
          roomSecret: generateRoomSecret(),
          name: 'Cosmic Lounge',
          members: [],
          savedAt: Date.now(),
        },
      ],
      currentRooms: [
        {
          tabId: 'tab-cosmic-1',
          convId: crypto.randomUUID(),
          roomMode: 'private',
          roomSecret: generateRoomSecret(),
          channelTitle: 'Cosmic Lounge',
          unreadCount: 0,
        },
      ],
      activeTabId: 'tab-cosmic-1',
    };

    const file = new File([JSON.stringify(mockBackup)], 'aircomic-backup.json', {
      type: 'application/json',
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    // Verify preview renders with details
    expect(screen.getByText('Backup Details')).toBeDefined();
    expect(screen.getByText('Imported Voyager')).toBeDefined();
    expect(screen.getByText('Exploring the cosmos of panels')).toBeDefined();
    expect(screen.getByText('1 Current Rooms')).toBeDefined();
    expect(screen.getByText('1 Favorite Rooms')).toBeDefined();
    expect(screen.getByText('1 Friends')).toBeDefined();

    // 4. Click Restore
    const restoreBtn = screen.getByRole('button', { name: /restore/i });
    await act(async () => {
      fireEvent.click(restoreBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Verify dialog form fields updated to the restored user
    fireEvent.click(identityTab!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    const updatedScreenName = screen.getByLabelText(/screen name/i) as HTMLInputElement;
    const updatedBio = screen.getByLabelText(/biography/i) as HTMLInputElement;
    expect(updatedScreenName.value).toBe('Imported Voyager');
    expect(updatedBio.value).toBe('Exploring the cosmos of panels');

    // Clean up mocks
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('does not include the Encryption & Keys tab on the profile dialog', async () => {
    const { ChatProvider } = await import('../context/ChatContext');

    await act(async () => {
      render(
        <ChatProvider>
          <ProfileDialog open={true} onClose={() => {}} />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    const tabs = screen.getAllByRole('tab');
    const tabLabels = tabs.map((t) => t.textContent?.trim());
    expect(tabLabels).toEqual(['Avatar & Backdrop', 'Identity', 'Backup & Restore']);
    expect(screen.queryByText(/Encryption & Keys/i)).toBeNull();
  });
});
