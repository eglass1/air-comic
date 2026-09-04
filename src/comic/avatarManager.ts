import { AVBParser } from './avbParser';
import { EmotionEngine } from './emotionEngine';
import {
  AvatarData,
  AvatarType,
  BackdropData,
  DecodedImage,
  EM_NEUTRAL,
} from './types';
import { EMBEDDED_AVATARS, EMBEDDED_BACKDROPS } from './artData';
import {
  EARL_HEAD_WIDTH,
  EARL_HEAD_HEIGHT,
  EARL_HEAD_DEFLATE_B64,
  EARL_ICON_DEFLATE_B64,
} from './earlData';
import pako from 'pako';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export interface AvatarInfo {
  id: string;
  name: string;
  filename: string;
}

export interface BackdropInfo {
  id: string;
  name: string;
  filename: string;
}

export class AvatarManager {
  private static instance: AvatarManager;

  private avatarCache: Map<string, AvatarData> = new Map();
  private backdropCache: Map<string, BackdropData> = new Map();
  private characterCanvasCache: Map<string, { canvas: HTMLCanvasElement; headX: number; headY: number; headTopY: number }> = new Map();
  private iconCanvasCache: Map<string, HTMLCanvasElement> = new Map();

  // Known built-in avatar list
  static readonly AVAILABLE_AVATARS: AvatarInfo[] = [
    { id: 'armando', name: 'Armando', filename: 'armando.avb' },
    { id: 'susan', name: 'Susan', filename: 'susan.avb' },
    { id: 'tux', name: 'Tux', filename: 'tux.avb' },
    { id: 'connor', name: 'Connor', filename: 'connor.avb' },
    { id: 'denise', name: 'Denise', filename: 'denise.avb' },
    { id: 'hugh', name: 'Hugh', filename: 'hugh.avb' },
    { id: 'jordan', name: 'Jordan', filename: 'jordan.avb' },
    { id: 'kirby', name: 'Kirby', filename: 'kirby.avb' },
    { id: 'lance', name: 'Lance', filename: 'lance.avb' },
    { id: 'lynnea', name: 'Lynnea', filename: 'lynnea.avb' },
    { id: 'mike', name: 'Mike', filename: 'mike.avb' },
    { id: 'tiki', name: 'Tiki', filename: 'tiki.avb' },
    { id: 'veronica', name: 'Veronica', filename: 'veronica.avb' },
    { id: 'xeno', name: 'Xeno', filename: 'xeno.avb' },
    { id: 'anna', name: 'Anna', filename: 'anna.avb' },
    { id: 'bolo', name: 'Bolo', filename: 'bolo.avb' },
    { id: 'buck', name: 'Buck', filename: 'buck.avb' },
    { id: 'cro', name: 'Cro', filename: 'cro.avb' },
    { id: 'dan', name: 'Dan', filename: 'dan.avb' },
    { id: 'glenda', name: 'Glenda', filename: 'glenda.avb' },
    { id: 'kevin', name: 'Kevin', filename: 'kevin.avb' },
    { id: 'kwensa', name: 'Kwensa', filename: 'kwensa.avb' },
    { id: 'margaret', name: 'Margaret', filename: 'margaret.avb' },
    { id: 'maynard', name: 'Maynard', filename: 'maynard.avb' },
    { id: 'pedagog', name: 'Pedagog', filename: 'pedagog.avb' },
    { id: 'rainbow', name: 'Rainbow', filename: 'rainbow.avb' },
    { id: 'rebecca', name: 'Rebecca', filename: 'rebecca.avb' },
    { id: 'sage', name: 'Sage', filename: 'sage.avb' },
    { id: 'scotty', name: 'Scotty', filename: 'scotty.avb' },
    { id: 'tongtyed', name: 'Tongtyed', filename: 'tongtyed.avb' },
    { id: 'waf', name: 'Waf', filename: 'waf.avb' },
    { id: 'earl', name: 'Earl', filename: 'earl.avb' },
  ];

  // Known built-in backdrop list
  static readonly AVAILABLE_BACKDROPS: BackdropInfo[] = [
    { id: 'room', name: 'Living Room', filename: 'room.bgb' },
    { id: 'clouds', name: 'Clouds', filename: 'clouds.bgb' },
    { id: 'field', name: 'Green Field', filename: 'field.bgb' },
    { id: 'pastoral', name: 'Pastoral Landscape', filename: 'pastoral.bgb' },
    { id: 'space', name: 'Outer Space', filename: 'space.bgb' },
    { id: 'yellow', name: 'Yellow Studio', filename: 'yellow.bgb' },
    { id: 'volcano', name: 'Volcano', filename: 'volcano.bgb' },
    { id: 'den', name: 'Cozy Den', filename: 'den.bgb' },
    { id: 'buckroom', name: 'Buck Room', filename: 'buckroom.bgb' },
  ];

  static getInstance(): AvatarManager {
    if (!AvatarManager.instance) {
      AvatarManager.instance = new AvatarManager();
    }
    return AvatarManager.instance;
  }

