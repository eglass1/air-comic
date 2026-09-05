import pako from 'pako';
import {
  AvatarType,
  AvatarImageFormat,
  AvatarImagePalette,
  HEADMASK,
  TORSOMASK,
  TORSOFIRST,
  ColorRGB,
  PoseOffset,
  DecodedImage,
  DecodedPose,
  FaceRecord,
  TorsoRecord,
  SimpleBodyRecord,
  AvatarData,
  BackdropData,
} from './types';

// Converts integer emotion code from AVB file to float radians or integer gesture code
export function emotionToFloat(emotion: number): number {
  if (emotion >= 10) return emotion; // special gestures (10=EM_WAVE, 11=EM_POINTOTHER, 12=EM_POINTSELF, 14=EM_SHRUG, etc.)
  if (emotion === 9 || emotion === 0) return 0; // Neutral
  if (emotion >= 1 && emotion <= 8) {
    // 1=Happy (0 rad), 2=Coy (45 deg), 3=Bored (90 deg), 4=Scared (135 deg),
    // 5=Sad (180 deg), 6=Angry (225 deg), 7=Shout (270 deg), 8=Laugh (315 deg)
    return ((emotion - 1) * 2 * Math.PI) / 8;
  }
  return emotion;
}

export function DIBStorageWidth(width: number, bitCount: number): number {
  return Math.floor((width * bitCount + 31) / 32) * 4;
}

