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

describe('title panel description', () => {
  it('sets description on the title panel when roomDescription is passed', () => {
    const panels = ComicLayoutEngine.generatePanels([], {
      panelWidth: 400,
      panelHeight: 425,
      roomName: 'My Secret Club',
      roomDescription: 'Where secret ideas become comics',
    });
    expect(panels[0].isTitlePanel).toBe(true);
    expect(panels[0].description).toBe('Where secret ideas become comics');

    const withMessages = ComicLayoutEngine.generatePanels([message({ id: 'm1' })], {
      panelWidth: 400,
      panelHeight: 425,
      roomName: 'My Secret Club',
      roomDescription: 'Where secret ideas become comics',
    });
    expect(withMessages[0].isTitlePanel).toBe(true);
    expect(withMessages[0].description).toBe('Where secret ideas become comics');
  });

  it('draws the description in mixed-case italic Comic Sans with smart quotes inside yellow title box', () => {
    const calls: Array<{ text?: string; font?: string; x?: number; y?: number; op: string; args?: any[] }> = [];

    let currentFont = '';
    const mockCtx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      textAlign: '',
      textBaseline: '',
      setLetterSpacing: () => {},
      fillRect: (x: number, y: number, w: number, h: number) => {
        calls.push({ op: 'fillRect', args: [x, y, w, h] });
      },
      strokeRect: (x: number, y: number, w: number, h: number) => {
        calls.push({ op: 'strokeRect', args: [x, y, w, h] });
      },
      fillText: (text: string, x: number, y: number) => {
        calls.push({ op: 'fillText', text, font: currentFont, x, y });
      },
      measureText: (text: string) => ({ width: text.length * 8 }),
      get font() {
        return currentFont;
      },
      set font(val: string) {
        currentFont = val;
      },
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {},
    } as unknown as CanvasRenderingContext2D;

    const [titlePanel] = ComicLayoutEngine.generatePanels([], {
      panelWidth: 400,
      panelHeight: 425,
      roomName: 'Clubhouse',
      roomDescription: 'Where Superheroes Hang Out',
    });

    const mockAvatarManager = {
      avatarCache: new Map(),
      renderAvatarHead: () => null,
      renderAvatarIcon: () => null,
    } as any;

    ComicLayoutEngine.drawTitlePanel(mockCtx, titlePanel, 400, 425, mockAvatarManager);

    // Verify fillText was called with description lines wrapped with smart quotes and preserved case
    const descCalls = calls.filter((c) => c.op === 'fillText' && c.font?.includes('italic 12px'));
    expect(descCalls.length).toBeGreaterThan(0);
    expect(descCalls[0]?.text?.startsWith('“')).toBe(true);
    expect(descCalls[descCalls.length - 1]?.text?.endsWith('”')).toBe(true);
    const combinedDesc = descCalls.map((c) => c.text).join(' ');
    expect(combinedDesc).toBe('“Where Superheroes Hang Out”');
    // Verify font was mixed-case italic Comic Sans
    expect(descCalls[0].font).toContain('italic 12px');
    expect(descCalls[0].font).toContain('Comic Sans');
    // Centered in the yellow box (width is 400, so center x = 200)
    expect(descCalls[0].x).toBe(200);

    // Verify the yellow title box rect was drawn
    const yellowBox = calls.find((c) => c.op === 'fillRect' && c.args?.[0] === 16 && c.args?.[1] === 18);
    expect(yellowBox).toBeDefined();
    // Yellow box width is 400 - 32 = 368
    expect(yellowBox?.args?.[2]).toBe(368);
    // Yellow box height accommodates title and description
    expect(yellowBox?.args?.[3]).toBeGreaterThanOrEqual(74);

    // Verify vertical separation:
    const titleCall = calls.find((c) => c.op === 'fillText' && c.text === 'CLUBHOUSE');
    expect(titleCall).toBeDefined();
    const titleY = titleCall!.y!;
    const descY = descCalls[0].y!;
    // Separation from title: 22px title + 10px separation = 32px
    expect(descY - titleY).toBe(32);
    // Separation from bottom of title box:
    const lastDescY = descCalls[descCalls.length - 1].y!;
    const boxBottom = (yellowBox?.args?.[1] ?? 18) + (yellowBox?.args?.[3] ?? 74);
    const separationToBottom = boxBottom - (lastDescY + 16);
    expect(separationToBottom).toBeGreaterThanOrEqual(9);
    expect(separationToBottom).toBeLessThanOrEqual(15);
  });
});

