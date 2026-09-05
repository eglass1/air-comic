import {
  ComicPanel,
  ComicCharacterInPanel,
  ComicBalloon,
  BalloonMode,
  AvatarData,
  AvatarMetrics,
  EM_NEUTRAL,
  EM_HAPPY,
  EM_LAUGH,
  EM_COY,
  EM_SHOUT,
  EM_BORED,
  TitleStarringMember,
} from './types';
import {
  buildBalloonOutline,
  arcPoints,
  breakSpline,
  XBORDER,
  SMALLDELTA,
  LARGEDELTA,
  MINTAILHEIGHT,
  BUBBLEHEIGHT,
  INTERBUBBLE,
  ENDBUBBLEWIDTH,
  type BalloonOutline,
  type BalloonFontMetrics,
  type Pt,
} from './balloonSpline';
import { EmotionEngine, DetectedEmotion } from './emotionEngine';
import { AvatarManager } from './avatarManager';
import { ChatMessage, Participant } from '../types';

/** Per-speaker placement memory, kept across the panels of one strip. */
export interface CharacterHysteresis {
  /** Which way they faced last time (false = facing right). */
  lastDir: boolean;
  /** Who stood immediately to their left / right in the previous panel. */
  lastLeft: string | null;
  lastRight: string | null;
}

export interface PanelLayoutContext {
  hysteresis: Map<string, CharacterHysteresis>;
  /** participantId -> the participantIds that speaker was addressing. */
  talkTos: Map<string, string[]>;
  /** Avatar proportions, when the artwork has loaded. */
  metricsOf?: (avatarName: string) => AvatarMetrics | null;
}

export interface LayoutOptions {
  panelWidth: number;
  panelHeight: number;
  defaultBackdrop: string;
  roomName: string;
  titleAvatars?: string[];
  profile?: { screenName?: string; avatarName?: string } | null;
  participants?: Participant[];
  /**
   * Avatar proportions, so the panel camera can size the cast. Returns null for
   * an avatar whose art has not loaded yet, and the layout falls back to
   * estimates until it has.
   */
  avatarMetrics?: (avatarName: string) => AvatarMetrics | null;
}

export const COMIC_FONT_FAMILY =
  '"Comic Sans MS", "Comic Relief", "Comic Neue", "Chalkboard SE", sans-serif';

/** Line box height used for balloon text, at both layout and draw time. */
const BALLOON_LINE_HEIGHT = 16;

/**
 * Approximate text height for the balloon font, used in the original's area
 * estimate (its tmHeight).
 */
const BALLOON_TEXT_HEIGHT = 16;

/**
 * The original seeds a panel's layout with srand(m_seed) so the same panel
 * always comes out the same on redraw, then uses rand() to vary balloon widths.
 * This is that generator; we seed it from the panel id so the variety is stable
 * across re-renders instead of shuffling on every keystroke.
 */
class MsvcRand {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }

  /** balloon.cpp randfloat(): rand() / RAND_MAX, in [0, 1]. */
  float(): number {
    return this.next() / 32767;
  }
}

function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/**
 * Font metrics the outline builder needs. `baseAdd` is the Comic Sans vertical
 * kern the original applies (30 twips at the 180-twip balloon size).
 */
const BALLOON_FONT_METRICS: BalloonFontMetrics = {
  lineHeight: BALLOON_LINE_HEIGHT,
  topOffset: 1,
  baseAdd: 2,
};

export function balloonFontFor(mode: BalloonMode): string {
  return mode === 'whisper'
    ? `italic bold 12px ${COMIC_FONT_FAMILY}`
    : `bold 12px ${COMIC_FONT_FAMILY}`;
}

/**
 * Scratch context used to measure balloon text during layout. The original
 * wraps text for real before negotiating positions (CBalloon::SetBBox), so the
 * box the layout reasons about is the box that actually gets drawn; estimating
 * from character counts and then re-wrapping at draw time lets the two drift.
 */
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

export class ComicLayoutEngine {
  static readonly DEFAULT_WIDTH = 420;
  static readonly DEFAULT_HEIGHT = 360;

