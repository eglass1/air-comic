import {
  ComicPanel,
  ComicCharacterInPanel,
  ComicBalloon,
  BalloonMode,
  AvatarData,
  EM_NEUTRAL,
  TitleStarringMember,
} from './types';
import { EmotionEngine, DetectedEmotion } from './emotionEngine';
import { AvatarManager } from './avatarManager';
import { ChatMessage, Participant } from '../types';

export interface LayoutOptions {
  panelWidth: number;
  panelHeight: number;
  defaultBackdrop: string;
  roomName: string;
  titleAvatars?: string[];
  profile?: { screenName?: string; avatarName?: string } | null;
  participants?: Participant[];
}

export const COMIC_FONT_FAMILY =
  '"Comic Sans MS", "Comic Relief", "Comic Neue", "Chalkboard SE", sans-serif';

/** Line box height used for balloon text, at both layout and draw time. */
const BALLOON_LINE_HEIGHT = 16;

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
        } else if (currentPanel.balloons.length >= 2) {
          // Max 2 balloons per panel for clean readability
          startNew = true;
        } else {
          // If another balloon is in the current panel:
          const lastBalloon = currentPanel.balloons[currentPanel.balloons.length - 1];
          if (lastBalloon && lastBalloon.speakerParticipantId === senderId) {
            // Same speaker can say 2 consecutive sentences in 1 panel only if short
            if (lastBalloon.text.length + chunkText.length > 70) {
              startNew = true;
            }
          }
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

        // Add balloon for this chunk
        currentPanel!.balloons.push({
          id: `balloon-${msg.id}-${cIdx}`,
          speakerParticipantId: senderId,
          speakerName: screenName,
          text: chunkText,
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

    // Position characters and balloons within each panel
    panels.forEach((p) => {
      if (!p.isTitlePanel) {
        this.layoutSinglePanel(p, width, height);
      }
    });

    return panels;
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
   * Gap left when docking a balloon under an earlier one. The original tucks the
   * two together by 90 twips because its outline carries a tall wavy fringe;
   * ours is tighter and carries a white nimbus, so it wants a small gap instead.
   */
  private static readonly BALLOON_DOCK_GAP = 4;
  /** Shortest stem worth drawing; below this the balloon is nudged up instead. */
  private static readonly MIN_STEM_HEIGHT = 14;
  /** How far the stem root is pulled inside the last text line's extent. */
  private static readonly STEM_ROOT_INSET = 10;
  /** Effectively infinite, for route-region intersection. */
  private static readonly FAR = 1e6;

  /**
   * Padding between the text line boxes and the drawn outline. Kept here so the
   * measured box and the painted outline are derived from the same numbers.
   */
  private static balloonPadding(mode: BalloonMode): { padX: number; padY: number; bleed: number; bleedY: number } {
    if (mode === 'think') {
      // The cloud path bulges 8px horizontally and 6px vertically past the boxes.
      return { padX: 22, padY: 11, bleed: 8, bleedY: 6 };
    }
    return { padX: 14, padY: 7, bleed: 0, bleedY: 0 };
  }

  /**
   * Wrap the text for real and return the outline's true footprint.
   *
   * Width is chosen by balancing the box rather than by counting characters:
   * for text of total run length `len` wrapped at width w, the stack is about
   * `len / w` lines tall, so w = sqrt(aspect * lineHeight * len) lands on a
   * given aspect ratio. Comic balloons read best at roughly 2.2:1.
   */
  static measureBalloon(
    text: string,
    mode: BalloonMode,
    panelWidth: number,
    maxHeight?: number
  ): { lines: string[]; width: number; height: number } {
    const { padX, padY, bleed, bleedY } = this.balloonPadding(mode);
    const ctx = getMeasureContext();
    const maxOutlineWidth = Math.round(panelWidth * (mode === 'think' ? 0.54 : 0.5));

    if (!ctx) {
      // No DOM (tests/SSR): fall back to a character-count estimate.
      const approxWidth = Math.min(maxOutlineWidth, Math.max(90, text.length * 7.5 + 2 * padX));
      const approxLines = Math.max(1, Math.ceil((text.length * 7.2) / Math.max(40, approxWidth - 2 * padX)));
      return {
        lines: [text],
        width: approxWidth,
        height: approxLines * BALLOON_LINE_HEIGHT + 2 * padY + 2 * bleedY,
      };
    }

    ctx.font = balloonFontFor(mode);
    const runLength = ctx.measureText(text).width;
    let widestWord = 0;
    for (const word of text.split(/\s+/)) {
      if (word) widestWord = Math.max(widestWord, ctx.measureText(word).width);
    }

    const maxTextWidth = maxOutlineWidth - 2 * padX - 2 * bleed;
    const balanced = Math.sqrt(2.2 * BALLOON_LINE_HEIGHT * runLength);
    let wrapWidth = Math.max(
      Math.min(widestWord, maxTextWidth),
      Math.min(balanced, runLength, maxTextWidth)
    );

    const chrome = 2 * padY + 2 * bleedY;
    let lines = this.getWrappedLines(ctx, text, wrapWidth);

    // Too tall for the space above the speaker? Spend width to buy back height,
    // the way the original derives a minimum width from the text's area and the
    // headroom it has left (CUnitPanel::GetCloudEstimate).
    if (maxHeight !== undefined) {
      const linesThatFit = Math.max(1, Math.floor((maxHeight - chrome) / BALLOON_LINE_HEIGHT));
      while (lines.length > linesThatFit && wrapWidth < maxTextWidth) {
        wrapWidth = Math.min(maxTextWidth, wrapWidth * 1.18);
        const widened = this.getWrappedLines(ctx, text, wrapWidth);
        if (widened.length >= lines.length && wrapWidth >= maxTextWidth) {
          lines = widened;
          break;
        }
        lines = widened;
      }
    }

    let maxLineWidth = 0;
    for (const line of lines) {
      maxLineWidth = Math.max(maxLineWidth, ctx.measureText(line.trim()).width);
    }

    return {
      lines,
      width: Math.ceil(maxLineWidth + 2 * padX + 2 * bleed),
      height: Math.ceil(lines.length * BALLOON_LINE_HEIGHT + chrome),
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

  static layoutSinglePanel(
    panel: ComicPanel,
    panelWidth: number,
    panelHeight: number
  ): void {
    const numChars = panel.characters.length;
    const groundY = panelHeight - 12;
    // Character height ~68% of panel height (matching authentic Comic Chat scale)
    const maxCharHeight = Math.round(panelHeight * 0.68);
    const aspect = 0.44;

    if (numChars === 1) {
      const char = panel.characters[0];
      char.height = maxCharHeight;
      char.width = Math.round(char.height * aspect);
      char.x = Math.round((panelWidth - char.width) / 2);
      char.y = groundY - char.height;
      char.flip = false;
      char.headX = char.x + Math.round(char.width * 0.5);
      char.headY = char.y + Math.round(char.height * 0.24); // Initial head estimate
      char.headTopY = char.y + Math.round(char.height * this.HEAD_TOP_RATIO);
    } else if (numChars === 2) {
      // Two characters facing each other
      const char1 = panel.characters[0];
      const char2 = panel.characters[1];

      char1.height = maxCharHeight;
      char1.width = Math.round(char1.height * aspect);
      char1.x = Math.round(panelWidth * 0.08);
      char1.y = groundY - char1.height;
      char1.flip = false; // faces right
      char1.headX = char1.x + Math.round(char1.width * 0.5);
      char1.headY = char1.y + Math.round(char1.height * 0.24);
      char1.headTopY = char1.y + Math.round(char1.height * this.HEAD_TOP_RATIO);

      char2.height = maxCharHeight;
      char2.width = Math.round(char2.height * aspect);
      char2.x = Math.round(panelWidth * 0.92 - char2.width);
      char2.y = groundY - char2.height;
      char2.flip = true; // faces left
      char2.headX = char2.x + Math.round(char2.width * 0.5);
      char2.headY = char2.y + Math.round(char2.height * 0.24);
      char2.headTopY = char2.y + Math.round(char2.height * this.HEAD_TOP_RATIO);
    } else {
      // 3 or more characters
      const availableWidth = panelWidth - 24;
      const slotWidth = availableWidth / numChars;

      panel.characters.forEach((char, idx) => {
        char.height = Math.round(maxCharHeight * 0.92);
        char.width = Math.round(char.height * aspect);
        char.x = Math.round(12 + idx * slotWidth + (slotWidth - char.width) / 2);
        char.y = groundY - char.height;
        char.flip = idx >= Math.floor(numChars / 2);
        char.headX = char.x + Math.round(char.width * 0.5);
        char.headY = char.y + Math.round(char.height * 0.24);
        char.headTopY = char.y + Math.round(char.height * this.HEAD_TOP_RATIO);
      });
    }

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

    panel.balloons.forEach((balloon, idx) => {
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
          headroom > 0 ? headroom : undefined
        );
        balloon.lines = measured.lines;
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
            top = Math.max(top, prior.y + prior.height + this.BALLOON_DOCK_GAP);
          }
        }
        // Settled: the second pass would measure against the same headroom.
        if (top === previousTop) break;
      }

      // Balloons hang from the top of the panel, as in the original, so they stay
      // as far off the cast as the panel allows and the stem does the reaching.
      balloon.y = top;

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
  }

  /**
   * Choose where the stem leaves the balloon's underside: the middle of whatever
   * corridor survived the negotiation, pulled inside the last line of text so it
   * springs from under the words rather than from an empty corner.
   * Ported from CBWoodringNormal::AddArrow's xbreak calculation.
   */
  private static resolveStemRoot(balloon: ComicBalloon): void {
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

    // 1. Draw Background
    if (backdropCanvas) {
      ctx.drawImage(backdropCanvas, 0, 0, width, height);
    } else {
      ctx.fillStyle = '#fbf9f4'; // warm paper tone
      ctx.fillRect(0, 0, width, height);
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

    // 4. Draw Solid Black Comic Border
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

    ctx.restore();
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

    // Measure and format title text
    ctx.font = `bold 22px "Bangers", ${COMIC_FONT_FAMILY}`;
    const titleMetrics = ctx.measureText(episodeTitle);
    if (titleMetrics.width > boxW - 20) {
      // Wrap into 2 lines if long
      const words = episodeTitle.split(' ');
      const mid = Math.ceil(words.length / 2);
      const line1 = words.slice(0, mid).join(' ');
      const line2 = words.slice(mid).join(' ');
      ctx.font = `bold 17px ${COMIC_FONT_FAMILY}`;
      ctx.fillText(line1, width / 2, boxY + boxH * 0.32);
      ctx.fillText(line2, width / 2, boxY + boxH * 0.70);
    } else {
      ctx.fillText(episodeTitle, width / 2, boxY + boxH / 2);
    }

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
      const iconCanvas = avatarManager.renderAvatarIcon(av);
      if (iconCanvas) {
        ctx.drawImage(iconCanvas, iconX, iconY, iconSize, iconSize);
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


  static drawBalloon(ctx: CanvasRenderingContext2D, balloon: ComicBalloon): void {
    ctx.save();

    const { x, y, width, height, tailX, tailY, mode, text } = balloon;

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

    // Set font for line measurement and rendering
    ctx.font = balloonFontFor(mode);

    // Reuse the wrap decided during layout so the painted outline is exactly the
    // box that was negotiated against the other balloons.
    const lines =
      balloon.lines && balloon.lines.length > 0
        ? balloon.lines
        : this.getWrappedLines(ctx, text, Math.max(60, width - 24));
    const lineHeight = BALLOON_LINE_HEIGHT;
    const totalTextHeight = lines.length * lineHeight;
    const startY = y + (height - totalTextHeight) / 2;
    const centerX = x + width / 2;
    const { padX, padY } = this.balloonPadding(mode);

    const lineBoxes = lines.map((line, i) => {
      const w = ctx.measureText(line.trim()).width;
      return {
        left: centerX - w / 2 - padX,
        right: centerX + w / 2 + padX,
        top: startY + i * lineHeight - (i === 0 ? padY : 0),
        bottom: startY + (i + 1) * lineHeight + (i === lines.length - 1 ? padY : 0),
      };
    });

    // 1. Build authentic Woodring hand-drawn hugging balloon path
    if (mode === 'think') {
      let minL = Infinity, maxR = -Infinity, minT = Infinity, maxB = -Infinity;
      lineBoxes.forEach((b) => {
        if (b.left < minL) minL = b.left;
        if (b.right > maxR) maxR = b.right;
        if (b.top < minT) minT = b.top;
        if (b.bottom > maxB) maxB = b.bottom;
      });
      const cloudL = minL - 8;
      const cloudR = maxR + 8;
      const cloudT = minT - 6;
      const cloudB = maxB + 6;
      ctx.beginPath();
      this.drawCloudPath(ctx, cloudL, cloudT, cloudR - cloudL, cloudB - cloudT);
    } else {
      const hasTail = tailX > 0 && tailY > 0;
      this.drawHuggingSpeechBalloonPath(
        ctx,
        lineBoxes,
        tailX,
        tailY,
        hasTail,
        balloon.tailRootX
      );
    }

    // 2. Pass 1: Solid White Fill + Nimbus (White Halo Outline)
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 7;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.restore();

    // 3. Pass 2: Black Comic Ink Stroke
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (mode === 'whisper') {
      ctx.setLineDash([7, 4.5]);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#000000';
    } else {
      ctx.setLineDash([]);
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = '#000000';
    }
    ctx.stroke();
    ctx.restore();

    // 4. Thought bubbles trailing from thought balloon to speaker head
    if (mode === 'think' && tailX > 0 && tailY > 0) {
      // Same reasoning as the speech stem: leave from the underside nearest the
      // speaker and keep the trail descending, so it reads as coming down off the
      // balloon rather than drifting sideways across the panel.
      const bubbleRootX = Math.max(
        x + 14,
        Math.min(x + width - 14, balloon.tailRootX ?? tailX)
      );
      const bubbleRootY = y + height + 2;
      const trailDy = Math.max(10, tailY - bubbleRootY);
      const maxTrailDx = trailDy;
      const trailDx = Math.max(-maxTrailDx, Math.min(maxTrailDx, tailX - bubbleRootX));
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const bx = bubbleRootX + trailDx * t;
        const by = bubbleRootY + trailDy * t;
        // Small descending circles: ~6.5px down to ~2px radius (13px down to 4px diameter)
        const r = 6.5 - (i - 1) * 1.5;

        // White Nimbus for bubble
        ctx.beginPath();
        ctx.arc(bx, by, r + 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        // Bubble fill & ink border
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
      }
    }

    // Dialogue Text centered line by line
    ctx.setLineDash([]);
    ctx.fillStyle = mode === 'whisper' ? '#222222' : '#000000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    lines.forEach((l, i) => {
      ctx.fillText(l.trim(), centerX, startY + i * lineHeight);
    });

    ctx.restore();
  }

  // Draws authentic Microsoft Comic Chat speech / whisper balloon that hugs the text shape
  static drawHuggingSpeechBalloonPath(
    ctx: CanvasRenderingContext2D,
    lineBoxes: { left: number; right: number; top: number; bottom: number }[],
    tailX: number,
    tailY: number,
    hasTail: boolean,
    preferredRootX?: number
  ): void {
    const n = lineBoxes.length;
    if (n === 0) return;

    const left = lineBoxes.map((b) => b.left);
    const right = lineBoxes.map((b) => b.right);
    const top = lineBoxes.map((b) => b.top);
    const bottom = lineBoxes.map((b) => b.bottom);

    // Smooth out negligible width differences (< 14px)
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(left[i] - left[i + 1]) < 14) {
        const minL = Math.min(left[i], left[i + 1]);
        left[i] = minL;
        left[i + 1] = minL;
      }
      if (Math.abs(right[i] - right[i + 1]) < 14) {
        const maxR = Math.max(right[i], right[i + 1]);
        right[i] = maxR;
        right[i + 1] = maxR;
      }
    }

    const R = 10;
    ctx.beginPath();

    // 1. Top Edge of Line 0
    const rTop = Math.min(R, (right[0] - left[0]) / 2, (bottom[0] - top[0]) / 2);
    ctx.moveTo(left[0] + rTop, top[0]);
    this.drawWavyLine(ctx, left[0] + rTop, top[0], right[0] - rTop, top[0], 1.0, 20);
    ctx.quadraticCurveTo(right[0], top[0], right[0], top[0] + rTop);

    // 2. Right Side down through all lines
    for (let i = 0; i < n; i++) {
      if (i < n - 1) {
        const splitY = bottom[i];
        const nextR = right[i + 1];
        const currR = right[i];
        const diff = currR - nextR;

        if (Math.abs(diff) < 2) {
          // Continuous straight edge
          this.drawWavyLine(ctx, currR, top[i] + (i === 0 ? rTop : 0), currR, splitY, 1.0, 20);
        } else if (diff > 0) {
          // Line i is WIDER than line i+1 (steps inward to the left)
          const stepR = Math.min(R, diff / 2, (bottom[i] - top[i]) / 2);
          this.drawWavyLine(ctx, currR, top[i] + (i === 0 ? rTop : 0), currR, splitY - stepR, 1.0, 20);
          ctx.quadraticCurveTo(currR, splitY, currR - stepR, splitY);
          this.drawWavyLine(ctx, currR - stepR, splitY, nextR + stepR, splitY, 0.8, 16);
          ctx.quadraticCurveTo(nextR, splitY, nextR, splitY + stepR);
        } else {
          // Line i is NARROWER than line i+1 (steps outward to the right)
          const stepR = Math.min(R, -diff / 2, (bottom[i + 1] - top[i + 1]) / 2);
          this.drawWavyLine(ctx, currR, top[i] + (i === 0 ? rTop : 0), currR, splitY, 1.0, 20);
          ctx.quadraticCurveTo(currR, splitY, currR + stepR, splitY);
          this.drawWavyLine(ctx, currR + stepR, splitY, nextR - stepR, splitY, 0.8, 16);
          ctx.quadraticCurveTo(nextR, splitY, nextR, splitY + stepR);
        }
      } else {
        // Last line bottom right corner
        const rBot = Math.min(R, (right[n - 1] - left[n - 1]) / 2, (bottom[n - 1] - top[n - 1]) / 2);
        const startY = n === 1 ? top[0] + rTop : top[n - 1] + R;
        this.drawWavyLine(ctx, right[n - 1], startY, right[n - 1], bottom[n - 1] - rBot, 1.0, 20);
        ctx.quadraticCurveTo(right[n - 1], bottom[n - 1], right[n - 1] - rBot, bottom[n - 1]);
      }
    }

    // 3. Bottom Edge of Line n-1 (with Tail)
    const lastIdx = n - 1;
    const rBotLast = Math.min(R, (right[lastIdx] - left[lastIdx]) / 2, (bottom[lastIdx] - top[lastIdx]) / 2);
    const botY = bottom[lastIdx];
    const botLeft = left[lastIdx];
    const botRight = right[lastIdx];

    if (hasTail && tailX > 0 && tailY > 0) {
      const tailBaseWidth = Math.min(18, Math.max(10, (botRight - botLeft) * 0.14));
      const minRootX = botLeft + rBotLast + tailBaseWidth / 2 + 2;
      const maxRootX = botRight - rBotLast - tailBaseWidth / 2 - 2;
      // The layout picked an exit point in the middle of this balloon's free
      // corridor; pull it onto the last line of text so the stem springs from
      // under the words rather than from an empty corner.
      const targetX =
        preferredRootX !== undefined
          ? preferredRootX
          : botLeft + (botRight - botLeft) * Math.max(0.12, Math.min(0.88,
              (tailX - botLeft) / Math.max(1, botRight - botLeft)));
      const tailRootX = Math.max(minRootX, Math.min(maxRootX, targetX));

      const tailRightX = tailRootX + tailBaseWidth / 2;
      const tailLeftX = tailRootX - tailBaseWidth / 2;

      this.drawWavyLine(ctx, botRight - rBotLast, botY, tailRightX, botY, 1.0, 20);

      const dy = Math.max(12, tailY - botY);
      // Hold the stem within 45 degrees of vertical, as the original does. The
      // root was already moved to satisfy this; the cap only catches the cases
      // where the balloon had no room to shift.
      const maxDx = dy;
      const dx = Math.max(-maxDx, Math.min(maxDx, tailX - tailRootX));
      const halfBase = tailBaseWidth / 2;

      // Concave Woodring stem: curves inward towards center spine immediately
      const r_cp1 = { x: tailRootX + halfBase * 0.25 + dx * 0.25, y: botY + dy * 0.35 };
      const r_cp2 = { x: tailRootX + halfBase * 0.05 + dx * 0.70, y: botY + dy * 0.75 };
      const l_cp1 = { x: tailRootX - halfBase * 0.05 + dx * 0.70, y: botY + dy * 0.75 };
      const l_cp2 = { x: tailRootX - halfBase * 0.25 + dx * 0.25, y: botY + dy * 0.35 };

      ctx.bezierCurveTo(r_cp1.x, r_cp1.y, r_cp2.x, r_cp2.y, tailRootX + dx, botY + dy);
      ctx.bezierCurveTo(l_cp1.x, l_cp1.y, l_cp2.x, l_cp2.y, tailLeftX, botY);

      this.drawWavyLine(ctx, tailLeftX, botY, botLeft + rBotLast, botY, 1.0, 20);
    } else {
      this.drawWavyLine(ctx, botRight - rBotLast, botY, botLeft + rBotLast, botY, 1.0, 20);
    }

    ctx.quadraticCurveTo(botLeft, botY, botLeft, botY - rBotLast);

    // 4. Left Side up through all lines
    for (let i = n - 1; i >= 0; i--) {
      if (i > 0) {
        const splitY = top[i];
        const prevL = left[i - 1];
        const currL = left[i];
        const diff = prevL - currL;

        if (Math.abs(diff) < 2) {
          this.drawWavyLine(ctx, currL, bottom[i] - (i === n - 1 ? rBotLast : 0), currL, splitY, 1.0, 20);
        } else if (diff < 0) {
          // Line i-1 is WIDER to the left than line i (prevL < currL) -> steps outward to the left as we go up
          const stepR = Math.min(R, -diff / 2, (bottom[i - 1] - top[i - 1]) / 2);
          this.drawWavyLine(ctx, currL, bottom[i] - (i === n - 1 ? rBotLast : 0), currL, splitY + stepR, 1.0, 20);
          ctx.quadraticCurveTo(currL, splitY, currL - stepR, splitY);
          this.drawWavyLine(ctx, currL - stepR, splitY, prevL + stepR, splitY, 0.8, 16);
          ctx.quadraticCurveTo(prevL, splitY, prevL, splitY - stepR);
        } else {
          // Line i-1 is NARROWER to the left than line i (prevL > currL) -> steps inward to the right as we go up
          const stepR = Math.min(R, diff / 2, (bottom[i] - top[i]) / 2);
          this.drawWavyLine(ctx, currL, bottom[i] - (i === n - 1 ? rBotLast : 0), currL, splitY, 1.0, 20);
          ctx.quadraticCurveTo(currL, splitY, currL + stepR, splitY);
          this.drawWavyLine(ctx, currL + stepR, splitY, prevL - stepR, splitY, 0.8, 16);
          ctx.quadraticCurveTo(prevL, splitY, prevL, splitY - stepR);
        }
      } else {
        // Top line left edge up to top-left corner
        const rTop0 = Math.min(R, (right[0] - left[0]) / 2, (bottom[0] - top[0]) / 2);
        const startY = n === 1 ? bottom[0] - rBotLast : bottom[0] - R;
        this.drawWavyLine(ctx, left[0], startY, left[0], top[0] + rTop0, 1.0, 20);
        ctx.quadraticCurveTo(left[0], top[0], left[0] + rTop0, top[0]);
      }
    }

    ctx.closePath();
  }

  // Draws a line segment with subtle hand-drawn organic waves
  static drawWavyLine(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    waveHeight: number = 1.2,
    interval: number = 22
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    const nWaves = Math.max(1, Math.floor(dist / interval));

    if (nWaves <= 1) {
      ctx.lineTo(x2, y2);
      return;
    }

    const waveLen = dist / nWaves;
    const ux = dx / dist;
    const uy = dy / dist;
    const nx = -uy;
    const ny = ux;

    for (let i = 1; i <= nWaves; i++) {
      const endX = i === nWaves ? x2 : x1 + ux * (i * waveLen);
      const endY = i === nWaves ? y2 : y1 + uy * (i * waveLen);

      const midT = (i - 0.5) * waveLen;
      const wave = (i % 2 === 1 ? 1 : -0.7) * waveHeight;
      const cpx = x1 + ux * midT + nx * wave;
      const cpy = y1 + uy * midT + ny * wave;

      ctx.quadraticCurveTo(cpx, cpy, endX, endY);
    }
  }

  static drawCloudPath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;

    const numArcs = Math.max(12, Math.min(18, Math.round((w + h) / 22)));
    for (let i = 0; i < numArcs; i++) {
      const angle = (i * 2 * Math.PI) / numArcs;
      const nextAngle = ((i + 1) * 2 * Math.PI) / numArcs;
      const midAngle = (angle + nextAngle) / 2;

      const x1 = cx + Math.cos(angle) * (rx - 1);
      const y1 = cy + Math.sin(angle) * (ry - 1);
      const x2 = cx + Math.cos(nextAngle) * (rx - 1);
      const y2 = cy + Math.sin(nextAngle) * (ry - 1);

      const bulgeR = Math.min(rx, ry) * 0.22;
      const cpx = cx + Math.cos(midAngle) * (rx + bulgeR);
      const cpy = cy + Math.sin(midAngle) * (ry + bulgeR);

      if (i === 0) {
        ctx.moveTo(x1, y1);
      }
      ctx.quadraticCurveTo(cpx, cpy, x2, y2);
    }
    ctx.closePath();
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
