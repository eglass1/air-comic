/**
 * @vitest-environment jsdom
 *
 * Comprehensive integration tests for Cloud Export & Restore:
 * 1. Cloud Export button is present to the left of "Export File" on Backup & Restore tab.
 * 2. Clicking Cloud Export prompts for a password.
 * 3. Entering password and clicking OK:
 *    - Captures export details
 *    - Encrypts using symmetric cipher based on password (with MAC / SHA-256 verification)
 *    - Posts to Nostr relay as a silent message with UUID key
 *    - Generates URL based on that UUID key and presents it in a modal with copy option
 * 4. Opening URL on another device (or with ?restore=<uuid>):
 *    - Automatically detects restore key
 *    - Retrieves silent message from Nostr relay
 *    - Prompts for password
 *    - Verifies and decrypts profile
 *    - Proceeds with the usual import process (previews Backup Details and restores via Clear & Load)
 * 5. Rejection on wrong password with error feedback.
 */

// Setup window.matchMedia immediately for jsdom
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

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { installFakeWebSocket, registerRelay, closeAllSockets } from './fakeRelay';
import { db } from '../services/v3/db';
import { relayPool } from '../services/nostr/relayPool';
import { ProfileDialog } from '../components/ProfileDialog';

installFakeWebSocket();

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://purplerelay.com',
  'wss://relay.snort.social',
];

beforeAll(() => {
  RELAYS.forEach(registerRelay);
  relayPool.configure(RELAYS);

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
});

afterAll(() => {
  cleanup();
  closeAllSockets();
});