export class AVBParser {
  static parseAvatar(buffer: ArrayBuffer, filename: string): AvatarData {
    const dataView = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    let pos = 0;

    const magic = dataView.getUint16(pos, true);
    pos += 2;
    const type = dataView.getUint16(pos, true) as AvatarType;
    pos += 2;
    const version = dataView.getUint16(pos, true);
    pos += 2;

    let name = filename.replace(/\.[^/.]+$/, '');
    let flags = 0;
    let style = 0;
    let copyright = '';
    let globalPalette: ColorRGB[] | undefined = undefined;
    let iconPoseID = 0;
    let adjustment = 0;

    const poses: PoseOffset[] = [];
    const faces: FaceRecord[] = [];
    const torsos: TorsoRecord[] = [];
    const bodies: SimpleBodyRecord[] = [];

    while (pos < buffer.byteLength) {
      const tag = dataView.getUint16(pos, true);
      pos += 2;
      let size = 0;
      if (tag >= 256) {
        size = dataView.getUint16(pos, true);
        pos += 2;
      }

      if (tag === 6) {
        // AK_STARTDATA
        break;
      }

      switch (tag) {
        case 1: {
          // AK_NAME
          let end = pos;
          while (end < buffer.byteLength && uint8[end] !== 0) end++;
          const decoder = new TextDecoder('utf-8');
          name = decoder.decode(uint8.subarray(pos, end));
          pos = end + 1;
          break;
        }

        case 2: {
          // AK_FLAGS
          flags = dataView.getUint16(pos, true);
          pos += 2;
          break;
        }

        case 8: {
          // AK_STYLE
          style = dataView.getUint16(pos, true);
          pos += 2;
          break;
        }

        case 259: {
          // AK_COPYRIGHT
          let end = pos;
          const maxEnd = pos + size;
          while (end < maxEnd && end < buffer.byteLength && uint8[end] !== 0) end++;
          const decoder = new TextDecoder('utf-8');
          copyright = decoder.decode(uint8.subarray(pos, end));
          pos = maxEnd;
          break;
        }

        case 263: {
          // AK_OFFSET_ADJUSTMENT
          adjustment += dataView.getInt32(pos, true);
          pos += 4;
          break;
        }

        case 3: {
          // AK_ICON
          const off = dataView.getUint32(pos, true);
          pos += 4;
          poses.push({
            offsets: [off + adjustment, 0, 0],
            formats: [AvatarImageFormat.AIF_DIB, 0, 0],
            palettes: [AvatarImagePalette.AIP_NOPALETTE, 0, 0],
          });
          iconPoseID = poses.length;
          break;
        }

        case 256: {
          // AK_ICON_NEW
          const off = dataView.getUint32(pos, true);
          pos += 4;
          const fmt = uint8[pos++];
          const pal = uint8[pos++];
          poses.push({
            offsets: [off + adjustment, 0, 0],
            formats: [fmt, 0, 0],
            palettes: [pal, 0, 0],
          });
          iconPoseID = poses.length;
          break;
        }

        case 257: {
          // AK_COLORPALETTE
          const count = dataView.getUint16(pos, true);
          pos += 2;
          const pal: ColorRGB[] = [];
          for (let i = 0; i < count; i++) {
            const r = uint8[pos++];
            const g = uint8[pos++];
            const b = uint8[pos++];
            pal.push({ r, g, b });
          }
          globalPalette = pal;
          break;
        }

        case 9:
        case 12: {
          // AK_NBODIES / AK_NBODIES2
          const count = dataView.getUint16(pos, true);
          pos += 2;
          const isOld = tag === 9;
          let prevImgOff = 0;

          for (let i = 0; i < count; i++) {
            const imgOff = dataView.getUint32(pos, true);
            const maskOff = dataView.getUint32(pos + 4, true);
            const auraOff = dataView.getUint32(pos + 8, true);
            const rawEmotion = dataView.getInt16(pos + 12, true);
            const rawIntensity = uint8[pos + 14];
            const faceX = dataView.getInt16(pos + 15, true);
            const faceY = dataView.getInt16(pos + 17, true);

            let imgFmt = 0;
            let maskFmt = 0;
            let auraFmt = 0;
            let imgPal = 0;
            let maskPal = 0;
            let auraPal = 0;

            if (isOld) {
              pos += 35;
            } else {
              imgFmt = uint8[pos + 19];
              maskFmt = uint8[pos + 20];
              auraFmt = uint8[pos + 21];
              imgPal = uint8[pos + 22];
              maskPal = uint8[pos + 23];
              auraPal = uint8[pos + 24];
              pos += 25;
            }

            let poseID: number;
            if (imgOff !== prevImgOff || poses.length === 0) {
              poses.push({
                offsets: [
                  imgOff ? imgOff + adjustment : 0,
                  maskOff ? maskOff + adjustment : 0,
                  auraOff ? auraOff + adjustment : 0,
                ],
                formats: [imgFmt, maskFmt, auraFmt],
                palettes: [imgPal, maskPal, auraPal],
              });
              poseID = poses.length;
              prevImgOff = imgOff;
            } else {
              poseID = poses.length;
            }

            bodies.push({
              poseID,
              emotion: emotionToFloat(rawEmotion),
              intensity: rawIntensity / 255.0,
              faceX,
              faceY,
            });
          }
          break;
        }

        case 4:
        case 10: {
          // AK_NFACES / AK_NFACES2
          const count = dataView.getUint16(pos, true);
          pos += 2;
          const isOld = tag === 4;
          let prevImgOff = 0;

          for (let i = 0; i < count; i++) {
            const imgOff = dataView.getUint32(pos, true);
            const maskOff = dataView.getUint32(pos + 4, true);
            const auraOff = dataView.getUint32(pos + 8, true);
            const rawEmotion = dataView.getInt16(pos + 12, true);
            const rawIntensity = uint8[pos + 14];
            const cx = dataView.getInt16(pos + 15, true);
            const cy = dataView.getInt16(pos + 17, true);
            const cxDelta = dataView.getInt16(pos + 19, true);
            const cyDelta = dataView.getInt16(pos + 21, true);
            const faceX = dataView.getInt16(pos + 23, true);
            const faceY = dataView.getInt16(pos + 25, true);

            let imgFmt = 0;
            let maskFmt = 0;
            let auraFmt = 0;
            let imgPal = 0;
            let maskPal = 0;
            let auraPal = 0;

            if (isOld) {
              pos += 43;
            } else {
              imgFmt = uint8[pos + 27];
              maskFmt = uint8[pos + 28];
              auraFmt = uint8[pos + 29];
              imgPal = uint8[pos + 30];
              maskPal = uint8[pos + 31];
              auraPal = uint8[pos + 32];
              pos += 33;
            }

            let poseID: number;
            if (imgOff !== prevImgOff || poses.length === 0) {
              poses.push({
                offsets: [
                  imgOff ? imgOff + adjustment : 0,
                  maskOff ? maskOff + adjustment : 0,
                  auraOff ? auraOff + adjustment : 0,
                ],
                formats: [imgFmt, maskFmt, auraFmt],
                palettes: [imgPal, maskPal, auraPal],
              });
              poseID = poses.length;
              prevImgOff = imgOff;
            } else {
              poseID = poses.length;
            }

            faces.push({
              poseID,
              emotion: emotionToFloat(rawEmotion),
              intensity: rawIntensity / 255.0,
              cx,
              cy,
              cxDelta,
              cyDelta,
              faceX,
              faceY,
            });
          }
          break;
        }

        case 5:
        case 11: {
          // AK_NTORSOS / AK_NTORSOS2
          const count = dataView.getUint16(pos, true);
          pos += 2;
          const isOld = tag === 5;
          let prevImgOff = 0;

          for (let i = 0; i < count; i++) {
            const imgOff = dataView.getUint32(pos, true);
            const maskOff = dataView.getUint32(pos + 4, true);
            const auraOff = dataView.getUint32(pos + 8, true);
            const rawEmotion = dataView.getInt16(pos + 12, true);
            const rawIntensity = uint8[pos + 14];
            const cx = dataView.getInt16(pos + 15, true);
            const cy = dataView.getInt16(pos + 17, true);

            let imgFmt = 0;
            let maskFmt = 0;
            let auraFmt = 0;
            let imgPal = 0;
            let maskPal = 0;
            let auraPal = 0;

            if (isOld) {
              pos += 35;
            } else {
              imgFmt = uint8[pos + 19];
              maskFmt = uint8[pos + 20];
              auraFmt = uint8[pos + 21];
              imgPal = uint8[pos + 22];
              maskPal = uint8[pos + 23];
              auraPal = uint8[pos + 24];
              pos += 25;
            }

            let poseID: number;
            if (imgOff !== prevImgOff || poses.length === 0) {
              poses.push({
                offsets: [
                  imgOff ? imgOff + adjustment : 0,
                  maskOff ? maskOff + adjustment : 0,
                  auraOff ? auraOff + adjustment : 0,
                ],
                formats: [imgFmt, maskFmt, auraFmt],
                palettes: [imgPal, maskPal, auraPal],
              });
              poseID = poses.length;
              prevImgOff = imgOff;
            } else {
              poseID = poses.length;
            }

            torsos.push({
              poseID,
              emotion: emotionToFloat(rawEmotion),
              intensity: rawIntensity / 255.0,
              cx,
              cy,
            });
          }
          break;
        }

        default: {
          if (size > 0) {
            pos += size;
          }
          break;
        }
      }
    }

    return {
      name,
      type,
      flags,
      style,
      copyright,
      iconPoseID,
      globalPalette,
      poses,
      decodedPoses: new Map<number, DecodedPose>(),
      faces,
      torsos,
      bodies,
      buffer,
    };
  }