  private createEarlAvatar(armando: AvatarData): AvatarData {
    const decompHead = pako.inflate(base64ToUint8Array(EARL_HEAD_DEFLATE_B64));
    const earlHeadImage: DecodedImage = {
      width: EARL_HEAD_WIDTH,
      height: EARL_HEAD_HEIGHT,
      data: new Uint8ClampedArray(decompHead.buffer, decompHead.byteOffset, decompHead.byteLength),
    };

    const decompIcon = pako.inflate(base64ToUint8Array(EARL_ICON_DEFLATE_B64));
    const earlIconImage: DecodedImage = {
      width: 64,
      height: 64,
      data: new Uint8ClampedArray(decompIcon.buffer, decompIcon.byteOffset, decompIcon.byteLength),
    };

    const earl: AvatarData = {
      name: 'Earl',
      type: AvatarType.AT_COMPLEX,
      flags: armando.flags,
      style: armando.style,
      copyright: 'AirComic Custom Character (Earl)',
      globalPalette: armando.globalPalette,
      iconPoseID: 1,
      poses: armando.poses,
      torsos: armando.torsos,
      bodies: armando.bodies,
      buffer: armando.buffer,
      faces: armando.faces.map((f) => ({
        ...f,
        poseID: 2,
        cx: 55,
        cy: 88,
        cxDelta: 0,
        cyDelta: 0,
        faceX: 55,
        faceY: 45,
      })),
      decodedPoses: new Map(armando.decodedPoses),
    };

    earl.decodedPoses.set(1, { drawing: earlIconImage, mask: null, aura: null });
    earl.decodedPoses.set(2, { drawing: earlHeadImage, mask: null, aura: null });
    return earl;
  }

