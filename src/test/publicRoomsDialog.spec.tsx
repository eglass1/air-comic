/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { createAppTheme } from '../theme';
import { PublicRoomsDialog } from '../components/PublicRoomsDialog';
import type { PublicRoomDescriptorPacket } from '../types';

let mockChatState: any = {};

vi.mock('../context/ChatContext', () => ({
  useChat: () => mockChatState,
}));

describe('PublicRoomsDialog', () => {
  beforeEach(() => {
    mockChatState = {
      publicRoomsList: [] as PublicRoomDescriptorPacket[],
      refreshPublicRoomsList: vi.fn().mockResolvedValue(undefined),
      joinPublicRoom: vi.fn(),
      convId: 'conv-pub-1',
      roomMode: 'public',
      channelTitle: 'My Cozy Public Lounge',
      channelDescription: 'Come hang out and chat',
      publicRoomId: 'pubroom-1',
      publicJoinToken: 'token-123',
      currentPublicRoomDescriptor: null,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const renderDialog = async (open = true, onClose = vi.fn()) => {
    const theme = createAppTheme('light');
    let utils: any;
    await act(async () => {
      utils = render(
        <ThemeProvider theme={theme}>
          <PublicRoomsDialog open={open} onClose={onClose} />
        </ThemeProvider>
      );
    });
    return utils;
  };

  it('displays the current public room even if publicRoomsList from relays is empty', async () => {
    mockChatState.publicRoomsList = [];
    await renderDialog(true);

    // The current room's title and description should be visible
    expect(await screen.findByText('My Cozy Public Lounge')).toBeTruthy();
    expect(screen.getByText('Come hang out and chat')).toBeTruthy();

    // The "Current Room" chip should be displayed
    expect(screen.getByText('Current Room')).toBeTruthy();

    // The button for the current room should be disabled and say "Inside"
    const insideButton = screen.getByRole('button', { name: /inside/i });
    expect(insideButton).toBeTruthy();
    expect((insideButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('prioritizes the current room at the top of the list when other rooms are present', async () => {
    const otherRoom: PublicRoomDescriptorPacket = {
      type: 'public_room_descriptor',
      protocol: 'airthread/3',
      extension: 'airthread/3-public-rooms',
      descriptorVersion: 3,
      publicRoomId: 'pubroom-other',
      convId: 'conv-other',
      publicJoinToken: 'token-other',
      name: 'Other Cool Room',
      description: 'Another conversation',
      creatorId: 'user-bob',
      creatorScreenName: 'Bob',
      creatorSigningPublicKey: 'key-bob',
      createdAt: Date.now() + 100000,
      updatedAt: Date.now() + 100000,
      expiresAt: Date.now() + 3600000,
      relayUrls: [],
      language: 'en',
      tags: ['cool'],
      historyPolicy: 'peer_sync',
      contentPolicy: 'public',
      signature: 'sig',
    };

    mockChatState.publicRoomsList = [otherRoom];
    await renderDialog(true);

    expect(await screen.findByText('My Cozy Public Lounge')).toBeTruthy();
    expect(screen.getByText('Other Cool Room')).toBeTruthy();

    // The other room should have an active "Join" button
    const joinButton = screen.getByRole('button', { name: /join/i });
    expect(joinButton).toBeTruthy();
    expect((joinButton as HTMLButtonElement).disabled).toBe(false);

    // Clicking Join calls joinPublicRoom
    fireEvent.click(joinButton);
    expect(mockChatState.joinPublicRoom).toHaveBeenCalledWith(otherRoom);
  });

  it('does not synthesize a public room entry if current roomMode is private', async () => {
    mockChatState.roomMode = 'private';
    mockChatState.convId = 'conv-priv-1';
    mockChatState.publicRoomsList = [];

    await renderDialog(true);

    // Since roomMode is private and list is empty, it shouldn't show "My Cozy Public Lounge"
    expect(screen.queryByText('My Cozy Public Lounge')).toBeNull();
    expect(await screen.findByText('No active public rooms currently')).toBeTruthy();
  });

  it('triggers refreshPublicRoomsList when opened and when refresh button is clicked', async () => {
    await renderDialog(true);
    expect(mockChatState.refreshPublicRoomsList).toHaveBeenCalled();

    const refreshElement = await screen.findByLabelText('Refresh');
    const button = refreshElement.querySelector('button') || refreshElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(mockChatState.refreshPublicRoomsList).toHaveBeenCalledTimes(2);
  });
});