  static parseBackdrop(buffer: ArrayBuffer, filename: string): BackdropData {
    const dataView = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    let pos = 0;

    const magic = dataView.getUint16(pos, true);
    if (magic === 0x4d42) {
      // Standard Windows BMP file
      const image = this.decodeDIB(uint8, 0, buffer.byteLength, AvatarImagePalette.AIP_NOPALETTE, undefined);
      const canvas = this.imageToCanvas(image);
      return {
        name: filename.replace(/\.[^/.]+$/, ''),
        image,
        canvas,
      };
    }

    pos += 2;
    const type = dataView.getUint16(pos, true);
    pos += 2;
    const version = dataView.getUint16(pos, true);
    pos += 2;

    let adjustment = 0;
    let bgOffset = 0;
    let bgFmt = 0;
    let bgPal = 0;

    while (pos < buffer.byteLength) {
      const tag = dataView.getUint16(pos, true);
      pos += 2;
      let size = 0;
      if (tag >= 256) {
        size = dataView.getUint16(pos, true);
        pos += 2;
      }

      if (tag === 6) break;

      if (tag === 263) {
        adjustment += dataView.getInt32(pos, true);
        pos += 4;
      } else if (tag === 258) {
        bgOffset = dataView.getUint32(pos, true);
        pos += 4;
        bgFmt = uint8[pos++];
        bgPal = uint8[pos++];
        break;
      } else {
        if (size > 0) pos += size;
      }
    }

    const off = bgOffset + adjustment;
    const decoded = this.decodeImageFromStream(
      uint8,
      off,
      bgFmt as AvatarImageFormat,
      bgPal as AvatarImagePalette,
      undefined
    );

    const canvas = this.imageToCanvas(decoded);
    return {
      name: filename.replace(/\.[^/.]+$/, ''),
      image: decoded,
      canvas,
    };
  }

