/**
 * @vitest-environment jsdom
 *
 * Smoke test: the provider mounts, completes its startup path, and renders the
 * app without throwing. This is the one thing the protocol tests cannot cover
 * -- it exercises profile creation, relay configuration, presence startup, tab
 * restoration and the first room session end to end in a DOM.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { installFakeWebSocket, registerRelay, closeAllSockets } from './fakeRelay';

installFakeWebSocket();

const errors: unknown[] = [];

/**
 * TabBar renders a close IconButton inside a MUI Tab, which nests a <button>.
 * That warning predates this work and is not a protocol concern, so it is
 * filtered rather than allowed to mask real errors.
 */
const isPreexistingNestingWarning = (entry: unknown) =>
  Array.isArray(entry) &&
  typeof entry[0] === 'string' &&
  (entry[0].includes('cannot be a descendant of') ||
    entry[0].includes('cannot contain a nested'));

const realErrors = () => errors.filter((e) => !isPreexistingNestingWarning(e));

beforeAll(() => {
  ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band',
   'wss://purplerelay.com', 'wss://relay.snort.social'].forEach(registerRelay);

  // jsdom implements neither of these; the untouched comic renderer uses both.
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    value: () => {},
    configurable: true,
  });
  // jsdom has no canvas; the comic renderer only needs it not to throw.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => null,
    configurable: true,
  });
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
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

describe('application mount', () => {
  it('renders through the full startup path without throwing', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

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

    // Let profile creation, relay configuration and the first session settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });

    expect(snapshot).not.toBeNull();
    const chat = snapshot!;

    // An identity was generated on first run [C-02].
    expect(chat.profile?.participantId).toBeTruthy();
    expect(chat.fingerprint).toMatch(/^[0-9A-F:]+$/);

    // A private room opened and reached its own epoch 1 [PR-01][O-03].
    expect(chat.tabs.length).toBeGreaterThan(0);
    expect(chat.roomMode).toBe('private');
    expect(chat.convId).toBeTruthy();
    expect(chat.isApproved).toBe(true);
    expect(chat.activeEpoch).toBe(1);
    expect(chat.activeKeyId).toMatch(/^epoch-1-/);
    expect(chat.roomFingerprint).toMatch(/^[0-9A-F:]+$/);

    // Relays are configured and connectivity is reported separately from
    // direct acceleration [W-04].
    expect(chat.relayUrls.length).toBe(5);
    expect(chat.relayStatuses.length).toBe(5);
    expect(chat.connectionStatus).toBe('connected');
    expect(['unavailable', 'disabled', 'active', 'partial']).toContain(
      chat.accelerationStatus
    );

    expect(realErrors()).toEqual([]);
  }, 30000);

  it('sends a message through the provider', async () => {
    const { ChatProvider, useChat } = await import('../context/ChatContext');

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
      await new Promise((r) => setTimeout(r, 400));
    });

    await act(async () => {
      await snapshot!.sendMessage('hello from the provider');
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(snapshot!.messages.some((m) => m.text === 'hello from the provider')).toBe(true);
  }, 30000);

  it('renders the real App tree, including the rewritten dialogs', async () => {
    const [{ default: App }, { ChatProvider }, { ThemeProvider, CssBaseline }, { createAppTheme }] =
      await Promise.all([
        import('../App'),
        import('../context/ChatContext'),
        import('@mui/material'),
        import('../theme'),
      ]);

    let container: HTMLElement | null = null;
    await act(async () => {
      const result = render(
        <ThemeProvider theme={createAppTheme('light')}>
          <CssBaseline />
          <ChatProvider>
            <App />
          </ChatProvider>
        </ThemeProvider>
      );
      container = result.container;
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    expect(container).not.toBeNull();
    // Something actually rendered rather than an empty error boundary.
    expect(container!.querySelectorAll('*').length).toBeGreaterThan(20);
    expect(realErrors()).toEqual([]);
  }, 30000);
});
