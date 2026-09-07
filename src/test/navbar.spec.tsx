/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { createAppTheme } from '../theme';
import { Navbar, formatConnectionTooltip } from '../components/Navbar';

// Mock useChat and usePwaStatus hooks used by Navbar
const mockChatState = {
  profile: { participantId: 'test-user', screenName: 'Alice' },
  favoriteRooms: [],
  connectionStatus: 'connected',
  connectedPeersCount: 0,
  accelerationStatus: 'unavailable',
  pendingSendCount: 0,
  failedSendCount: 0,
  activeEpoch: 1,
  isApproved: true,
  isRekeying: false,
  pendingJoinRequests: [] as string[],
  clearHistory: vi.fn(),
  friends: [],
  roomMode: 'private',
  channelTitle: 'Test Room',
  zoomLevel: 1,
  setZoomLevel: vi.fn(),
};

const mockPwaState = {
  standalone: false,
  online: true,
  updateReady: false,
};

vi.mock('../context/ChatContext', () => ({
  useChat: () => mockChatState,
}));

vi.mock('../services/pwa', () => ({
  usePwaStatus: () => mockPwaState,
}));

describe('formatConnectionTooltip', () => {
  it('returns offline message when offline without mentioning relays or Nostr', () => {
    const text = formatConnectionTooltip({
      online: false,
      connectionStatus: 'connected',
      connectedPeersCount: 0,
    });
    expect(text).toBe('Offline - no network connection');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('returns connecting state without mentioning relays or Nostr', () => {
    const text = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connecting',
      connectedPeersCount: 0,
    });
    expect(text).toBe('Connecting...');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('returns connection error state when status is error', () => {
    const text = formatConnectionTooltip({
      online: true,
      connectionStatus: 'error',
      connectedPeersCount: 0,
    });
    expect(text).toBe('Connection error');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('returns just "Connected" when connected with 0 direct peers', () => {
    const text = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connected',
      connectedPeersCount: 0,
    });
    expect(text).toBe('Connected');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('returns singular "Connected - 1 Direct Connection" when 1 peer is directly connected', () => {
    const text = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connected',
      connectedPeersCount: 1,
    });
    expect(text).toBe('Connected - 1 Direct Connection');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('returns plural "Connected - x Direct Connections" when multiple peers are connected', () => {
    const text = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connected',
      connectedPeersCount: 3,
    });
    expect(text).toBe('Connected - 3 Direct Connections');
    expect(text.toLowerCase()).not.toContain('nostr');
    expect(text.toLowerCase()).not.toContain('relay');
  });

  it('appends sending and failed counts if present', () => {
    const textWithSend = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connected',
      connectedPeersCount: 2,
      pendingSendCount: 1,
    });
    expect(textWithSend).toBe('Connected - 2 Direct Connections | 1 sending');

    const textWithFailed = formatConnectionTooltip({
      online: true,
      connectionStatus: 'connected',
      connectedPeersCount: 0,
      failedSendCount: 2,
    });
    expect(textWithFailed).toBe('Connected | 2 failed to send');
  });
});

describe('Navbar component', () => {
  const defaultProps = {
    themeMode: 'light' as const,
    onToggleTheme: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenFriends: vi.fn(),
    onOpenInvite: vi.fn(),
    onOpenSecurity: vi.fn(),
    onOpenAddContact: vi.fn(),
    onOpenRequests: vi.fn(),
    onOpenPublicRooms: vi.fn(),
    onOpenFavorites: vi.fn(),
    onOpenInstall: vi.fn(),
  };

  const renderNavbar = (props = {}) => {
    const theme = createAppTheme('light');
    return render(
      <ThemeProvider theme={theme}>
        <Navbar {...defaultProps} {...props} />
      </ThemeProvider>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChatState.connectionStatus = 'connected';
    mockChatState.connectedPeersCount = 0;
    mockChatState.pendingJoinRequests = [];
    mockChatState.roomMode = 'private';
    mockPwaState.online = true;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows toolbar action icons in desktop mode (isMobile=false)', () => {
    renderNavbar({ isMobile: false });

    // Toolbar icons should be rendered
    expect(screen.getByRole('button', { name: /share invite/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /public rooms/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /favorite rooms/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /friends/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /profile/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /dark\/light mode/i })).toBeTruthy();

    // Status indicators are also present
    expect(screen.getByRole('button', { name: /private encrypted room/i })).toBeTruthy();
    expect(screen.getAllByLabelText(/aircomic main menu/i).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Connected')).toBeTruthy();
  });

  it('hides the top right toolbar action icons in mobile mode (isMobile=true)', () => {
    renderNavbar({ isMobile: true });

    // Toolbar action icons should NOT be in the document
    expect(screen.queryByRole('button', { name: /share invite/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /public rooms/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /favorite rooms/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /friends/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /profile/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /dark\/light mode/i })).toBeNull();

    // Private indicator icon is STILL present
    expect(screen.getByRole('button', { name: /private encrypted room/i })).toBeTruthy();
    // Brand logo menu is STILL present
    expect(screen.getAllByLabelText(/aircomic main menu/i).length).toBeGreaterThan(0);
    // Connection indicator is STILL present
    expect(screen.getByLabelText('Connected')).toBeTruthy();
  });

  it('shows connection indicator with direct connections count in mobile mode', () => {
    mockChatState.connectedPeersCount = 2;
    renderNavbar({ isMobile: true });

    expect(screen.getByLabelText('Connected - 2 Direct Connections')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('still shows public room indicator in mobile mode when roomMode=public', () => {
    mockChatState.roomMode = 'public';
    renderNavbar({ isMobile: true });

    expect(screen.getByRole('button', { name: /public room:/i })).toBeTruthy();
  });

  it('allows mobile users to open the main menu and access actions', async () => {
    mockChatState.pendingJoinRequests = ['req-1'];
    renderNavbar({ isMobile: true });

    // Click brand logo to open menu
    const menuTrigger = screen.getAllByLabelText(/aircomic main menu/i)[0];
    await act(async () => {
      fireEvent.click(menuTrigger);
    });

    // Menu items are available
    expect(screen.getByText('Share Invite')).toBeTruthy();
    expect(screen.getByText('Public Rooms')).toBeTruthy();
    expect(screen.getByText('Join Requests (1)')).toBeTruthy();
    expect(screen.getByText('Profile')).toBeTruthy();
    expect(screen.getByText('Network/Security')).toBeTruthy();
  });
});