  static decodeImageFromStream(
    uint8: Uint8Array,
    offset: number,
    format: AvatarImageFormat,
    paletteType: AvatarImagePalette,
    globalPalette?: ColorRGB[]
  ): DecodedImage {
    const dataView = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let p = offset;

    let localPalette: ColorRGB[] | undefined = undefined;

    // Check if local palette is stored inline (AK_COLORPALETTE tag = 257)
    if (paletteType === AvatarImagePalette.AIP_LOCALPALETTE) {
      const tag = dataView.getUint16(p, true);
      if (tag === 257) {
        p += 2;
        const palSize = dataView.getUint16(p, true);
        p += 2;
        const nEntries = dataView.getUint16(p, true);
        p += 2;
        localPalette = [];
        for (let i = 0; i < nEntries; i++) {
          const r = uint8[p++];
          const g = uint8[p++];
          const b = uint8[p++];
          localPalette.push({ r, g, b });
        }
      }
    }

    const effectivePalette =
      paletteType === AvatarImagePalette.AIP_GLOBALPALETTE
        ? globalPalette
        : localPalette;

    if (format === AvatarImageFormat.AIF_DIB) {
      return this.decodeDIB(uint8, p, uint8.byteLength - p, paletteType, effectivePalette);
    } else {
      const headerStart = p;
      const dwHeaderSize = dataView.getUint32(p, true);
      p += 4;
      const biWidth = dataView.getInt32(p, true);
      p += 4;
      const biHeight = dataView.getInt32(p, true);
      p += 4;
      const biPlanes = dataView.getUint16(p, true);
      p += 2;
      const biBitCount = dataView.getUint16(p, true);
      p += 2;
      const biCompression = dataView.getUint32(p, true);
      p += 4;
      const biSizeImage = dataView.getUint32(p, true);
      p += 4;
      const biXPels = dataView.getInt32(p, true);
      p += 4;
      const biYPels = dataView.getInt32(p, true);
      p += 4;
      const biClrUsed = dataView.getUint32(p, true);
      p += 4;
      const biClrImportant = dataView.getUint32(p, true);
      p += 4;

      // Position stream immediately at the end of the BITMAPINFOHEADER
      p = headerStart + dwHeaderSize;

      const dwUncompressedSize = dataView.getUint32(p, true);
      p += 4;
      const dwCompressedSize = dataView.getUint32(p, true);
      p += 4;

      const compBytes = uint8.subarray(p, p + dwCompressedSize);
      let decomp: Uint8Array;
      try {
        decomp = pako.inflate(compBytes);
      } catch (err) {
        try {
          decomp = pako.inflateRaw(compBytes);
        } catch (err2) {
          console.warn('Decompression failed, using blank buffer:', err2);
          decomp = new Uint8Array(dwUncompressedSize);
        }
      }

      return this.decodeRawDIBBits(
        decomp,
        biWidth,
        biHeight,
        biBitCount,
        paletteType,
        effectivePalette
      );
    }
  }

