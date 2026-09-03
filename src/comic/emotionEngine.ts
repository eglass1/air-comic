import {
  AvatarData,
  FaceRecord,
  TorsoRecord,
  SimpleBodyRecord,
  BalloonMode,
  EM_HAPPY,
  EM_COY,
  EM_BORED,
  EM_SCARED,
  EM_SAD,
  EM_ANGRY,
  EM_SHOUT,
  EM_LAUGH,
  EM_NEUTRAL,
  EM_WAVE,
  EM_POINTOTHER,
  EM_POINTSELF,
  EM_DOUBLEPOINT,
  EM_SHRUG,
} from './types';

export function subtractAngles(a1: number, a2: number): number {
  let diff = a1 - a2;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  return diff;
}

export interface DetectedEmotion {
  emotion: number;
  intensity: number;
  gesture?: number;
  balloonMode: BalloonMode;
  cleanText: string;
}

export class EmotionEngine {
  // Emotion names for UI display
  static readonly EMOTION_NAMES: { [key: number]: string } = {
    [EM_HAPPY]: 'Happy',
    [EM_COY]: 'Coy',
    [EM_BORED]: 'Bored',
    [EM_SCARED]: 'Scared',
    [EM_SAD]: 'Sad',
    [EM_ANGRY]: 'Angry',
    [EM_SHOUT]: 'Shout',
    [EM_LAUGH]: 'Laugh',
    [EM_WAVE]: 'Wave',
    [EM_POINTOTHER]: 'Point at other',
    [EM_POINTSELF]: 'Point at self',
    [EM_DOUBLEPOINT]: 'Double point',
    [EM_SHRUG]: 'Shrug',
  };