  async loadAvatar(avatarNameOrFilename: string): Promise<AvatarData | null> {
    const cleanKey = (avatarNameOrFilename || 'armando').trim().toLowerCase().replace(/\.avb$/, '') || 'armando';
    if (this.avatarCache.has(cleanKey)) {
      return this.avatarCache.get(cleanKey)!;
    }

    if (cleanKey === 'earl') {
      const armando = await this.loadAvatar('armando');
      if (armando) {
        const earl = this.createEarlAvatar(armando);
        this.avatarCache.set('earl', earl);
        this.avatarCache.set('earl.avb', earl);
        return earl;
      }
    }

    const info =
      AvatarManager.AVAILABLE_AVATARS.find(
        (a) => a.id === cleanKey || a.name.toLowerCase() === cleanKey
      ) || { id: cleanKey, name: avatarNameOrFilename, filename: `${cleanKey}.avb` };

    // 1. Check embedded in-memory artwork first (100% standalone single-file support)
    if (EMBEDDED_AVATARS[cleanKey]) {
      try {
        const buffer = base64ToArrayBuffer(EMBEDDED_AVATARS[cleanKey]);
        const parsed = AVBParser.parseAvatar(buffer, info.filename);
        this.cacheAvatarData(cleanKey, info, parsed);
        return parsed;
      } catch (err) {
        console.warn(`Failed to parse embedded avatar ${cleanKey}:`, err);
      }
    }

    // 2. Fallback to network fetch if external
    const url = `/art/avatars/${info.filename}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`Failed to fetch avatar from ${url}: status ${resp.status}`);
        if (cleanKey !== 'armando') {
          return this.loadAvatar('armando');
        }
        return null;
      }
      const buffer = await resp.arrayBuffer();
      const parsed = AVBParser.parseAvatar(buffer, info.filename);
      this.cacheAvatarData(cleanKey, info, parsed);
      return parsed;
    } catch (err) {
      console.error(`Error loading avatar ${avatarNameOrFilename}:`, err);
      if (cleanKey !== 'armando') {
        return this.loadAvatar('armando');
      }
      return null;
    }
  }

  private cacheAvatarData(cleanKey: string, info: AvatarInfo, parsed: AvatarData): void {
    this.avatarCache.set(cleanKey, parsed);
    this.avatarCache.set(`${cleanKey}.avb`, parsed);
    this.avatarCache.set(info.id.toLowerCase(), parsed);
    this.avatarCache.set(info.name.toLowerCase(), parsed);
    this.avatarCache.set(info.filename.toLowerCase(), parsed);
    this.avatarCache.set(parsed.name.toLowerCase(), parsed);
  }

  getCachedAvatar(avatarNameOrFilename: string): AvatarData | null {
    const cleanKey = avatarNameOrFilename.toLowerCase().replace(/\.avb$/, '');
    if (this.avatarCache.has(cleanKey)) {
      return this.avatarCache.get(cleanKey)!;
    }
    const found = AvatarManager.AVAILABLE_AVATARS.find(
      (a) => a.id === cleanKey || a.name.toLowerCase() === cleanKey
    );
    if (found && this.avatarCache.has(found.id)) {
      return this.avatarCache.get(found.id)!;
    }
    for (const [key, av] of this.avatarCache.entries()) {
      if (key === cleanKey || av.name.toLowerCase() === cleanKey) {
        return av;
      }
    }
    return null;
  }

  async loadBackdrop(backdropNameOrFilename: string): Promise<BackdropData | null> {
    const cleanKey = backdropNameOrFilename.toLowerCase().replace(/\.bgb$/, '');
    if (this.backdropCache.has(cleanKey)) {
      return this.backdropCache.get(cleanKey)!;
    }

    const info =
      AvatarManager.AVAILABLE_BACKDROPS.find(
        (b) => b.id === cleanKey || b.name.toLowerCase() === cleanKey
      ) || { id: cleanKey, name: backdropNameOrFilename, filename: `${cleanKey}.bgb` };

    // 1. Check embedded in-memory artwork first (100% standalone single-file support)
    if (EMBEDDED_BACKDROPS[cleanKey]) {
      try {
        const buffer = base64ToArrayBuffer(EMBEDDED_BACKDROPS[cleanKey]);
        const parsed = AVBParser.parseBackdrop(buffer, info.filename);
        this.backdropCache.set(cleanKey, parsed);
        return parsed;
      } catch (err) {
        console.warn(`Failed to parse embedded backdrop ${cleanKey}:`, err);
      }
    }

    // 2. Fallback to network fetch if external
    const url = `/art/backdrops/${info.filename}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`Failed to fetch backdrop from ${url}: status ${resp.status}`);
        return null;
      }
      const buffer = await resp.arrayBuffer();
      const parsed = AVBParser.parseBackdrop(buffer, info.filename);
      this.backdropCache.set(cleanKey, parsed);
      return parsed;
    } catch (err) {
      console.error(`Error loading backdrop ${backdropNameOrFilename}:`, err);
      return null;
    }
  }

  /**
   * Topmost row holding any ink — the top of the hair, not the face anchor.
   * Balloon stems are aimed at this so they stop above the character instead of
   * landing on the mouth and covering the face.
   */
  private static measureHeadTop(canvas: HTMLCanvasElement): number {
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx || !canvas.width || !canvas.height) return 0;

      const scanHeight = Math.max(1, Math.min(canvas.height, Math.ceil(canvas.height * 0.6)));
      const data = ctx.getImageData(0, 0, canvas.width, scanHeight).data;
      for (let y = 0; y < scanHeight; y++) {
        const rowStart = y * canvas.width * 4;
        for (let x = 0; x < canvas.width; x++) {
          if (data[rowStart + x * 4 + 3] > 40) return y;
        }
      }
    } catch {
      // Reading pixels can fail in exotic contexts; the caller falls back safely.
    }
    return 0;
  }

  renderCharacter(
    avatar: AvatarData,
    emotion: number = EM_NEUTRAL,
    intensity: number = 0.0,
    flip: boolean = false
  ): { canvas: HTMLCanvasElement; headX: number; headY: number; headTopY: number } {
    const cacheKey = `${avatar.name}_${emotion.toFixed(2)}_${intensity.toFixed(2)}_${flip ? 'F' : 'N'}`;
    if (this.characterCanvasCache.has(cacheKey)) {
      return this.characterCanvasCache.get(cacheKey)!;
    }

    let rendered: { canvas: HTMLCanvasElement; headX: number; headY: number };

    if (avatar.type === AvatarType.AT_COMPLEX) {
      const poseRecs = EmotionEngine.getFaceAndTorso(avatar, emotion, intensity);
      if (poseRecs) {
        rendered = AVBParser.compositeComplexAvatar(
          avatar,
          poseRecs.face,
          poseRecs.torso,
          flip
        );
      } else {
        const empty = document.createElement('canvas');
        empty.width = 100;
        empty.height = 100;
        rendered = { canvas: empty, headX: 50, headY: 20 };
      }
    } else {
      // Simple avatar
      const bodyRec = EmotionEngine.getSimpleBody(avatar, emotion, intensity);
      if (bodyRec) {
        rendered = AVBParser.compositeSimpleAvatar(avatar, bodyRec, flip);
      } else {
        const empty = document.createElement('canvas');
        empty.width = 100;
        empty.height = 100;
        rendered = { canvas: empty, headX: 50, headY: 20 };
      }
    }

    const measured = { ...rendered, headTopY: AvatarManager.measureHeadTop(rendered.canvas) };
    this.characterCanvasCache.set(cacheKey, measured);
    return measured;
  }

  renderAvatarIcon(avatar: AvatarData): HTMLCanvasElement {
    const cacheKey = `${avatar.name}_icon`;
    if (this.iconCanvasCache.has(cacheKey)) {
      return this.iconCanvasCache.get(cacheKey)!;
    }

    let iconCanvas: HTMLCanvasElement;

    if (avatar.iconPoseID > 0) {
      const pose = AVBParser.getPose(avatar, avatar.iconPoseID);
      if (pose?.drawing) {
        iconCanvas = AVBParser.imageToCanvas(pose.drawing);
      } else {
        const rendered = this.renderCharacter(avatar, EM_NEUTRAL, 0, false);
        iconCanvas = rendered.canvas;
      }
    } else {
      const rendered = this.renderCharacter(avatar, EM_NEUTRAL, 0, false);
      iconCanvas = rendered.canvas;
    }

    this.iconCanvasCache.set(cacheKey, iconCanvas);
    return iconCanvas;
  }
}