  static decodeDIB(
    uint8: Uint8Array,
    offset: number,
    length: number,
    paletteType: AvatarImagePalette,
    palette?: ColorRGB[]
  ): DecodedImage {
    const dataView = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
    let p = offset;

    // Check if BITMAPFILEHEADER is present
    let bfOffBits = 0;
    if (dataView.getUint16(p, true) === 0x4d42) {
      // 'BM'
      const bfSize = dataView.getUint32(p + 2, true);
      bfOffBits = dataView.getUint32(p + 10, true);
      p += 14;
    }

    const biSize = dataView.getUint32(p, true);
    p += 4;
    const biWidth = dataView.getInt32(p, true);
    p += 4;
    const biHeight = dataView.getInt32(p, true);
    p += 4;
    const biPlanes = dataView.getUint16(p, true);
    p += 2;
    const biBitCount = dataView.getUint16(p, true);
    p += 2;
    const biCompression = dataView.getUint32(p, true);
    p += 4;
    const biSizeImage = dataView.getUint32(p, true);
    p += 4;
    const biXPels = dataView.getInt32(p, true);
    p += 4;
    const biYPels = dataView.getInt32(p, true);
    p += 4;
    const biClrUsed = dataView.getUint32(p, true);
    p += 4;
    const biClrImportant = dataView.getUint32(p, true);
    p += 4;

    const numColors = biClrUsed > 0 ? biClrUsed : biBitCount <= 8 ? 1 << biBitCount : 0;
    let dibPalette = palette;

    if (numColors > 0 && !dibPalette) {
      dibPalette = [];
      for (let i = 0; i < numColors; i++) {
        const b = uint8[p++];
        const g = uint8[p++];
        const r = uint8[p++];
        p++; // reserved
        dibPalette.push({ r, g, b });
      }
    }

    const bitsOffset = bfOffBits ? offset + bfOffBits : p;
    const bits = uint8.subarray(bitsOffset);

    return this.decodeRawDIBBits(
      bits,
      biWidth,
      biHeight,
      biBitCount,
      paletteType,
      dibPalette
    );
  }