  static detectEmotionFromText(text: string): DetectedEmotion {
    let rawText = text.trim();
    let balloonMode: BalloonMode = 'say';

    // Check slash commands
    if (rawText.startsWith('/me ') || rawText.startsWith('/action ')) {
      balloonMode = 'action';
      rawText = rawText.replace(/^\/(me|action)\s+/, '');
    } else if (rawText.startsWith('/think ') || rawText.startsWith('/thought ')) {
      balloonMode = 'think';
      rawText = rawText.replace(/^\/(think|thought)\s+/, '');
    } else if (rawText.startsWith('/whisper ') || rawText.startsWith('/w ')) {
      balloonMode = 'whisper';
      rawText = rawText.replace(/^\/(whisper|w)\s+/, '');
    } else if (rawText.startsWith('/shout ')) {
      balloonMode = 'say';
      rawText = rawText.replace(/^\/shout\s+/, '');
      return {
        emotion: EM_SHOUT,
        intensity: 0.9,
        balloonMode,
        cleanText: rawText,
      };
    } else if (rawText.startsWith('/shrug')) {
      return {
        emotion: EM_SHRUG,
        intensity: 0.9,
        gesture: EM_SHRUG,
        balloonMode,
        cleanText: rawText.replace(/^\/shrug\s*/, '') || '*shrugs*',
      };
    } else if (rawText.startsWith('/wave')) {
      return {
        emotion: EM_WAVE,
        intensity: 0.9,
        gesture: EM_WAVE,
        balloonMode,
        cleanText: rawText.replace(/^\/wave\s*/, '') || '*waves*',
      };
    } else if (rawText.startsWith('/point')) {
      return {
        emotion: EM_POINTOTHER,
        intensity: 0.9,
        gesture: EM_POINTOTHER,
        balloonMode,
        cleanText: rawText.replace(/^\/point\s*/, '') || '*points*',
      };
    }

    const lower = rawText.toLowerCase();

    // Check All Caps (> 3 letters)
    const upperCount = (rawText.match(/[A-Z]/g) || []).length;
    const letterCount = (rawText.match(/[A-Za-z]/g) || []).length;
    if (letterCount >= 4 && upperCount / letterCount >= 0.8) {
      return {
        emotion: EM_SHOUT,
        intensity: 0.9,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Exclamations
    if (rawText.includes('!!!') || rawText.includes('!?!')) {
      return {
        emotion: EM_SHOUT,
        intensity: 0.85,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Laughs
    if (
      /\b(lol|rotfl|rofl|lmao|haha|hehe|xd)\b/i.test(rawText) ||
      rawText.includes(':-D') ||
      rawText.includes(':D')
    ) {
      return {
        emotion: EM_LAUGH,
        intensity: 0.85,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Greetings / Wave
    if (/^(hi|hello|hey|howdy|welcome|bye|goodbye|cya)\b/i.test(rawText)) {
      return {
        emotion: EM_WAVE,
        intensity: 0.9,
        gesture: EM_WAVE,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Point Other
    if (
      /^you\b/i.test(rawText) ||
      /\b(are you|will you|did you|aren't you|don't you|look at you)\b/i.test(lower)
    ) {
      return {
        emotion: EM_POINTOTHER,
        intensity: 0.8,
        gesture: EM_POINTOTHER,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Point Self
    if (
      /^i\b/i.test(rawText) ||
      /\b(i'm|i will|i'll|i am|me|myself)\b/i.test(lower)
    ) {
      return {
        emotion: EM_POINTSELF,
        intensity: 0.75,
        gesture: EM_POINTSELF,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Happy
    if (
      rawText.includes(':)') ||
      rawText.includes(':-)') ||
      rawText.includes('<3') ||
      /\b(happy|yay|awesome|great|cool|good|love|nice|congrats)\b/i.test(lower)
    ) {
      return {
        emotion: EM_HAPPY,
        intensity: 0.8,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Coy / Winking
    if (
      rawText.includes(';)') ||
      rawText.includes(';-)') ||
      /\b(wink|maybe|perhaps|shh|secret|coy)\b/i.test(lower)
    ) {
      return {
        emotion: EM_COY,
        intensity: 0.8,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Sad
    if (
      rawText.includes(':(') ||
      rawText.includes(':-(') ||
      rawText.includes(":'(") ||
      /\b(sad|sorry|sigh|unfortunately|unhappy|cry|crying|depressed|grief)\b/i.test(lower)
    ) {
      return {
        emotion: EM_SAD,
        intensity: 0.8,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Angry
    if (
      rawText.includes('>:(') ||
      rawText.includes('>:-(') ||
      /\b(angry|mad|furious|damn|grr|hate|shut up|annoying|rage)\b/i.test(lower)
    ) {
      return {
        emotion: EM_ANGRY,
        intensity: 0.85,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Scared / Surprised
    if (
      rawText.includes(':o') ||
      rawText.includes(':-o') ||
      rawText.includes(':O') ||
      /\b(scared|afraid|eek|yikes|omg|oh no|help|panic|danger)\b/i.test(lower)
    ) {
      return {
        emotion: EM_SCARED,
        intensity: 0.8,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Bored / Skeptical
    if (
      rawText.includes('-_-') ||
      rawText.includes(':|') ||
      /\b(bored|meh|boring|whatever|yawn|tired|sleepy)\b/i.test(lower)
    ) {
      return {
        emotion: EM_BORED,
        intensity: 0.7,
        balloonMode,
        cleanText: rawText,
      };
    }

    // Shrug / Confused
    if (
      rawText.startsWith('/shrug') ||
      rawText.includes('¯\\_(ツ)_/¯') ||
      /\b(idk|i don\'t know|dunno|who knows|shrug|no idea|confused)\b/i.test(lower)
    ) {
      return {
        emotion: EM_SHRUG,
        intensity: 0.85,
        gesture: EM_SHRUG,
        balloonMode,
        cleanText: rawText.replace(/^\/shrug\s*/, ''),
      };
    }

    // Default neutral
    return {
      emotion: EM_NEUTRAL,
      intensity: 0.0,
      balloonMode,
      cleanText: rawText,
    };
  }

  static getFaceAndTorso(
    avatar: AvatarData,
    targetEmotion: number,
    targetIntensity: number
  ): { face: FaceRecord; torso: TorsoRecord } | null {
    if (avatar.faces.length === 0 || avatar.torsos.length === 0) return null;

    let bestFace = avatar.faces[0];
    let bestTorso = avatar.torsos[0];

    if (targetEmotion >= 10) {
      // Special gesture (Wave, Point Self, Point Other, Shrug, etc.)
      const matchingTorso = avatar.torsos.find((t) => t.emotion === targetEmotion);
      if (matchingTorso) {
        bestTorso = matchingTorso;
      } else if (targetEmotion === EM_SHRUG) {
        // Fallback for avatars without explicit shrug torso
        const fallbackTorso =
          avatar.torsos.find((t) => Math.abs(subtractAngles(t.emotion, EM_BORED)) < 0.3) ||
          avatar.torsos.find((t) => Math.abs(subtractAngles(t.emotion, EM_COY)) < 0.3) ||
          avatar.torsos[0];
        bestTorso = fallbackTorso;
      }

      // Pick an expressive face matching the gesture
      if (targetEmotion === EM_WAVE) {
        bestFace =
          avatar.faces.find((f) => Math.abs(subtractAngles(f.emotion, EM_HAPPY)) < 0.2) ||
          avatar.faces.find((f) => f.emotion === EM_NEUTRAL && f.intensity === 0) ||
          avatar.faces[0];
      } else if (targetEmotion === EM_SHRUG) {
        bestFace =
          avatar.faces.find((f) => Math.abs(subtractAngles(f.emotion, EM_COY)) < 0.2) ||
          avatar.faces.find((f) => Math.abs(subtractAngles(f.emotion, EM_BORED)) < 0.2) ||
          avatar.faces[0];
      } else {
        // Pointing gestures
        bestFace =
          avatar.faces.find((f) => f.intensity > 0 && Math.abs(subtractAngles(f.emotion, EM_HAPPY)) < 0.5) ||
          avatar.faces[0];
      }
    } else {
      // Standard Emotion Wheel
      let nearestAngle = 3 * Math.PI;
      let intensityOfNearest = 2.0;

      for (let i = 0; i < avatar.faces.length; i++) {
        const face = avatar.faces[i];
        const thisAngle = Math.abs(subtractAngles(face.emotion, targetEmotion));
        if (thisAngle <= nearestAngle) {
          const deltaIntensity = Math.abs(targetIntensity - face.intensity);
          if (thisAngle === nearestAngle && deltaIntensity >= intensityOfNearest) {
            continue;
          }
          nearestAngle = thisAngle;
          intensityOfNearest = deltaIntensity;
          bestFace = face;
        }
      }

      // Find torso with closest emotion or neutral fallback
      intensityOfNearest = 2.0;
      for (let i = 0; i < avatar.torsos.length; i++) {
        const torso = avatar.torsos[i];
        if (torso.emotion >= 10) continue; // skip gestures for standard emotions
        const thisAngle = Math.abs(subtractAngles(torso.emotion, targetEmotion));
        if (
          thisAngle < Math.PI / 8 ||
          (torso.emotion === EM_NEUTRAL && torso.intensity === 0)
        ) {
          const deltaIntensity = Math.abs(targetIntensity - torso.intensity);
          if (deltaIntensity < intensityOfNearest) {
            intensityOfNearest = deltaIntensity;
            bestTorso = torso;
          }
        }
      }
    }

    return { face: bestFace, torso: bestTorso };
  }

  static getSimpleBody(
    avatar: AvatarData,
    targetEmotion: number,
    targetIntensity: number
  ): SimpleBodyRecord | null {
    if (avatar.bodies.length === 0) return null;

    if (targetEmotion >= 10) {
      const match = avatar.bodies.find((b) => b.emotion === targetEmotion);
      if (match) return match;
    }

    let nearestAngle = 3 * Math.PI;
    let intensityOfNearest = 2.0;
    let bestBody = avatar.bodies[0];

    for (let i = 0; i < avatar.bodies.length; i++) {
      const body = avatar.bodies[i];
      if (body.emotion > 7) continue;
      const thisAngle = Math.abs(subtractAngles(body.emotion, targetEmotion));
      const isNeutral = body.emotion === EM_NEUTRAL && body.intensity === 0;

      if (thisAngle < Math.PI / 8 || isNeutral) {
        const deltaIntensity = Math.abs(targetIntensity - body.intensity);
        if (deltaIntensity < intensityOfNearest) {
          nearestAngle = thisAngle;
          intensityOfNearest = deltaIntensity;
          bestBody = body;
        }
      }
    }

    return bestBody;
  }
}