beforeEach(async () => {
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

describe('Cloud Export & Cloud Restore E2E Flow', () => {
  it('renders Cloud Export button to the left of Export File with a cloud icon', async () => {
    const { ChatProvider } = await import('../context/ChatContext');

    await act(async () => {
      render(
        <ChatProvider>
          <ProfileDialog open={true} onClose={() => {}} />
        </ChatProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });

    // Switch to Backup & Restore tab
    const tabs = screen.getAllByRole('tab');
    const backupTab = tabs.find((t) => t.textContent?.includes('Backup & Restore'));
    expect(backupTab).toBeDefined();

    await act(async () => {
      fireEvent.click(backupTab!);
    });

    const cloudExportBtn = screen.getByRole('button', { name: /cloud export/i });
    const exportFileBtn = screen.getByRole('button', { name: /export file/i });

    expect(cloudExportBtn).toBeDefined();
    expect(exportFileBtn).toBeDefined();

    // Verify ordering: Cloud Export should appear before (to the left of) Export File in the DOM
    const buttons = screen.getAllByRole('button');
    const cloudIndex = buttons.indexOf(cloudExportBtn);
    const exportIndex = buttons.indexOf(exportFileBtn);
    expect(cloudIndex).toBeLessThan(exportIndex);
  });

  it('prompts for password on Cloud Export, encrypts, posts to Nostr relay, and displays URL', async () => {
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

    // 1. Set screen name on Identity tab
    const tabs = screen.getAllByRole('tab');
    const identityTab = tabs.find((t) => t.textContent?.includes('Identity'));
    await act(async () => {
      fireEvent.click(identityTab!);
    });

    const screenNameInput = screen.getByLabelText(/screen name/i);
    await act(async () => {
      fireEvent.change(screenNameInput, { target: { value: 'Starlight Nomad' } });
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // 2. Switch to Backup & Restore tab
    const backupTab = tabs.find((t) => t.textContent?.includes('Backup & Restore'));
    await act(async () => {
      fireEvent.click(backupTab!);
    });

    // 3. Click "Cloud Export"
    const cloudExportBtn = screen.getByRole('button', { name: /cloud export/i });
    await act(async () => {
      fireEvent.click(cloudExportBtn);
    });

    // Verify password prompt modal appeared
    expect(screen.getByText('Set a password to encrypt your profile backup before posting to Nostr relays. You will need this password to decrypt and restore your profile on another device.')).toBeDefined();

    const passwordInput = screen.getByLabelText(/encryption password/i);
    expect(passwordInput).toBeDefined();

    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: 'SuperSecret123!' } });
    });

    // Click OK
    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    await act(async () => {
      fireEvent.click(okBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    // 4. Verify presentation modal with generated URL
    expect(screen.getByText('Cloud Export Ready')).toBeDefined();
    expect(
      screen.getByText('Open the link below on your other device to decrypt and restore your profile:')
    ).toBeDefined();

    // Verify restore URL contains ?restore=
    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const urlInput = inputs.find((input) => input.value.includes('?restore='));
    expect(urlInput).toBeDefined();
    expect(urlInput!.value).toMatch(/\?restore=[a-f0-9-]+/i);
  });

  it(
    'completes the full loop: Cloud Export on device 1 -> Cloud Restore URL on device 2 -> Usual Import Process',
    async () => {
    // DEVICE 1: Create profile and cloud export
    let generatedRestoreUrl = '';

    const { ChatProvider } = await import('../context/ChatContext');

    const { unmount: unmountDev1 } = render(
      <ChatProvider>
        <ProfileDialog open={true} onClose={() => {}} />
      </ChatProvider>
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Set screen name
    const tabs = screen.getAllByRole('tab');
    const identityTab = tabs.find((t) => t.textContent?.includes('Identity'))!;
    await act(async () => {
      fireEvent.click(identityTab);
    });

    const screenNameInput = screen.getByLabelText(/screen name/i);
    await act(async () => {
      fireEvent.change(screenNameInput, { target: { value: 'DeviceOneHero' } });
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Backup tab -> Cloud Export
    const backupTab = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Backup & Restore'))!;
    await act(async () => {
      fireEvent.click(backupTab);
    });

    const cloudExportBtn = screen.getByRole('button', { name: /cloud export/i });
    await act(async () => {
      fireEvent.click(cloudExportBtn);
    });

    const passwordInput = screen.getByLabelText(/encryption password/i);
    await act(async () => {
      fireEvent.change(passwordInput, { target: { value: 'CrossDevicePass99!' } });
    });

    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    await act(async () => {
      fireEvent.click(okBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
    const urlInput = inputs.find((input) => input.value.includes('?restore='));
    expect(urlInput).toBeDefined();
    generatedRestoreUrl = urlInput!.value;
    expect(generatedRestoreUrl).toBeTruthy();

    // Extract UUID from generated URL
    const restoreUuid = new URL(generatedRestoreUrl).searchParams.get('restore');
    expect(restoreUuid).toBeTruthy();

    unmountDev1();
    cleanup();

    // DEVICE 2: Simulate another fresh device opening the URL
    localStorage.clear();
    sessionStorage.clear();
    await db.clearAll();

    // Set browser address bar to the restore URL
    window.history.replaceState(null, '', `/?restore=${restoreUuid}`);

    // Render App on device 2
    const { default: App } = await import('../App');
    render(<App />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    // CloudRestoreDialog should appear automatically
    expect(screen.getByText('Cloud Profile Restore')).toBeDefined();

    // Wait for retrieval from Nostr relay
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    // Expect password prompt on device 2
    expect(screen.getByText('Encrypted profile backup found on Nostr relays!')).toBeDefined();

    // Test wrong password first
    const dev2PasswordInput = screen.getByLabelText(/encryption password/i);
    await act(async () => {
      fireEvent.change(dev2PasswordInput, { target: { value: 'WrongPassword!' } });
    });

    const decryptBtn = screen.getByRole('button', { name: /decrypt & restore/i });
    await act(async () => {
      fireEvent.click(decryptBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Should show decryption error
    expect(screen.getByText(/Decryption failed/i)).toBeDefined();

    // Now enter the correct password
    await act(async () => {
      fireEvent.change(dev2PasswordInput, { target: { value: 'CrossDevicePass99!' } });
    });

    await act(async () => {
      fireEvent.click(decryptBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });

    // Verify URL parameter was cleaned
    expect(window.location.search).not.toContain('restore=');

    // Should proceed to the usual import process in ProfileDialog:
    // Backup Details preview is rendered!
    expect(screen.getByText('Backup Details')).toBeDefined();
    expect(screen.getByText('DeviceOneHero')).toBeDefined();
    expect(screen.getByRole('button', { name: /restore \(clear & load\)/i })).toBeDefined();

    // Click "Restore (Clear & Load)" to finalize usual import process
    const restoreClearBtn = screen.getByRole('button', { name: /restore \(clear & load\)/i });
    await act(async () => {
      fireEvent.click(restoreClearBtn);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    // Check that profile on Device 2 now has DeviceOneHero
    const storedProfile = await db.getProfile();
    expect(storedProfile?.screenName).toBe('DeviceOneHero');
  }, 25000);
});