  static decodeRawDIBBits(
    bits: Uint8Array,
    width: number,
    rawHeight: number,
    bitCount: number,
    paletteType: AvatarImagePalette,
    palette?: ColorRGB[]
  ): DecodedImage {
    const isTopDown = rawHeight < 0;
    const height = Math.abs(rawHeight);
    const stride = DIBStorageWidth(width, bitCount);
    const rgba = new Uint8ClampedArray(width * height * 4);

    const isMaskedMono = paletteType === AvatarImagePalette.AIP_MASKEDMONO;
    const isDualMask = paletteType === AvatarImagePalette.AIP_DUALMASK;

    for (let y = 0; y < height; y++) {
      const srcRowY = isTopDown ? y : height - 1 - y;
      const rowOffset = srcRowY * stride;
      const dstRowOffset = y * width * 4;

      if (bitCount === 2 && (isMaskedMono || isDualMask)) {
        // AIP_MASKEDMONO / AIP_DUALMASK:
        // 00 (0) = Blank / Transparent background (0, 0, 0, 0)
        // 01 (1) = White Aura knockout halo (255, 255, 255, 255)
        // 10 (2) = White body / skin / clothes fill (255, 255, 255, 255)
        // 11 (3) = Solid Black ink outline & black clothes (0, 0, 0, 255)
        for (let x = 0; x < width; x++) {
          const byteVal = bits[rowOffset + (x >> 2)];
          const shift = 6 - (x & 3) * 2;
          const px = (byteVal >> shift) & 3;
          const dstIdx = dstRowOffset + x * 4;

          if (px === 0) {
            // Transparent background
            rgba[dstIdx] = 0;
            rgba[dstIdx + 1] = 0;
            rgba[dstIdx + 2] = 0;
            rgba[dstIdx + 3] = 0;
          } else if (px === 1 || px === 2) {
            // White aura halo or white body fill
            rgba[dstIdx] = 255;
            rgba[dstIdx + 1] = 255;
            rgba[dstIdx + 2] = 255;
            rgba[dstIdx + 3] = 255;
          } else {
            // Black ink outline / black clothes (px === 3)
            rgba[dstIdx] = 0;
            rgba[dstIdx + 1] = 0;
            rgba[dstIdx + 2] = 0;
            rgba[dstIdx + 3] = 255;
          }
        }
      } else if (bitCount === 1) {
        // Monochrome (1 bpp)
        for (let x = 0; x < width; x++) {
          const byteVal = bits[rowOffset + (x >> 3)];
          const shift = 7 - (x & 7);
          const bit = (byteVal >> shift) & 1;
          const dstIdx = dstRowOffset + x * 4;

          if (palette && palette.length >= 2) {
            const color = palette[bit];
            rgba[dstIdx] = color.r;
            rgba[dstIdx + 1] = color.g;
            rgba[dstIdx + 2] = color.b;
            rgba[dstIdx + 3] = 255;
          } else {
            const val = bit ? 0 : 255; // 0 is white, 1 is black in standard mono
            rgba[dstIdx] = val;
            rgba[dstIdx + 1] = val;
            rgba[dstIdx + 2] = val;
            rgba[dstIdx + 3] = val === 255 ? 0 : 255;
          }
        }
      } else if (bitCount === 4) {
        // 4 bpp paletted
        for (let x = 0; x < width; x++) {
          const byteVal = bits[rowOffset + (x >> 1)];
          const shift = (1 - (x & 1)) * 4;
          const colorIdx = (byteVal >> shift) & 0x0f;
          const dstIdx = dstRowOffset + x * 4;

          if (palette && colorIdx < palette.length) {
            const c = palette[colorIdx];
            rgba[dstIdx] = c.r;
            rgba[dstIdx + 1] = c.g;
            rgba[dstIdx + 2] = c.b;
            rgba[dstIdx + 3] = 255;
          } else {
            const val = colorIdx * 17;
            rgba[dstIdx] = val;
            rgba[dstIdx + 1] = val;
            rgba[dstIdx + 2] = val;
            rgba[dstIdx + 3] = 255;
          }
        }
      } else if (bitCount === 8) {
        // 8 bpp paletted
        for (let x = 0; x < width; x++) {
          const colorIdx = bits[rowOffset + x];
          const dstIdx = dstRowOffset + x * 4;

          if (palette && colorIdx < palette.length) {
            const c = palette[colorIdx];
            rgba[dstIdx] = c.r;
            rgba[dstIdx + 1] = c.g;
            rgba[dstIdx + 2] = c.b;
            rgba[dstIdx + 3] = 255;
          } else {
            rgba[dstIdx] = colorIdx;
            rgba[dstIdx + 1] = colorIdx;
            rgba[dstIdx + 2] = colorIdx;
            rgba[dstIdx + 3] = 255;
          }
        }
      } else if (bitCount === 24) {
        // 24 bpp BGR
        for (let x = 0; x < width; x++) {
          const srcIdx = rowOffset + x * 3;
          const dstIdx = dstRowOffset + x * 4;
          rgba[dstIdx] = bits[srcIdx + 2]; // R
          rgba[dstIdx + 1] = bits[srcIdx + 1]; // G
          rgba[dstIdx + 2] = bits[srcIdx]; // B
          rgba[dstIdx + 3] = 255;
        }
      } else if (bitCount === 32) {
        // 32 bpp BGRA
        for (let x = 0; x < width; x++) {
          const srcIdx = rowOffset + x * 4;
          const dstIdx = dstRowOffset + x * 4;
          rgba[dstIdx] = bits[srcIdx + 2]; // R
          rgba[dstIdx + 1] = bits[srcIdx + 1]; // G
          rgba[dstIdx + 2] = bits[srcIdx]; // B
          rgba[dstIdx + 3] = bits[srcIdx + 3] || 255;
        }
      }
    }

    return { width, height, data: rgba };
  }

