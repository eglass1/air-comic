/**
 * Title-panel cast composition.
 *
 * The strip's "starring" list is built from three sources that can disagree
 * about a person's name -- the local profile, the roster, and the name carried
 * by each historical message -- so it has to be keyed by identity.
 */

import { describe, it, expect } from 'vitest';
import { ComicLayoutEngine } from '../comicLayout';
import type { ChatMessage, Participant } from '../../types';

const ALICE = 'participant-alice';

const message = (overrides: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  convId: 'conv',
  senderId: ALICE,
  sender: { screenName: 'Alice', avatarName: 'Armando' },
  timestamp: 1_000,
  text: 'hello',
  keyId: 'public-v3',
  isSelf: true,
  sendState: 'relayed',
  ...overrides,
});

const participant = (screenName: string): Participant => ({
  participantId: ALICE,
  publicKey: '',
  signingPublicKey: '',
  screenName,
  avatarName: 'Armando',
  lastSeen: 1_000,
  isSelf: true,
  status: 'online',
  isApproved: true,
});

describe('starring cast', () => {
  it('stars a renamed person once, under the name they now use', () => {
    const messages = [
      message({ id: 'm1', timestamp: 1_000, sender: { screenName: 'Alice', avatarName: 'Armando' } }),
      message({ id: 'm2', timestamp: 2_000, sender: { screenName: 'Alicia', avatarName: 'Armando' } }),
    ];

    const [title] = ComicLayoutEngine.generatePanels(messages, {
      panelWidth: 400,
      panelHeight: 425,
      roomName: 'Test Room',
      profile: { participantId: ALICE, screenName: 'Alicia', avatarName: 'Armando' },
      participants: [participant('Alicia')],
    });

    expect(title.isTitlePanel).toBe(true);
    expect(title.starringMembers?.map((m) => m.screenName)).toEqual(['Alicia']);
  });

  it('still separates two people who happen to share a screen name', () => {
    const messages = [
      message({ id: 'm1', senderId: 'participant-a', sender: { screenName: 'Alex', avatarName: 'Armando' } }),
      message({ id: 'm2', senderId: 'participant-b', sender: { screenName: 'Alex', avatarName: 'Susan' } }),
    ];

    const [title] = ComicLayoutEngine.generatePanels(messages, {
      panelWidth: 400,
      panelHeight: 425,
      roomName: 'Test Room',
    });

    expect(title.starringMembers?.length).toBe(2);
  });
});
