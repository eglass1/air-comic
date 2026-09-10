/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { createAppTheme } from '../theme';
import { FriendsDialog } from '../components/FriendsDialog';
import type { Friend } from '../types';

let mockChatState: any = {};

vi.mock('../context/ChatContext', () => ({
  useChat: () => mockChatState,
}));

describe('FriendsDialog', () => {
  const sampleFriend: Friend = {
    id: 'friend-1',
    participantId: 'GtlJBFqqZnA6test123',
    screenName: 'Dave',
    publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAAAAA',
    signingPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAA',
    contactInfo: {
      info: 'Secret Bio Info that should not show',
    },
    notes: 'Encountered in AirComic on 9/6/2026',
    createdAt: 1725600000000,
    updatedAt: 1725600000000,
  };

  beforeEach(() => {
    mockChatState = {
      friends: [sampleFriend],
      updateFriend: vi.fn().mockResolvedValue(undefined),
      deleteFriend: vi.fn().mockResolvedValue(undefined),
      inviteFriendToRoom: vi.fn().mockResolvedValue('sent'),
      isFriendOnline: vi.fn().mockReturnValue(false),
      pendingInvites: [],
      cancelPendingInvite: vi.fn(),
      participants: [],
      isApproved: true,
      isRekeying: false,
      openQuickMessage: vi.fn(),
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
          <FriendsDialog open={open} onClose={onClose} />
        </ThemeProvider>
      );
    });
    return utils;
  };

  it('is titled "Friends (count)" and retains the count in the title', async () => {
    await renderDialog(true);

    // Title should be "Friends (1)" instead of "Friends Directory (1)"
    expect(screen.getByText('Friends (1)')).toBeTruthy();
    expect(screen.queryByText(/Friends Directory/i)).toBeNull();
  });

  it('removes the "Add Friend" functionality for adding a friend manually', async () => {
    await renderDialog(true);

    // No "Add Friend" button in header
    expect(screen.queryByRole('button', { name: /add friend/i })).toBeNull();
  });

  it('displays empty state without manual add button or instructions', async () => {
    mockChatState.friends = [];
    await renderDialog(true);

    expect(screen.getByText('No friends yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add first friend/i })).toBeNull();
    expect(screen.queryByText(/add contacts manually/i)).toBeNull();
  });

  it('only shows name, online/offline status, and notes on the friend card (no key info, no bio)', async () => {
    await renderDialog(true);

    // Name
    expect(screen.getByText('Dave')).toBeTruthy();
    // Offline status
    expect(screen.getByText('Offline')).toBeTruthy();
    // Notes
    expect(screen.getByText('Encountered in AirComic on 9/6/2026')).toBeTruthy();

    // Does NOT show public key, ID snippet, or bio
    expect(screen.queryByText(/ID: GtlJBFqqZnA6/i)).toBeNull();
    expect(screen.queryByText(/MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA/i)).toBeNull();
    expect(screen.queryByText(/Secret Bio Info/i)).toBeNull();
    expect(screen.queryByLabelText(/copy public key pem/i)).toBeNull();
  });

  it('allows notes to be edited directly on the card with pencil icon', async () => {
    await renderDialog(true);

    // Pencil edit button on the card
    const editNoteBtn = screen.getByLabelText('Edit note for Dave');
    expect(editNoteBtn).toBeTruthy();

    // Click pencil to edit note
    await act(async () => {
      fireEvent.click(editNoteBtn);
    });

    // An input field with the current note should appear
    const noteInput = screen.getByPlaceholderText('Add a note...') as HTMLInputElement;
    expect(noteInput).toBeTruthy();
    expect(noteInput.value).toBe('Encountered in AirComic on 9/6/2026');

    // Change note and click Save
    await act(async () => {
      fireEvent.change(noteInput, { target: { value: 'Best comic friend ever' } });
    });

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockChatState.updateFriend).toHaveBeenCalledTimes(1);
    expect(mockChatState.updateFriend).toHaveBeenCalledWith({
      ...sampleFriend,
      notes: 'Best comic friend ever',
    });
  });

  it('cancels notes editing without saving', async () => {
    await renderDialog(true);

    const editNoteBtn = screen.getByLabelText('Edit note for Dave');
    await act(async () => {
      fireEvent.click(editNoteBtn);
    });

    const noteInput = screen.getByPlaceholderText('Add a note...') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(noteInput, { target: { value: 'Different note' } });
    });

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    expect(mockChatState.updateFriend).not.toHaveBeenCalled();
    expect(screen.getByText('Encountered in AirComic on 9/6/2026')).toBeTruthy();
  });

  it('removes the separate "Edit" button and related editing dialog', async () => {
    await renderDialog(true);

    // There should be NO separate "Edit" action button on the card
    expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();

    // The separate edit dialog with screen name, encryption key, etc., should not exist
    expect(screen.queryByLabelText(/Screen Name \*/i)).toBeNull();
    expect(screen.queryByLabelText(/Encryption Public Key/i)).toBeNull();
  });

  it('retains Delete button and Invite to Room button', async () => {
    window.confirm = vi.fn().mockReturnValue(true);
    await renderDialog(true);

    const inviteBtn = screen.getByRole('button', { name: /invite to room/i });
    expect(inviteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(inviteBtn);
    });
    expect(mockChatState.inviteFriendToRoom).toHaveBeenCalledWith(sampleFriend);

    const deleteBtn = screen.getByRole('button', { name: /delete/i });
    expect(deleteBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(mockChatState.deleteFriend).toHaveBeenCalledWith('friend-1');
  });

  it('displays the info icon on the friend card and opens the details popup window when clicked', async () => {
    await renderDialog(true);

    const infoBtn = screen.getByLabelText('View details for Dave');
    expect(infoBtn).toBeTruthy();

    // Initially popup is closed
    expect(screen.queryByText('INFORMATION / BIOGRAPHY')).toBeNull();

    // Click info icon
    await act(async () => {
      fireEvent.click(infoBtn);
    });

    // Contact card details popup is now open
    expect(screen.getByText('INFORMATION / BIOGRAPHY')).toBeTruthy();
    expect(screen.getByText('PUBLIC KEYS & IDENTITY')).toBeTruthy();
    expect(screen.getByText('Secret Bio Info that should not show')).toBeTruthy();
    expect(screen.getByText('GtlJBFqqZnA6test123')).toBeTruthy();
    expect(screen.getByText('Saved in Friends')).toBeTruthy();

    // Close the details popup
    const closeButtons = screen.getAllByRole('button', { name: /close/i });
    // The details dialog has its own Close button
    await act(async () => {
      fireEvent.click(closeButtons[closeButtons.length - 1]);
    });

    // Contact card details popup is closed
    expect(screen.queryByText('INFORMATION / BIOGRAPHY')).toBeNull();
  });

  it('does not display the Quick Message balloon icon when the friend is offline', async () => {
    mockChatState.isFriendOnline = vi.fn().mockReturnValue(false);
    await renderDialog(true);

    expect(screen.queryByLabelText('Quick message to Dave')).toBeNull();
    expect(screen.queryByRole('button', { name: /quick message/i })).toBeNull();
  });

  it('displays the Quick Message balloon icon when the friend is online and opens quick message on click', async () => {
    mockChatState.isFriendOnline = vi.fn().mockReturnValue(true);
    await renderDialog(true);

    const quickMsgBtn = screen.getByLabelText('Quick message to Dave');
    expect(quickMsgBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(quickMsgBtn);
    });

    expect(mockChatState.openQuickMessage).toHaveBeenCalledTimes(1);
    expect(mockChatState.openQuickMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        participantId: 'GtlJBFqqZnA6test123',
        screenName: 'Dave',
        publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAAAAA',
        signingPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAA',
      })
    );
  });

  it('displays friend as online and messagable when present in room participants', async () => {
    mockChatState.isFriendOnline = vi.fn().mockReturnValue(false);
    mockChatState.participants = [
      {
        participantId: 'GtlJBFqqZnA6test123',
        screenName: 'Dave',
        publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAAAAA',
        signingPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAAAA',
        status: 'online',
        isSelf: false,
        isApproved: true,
        lastSeen: Date.now(),
      },
    ];
    await renderDialog(true);

    expect(screen.getByText('1 online')).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.getByLabelText('Quick message to Dave')).toBeTruthy();
  });
});