  static getPose(avatar: AvatarData, poseID: number): DecodedPose | null {
    if (poseID <= 0 || poseID > avatar.poses.length) return null;

    let cached = avatar.decodedPoses.get(poseID);
    if (cached) return cached;

    const poseOffset = avatar.poses[poseID - 1];
    const uint8 = new Uint8Array(avatar.buffer);

    let drawing: DecodedImage | null = null;
    let mask: DecodedImage | null = null;
    let aura: DecodedImage | null = null;

    if (poseOffset.offsets[0] > 0) {
      drawing = this.decodeImageFromStream(
        uint8,
        poseOffset.offsets[0],
        poseOffset.formats[0] as AvatarImageFormat,
        poseOffset.palettes[0] as AvatarImagePalette,
        avatar.globalPalette
      );
    }

    if (poseOffset.offsets[1] > 0) {
      mask = this.decodeImageFromStream(
        uint8,
        poseOffset.offsets[1],
        poseOffset.formats[1] as AvatarImageFormat,
        poseOffset.palettes[1] as AvatarImagePalette,
        avatar.globalPalette
      );
    }

    if (poseOffset.offsets[2] > 0) {
      aura = this.decodeImageFromStream(
        uint8,
        poseOffset.offsets[2],
        poseOffset.formats[2] as AvatarImageFormat,
        poseOffset.palettes[2] as AvatarImagePalette,
        avatar.globalPalette
      );
    }

    // If separate mask is present, apply transparency to drawing layer
    if (drawing && mask) {
      const dData = drawing.data;
      const mData = mask.data;
      const minLen = Math.min(dData.length, mData.length);
      for (let i = 0; i < minLen; i += 4) {
        // If mask is transparent (alpha === 0 or white), make drawing pixel transparent
        const isMaskTrans =
          mData[i + 3] === 0 ||
          (mData[i] === 255 && mData[i + 1] === 255 && mData[i + 2] === 255);
        if (isMaskTrans) {
          dData[i + 3] = 0;
        } else {
          dData[i + 3] = 255;
        }
      }
    }

    cached = { drawing, mask, aura };
    avatar.decodedPoses.set(poseID, cached);
    return cached;
  }

