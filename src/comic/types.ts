export enum AvatarType {
  AT_SIMPLE = 1,
  AT_COMPLEX = 2,
  AT_BACKDROP = 3,
}

export enum AvatarImageFormat {
  AIF_DIB = 0,
  AIF_LZDEFLATE = 1,
}

export enum AvatarImagePalette {
  AIP_NOPALETTE = 0,
  AIP_GLOBALPALETTE = 1,
  AIP_LOCALPALETTE = 2,
  AIP_MONOCHROME = 3,
  AIP_MASKEDMONO = 4,
  AIP_DUALMASK = 5,
}

// Avatar flags
export const HEADMASK = 1;
export const TORSOMASK = 2;
export const TORSOFIRST = 4;
export const OTHERMAPPED = 8;

// Emotion angles (in radians: 0 to 2*PI)
export const EM_HAPPY = 0;
export const EM_COY = (1 * 2 * Math.PI) / 8;
export const EM_BORED = (2 * 2 * Math.PI) / 8;
export const EM_SCARED = (3 * 2 * Math.PI) / 8;
export const EM_SAD = (4 * 2 * Math.PI) / 8;
export const EM_ANGRY = (5 * 2 * Math.PI) / 8;
export const EM_SHOUT = (6 * 2 * Math.PI) / 8;
export const EM_LAUGH = (7 * 2 * Math.PI) / 8;
export const EM_NEUTRAL = 0.0;

// Special gestures (matching AVB raw emotion indices)
export const EM_WAVE = 10;
export const EM_POINTOTHER = 11;
export const EM_POINTSELF = 12;
export const EM_DOUBLEPOINT = 13;
export const EM_SHRUG = 14;
export const EM_3QRWALK = 15;
export const EM_SIDEWALK = 16;
export const EM_3QFWALK = 17;

export interface ColorRGB {
  r: number;
  g: number;
  b: number;
}

export interface PoseOffset {
  offsets: [number, number, number]; // [drawing, mask, aura]
  formats: [number, number, number];
  palettes: [number, number, number];
}

export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA pixels
  canvas?: HTMLCanvasElement;
}

export interface DecodedPose {
  drawing: DecodedImage | null;
  mask: DecodedImage | null;
  aura: DecodedImage | null;
}

export interface FaceRecord {
  poseID: number;
  emotion: number;
  intensity: number;
  cx: number;
  cy: number;
  cxDelta: number;
  cyDelta: number;
  faceX: number;
  faceY: number;
}

export interface TorsoRecord {
  poseID: number;
  emotion: number;
  intensity: number;
  cx: number;
  cy: number;
}

export interface SimpleBodyRecord {
  poseID: number;
  emotion: number;
  intensity: number;
  faceX: number;
  faceY: number;
}

export interface AvatarData {
  name: string;
  type: AvatarType;
  flags: number;
  style: number;
  copyright?: string;
  iconPoseID: number;
  globalPalette?: ColorRGB[];
  poses: PoseOffset[];
  decodedPoses: Map<number, DecodedPose>;
  faces: FaceRecord[];
  torsos: TorsoRecord[];
  bodies: SimpleBodyRecord[];
  buffer: ArrayBuffer;
}

export interface BackdropData {
  name: string;
  image: DecodedImage;
  canvas: HTMLCanvasElement;
}

export type BalloonMode = 'say' | 'whisper' | 'think' | 'action';

export interface ComicBalloon {
  id: string;
  speakerParticipantId: string;
  speakerName: string;
  text: string;
  mode: BalloonMode;
  x: number;
  y: number;
  width: number;
  height: number;
  tailX: number;
  tailY: number;
}

export interface ComicCharacterInPanel {
  participantId: string;
  screenName: string;
  avatarName: string;
  avatarData: AvatarData | null;
  emotion: number;
  intensity: number;
  isSpeaker: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  flip: boolean;
  headX: number;
  /** Face anchor, roughly the mouth. */
  headY: number;
  /** Top of the hair. Balloon stems stop above this so they never cover the face. */
  headTopY: number;
  canvas?: HTMLCanvasElement;
}

export interface TitleStarringMember {
  screenName: string;
  avatarName: string;
}

export interface ComicPanel {
  id: string;
  panelIndex: number;
  isTitlePanel: boolean;
  title?: string;
  roomName?: string;
  backdropName: string;
  characters: ComicCharacterInPanel[];
  balloons: ComicBalloon[];
  timestamp: number;
  titleAvatars?: string[];
  starringMembers?: TitleStarringMember[];
}