  static getRandomTitleAvatars(): string[] {
    const candidates = AvatarManager.AVAILABLE_AVATARS
      .map((a) => a.id.toLowerCase())
      .filter((id) => id !== 'earl');
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3);
  }

  /**
   * Emulate Microsoft Comic Chat's heuristic for breaking long messages
   * into natural phrase/clause chunks across comic balloons and panels.
   */
  static splitLongMessage(text: string, maxChunkLen: number = 80): string[] {
    text = text.trim();
    if (!text) return [];
    if (text.length <= maxChunkLen && !text.includes('\n')) {
      return [text];
    }

    // 1. First split by explicit line breaks
    const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
    const result: string[] = [];

    for (const para of paragraphs) {
      if (para.length <= maxChunkLen) {
        result.push(para);
        continue;
      }

      // 2. Split paragraph by sentence delimiters (. ! ?) while keeping punctuation
      const sentenceRegex = /([^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$)/g;
      const rawSentences = (para.match(sentenceRegex) || [para])
        .map((s) => s.trim())
        .filter(Boolean);

      let currentChunk = '';

      for (const sent of rawSentences) {
        if (sent.length <= maxChunkLen) {
          if (!currentChunk) {
            currentChunk = sent;
          } else if (currentChunk.length + 1 + sent.length <= maxChunkLen) {
            currentChunk += ' ' + sent;
          } else {
            result.push(currentChunk);
            currentChunk = sent;
          }
        } else {
          // 3. Sentence itself is longer than maxChunkLen. Split by clause punctuation or conjunctions
          if (currentChunk) {
            result.push(currentChunk);
            currentChunk = '';
          }

          const clauseRegex =
            /([^,;:—–-]+[,;:—–-]+\s*|\s+(?:and|but|or|so|because|although|however|then|while)\s+|[^,;:—–-]+$)/gi;
          const rawClauses = (sent.match(clauseRegex) || [sent])
            .map((c) => c.trim())
            .filter(Boolean);

          let clauseChunk = '';
          for (const clause of rawClauses) {
            if (clause.length <= maxChunkLen) {
              if (!clauseChunk) {
                clauseChunk = clause;
              } else if (clauseChunk.length + 1 + clause.length <= maxChunkLen) {
                clauseChunk += ' ' + clause;
              } else {
                result.push(clauseChunk);
                clauseChunk = clause;
              }
            } else {
              // 4. Split by words if clause itself is still too long
              if (clauseChunk) {
                result.push(clauseChunk);
                clauseChunk = '';
              }
              const words = clause.split(/\s+/);
              let wordChunk = '';
              for (const word of words) {
                if (!wordChunk) {
                  wordChunk = word;
                } else if (wordChunk.length + 1 + word.length <= maxChunkLen) {
                  wordChunk += ' ' + word;
                } else {
                  result.push(wordChunk);
                  wordChunk = word;
                }
              }
              if (wordChunk) {
                clauseChunk = wordChunk;
              }
            }
          }
          if (clauseChunk) {
            result.push(clauseChunk);
          }
        }
      }
      if (currentChunk) {
        result.push(currentChunk);
      }
    }

    return result.length > 0 ? result : [text];
  }

  /** The original caps a panel at five bodies and five balloons. */
  static readonly MAX_PANEL_BODIES = 5;
  static readonly MAX_PANEL_BALLOONS = 5;

  /**
   * Work out who a line is addressed to. Comic Chat took this from IRC-style
   * addressing, so we look for the classic "Name:" / "Name," opener first and
   * otherwise accept the name mentioned anywhere in the line.
   */
  private static detectTalkTos(
    text: string,
    idByName: Map<string, string>,
    selfId: string
  ): string[] {
    if (!text) return [];
    const found: string[] = [];
    const opener = text.match(/^\s*([^\s,:]{1,32})\s*[,:]/);
    const openerId = opener ? idByName.get(opener[1].toLowerCase()) : undefined;
    if (openerId && openerId !== selfId) found.push(openerId);

    const lower = text.toLowerCase();
    for (const [name, id] of idByName) {
      if (id === selfId || found.includes(id)) continue;
      const at = lower.indexOf(name);
      if (at < 0) continue;
      // Whole word only, so "Sam" does not match inside "Samantha".
      const before = at === 0 ? ' ' : lower[at - 1];
      const after = at + name.length >= lower.length ? ' ' : lower[at + name.length];
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      found.push(id);
    }
    return found;
  }

  static generatePanels(
    messages: ChatMessage[],
    options: Partial<LayoutOptions> = {}
  ): ComicPanel[] {
    const width = options.panelWidth || ComicLayoutEngine.DEFAULT_WIDTH;
    const height = options.panelHeight || ComicLayoutEngine.DEFAULT_HEIGHT;
    const defaultBackdrop = options.defaultBackdrop || 'room.bgb';
    const roomName = options.roomName || 'AirComic Lounge';
    const titleAvatars =
      options.titleAvatars && options.titleAvatars.length === 3
        ? options.titleAvatars
        : ComicLayoutEngine.getRandomTitleAvatars();

    // Collect starring cast members in chronological order of appearance (bumping up when > 3)
    const seenMembersMap = new Map<string, { screenName: string; avatarName: string }>();

    // 1. Initial participant / profile seed
    if (options.profile?.screenName) {
      seenMembersMap.set(options.profile.screenName.toLowerCase(), {
        screenName: options.profile.screenName,
        avatarName: options.profile.avatarName || 'Armando',
      });
    }

    if (options.participants) {
      options.participants.forEach((p) => {
        if (p.screenName && !seenMembersMap.has(p.screenName.toLowerCase())) {
          seenMembersMap.set(p.screenName.toLowerCase(), {
            screenName: p.screenName,
            avatarName: p.avatarName || 'Susan',
          });
        }
      });
    }

    // 2. Chronological messages: as new people enter / speak, add to bottom (bumping top if > 3)
    messages.forEach((msg) => {
      if (msg.isSystem) return;
      const sName = msg.sender?.screenName || (msg as any).senderName;
      const aName = msg.sender?.avatarName || (msg as any).avatarName;
      if (sName) {
        const key = sName.toLowerCase();
        seenMembersMap.delete(key);
        seenMembersMap.set(key, {
          screenName: sName,
          avatarName: aName || 'Armando',
        });
      }
    });

    if (seenMembersMap.size === 0) {
      seenMembersMap.set('host', { screenName: 'Host', avatarName: 'Armando' });
    }

    // Up to 8 members (2 columns of 4 rows, bumping oldest when > 8)
    const starringMembers = Array.from(seenMembersMap.values()).slice(-8);

    // Who is in the room, so a line can be matched to the person it addresses.
    const castById = new Map<string, { screenName: string; avatarName: string }>();
    const idByName = new Map<string, string>();
    messages.forEach((msg) => {
      if (msg.isSystem || !msg.senderId) return;
      const sName = msg.sender?.screenName || (msg as any).senderName;
      if (!sName) return;
      castById.set(msg.senderId, {
        screenName: sName,
        avatarName: msg.sender?.avatarName || (msg as any).avatarName || 'Armando',
      });
      idByName.set(sName.toLowerCase(), msg.senderId);
    });

    /** participantId -> who they were last addressing. */
    const talkTos = new Map<string, string[]>();

    const panels: ComicPanel[] = [];

    if (messages.length === 0) {
      // Empty state: render title panel with welcome
      panels.push({
        id: 'title-panel',
        panelIndex: 0,
        isTitlePanel: true,
        title: roomName,
        roomName,
        backdropName: defaultBackdrop,
        characters: [],
        balloons: [],
        titleAvatars,
        starringMembers,
        timestamp: Date.now(),
      });
      return panels;
    }

    // Title Panel
    panels.push({
      id: 'title-panel',
      panelIndex: 0,
      isTitlePanel: true,
      title: roomName,
      roomName,
      backdropName: defaultBackdrop,
      characters: [],
      balloons: [],
      titleAvatars,
      starringMembers,
      timestamp: messages[0].timestamp,
    });

    let currentPanel: ComicPanel | null = null;
    let panelIndex = 1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.isSystem) continue;

      const rawText = msg.text || (msg as any).content || '';
      const detected = EmotionEngine.detectEmotionFromText(rawText);
      const balloonMode: BalloonMode =
        (msg as any).balloonMode || detected.balloonMode;
      const emotion =
        (msg as any).emotion !== undefined
          ? (msg as any).emotion
          : detected.emotion;
      const intensity =
        (msg as any).emotionIntensity !== undefined
          ? (msg as any).emotionIntensity
          : detected.intensity;

      const avatarName = msg.sender?.avatarName || (msg as any).avatarName || (msg.isSelf ? 'Armando' : 'Susan');
      const senderId = msg.senderId;
      const screenName = msg.sender?.screenName || (msg as any).senderName || 'User';

      // Split long text into phrase-sized chunks according to MS Comic Chat heuristics
      const chunks = ComicLayoutEngine.splitLongMessage(detected.cleanText, 80);

      for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
        const chunkText = chunks[cIdx];
        if (!chunkText) continue;

        // Determine if we should start a new panel:
        let startNew = false;
        if (!currentPanel) {
          startNew = true;
        } else if (balloonMode === 'action') {
          // Actions get their own panel
          startNew = true;
        } else if (cIdx > 0) {
          // Subsequent chunks of a split long message flow into a new panel
          startNew = true;
        } else if (currentPanel.balloons.length >= this.MAX_PANEL_BALLOONS) {
          startNew = true;
        } else if (currentPanel.characters.some((c) => c.participantId === senderId)) {
          // Already in this panel, as speaker or listener: the original starts a
          // fresh panel rather than drawing anyone twice (CUnitPanelPage::AddLine
          // checking last->HasMember). It is what gives a back-and-forth its
          // panel-per-line rhythm.
          startNew = true;
        }

        if (startNew) {
          currentPanel = {
            id: `panel-${panelIndex}`,
            panelIndex,
            isTitlePanel: false,
            backdropName: defaultBackdrop,
            characters: [],
            balloons: [],
            timestamp: msg.timestamp,
          };
          panels.push(currentPanel);
          panelIndex++;
        }

        // Note who this line addresses; it steers where people stand and who
        // gets pulled into the panel to listen.
        const addressed = this.detectTalkTos(rawText, idByName, senderId);
        if (cIdx === 0) talkTos.set(senderId, addressed);

        // Add character to panel if not already present
        let charEntry = currentPanel!.characters.find(
          (c) => c.participantId === senderId
        );

        if (!charEntry) {
          charEntry = {
            participantId: senderId,
            screenName,
            avatarName,
            avatarData: null, // loaded asynchronously
            emotion,
            intensity,
            isSpeaker: true,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            flip: false,
            headX: 0,
            headY: 0,
            headTopY: 0,
          };
          currentPanel!.characters.push(charEntry);
        } else {
          charEntry.emotion = emotion;
          charEntry.intensity = intensity;
          charEntry.isSpeaker = true;
        }

        // Pull the people being spoken to into the panel as listeners, up to the
        // original's five-body limit (CUnitPanel::AddTalkTos).
        for (const targetId of talkTos.get(senderId) ?? []) {
          if (currentPanel!.characters.length >= this.MAX_PANEL_BODIES) break;
          if (currentPanel!.characters.some((c) => c.participantId === targetId)) continue;
          const info = castById.get(targetId);
          if (!info) continue;
          currentPanel!.characters.push({
            participantId: targetId,
            screenName: info.screenName,
            avatarName: info.avatarName,
            avatarData: null,
            emotion: EM_NEUTRAL,
            intensity: 0,
            isSpeaker: false,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            flip: false,
            headX: 0,
            headY: 0,
            headTopY: 0,
          });
        }

        // Add balloon for this chunk. Spoken text is upper-cased, which is how
        // the original renders every balloon (CBalloon's Capitalize); narration
        // boxes keep their own casing.
        currentPanel!.balloons.push({
          id: `balloon-${msg.id}-${cIdx}`,
          speakerParticipantId: senderId,
          speakerName: screenName,
          text: balloonMode === 'action' ? chunkText : chunkText.toLocaleUpperCase(),
          mode: balloonMode,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          tailX: 0,
          tailY: 0,
        });
      }
    }

    // Settle the strip: a balloon that will not fit above the cast moves into a
    // fresh panel, and a force-fitted balloon's leftover text follows it there.
    // The original does this inline as each line arrives (CUnitPanelPage::AddLine
    // starting a new panel when LayoutBalloons fails); doing it as a pass here
    // reaches the same arrangement.
    this.settlePanelOverflow(panels, width, height, defaultBackdrop, {
      hysteresis: new Map(),
      talkTos,
      metricsOf: options.avatarMetrics,
    });

    // Final pass with a clean placement memory, so hysteresis reflects the
    // panels as they finally stand rather than any speculative layout above.
    const layoutCtx = this.createLayoutContext();
    layoutCtx.talkTos = talkTos;
    layoutCtx.metricsOf = options.avatarMetrics;
    panels.forEach((p) => {
      if (!p.isTitlePanel) {
        this.layoutSinglePanel(p, width, height, layoutCtx);
      }
    });

    return panels;
  }

  /**
   * Repeatedly re-lay out the strip, splitting any panel whose balloons do not
   * fit, until everything settles. Panels are renumbered afterwards.
   */
  private static settlePanelOverflow(
    panels: ComicPanel[],
    width: number,
    height: number,
    defaultBackdrop: string,
    layoutCtx: PanelLayoutContext
  ): void {
    const MAX_SPLITS = 200;
    let splits = 0;

    for (let i = 0; i < panels.length && splits < MAX_SPLITS; i++) {
      const panel = panels[i];
      if (panel.isTitlePanel || panel.balloons.length === 0) continue;

      const fits = this.layoutSinglePanel(panel, width, height, layoutCtx);

      if (!fits && panel.balloons.length > 1) {
        // Move the last balloon (and its speaker, if nobody else needs them)
        // into a new panel and try this one again.
        const moved = panel.balloons.pop()!;
        const stillSpeaking = panel.balloons.some(
          (b) => b.speakerParticipantId === moved.speakerParticipantId
        );
        const speaker = panel.characters.find(
          (c) => c.participantId === moved.speakerParticipantId
        );
        if (!stillSpeaking && speaker) {
          panel.characters = panel.characters.filter((c) => c !== speaker);
        }
        panels.splice(i + 1, 0, {
          id: `${panel.id}-split`,
          panelIndex: 0,
          isTitlePanel: false,
          backdropName: panel.backdropName || defaultBackdrop,
          characters: speaker ? [{ ...speaker }] : [],
          balloons: [moved],
          timestamp: panel.timestamp,
        });
        splits++;
        i--; // retry this panel now that it is lighter
        continue;
      }

      // A force-fitted balloon may have handed us the tail of its text.
      const last = panel.balloons[panel.balloons.length - 1];
      if (last?.overflowText) {
        const carried = last.overflowText;
        last.overflowText = undefined;
        const speaker = panel.characters.find(
          (c) => c.participantId === last.speakerParticipantId
        );
        panels.splice(i + 1, 0, {
          id: `${panel.id}-cont`,
          panelIndex: 0,
          isTitlePanel: false,
          backdropName: panel.backdropName || defaultBackdrop,
          characters: speaker ? [{ ...speaker }] : [],
          balloons: [
            {
              ...last,
              id: `${last.id}-cont`,
              text: carried,
              lines: undefined,
              outline: undefined,
              overflowText: undefined,
            },
          ],
          timestamp: panel.timestamp,
        });
        splits++;
      }
    }

    let index = 0;
    for (const panel of panels) panel.panelIndex = index++;
  }

  /**
   * Estimated hair top as a fraction of character height, used to place balloons
   * before the avatar art has loaded. Refined from the real pixels at draw time.
   */
  private static readonly HEAD_TOP_RATIO = 0.08;
  /** Gap left between a balloon's underside and the top of the speaker's hair. */
  private static readonly STEM_GAP = 34;
  /** How far above the hair a stem stops. Keeps the tip clear of the artwork. */
  private static readonly STEM_CLEARANCE = 10;
  /** Side and top margins of the region balloons may occupy. */
  private static readonly BALLOON_MARGIN = 14;
  private static readonly BALLOON_TOP_MARGIN = 12;
  /**
   * Width of the corridor a balloon keeps clear on the side its stem descends,
   * so a later balloon can never be dropped on top of an earlier stem.
   * Ported from MINROUTEWIDTH (300 twips).
   */
  private static readonly MIN_ROUTE_WIDTH = 20;
  /**
   * How far a balloon tucks up under the one above it when they overlap
   * horizontally. The wavy outlines interleave rather than collide, and the
   * upper balloon is painted last so it stays legible.
   * Ported from TOPBORDER + YBORDER + HWAVEHEIGHT (90 twips).
   */
  private static readonly BALLOON_DOCK_TUCK = 6;
  /** Shortest stem worth drawing; below this the balloon is nudged up instead. */
  private static readonly MIN_STEM_HEIGHT = 14;
  /** How far the stem root is pulled inside the last text line's extent. */
  private static readonly STEM_ROOT_INSET = 10;
  /** Effectively infinite, for route-region intersection. */
  private static readonly FAR = 1e6;
  /**
   * Panel height over base body height. The original's LayoutAvatars uses
   * unitHeight / 1.9, so an unzoomed body fills a little over half the panel.
   */
  private static readonly BODY_HEIGHT_DIVISOR = 1.9;
  /** Width over height for an avatar whose art has not loaded yet. */
  private static readonly FALLBACK_ASPECT = 0.44;
  /** Where the head ends, as a fraction of body height, before art loads. */
  private static readonly FALLBACK_HEAD_BOTTOM_RATIO = 0.36;
  /** Opening panels the camera leaves as wide shots. */
  private static readonly ESTABLISHING_PANELS = 2;
  /**
   * Ceiling on the camera push-in. The head cap usually binds first; this stops
   * an avatar with unusual proportions from filling the whole frame.
   */
  private static readonly MAX_CAMERA_ZOOM = 1.9;
  /** Text short enough to keep on one line whatever else happens (ONELINETHRESHOLD). */
  private static readonly ONE_LINE_THRESHOLD = 33;
  /** Slack added to the estimated width so words are not wrapped too tightly. */
  private static readonly BALLOON_WIDTH_SLACK = 13;
  /** Balloon ink width (BALLOON_PEN, 28 twips) and the whisper halo (NIMBUS_PEN). */
  private static readonly BALLOON_PEN = 1.9;
  private static readonly NIMBUS_PEN = 6.7;


  /**
   * Wrap the text for real, build the hand-drawn outline around it, and report
   * the box that outline occupies. Mirrors CBalloon::SetBBox / ComputeInternals:
   * the original measures and shapes the balloon before negotiating positions,
   * so layout and drawing can never disagree about how big it is.
   *
   * Width comes from CUnitPanel::GetCloudEstimate. A very short line just gets
   * its own width. Otherwise the text's area and the headroom above the speaker
   * give a minimum width, and the balloon is then drawn somewhere between that
   * and the full panel — the original rolls its seeded rand() here, which is why
   * its balloons vary in shape rather than all coming out the same proportion.
   */
  static measureBalloon(
    text: string,
    mode: BalloonMode,
    panelWidth: number,
    maxHeight?: number,
    maxWidthOverride?: number,
    rand?: MsvcRand
  ): { lines: string[]; width: number; height: number; outline: BalloonOutline | null } {
    const ctx = getMeasureContext();
    const maxOutlineWidth = maxWidthOverride ?? Math.round(panelWidth - 2 * this.BALLOON_MARGIN);

    if (!ctx) {
      // No DOM (tests/SSR): fall back to a character-count estimate.
      const approxWidth = Math.min(maxOutlineWidth, Math.max(90, text.length * 7.5 + 14));
      const approxLines = Math.max(
        1,
        Math.ceil((text.length * 7.2) / Math.max(40, approxWidth - 14))
      );
      return {
        lines: [text],
        width: approxWidth,
        height: approxLines * BALLOON_LINE_HEIGHT + 14,
        outline: null,
      };
    }

    ctx.font = balloonFontFor(mode);
    const runLength = ctx.measureText(text).width;
    let widestWord = 0;
    for (const word of text.split(/\s+/)) {
      if (word) widestWord = Math.max(widestWord, ctx.measureText(word).width);
    }

    // The outline adds roughly XBORDER either side of the text.
    const maxTextWidth = maxOutlineWidth - 2 * XBORDER;

    let goalWidth: number;
    if (runLength <= this.ONE_LINE_THRESHOLD) {
      goalWidth = runLength;
    } else {
      const area = 1.3 * runLength * (BALLOON_TEXT_HEIGHT + BALLOON_LINE_HEIGHT);
      const potentialHeight = (maxHeight ?? BALLOON_LINE_HEIGHT * 6) + MINTAILHEIGHT;
      let minWidth = potentialHeight > 0 ? area / potentialHeight : maxTextWidth;
      minWidth = Math.max(minWidth, widestWord);
      minWidth = Math.min(minWidth, maxTextWidth);
      const spread = Math.max(0, maxTextWidth - minWidth);
      goalWidth = minWidth + (rand ? rand.float() : 0.5) * spread;
    }
    // A little slack past the goal, but never wider than the text needs.
    goalWidth = Math.min(goalWidth + this.BALLOON_WIDTH_SLACK, maxTextWidth);
    goalWidth = Math.min(goalWidth, runLength + this.BALLOON_WIDTH_SLACK);
    let wrapWidth = Math.max(Math.min(widestWord, maxTextWidth), goalWidth);

    const shape = (wrap: number) => {
      const lines = this.getWrappedLines(ctx, text, wrap);
      const widths = lines.map((l) => ctx.measureText(l.trim()).width);
      const outline = buildBalloonOutline(widths, BALLOON_FONT_METRICS);
      return { lines, outline };
    };

    let built = shape(wrapWidth);

    // Too tall for the space above the speaker? Spend width to buy back height,
    // the way the original derives a minimum width from the text's area and the
    // headroom it has left (CUnitPanel::GetCloudEstimate).
    if (maxHeight !== undefined) {
      let guard = 0;
      while (
        built.outline.trueBox.top - built.outline.trueBox.bottom > maxHeight &&
        wrapWidth < maxTextWidth &&
        guard++ < 12
      ) {
        wrapWidth = Math.min(maxTextWidth, wrapWidth * 1.18);
        built = shape(wrapWidth);
      }
    }

    const box = built.outline.trueBox;
    return {
      lines: built.lines,
      width: Math.ceil(box.right - box.left),
      height: Math.ceil(box.top - box.bottom),
      outline: built.outline,
    };
  }

  /**
   * The corridor `other` must respect so it does not land on this balloon's
   * stem. A balloon whose speaker stands to the right has to stay right of this
   * stem, and vice versa. Ported from CBalloon::QueryRouteRgn.
   */
  private static queryRouteRegion(
    balloon: ComicBalloon,
    ownArrowX: number,
    otherArrowX: number
  ): { left: number; right: number } {
    const left = balloon.routeLeft ?? balloon.x;
    const right = balloon.routeRight ?? balloon.x + balloon.width;
    if (otherArrowX > ownArrowX) {
      return { left: Math.max(ownArrowX, left + this.MIN_ROUTE_WIDTH), right: this.FAR };
    }
    return { left: -this.FAR, right: Math.min(ownArrowX, right - this.MIN_ROUTE_WIDTH) };
  }

  /**
   * Shrink this balloon's stem corridor away from a newly placed balloon, so the
   * stem leaves on the side that is still clear. Ported from CBalloon::SetRouteRgn.
   */
  private static setRouteRegion(
    balloon: ComicBalloon,
    ownArrowX: number,
    otherArrowX: number,
    otherLeft: number,
    otherRight: number
  ): void {
    if (otherArrowX > ownArrowX) {
      balloon.routeRight = Math.min(balloon.routeRight ?? balloon.x + balloon.width, otherLeft);
    } else {
      balloon.routeLeft = Math.max(balloon.routeLeft ?? balloon.x, otherRight);
    }
  }

  /**
   * Per-speaker memory of where they stood and which way they faced in the last
   * panel, so the cast does not reshuffle from panel to panel.
   * Ported from CAvatarX's m_lastDir / m_lastLeft / m_lastRight.
   */
  static createLayoutContext(): PanelLayoutContext {
    return { hysteresis: new Map(), talkTos: new Map() };
  }

  private static hysteresisFor(ctx: PanelLayoutContext, id: string): CharacterHysteresis {
    let h = ctx.hysteresis.get(id);
    if (!h) {
      h = { lastDir: false, lastLeft: null, lastRight: null };
      ctx.hysteresis.set(id, h);
    }
    return h;
  }

  /**
   * Decide the left-to-right order of the cast and which way each one faces.
   *
   * Ported from CUnitPanel::OrderAvatars / DoGreedyOrdering: characters are
   * inserted one at a time, and every candidate slot and facing is scored by
   * summing EvalPair over all pairs already placed. Lower is better. Someone
   * addressing another character wants to stand next to them and face them
   * (facing away costs 40, standing further away costs 4 per extra place), and
   * a displacement penalty keeps the arrangement stable between panels.
   */
  private static orderCharacters(panel: ComicPanel, ctx: PanelLayoutContext | undefined): void {
    const chars = panel.characters;
    if (chars.length === 0) return;
    if (chars.length === 1) {
      chars[0].flip = ctx ? this.hysteresisFor(ctx, chars[0].participantId).lastDir : false;
      if (ctx) this.hysteresisFor(ctx, chars[0].participantId).lastDir = chars[0].flip;
      return;
    }

    const talkTosOf = (id: string): string[] => ctx?.talkTos.get(id) ?? [];
    const lastDirOf = (id: string): boolean =>
      ctx ? this.hysteresisFor(ctx, id).lastDir : false;

    // `delta` is how many places b2 sits to the right of b1 (negative for left).
    const evalPair = (
      b1: ComicCharacterInPanel,
      b2: ComicCharacterInPanel,
      delta: number
    ): number => {
      let rating = 0;
      let desiredDir: boolean;
      if (delta > 0) {
        desiredDir = false; // b2 is to the right, so b1 must face right
      } else {
        desiredDir = true;
        delta = -delta;
      }
      const talk = talkTosOf(b1.participantId);
      if (talk.length === 0) {
        // Nobody in particular: a mild pull towards facing one another.
        if (b1.flip !== desiredDir) rating += 4;
        if (b2.flip === desiredDir) rating += 2;
      } else {
        for (const t of talk) {
          if (t !== b2.participantId) continue;
          if (b1.flip === desiredDir) rating += 4 * (delta - 1);
          else rating += 40; // talking to someone while facing away
          if (b2.flip === desiredDir) rating += 4;
        }
      }
      return rating;
    };

    const displacementPenalty = (arr: ComicCharacterInPanel[]): number => {
      if (!ctx) return 0;
      let penalty = 0;
      for (let i = 0; i < arr.length; i++) {
        const h = this.hysteresisFor(ctx, arr[i].participantId);
        if (i > 0 && h.lastRight !== arr[i - 1].participantId) penalty++;
        if (i < arr.length - 1 && h.lastLeft !== arr[i + 1].participantId) penalty++;
      }
      return penalty;
    };

    const placed: ComicCharacterInPanel[] = [];

    const scoreAll = (): number => {
      let rating = 0;
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          rating += evalPair(placed[i], placed[j], j - i);
          rating += evalPair(placed[j], placed[i], i - j);
        }
      }
      return rating;
    };

    const evalPlacement = (
      candidate: ComicCharacterInPanel,
      index: number
    ): { rating: number; dir: boolean } => {
      placed.splice(index, 0, candidate);
      const penalty = displacementPenalty(placed);
      candidate.flip = false;
      const facingRight = penalty + scoreAll();
      candidate.flip = true;
      const facingLeft = penalty + scoreAll();
      placed.splice(index, 1);

      if (facingRight < facingLeft) return { rating: facingRight, dir: false };
      if (facingRight > facingLeft) return { rating: facingLeft, dir: true };
      return { rating: facingRight, dir: lastDirOf(candidate.participantId) };
    };

    for (const candidate of chars) {
      let bestRating = Infinity;
      let bestPosition = 0;
      let bestDir = false;
      for (let slot = 0; slot <= placed.length; slot++) {
        const { rating, dir } = evalPlacement(candidate, slot);
        if (rating < bestRating) {
          bestRating = rating;
          bestPosition = slot;
          bestDir = dir;
        }
      }
      candidate.flip = bestDir;
      placed.splice(bestPosition, 0, candidate);
    }

    panel.characters = placed;

    if (ctx) {
      for (let i = 0; i < placed.length; i++) {
        const h = this.hysteresisFor(ctx, placed[i].participantId);
        h.lastDir = placed[i].flip;
        h.lastRight = i > 0 ? placed[i - 1].participantId : null;
        h.lastLeft = i < placed.length - 1 ? placed[i + 1].participantId : null;
      }
    }
  }

  /**
   * Size, scale and position the cast, and set the backdrop's source window.
   * Ported from the second half of CUnitPanel::LayoutAvatars.
   *
   * Everyone is drawn at the same height, standing on the same floor, and the
   * row is centred with equal gaps. Then the camera moves:
   *
   *  - Too wide for the panel? Everyone shrinks together and the backdrop stays
   *    put — the wide shot.
   *  - Room to spare, and this is not one of the opening establishing panels?
   *    The camera pushes in until either the row fills the panel or the biggest
   *    head reaches its limit, and the backdrop zooms with it. The cast's *top*
   *    stays where it is, so a close-up crops legs off the bottom of the frame
   *    rather than sliding the whole body down.
   */
  private static placeCast(
    panel: ComicPanel,
    panelWidth: number,
    panelHeight: number,
    layoutCtx?: PanelLayoutContext
  ): void {
    const numChars = panel.characters.length;
    // maxBodyHeight: the original's unitHeight / 1.9.
    const baseHeight = Math.floor(panelHeight / this.BODY_HEIGHT_DIVISOR);
    const bodyTop = panelHeight - baseHeight;

    if (numChars === 0) {
      panel.backdropBox = this.backdropWindow(panelWidth, panelHeight, bodyTop, 1);
      return;
    }

    const edgePad = 10;
    const minGap = 6;
    const usableWidth = panelWidth - 2 * edgePad;

    // Per-character proportions, from the real artwork when it has loaded.
    const metrics = panel.characters.map((char) => {
      const m = layoutCtx?.metricsOf?.(char.avatarName) ?? null;
      return {
        aspect: m?.aspect ?? this.FALLBACK_ASPECT,
        headTopRatio: m?.headTopRatio ?? this.HEAD_TOP_RATIO,
        headBottomRatio: m?.headBottomRatio ?? this.FALLBACK_HEAD_BOTTOM_RATIO,
      };
    });

    // Everyone scaled to the same height.
    let heights = metrics.map(() => baseHeight);
    let widths = metrics.map((m) => Math.max(1, Math.round(baseHeight * m.aspect)));
    let rowWidth = widths.reduce((a, b) => a + b, 0);

    let zoom = 1;
    // Height everyone stands on before any zoom; the row's footing is derived
    // from this, so a zoomed cast grows downward out of frame.
    let footingHeight = baseHeight;
    const maxRowWidth = usableWidth - minGap * (numChars + 1);

    if (rowWidth > maxRowWidth) {
      // Wide shot: shrink the whole cast to fit, feet still on the floor.
      const reduction = maxRowWidth / rowWidth;
      heights = heights.map((h) => Math.round(h * reduction));
      widths = widths.map((w) => Math.round(w * reduction));
      rowWidth = widths.reduce((a, b) => a + b, 0);
      footingHeight = Math.max(...heights);
    } else if (!this.isEstablishingPanel(panel)) {
      const widthFactor = maxRowWidth / rowWidth;
      // Cap the zoom so the largest head stays within the body height.
      let maxHeadHeight = 0;
      for (let i = 0; i < numChars; i++) {
        maxHeadHeight = Math.max(maxHeadHeight, heights[i] * metrics[i].headBottomRatio);
      }
      const headFactor =
        maxHeadHeight > 0 ? baseHeight / (maxHeadHeight * 1.2) : widthFactor;
      zoom = Math.min(widthFactor, headFactor, this.MAX_CAMERA_ZOOM);
      // The original ignores a zoom that would barely register.
      if (zoom < 1.1) zoom = 1;
      if (zoom !== 1) {
        heights = heights.map((h) => Math.round(h * zoom));
        widths = widths.map((w) => Math.round(w * zoom));
        rowWidth = widths.reduce((a, b) => a + b, 0);
      }
    }

    // The row is laid out on the pre-zoom footing, so a zoomed cast grows down
    // out of the frame while their heads stay at the same height.
    const rowTop = panelHeight - footingHeight;
    const gap = (usableWidth - rowWidth) / (numChars + 1);
    let x = edgePad + gap;
    panel.characters.forEach((char, idx) => {
      char.width = widths[idx];
      char.height = heights[idx];
      char.x = Math.round(x);
      char.y = rowTop;
      char.headX = char.x + Math.round(char.width * 0.5);
      // Refined from the real pixels at draw time.
      char.headTopY = char.y + Math.round(char.height * metrics[idx].headTopRatio);
      char.headY =
        char.y + Math.round(char.height * (metrics[idx].headBottomRatio * 0.55));
      x += widths[idx] + gap;
    });

    panel.backdropBox = this.backdropWindow(panelWidth, panelHeight, rowTop, zoom);
  }

  /** True for the opening panels, which the original keeps as wide shots. */
  private static isEstablishingPanel(panel: ComicPanel): boolean {
    return panel.panelIndex > 0 && panel.panelIndex <= this.ESTABLISHING_PANELS;
  }

  /**
   * The slice of backdrop art the panel shows, in panel pixels. Zooming shrinks
   * the window about `fixedY` — the line the cast's heads stand on — so the
   * background pushes in with them. Ported from CPanel::AdjustArtToCoord.
   */
  private static backdropWindow(
    panelWidth: number,
    panelHeight: number,
    fixedY: number,
    zoom: number
  ): { left: number; top: number; right: number; bottom: number } {
    if (zoom <= 1) {
      return { left: 0, top: 0, right: panelWidth, bottom: panelHeight };
    }
    const windowHeight = panelHeight / zoom;
    const top = fixedY * (1 - 1 / zoom);
    return {
      left: 0,
      top,
      right: panelWidth / zoom,
      bottom: top + windowHeight,
    };
  }

  /**
   * Position the cast and the balloons in one panel.
   *
   * Returns false when a balloon simply will not fit above the speakers, which
   * is the caller's cue to move it into a fresh panel — the original's
   * CUnitPanel::LayoutBalloons reports overflow the same way. A panel holding a
   * single oversized balloon is force-fitted instead, splitting the tail of the
   * text into `overflowText` for the next panel to carry.
   */
  static layoutSinglePanel(
    panel: ComicPanel,
    panelWidth: number,
    panelHeight: number,
    layoutCtx?: PanelLayoutContext
  ): boolean {
    const numChars = panel.characters.length;

    // Who stands where, and which way they face.
    this.orderCharacters(panel, layoutCtx);

    // The camera.
    this.placeCast(panel, panelWidth, panelHeight, layoutCtx);

    // ---- Balloon placement --------------------------------------------------
    // Ported from CUnitPanel::LayoutBalloons. Balloons dock from the top of the
    // panel downward and each one reserves a horizontal corridor for its stem;
    // later balloons are slid out of those corridors, so stems can never cross
    // another balloon or each other, and never have to cut back across a face.
    const margin = this.BALLOON_MARGIN;
    const freeLeft = margin;
    const freeRight = panelWidth - margin;
    const freeTop = this.BALLOON_TOP_MARGIN;

    const placed: ComicBalloon[] = [];
    let everythingFits = true;
    const soleBalloon = panel.balloons.length === 1;
    // Seeded from the panel id, so a panel's balloon shapes stay put across
    // re-renders while still varying from panel to panel.
    const rand = new MsvcRand(seedFromId(panel.id));

    panel.balloons.forEach((balloon, idx) => {
      balloon.overflowText = undefined;
      const speaker =
        panel.characters.find((c) => c.participantId === balloon.speakerParticipantId) ||
        panel.characters[idx % Math.max(1, numChars)];

      if (balloon.mode === 'action') {
        // Narrative box: full width, pinned to the top, no stem. Measured against
        // its own box rather than a balloon's, since drawBalloon lays this out
        // with its own padding and 15px leading.
        balloon.width = panelWidth - 2 * margin - 4;
        const actionText = `* ${balloon.speakerName}: ${balloon.text} *`;
        const actionCtx = getMeasureContext();
        let actionLines = 1;
        if (actionCtx) {
          actionCtx.font = `italic bold 12px ${COMIC_FONT_FAMILY}`;
          actionLines = this.getWrappedLines(actionCtx, actionText, balloon.width - 24).length;
        } else {
          actionLines = Math.max(1, Math.ceil((actionText.length * 7.2) / (balloon.width - 24)));
        }
        balloon.height = Math.max(34, 16 + actionLines * 15);
        balloon.x = margin + 2;
        balloon.y = freeTop;
        balloon.lines = undefined;
        balloon.tailX = 0;
        balloon.tailY = 0;
        balloon.routeLeft = balloon.x;
        balloon.routeRight = balloon.x + balloon.width;
        placed.push(balloon);
        return;
      }

      const arrowX = speaker ? speaker.headX : panelWidth / 2;
      // Lowest the underside may reach and still leave the stem somewhere to run.
      const lowestBottom = speaker
        ? speaker.headTopY - this.STEM_CLEARANCE - this.MIN_STEM_HEIGHT
        : panelHeight;

      // Placing is mildly circular — the wrap width decides the height, the width
      // decides which corridor we land in, and that decides how much headroom is
      // left. Two passes settle it: measure against the whole band, place, then
      // re-measure against the headroom that actually survived.
      let top = freeTop;
      for (let pass = 0; pass < 2; pass++) {
        const headroom = lowestBottom - top;
        const measured = this.measureBalloon(
          balloon.text,
          balloon.mode,
          panelWidth,
          headroom > 0 ? headroom : undefined,
          undefined,
          rand
        );
        balloon.lines = measured.lines;
        balloon.outline = measured.outline ?? undefined;
        balloon.width = Math.min(measured.width, freeRight - freeLeft);
        balloon.height = measured.height;

        // Start centred over the speaker, then slide into the corridor every
        // earlier balloon leaves open for us (CUnitPanel::GetInterveningBBox).
        let left = Math.round(arrowX - balloon.width / 2);
        let allowedLeft = freeLeft;
        let allowedRight = freeRight;
        for (const prior of placed) {
          if (prior.mode === 'action') continue;
          const priorSpeaker = panel.characters.find(
            (c) => c.participantId === prior.speakerParticipantId
          );
          const priorArrowX = priorSpeaker ? priorSpeaker.headX : panelWidth / 2;
          const corridor = this.queryRouteRegion(prior, priorArrowX, arrowX);
          allowedLeft = Math.max(allowedLeft, corridor.left);
          allowedRight = Math.min(allowedRight, corridor.right);
        }

        if (allowedRight - allowedLeft >= balloon.width) {
          left = Math.max(allowedLeft, Math.min(allowedRight - balloon.width, left));
        } else {
          // Corridor too tight to honour: keep the balloon on the panel and let
          // the vertical docking below separate it from the earlier ones.
          left = Math.max(freeLeft, Math.min(freeRight - balloon.width, left));
        }
        balloon.x = left;

        // Dock below any earlier balloon we overlap horizontally, otherwise sit
        // level with it. Balloons hang from the top so they clear the cast.
        const previousTop = top;
        top = freeTop;
        for (const prior of placed) {
          const overlaps =
            balloon.x < prior.x + prior.width && prior.x < balloon.x + balloon.width;
          if (overlaps) {
            top = Math.max(top, prior.y + prior.height - this.BALLOON_DOCK_TUCK);
          }
        }
        // Settled: the second pass would measure against the same headroom.
        if (top === previousTop) break;
      }

      // Balloons hang from the top of the panel, as in the original, so they stay
      // as far off the cast as the panel allows and the stem does the reaching.
      balloon.y = top;

      if (balloon.y + balloon.height > lowestBottom) {
        if (soleBalloon) {
          // Nothing to make room by moving, so widen it to the whole panel and,
          // if it still overruns, hand the tail of the text to the next panel
          // (CUnitPanel::ForceFitBalloon / CBalloon::TruncateAtLine).
          this.forceFitBalloon(balloon, freeLeft, freeRight, freeTop, lowestBottom);
        } else {
          everythingFits = false;
        }
      }

      balloon.tailX = speaker ? speaker.headX : arrowX;
      balloon.tailY = speaker ? speaker.headTopY - this.STEM_CLEARANCE : balloon.y + balloon.height;

      // Reserve our own corridor, then push every earlier stem clear of us.
      balloon.routeLeft = balloon.x;
      balloon.routeRight = balloon.x + balloon.width;
      for (const prior of placed) {
        if (prior.mode === 'action') continue;
        const priorSpeaker = panel.characters.find(
          (c) => c.participantId === prior.speakerParticipantId
        );
        const priorArrowX = priorSpeaker ? priorSpeaker.headX : panelWidth / 2;
        this.setRouteRegion(prior, priorArrowX, arrowX, balloon.x, balloon.x + balloon.width);
      }

      placed.push(balloon);
    });

    // Resolve each stem's exit point now that all corridors are final.
    panel.balloons.forEach((balloon) => {
      this.resolveStemRoot(balloon);
    });

    return everythingFits;
  }

  /**
   * Last resort for a balloon that cannot fit above its speaker even alone:
   * widen it to the full panel, then drop whole lines off the end until it fits,
   * leaving the remainder in `overflowText` for the next panel.
   */
  private static forceFitBalloon(
    balloon: ComicBalloon,
    freeLeft: number,
    freeRight: number,
    freeTop: number,
    lowestBottom: number
  ): void {
    const fullWidth = freeRight - freeLeft;
    const available = Math.max(BALLOON_LINE_HEIGHT, lowestBottom - freeTop);

    const remeasure = (text: string) =>
      this.measureBalloon(text, balloon.mode, fullWidth, available, fullWidth);

    let measured = remeasure(balloon.text);
    if (measured.height > available && measured.lines.length > 1) {
      // How much of the height is outline rather than text.
      const chrome = measured.height - measured.lines.length * BALLOON_LINE_HEIGHT;
      const linesThatFit = Math.max(1, Math.floor((available - chrome) / BALLOON_LINE_HEIGHT));
      if (linesThatFit < measured.lines.length) {
        const kept = measured.lines.slice(0, linesThatFit).join(' ').trim();
        const rest = measured.lines.slice(linesThatFit).join(' ').trim();
        balloon.text = `${kept}...`;
        balloon.overflowText = `...${rest}`;
        measured = remeasure(balloon.text);
      }
    }

    balloon.lines = measured.lines;
    balloon.outline = measured.outline ?? undefined;
    balloon.width = Math.min(measured.width, fullWidth);
    balloon.height = measured.height;
    balloon.x = Math.max(freeLeft, Math.min(freeRight - balloon.width, balloon.x));
    balloon.y = freeTop;
    balloon.routeLeft = balloon.x;
    balloon.routeRight = balloon.x + balloon.width;
  }

  /**
   * Choose where the stem leaves the balloon's underside: the middle of whatever
   * corridor survived the negotiation, pulled inside the last line of text so it
   * springs from under the words rather than from an empty corner.
   * Ported from CBWoodringNormal::AddArrow's xbreak calculation.
   *
   * Public because a balloon can be drawn outside a panel — the quick-message
   * overlay lays one out on its own and needs the same stem treatment.
   */
  static resolveStemRoot(balloon: ComicBalloon): void {
    if (balloon.mode === 'action' || !balloon.tailY) {
      balloon.tailRootX = undefined;
      return;
    }
    const routeLeft = balloon.routeLeft ?? balloon.x;
    const routeRight = balloon.routeRight ?? balloon.x + balloon.width;

    // An empty corridor means later balloons boxed this stem in on both sides;
    // fall back to aiming straight at the speaker.
    let root =
      routeRight > routeLeft ? (routeLeft + routeRight) / 2 : balloon.tailX;

    const inset = this.STEM_ROOT_INSET;
    root = Math.max(balloon.x + inset, Math.min(balloon.x + balloon.width - inset, root));

    // Limit the stem to 45 degrees from vertical by moving its root along the
    // balloon rather than bending it sideways (the original clamps the angle and
    // recomputes xbreak). A bent stem is what read as a spike across the face.
    const drop = balloon.tailY - (balloon.y + balloon.height);
    if (drop > 0) {
      const maxRun = drop;
      root = Math.max(balloon.tailX - maxRun, Math.min(balloon.tailX + maxRun, root));
      root = Math.max(balloon.x + inset, Math.min(balloon.x + balloon.width - inset, root));
    }

    balloon.tailRootX = root;
  }

  // Draw a comic panel onto a 2D Canvas context
  static drawPanelToCanvas(
    ctx: CanvasRenderingContext2D,
    panel: ComicPanel,
    width: number,
    height: number,
    avatarManager: AvatarManager,
    backdropCanvas: HTMLCanvasElement | null
  ): void {
    ctx.save();

    // 1. Draw Background through the panel's camera window. The window is a
    //    slice of the art expressed in panel pixels; it stretches to fill the
    //    panel, so a smaller window means the camera has pushed in.
    ctx.fillStyle = '#fbf9f4'; // warm paper tone
    ctx.fillRect(0, 0, width, height);
    if (backdropCanvas) {
      const box = panel.backdropBox;
      if (!box || (box.left === 0 && box.top === 0 && box.right === width && box.bottom === height)) {
        ctx.drawImage(backdropCanvas, 0, 0, width, height);
      } else {
        const artW = backdropCanvas.width;
        const artH = backdropCanvas.height;
        const srcLeft = (box.left / width) * artW;
        const srcTop = (box.top / height) * artH;
        const srcW = ((box.right - box.left) / width) * artW;
        const srcH = ((box.bottom - box.top) / height) * artH;
        if (srcW > 0 && srcH > 0) {
          // Draw the whole bitmap scaled and offset so the window lands on the
          // panel; anything outside simply falls off the canvas.
          const sx = width / srcW;
          const sy = height / srcH;
          ctx.drawImage(backdropCanvas, -srcLeft * sx, -srcTop * sy, artW * sx, artH * sy);
        } else {
          ctx.drawImage(backdropCanvas, 0, 0, width, height);
        }
      }
    }

    if (panel.isTitlePanel) {
      // Draw Title Page
      this.drawTitlePanel(ctx, panel, width, height, avatarManager);
      ctx.restore();
      return;
    }

    // 2. Draw Characters
    panel.characters.forEach((char) => {
      if (char.avatarData) {
        const rendered = avatarManager.renderCharacter(
          char.avatarData,
          char.emotion,
          char.intensity,
          char.flip
        );
        const aspect = rendered.canvas.width / rendered.canvas.height;
        const charWidth = Math.round(char.height * aspect);
        const charX = char.flip
          ? char.x + (char.width - charWidth)
          : char.x;

        ctx.drawImage(
          rendered.canvas,
          charX,
          char.y,
          charWidth,
          char.height
        );

        // Anchor on the measured top of the artwork rather than the face anchor:
        // aiming at the mouth is what used to run the stem straight over the face.
        const exactHeadX = charX + (rendered.headX / rendered.canvas.width) * charWidth;
        const exactHeadTopY = char.y + (rendered.headTopY / rendered.canvas.height) * char.height;
        const targetHeadY = Math.round(exactHeadTopY - this.STEM_CLEARANCE);

        char.headX = exactHeadX;
        char.headY = char.y + (rendered.headY / rendered.canvas.height) * char.height;
        char.headTopY = exactHeadTopY;

        // Retarget this speaker's balloons onto the measured artwork, then
        // re-resolve their stem roots so the corridors negotiated at layout time
        // still hold against the real head position.
        const speakerBalloons = panel.balloons
          .filter(
            (b) =>
              b.mode !== 'action' &&
              (b.speakerParticipantId === char.participantId || panel.characters.length === 1)
          )
          .sort((a, b) => a.y - b.y);

        // Every balloon points at its own speaker. Stacked balloons no longer
        // need to chain through one another: the route regions guarantee an
        // upper balloon's stem descends past the lower one rather than over it.
        for (const speakerBalloon of speakerBalloons) {
          speakerBalloon.tailX = exactHeadX;
          speakerBalloon.tailY = targetHeadY;
          this.resolveStemRoot(speakerBalloon);
        }
      } else {
        // Fallback sketch avatar if loading
        this.drawPlaceholderCharacter(ctx, char);
      }
    });

    // 3. Draw Balloons, latest first so earlier ones stay on top and reading
    //    order survives any overlap (matches the original's paint order).
    for (let i = panel.balloons.length - 1; i >= 0; i--) {
      this.drawBalloon(ctx, panel.balloons[i]);
    }

    // 4. Panel border: a 60-twip pen on the edge, so half of it shows.
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000000';
    ctx.setLineDash([]);
    ctx.strokeRect(1, 1, width - 2, height - 2);

    ctx.restore();
  }

  /** Tracking added to the title banner's lettering. */
  private static readonly TITLE_LETTER_SPACING = '2.5px';

  /**
   * `letterSpacing` is a fairly recent canvas property; setting it on a context
   * that does not support it is silently ignored rather than throwing, but the
   * guard keeps the intent obvious.
   */
  private static setLetterSpacing(ctx: CanvasRenderingContext2D, value: string): void {
    if ('letterSpacing' in ctx) {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = value;
    }
  }

  static drawTitlePanel(
    ctx: CanvasRenderingContext2D,
    panel: ComicPanel,
    width: number,
    height: number,
    avatarManager: AvatarManager
  ): void {
    // Title background (classic warm paper)
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, width, height);

    // 1. Episode Title Box Header
    const boxX = 16;
    const boxY = 18;
    const boxW = width - 32;
    const boxH = 74;

    ctx.fillStyle = '#ffde59'; // Comic yellow banner
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Episode title text inside the box
    const episodeTitle = (panel.roomName || 'Burnin\' the Midnight Oil').toUpperCase();
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Measure and format title text. Bangers sets very tightly, so the letters
    // are tracked apart a little; measureText accounts for it once it is set.
    this.setLetterSpacing(ctx, this.TITLE_LETTER_SPACING);
    ctx.font = `bold 22px "Bangers", ${COMIC_FONT_FAMILY}`;
    const titleMetrics = ctx.measureText(episodeTitle);
    if (titleMetrics.width > boxW - 20) {
      // Wrap into 2 lines if long
      const words = episodeTitle.split(' ');
      const mid = Math.ceil(words.length / 2);
      const line1 = words.slice(0, mid).join(' ');
      const line2 = words.slice(mid).join(' ');
      ctx.font = `bold 17px "Bangers", ${COMIC_FONT_FAMILY}`;
      ctx.fillText(line1, width / 2, boxY + boxH * 0.32);
      ctx.fillText(line2, width / 2, boxY + boxH * 0.70);
    } else {
      ctx.fillText(episodeTitle, width / 2, boxY + boxH / 2);
    }
    this.setLetterSpacing(ctx, '0px');

    // 2. STARRING Subtitle
    ctx.font = `bold 16px ${COMIC_FONT_FAMILY}`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('STARRING:', width / 2, boxY + boxH + 14);

    // 3. Row of stars
    ctx.fillStyle = '#f59e0b'; // Warm golden amber stars
    ctx.font = '15px sans-serif';
    ctx.fillText('★ ★ ★ ★ ★', width / 2, boxY + boxH + 36);

    // 4. Character heads with screen names
    const starring = panel.starringMembers || [];
    const count = starring.length;

    if (count > 0) {
      const listStartY = boxY + boxH + 54;
      const listEndY = height - 16;
      const contentH = listEndY - listStartY;
      const availWidth = width - 48;

      if (count === 1) {
        // 1 Person: Zoom entry proportionally to fill content area horizontally
        const member = starring[0];
        const minIconSize = 40;
        const maxIconHeight = Math.min(Math.round(contentH * 0.75), 140);

        let bestScale = 1.0;
        for (let s = 1.0; s <= 4.0; s += 0.02) {
          const testIconSize = Math.round(minIconSize * s);
          if (testIconSize > maxIconHeight) break;
          const testFontSize = Math.max(14, Math.round(15 * s));
          const testGap = Math.round(14 * s);
          ctx.font = `bold ${testFontSize}px ${COMIC_FONT_FAMILY}`;
          const nameW = ctx.measureText(member.screenName).width;
          if (testIconSize + testGap + nameW <= availWidth) {
            bestScale = s;
          } else {
            break;
          }
        }

        const iconSize = Math.round(minIconSize * bestScale);
        const fontSize = Math.max(14, Math.round(15 * bestScale));
        const gap = Math.round(14 * bestScale);
        ctx.font = `bold ${fontSize}px ${COMIC_FONT_FAMILY}`;
        const nameW = ctx.measureText(member.screenName).width;
        const totalW = iconSize + gap + nameW;

        const iconX = Math.round((width - totalW) / 2);
        const iconY = Math.round(listStartY + (contentH - iconSize) / 2);
        const nameX = iconX + iconSize + gap;
        const nameY = iconY + iconSize / 2;

        this.drawTitleCastMember(ctx, avatarManager, member, iconX, iconY, iconSize, nameX, nameY, fontSize, availWidth);
      } else if (count === 2) {
        // 2 People: Split vertical space top/bottom and scale proportionally
        const slotH = contentH / 2;
        const minIconSize = 40;
        const maxIconHeight = Math.min(Math.round(slotH * 0.70), 80);

        let bestScale = 1.0;
        for (let s = 1.0; s <= 2.5; s += 0.02) {
          const testIconSize = Math.round(minIconSize * s);
          if (testIconSize > maxIconHeight) break;
          const testFontSize = Math.max(14, Math.round(15 * s));
          const testGap = Math.round(14 * s);
          ctx.font = `bold ${testFontSize}px ${COMIC_FONT_FAMILY}`;
          const w1 = testIconSize + testGap + ctx.measureText(starring[0].screenName).width;
          const w2 = testIconSize + testGap + ctx.measureText(starring[1].screenName).width;
          if (Math.max(w1, w2) <= availWidth) {
            bestScale = s;
          } else {
            break;
          }
        }

        const iconSize = Math.round(minIconSize * bestScale);
        const fontSize = Math.max(14, Math.round(15 * bestScale));
        const gap = Math.round(14 * bestScale);
        ctx.font = `bold ${fontSize}px ${COMIC_FONT_FAMILY}`;
        const w1 = iconSize + gap + ctx.measureText(starring[0].screenName).width;
        const w2 = iconSize + gap + ctx.measureText(starring[1].screenName).width;
        const maxW = Math.max(w1, w2);
        const startX = Math.round((width - maxW) / 2);

        starring.forEach((member, idx) => {
          const iconX = startX;
          const iconY = Math.round(listStartY + idx * slotH + (slotH - iconSize) / 2);
          const nameX = iconX + iconSize + gap;
          const nameY = iconY + iconSize / 2;
          this.drawTitleCastMember(ctx, avatarManager, member, iconX, iconY, iconSize, nameX, nameY, fontSize, width - iconX - 16);
        });
      } else {
        // 3 or more: standard 4 rows per column, 2 columns max (up to 8 participants)
        const rowHeight = 58;
        const iconSize = 38;
        const fontSize = 14;
        const numCols = count > 4 ? 2 : 1;

        const col1Left = 24;
        const col2Left = Math.round(width / 2 + 10);
        const maxNameWidth1Col = width - col1Left - iconSize - 20;
        const maxNameWidth2Col = Math.round(width / 2 - 18) - iconSize - 12;
        const maxNameWidth = numCols === 2 ? maxNameWidth2Col : maxNameWidth1Col;

        starring.forEach((member, idx) => {
          const colIndex = Math.floor(idx / 4);
          const rowIndex = idx % 4;

          const iconX = colIndex === 0 ? col1Left : col2Left;
          const iconY = listStartY + rowIndex * rowHeight;
          const nameX = iconX + iconSize + 10;
          const nameY = iconY + iconSize / 2;

          this.drawTitleCastMember(ctx, avatarManager, member, iconX, iconY, iconSize, nameX, nameY, fontSize, maxNameWidth);
        });
      }
    }

    // 5. Comic border
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(1.5, 1.5, width - 3, height - 3);
  }

  static drawTitleCastMember(
    ctx: CanvasRenderingContext2D,
    avatarManager: AvatarManager,
    member: TitleStarringMember,
    iconX: number,
    iconY: number,
    iconSize: number,
    nameX: number,
    nameY: number,
    fontSize: number,
    maxNameWidth: number
  ): void {
    const cleanKey = (member.avatarName || 'Armando').toLowerCase().replace(/\.avb$/, '');
    const av = avatarManager['avatarCache'].get(cleanKey);

    if (av) {
      // Each face gets its own expression and facing, picked from a seed seeded
      // on who they are, so the cast list has some life in it but a given person
      // looks the same every time the card is drawn.
      const variant = this.titleHeadVariant(member);
      const head =
        avatarManager.renderAvatarHead(av, variant.emotion, variant.intensity, variant.flip) ||
        avatarManager.renderAvatarIcon(av);
      if (head) {
        // Fit inside the square box without stretching the artwork.
        const scale = Math.min(iconSize / head.width, iconSize / head.height);
        const w = Math.round(head.width * scale);
        const h = Math.round(head.height * scale);
        ctx.drawImage(
          head,
          iconX + Math.round((iconSize - w) / 2),
          iconY + Math.round((iconSize - h) / 2),
          w,
          h
        );
      }
    } else {
      // Fallback placeholder head circle
      ctx.beginPath();
      ctx.arc(iconX + iconSize / 2, iconY + iconSize / 2, iconSize / 2 - 2, 0, Math.PI * 2);
      ctx.fillStyle = '#e2e8f0';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#64748b';
      ctx.stroke();
      ctx.fillStyle = '#1e293b';
      ctx.font = `bold ${Math.round(fontSize * 1.1)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(member.screenName.charAt(0).toUpperCase(), iconX + iconSize / 2, iconY + iconSize / 2);
    }

    // Screen Name with truncation if needed
    ctx.font = `bold ${fontSize}px ${COMIC_FONT_FAMILY}`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const displayName = this.truncateText(ctx, member.screenName, maxNameWidth);
    ctx.fillText(displayName, nameX, nameY);
  }

  /**
   * Expressions the cast card draws from. Neutral is in there more than once so
   * a straight face stays the most common look.
   */
  private static readonly TITLE_HEAD_EMOTIONS: { emotion: number; intensity: number }[] = [
    { emotion: EM_NEUTRAL, intensity: 0 },
    { emotion: EM_NEUTRAL, intensity: 0 },
    { emotion: EM_HAPPY, intensity: 0.7 },
    { emotion: EM_HAPPY, intensity: 1.0 },
    { emotion: EM_LAUGH, intensity: 0.9 },
    { emotion: EM_COY, intensity: 0.7 },
    { emotion: EM_SHOUT, intensity: 0.8 },
    { emotion: EM_BORED, intensity: 0.6 },
  ];

  /** Stable per-person pick, so the card does not reshuffle on every redraw. */
  private static titleHeadVariant(
    member: TitleStarringMember
  ): { emotion: number; intensity: number; flip: boolean } {
    const rand = new MsvcRand(seedFromId(`${member.screenName}|${member.avatarName}`));
    const choice = this.TITLE_HEAD_EMOTIONS[rand.next() % this.TITLE_HEAD_EMOTIONS.length];
    return { ...choice, flip: rand.next() % 2 === 0 };
  }

  static truncateText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number
  ): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 0 && ctx.measureText(truncated + '...').width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return (truncated.trim() || text.slice(0, 1)) + '...';
  }

  static getWrappedLines(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number
  ): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (let n = 0; n < words.length; n++) {
      const testLine = currentLine ? currentLine + ' ' + words[n] : words[n];
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = words[n];
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }


  /**
   * Map a balloon's local outline space (origin at the text block's top-left,
   * y pointing up) into panel pixels.
   */
  private static outlineOrigin(balloon: ComicBalloon): { ox: number; oy: number } {
    const box = balloon.outline!.trueBox;
    return { ox: balloon.x - box.left, oy: balloon.y + box.top };
  }

  /**
   * Cut the tail into the balloon's outline and return the pieces of the closed
   * path: the opened outline plus the two arcs that sweep down to the stem tip.
   * Ported from CBWoodringNormal::AddArrow.
   */
  private static buildBalloonTail(
    balloon: ComicBalloon
  ): { opened: ReturnType<typeof breakSpline>; arcInto: Pt[]; arcBack: Pt[] } | null {
    const outline = balloon.outline;
    if (!outline || balloon.mode === 'think' || balloon.mode === 'action') return null;
    if (!(balloon.tailX > 0 && balloon.tailY > 0)) return null;

    const { ox, oy } = this.outlineOrigin(balloon);
    const { fInfo, spline } = outline;
    // Stem tip in local space.
    const tip: Pt = { x: balloon.tailX - ox, y: -(balloon.tailY - oy) };

    let xbreak = (balloon.tailRootX ?? balloon.tailX) - ox;

    // Pull the exit point onto the last line of text so the stem springs from
    // under the words rather than from an empty corner.
    const lastLine = fInfo.nLines - 1;
    const bottomStart = fInfo.leftX[lastLine];
    const bottomEnd = bottomStart + fInfo.widths[lastLine];
    const routeLeft = (balloon.routeLeft ?? balloon.x) - ox;
    const routeRight = (balloon.routeRight ?? balloon.x + balloon.width) - ox;
    if (xbreak < bottomStart && bottomStart < routeRight - LARGEDELTA) {
      xbreak = bottomStart + SMALLDELTA;
    } else if (xbreak > bottomEnd && bottomEnd > routeLeft + LARGEDELTA) {
      xbreak = bottomEnd - SMALLDELTA;
    }
    xbreak = Math.max(
      outline.trueBox.left + 2,
      Math.min(outline.trueBox.right - 2, xbreak)
    );

    // Guarantee the stem has somewhere to run.
    if (outline.trueBox.bottom - tip.y < MINTAILHEIGHT) {
      tip.y = outline.trueBox.bottom - MINTAILHEIGHT;
    }

    const opened = breakSpline(spline, xbreak, fInfo.bbox.bottom);
    if (opened.cps.length < 3) return null;
    const leftLip = opened.cps[opened.cps.length - 1];
    const rightLip = opened.cps[0];
    const mid = { x: (leftLip.x + rightLip.x) / 2, y: (leftLip.y + rightLip.y) / 2 };
    const tailLen = Math.hypot(mid.x - tip.x, mid.y - tip.y);
    const altitude = 0.05 * tailLen;
    const sign = tip.x > leftLip.x ? 1 : -1;

    const arcInto: Pt[] = [];
    arcPoints(leftLip, tip, sign * altitude, arcInto);
    const arcBack: Pt[] = [];
    arcPoints(tip, rightLip, -sign * altitude, arcBack);
    return { opened, arcInto, arcBack };
  }

  /** Lay the balloon's outline (with tail, if any) into the current path. */
  private static traceBalloonPath(ctx: CanvasRenderingContext2D, balloon: ComicBalloon): void {
    const outline = balloon.outline;
    if (!outline) return;
    const { ox, oy } = this.outlineOrigin(balloon);
    const toCanvas = (p: Pt): [number, number] => [ox + p.x, oy - p.y];

    const tail = this.buildBalloonTail(balloon);
    ctx.beginPath();
    if (tail) {
      tail.opened.addToPath(ctx, toCanvas, true);
      for (const p of tail.arcInto) ctx.lineTo(...toCanvas(p));
      for (const p of tail.arcBack) ctx.lineTo(...toCanvas(p));
    } else {
      outline.spline.addToPath(ctx, toCanvas, true);
    }
    ctx.closePath();
  }

  static drawBalloon(ctx: CanvasRenderingContext2D, balloon: ComicBalloon): void {
    ctx.save();

    const { x, y, width, height, mode, text } = balloon;

    if (mode === 'action') {
      // Narrative Box (Yellow/amber banner with black border)
      ctx.fillStyle = '#fff9c4';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.fillRect(x, y, width, height);
      ctx.strokeRect(x, y, width, height);

      ctx.fillStyle = '#1a1a1a';
      ctx.font = `italic bold 12px ${COMIC_FONT_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      this.drawWrappedText(
        ctx,
        `* ${balloon.speakerName}: ${text} *`,
        x + width / 2,
        y + 8,
        width - 24,
        15,
        height - 16
      );
      ctx.restore();
      return;
    }

    ctx.font = balloonFontFor(mode);

    if (!balloon.outline) {
      // Layout ran without a DOM to measure with; nothing to trace.
      ctx.restore();
      return;
    }

    const { ox, oy } = this.outlineOrigin(balloon);
    const { fInfo } = balloon.outline;
    const lines = balloon.lines ?? [text];

    // 1. Outline. Only a whisper gets the fat white nimbus underneath — its
    //    dashed edge would otherwise disappear into the artwork. A plain balloon
    //    is white fill and one black line, as in the original.
    this.traceBalloonPath(ctx, balloon);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    if (mode === 'whisper') {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = this.NIMBUS_PEN;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = this.BALLOON_PEN;
    if (mode === 'whisper') ctx.setLineDash([6.7, 6.7]);
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();

    // 2. Thought bubbles trail from the balloon down to the speaker.
    if (mode === 'think') this.drawThinkBubbles(ctx, balloon);

    // 3. Text, laid out on the same line boxes the outline was built around.
    ctx.setLineDash([]);
    ctx.fillStyle = mode === 'whisper' ? '#222222' : '#000000';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(
        lines[i].trim(),
        ox + (fInfo.leftX[i] ?? 0),
        oy + (i + 0.5) * BALLOON_LINE_HEIGHT
      );
    }

    ctx.restore();
  }

  /**
   * The chain of shrinking bubbles that connects a thought balloon to its
   * thinker. Ported from CBWoodringThink::Draw.
   */
  private static drawThinkBubbles(ctx: CanvasRenderingContext2D, balloon: ComicBalloon): void {
    const outline = balloon.outline;
    if (!outline || !(balloon.tailX > 0 && balloon.tailY > 0)) return;

    const entryX = balloon.tailRootX ?? balloon.x + balloon.width / 2;
    const entryY = balloon.y + balloon.height;
    const tipX = balloon.tailX;
    const tipY = balloon.tailY;

    const deltaY = tipY - entryY;
    if (deltaY <= 0) return;
    const nBubbles = Math.floor((deltaY + INTERBUBBLE) / (BUBBLEHEIGHT + INTERBUBBLE));
    if (nBubbles <= 0) return;

    const spacing = nBubbles > 1 ? (deltaY - BUBBLEHEIGHT * nBubbles) / (nBubbles - 1) : 0;
    // The chain is walked from the thinker up to the balloon, growing as it
    // goes, so the bubble that meets the balloon is the widest one.
    const dx = entryX - tipX;
    const dy = -deltaY;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let cx = tipX + (ux * BUBBLEHEIGHT) / 2;
    let cy = tipY + (uy * BUBBLEHEIGHT) / 2;
    const incX = ux * (BUBBLEHEIGHT + spacing);
    const incY = uy * (BUBBLEHEIGHT + spacing);
    const widthDelta = nBubbles > 1 ? (ENDBUBBLEWIDTH - BUBBLEHEIGHT) / (2 * (nBubbles - 1)) : 0;
    let widthAdj = 0;

    for (let i = 0; i < nBubbles; i++) {
      const rx = BUBBLEHEIGHT / 2 + widthAdj;
      const ry = BUBBLEHEIGHT / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = this.BALLOON_PEN;
      ctx.strokeStyle = '#000000';
      ctx.stroke();

      cx += incX;
      cy += incY;
      widthAdj += widthDelta;
    }
  }

  static drawWrappedText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
    boxHeight?: number
  ): void {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (let n = 0; n < words.length; n++) {
      const testLine = currentLine ? currentLine + ' ' + words[n] : words[n];
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = words[n];
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }

    const totalTextHeight = lines.length * lineHeight;
    let startY = y;
    if (boxHeight) {
      startY = y + (boxHeight - totalTextHeight) / 2;
    }

    lines.forEach((l, i) => {
      ctx.fillText(l.trim(), x, startY + i * lineHeight);
    });
  }

  static drawPlaceholderCharacter(
    ctx: CanvasRenderingContext2D,
    char: ComicCharacterInPanel
  ): void {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;

    // Body oval
    ctx.beginPath();
    ctx.ellipse(
      char.x + char.width / 2,
      char.y + char.height * 0.65,
      char.width * 0.35,
      char.height * 0.3,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();

    // Head circle
    ctx.beginPath();
    ctx.arc(
      char.x + char.width / 2,
      char.y + char.height * 0.25,
      char.width * 0.25,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();

    // Character name
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(char.screenName, char.x + char.width / 2, char.y + char.height + 12);
    ctx.restore();
  }
}