  static imageToCanvas(img: DecodedImage): HTMLCanvasElement {
    if (img.canvas) return img.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(img.width, img.height);
      imgData.data.set(img.data);
      ctx.putImageData(imgData, 0, 0);
    }
    img.canvas = canvas;
    return canvas;
  }

  // Composite a complex avatar (Face + Torso) into a single crisp Canvas
  static compositeComplexAvatar(
    avatar: AvatarData,
    faceRec: FaceRecord,
    torsoRec: TorsoRecord,
    flip: boolean
  ): { canvas: HTMLCanvasElement; headX: number; headY: number; headBottomY: number } {
    const headPose = this.getPose(avatar, faceRec.poseID);
    const torsoPose = this.getPose(avatar, torsoRec.poseID);

    if (!headPose?.drawing || !torsoPose?.drawing) {
      const empty = document.createElement('canvas');
      empty.width = 100;
      empty.height = 100;
      return { canvas: empty, headX: 50, headY: 20, headBottomY: 45 };
    }

    const headCanvas = this.imageToCanvas(headPose.drawing);
    const torsoCanvas = this.imageToCanvas(torsoPose.drawing);

    const xOffset = torsoRec.cx + faceRec.cxDelta - faceRec.cx;
    const yOffset = torsoRec.cy + faceRec.cyDelta - faceRec.cy;

    const bitLeft = Math.min(0, xOffset);
    const bitRight = Math.max(torsoCanvas.width, xOffset + headCanvas.width);
    const bitTop = Math.min(0, yOffset);
    const bitBottom = Math.max(torsoCanvas.height, yOffset + headCanvas.height);

    const totalWidth = bitRight - bitLeft;
    const totalHeight = bitBottom - bitTop;

    const canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { canvas, headX: totalWidth / 2, headY: 20, headBottomY: totalHeight / 2 };

    // In MS Comic Chat:
    // Torso position in canvas: (-bitLeft, -bitTop)
    // Head position in canvas: (xOffset - bitLeft, yOffset - bitTop)
    const torsoX = -bitLeft;
    const torsoY = -bitTop;
    const headX = xOffset - bitLeft;
    const headY = yOffset - bitTop;

    const flags = avatar.flags;
    const torsoFirst = (flags & TORSOFIRST) !== 0;

    if (torsoFirst) {
      ctx.drawImage(torsoCanvas, torsoX, torsoY);
      ctx.drawImage(headCanvas, headX, headY);
    } else {
      ctx.drawImage(headCanvas, headX, headY);
      ctx.drawImage(torsoCanvas, torsoX, torsoY);
    }

    let resultCanvas = canvas;
    let actualHeadX = headX + faceRec.faceX;
    let actualHeadY = headY + faceRec.faceY;
    // Bottom edge of the head artwork within the composite. The camera uses it
    // to keep a zoomed-in head from growing past the panel (headHeight in
    // avatar.cpp's ComputeBodyGeometry).
    const headBottomY = headY + headCanvas.height;

    if (flip) {
      const flippedCanvas = document.createElement('canvas');
      flippedCanvas.width = totalWidth;
      flippedCanvas.height = totalHeight;
      const fCtx = flippedCanvas.getContext('2d');
      if (fCtx) {
        fCtx.translate(totalWidth, 0);
        fCtx.scale(-1, 1);
        fCtx.drawImage(canvas, 0, 0);
      }
      resultCanvas = flippedCanvas;
      actualHeadX = totalWidth - actualHeadX;
    }

    return { canvas: resultCanvas, headX: actualHeadX, headY: actualHeadY, headBottomY };
  }

  // Composite a simple avatar into a single Canvas
  static compositeSimpleAvatar(
    avatar: AvatarData,
    bodyRec: SimpleBodyRecord,
    flip: boolean
  ): { canvas: HTMLCanvasElement; headX: number; headY: number; headBottomY: number } {
    const pose = this.getPose(avatar, bodyRec.poseID);
    if (!pose?.drawing) {
      const empty = document.createElement('canvas');
      empty.width = 100;
      empty.height = 100;
      return { canvas: empty, headX: 50, headY: 20, headBottomY: 45 };
    }

    const drawingCanvas = this.imageToCanvas(pose.drawing);
    let resultCanvas = drawingCanvas;
    let headX = bodyRec.faceX;
    let headY = bodyRec.faceY;

    if (flip) {
      const flippedCanvas = document.createElement('canvas');
      flippedCanvas.width = drawingCanvas.width;
      flippedCanvas.height = drawingCanvas.height;
      const fCtx = flippedCanvas.getContext('2d');
      if (fCtx) {
        fCtx.translate(drawingCanvas.width, 0);
        fCtx.scale(-1, 1);
        fCtx.drawImage(drawingCanvas, 0, 0);
      }
      resultCanvas = flippedCanvas;
      headX = drawingCanvas.width - headX;
    }

    // A simple avatar is one image, so the original just calls the top half the
    // head (CAvatarSimple's headHeight = pose.h / 2).
    return {
      canvas: resultCanvas,
      headX,
      headY,
      headBottomY: Math.floor(drawingCanvas.height / 2),
    };
  }
}
