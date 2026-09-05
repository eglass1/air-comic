import { DecodedImage } from './types';

/**
 * Earl wears Armando's body, so his torso artwork is derived from it at load
 * time rather than shipped as a second copy of the same nine bitmaps.
 *
 * Two changes turn Armando into Earl from the neck down:
 *  - his sandals become plain black shoes, and
 *  - a white bolo tie hangs under the collar.
 *
 * Everything works on the decoded 1-bit artwork: every pixel is opaque black,
 * opaque white, or transparent, and the silhouette carries a white knockout
 * aura. The helpers below stay inside that vocabulary so the result composites
 * exactly like the original art.
 */

const CLEAR = 0;
const INK = 1;
const PAPER = 2;

/** Width of the white knockout aura the avatars carry around their silhouette. */
const AURA_WIDTH = 5;

/**
 * The ankle line for each of Armando's torso poses: the shoe drawing lies
 * entirely below it. Read off the artwork -- pose 19 is mid-stride, so its
 * lifted foot sits highest.
 */
const ANKLE_Y: Record<number, number> = {
  11: 262,
  12: 264,
  13: 265,
  14: 238,
  15: 264,
  16: 250,
  17: 254,
  18: 258,
  19: 228,
};

/**
 * Where the bolo's slide hangs, as an offset from the torso's neck anchor.
 * Uniform except for pose 14, which is close to a profile: there the tie rides
 * the one edge of the chest that is actually facing us.
 */
const BOLO_OFFSET: Record<number, { dx: number; dy: number }> = {
  11: { dx: 0, dy: 58 },
  12: { dx: 0, dy: 58 },
  13: { dx: 0, dy: 58 },
  14: { dx: -11, dy: 52 },
  15: { dx: 0, dy: 58 },
  16: { dx: 0, dy: 58 },
  17: { dx: 0, dy: 58 },
  18: { dx: 0, dy: 58 },
  19: { dx: 0, dy: 58 },
};

/**
 * The steer skull that slides on the cord, drawn at the artwork's own
 * resolution: '#' is white, '.' is left as jacket black, so the gaps read as
 * the sweep of the horns and the eye sockets.
 */
const SKULL = [
  '##.............##',
  '###...........###',
  '.####.......####.',
  '..#############..',
  '.###############.',
  '.###############.',
  '.###.#######.###.',
  '.###############.',
  '..#############..',
  '...###########...',
  '....#########....',
  '......#####......',
];

const CORD_SPREAD_TOP = 5; // half-width where the cords leave the slide
const CORD_SPREAD_BOTTOM = 13; // half-width where they reach the tips
const CORD_DROP = 32; // how far the cords fall below the slide
const TIP_LEN = 8; // length of the metal tips
const TIE_EDGE_MARGIN = 4; // keep the tie this far inside the silhouette

const NEIGHBOURS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const NEIGHBOURS_8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** RGBA pixels -> one byte per pixel: transparent, black or white. */
function toCells(img: DecodedImage): Uint8Array {
  const cells = new Uint8Array(img.width * img.height);
  for (let i = 0; i < cells.length; i++) {
    const p = i * 4;
    if (img.data[p + 3] < 128) cells[i] = CLEAR;
    else cells[i] = img.data[p] < 128 ? INK : PAPER;
  }
  return cells;
}

function toImage(cells: Uint8Array, width: number, height: number): DecodedImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < cells.length; i++) {
    const p = i * 4;
    if (cells[i] === CLEAR) continue;
    const v = cells[i] === PAPER ? 255 : 0;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  return { width, height, data };
}

/** Opaque pixels the background can reach without crossing ink -- the aura. */
function reachableFromOutside(cells: Uint8Array, W: number, H: number): Uint8Array {
  const seen = new Uint8Array(cells.length);
  const queue: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * W + x;
    if (!seen[i] && cells[i] !== INK) {
      seen[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    push(0, y);
    push(W - 1, y);
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy] of NEIGHBOURS_4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) push(nx, ny);
    }
  }
  return seen;
}

/** Chebyshev distance from every pixel to the nearest transparent one. */
function depthFromClear(cells: Uint8Array, W: number, H: number): Int32Array {
  const dist = new Int32Array(cells.length).fill(0x7fffffff);
  const queue: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === CLEAR) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    const x = i % W;
    const y = (i / W) | 0;
    const d = dist[i] + 1;
    for (const [dx, dy] of NEIGHBOURS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] > d) {
        dist[ni] = d;
        queue.push(ni);
      }
    }
  }
  return dist;
}

/**
 * Turn the sandal-and-bare-foot drawing into a solid black shoe by flooding the
 * white the shoe outline encloses.
 */
function blackenFeet(cells: Uint8Array, W: number, H: number, ankleY: number): void {
  const outside = reachableFromOutside(cells, W, H);
  const dist = depthFromClear(cells, W, H);

  // White that is either walled in by ink, or too far from the background to be
  // aura. The second test catches the toe pockets, where a break in the sandal
  // outline lets the aura leak into the foot.
  const isFill = (i: number) =>
    cells[i] === PAPER && (!outside[i] || dist[i] > AURA_WIDTH);

  const seen = new Uint8Array(cells.length);
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || !isFill(start)) continue;
    const blob: number[] = [start];
    seen[start] = 1;
    let sumY = 0;
    for (let head = 0; head < blob.length; head++) {
      const i = blob[head];
      const x = i % W;
      const y = (i / W) | 0;
      sumY += y;
      for (const [dx, dy] of NEIGHBOURS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && isFill(ni)) {
          seen[ni] = 1;
          blob.push(ni);
        }
      }
    }
    // A pant-leg highlight can dip past the ankle line, so judge a blob by where
    // its bulk sits rather than by how far down it reaches.
    if (sumY / blob.length >= ankleY) {
      for (const i of blob) cells[i] = INK;
    }
  }
}

/**
 * Stamp the bolo tie with its slide centred on (ax, ay), hanging along
 * `angleDeg` (clockwise from straight down) so it can follow a leaning torso.
 */
function drawBolo(
  cells: Uint8Array,
  W: number,
  H: number,
  ax: number,
  ay: number,
  angleDeg: number
): void {
  const dist = depthFromClear(cells, W, H);
  const th = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  /** Tie-space (across, down) -> pixel, painted only where it lands on jacket. */
  const place = (u: number, v: number) => {
    // floor(t + 0.5), not Math.round on a negative half: keep the sprite's rows
    // evenly spaced either side of the anchor.
    const x = Math.floor(ax + u * cos - v * sin + 0.5);
    const y = Math.floor(ay + u * sin + v * cos + 0.5);
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = y * W + x;
    if (cells[i] === INK && dist[i] >= TIE_EDGE_MARGIN) cells[i] = PAPER;
  };

  const disc = (u: number, v: number, r: number) => {
    const steps = Math.max(1, Math.trunc(r * 2));
    for (let i = -steps; i <= steps; i++) {
      for (let j = -steps; j <= steps; j++) {
        if ((i / 2) ** 2 + (j / 2) ** 2 <= r * r) place(u + i / 2, v + j / 2);
      }
    }
  };

  const stroke = (u0: number, v0: number, u1: number, v1: number, r: number) => {
    const n = Math.trunc(Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0)) * 3) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      disc(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, r);
    }
  };

  const sw = SKULL[0].length;
  const sh = SKULL.length;
  for (let row = 0; row < sh; row++) {
    for (let col = 0; col < sw; col++) {
      if (SKULL[row][col] === '#') {
        place(col - (sw >> 1), row - (sh >> 1));
      }
    }
  }

  const top = sh - (sh >> 1) - 2;
  const bottom = top + CORD_DROP;
  for (const side of [-1, 1]) {
    stroke(side * CORD_SPREAD_TOP, top, side * CORD_SPREAD_BOTTOM, bottom, 0.9);
    stroke(
      side * CORD_SPREAD_BOTTOM,
      bottom,
      side * CORD_SPREAD_BOTTOM,
      bottom + TIP_LEN,
      1.5
    );
  }
}

/** True if this pose of Armando's has an Earl variant to derive. */
export function isEarlTorsoPose(poseID: number): boolean {
  return poseID in ANKLE_Y;
}

/**
 * Earl's version of one of Armando's torso drawings: black shoes instead of
 * sandals, plus the bolo tie. `neckX`/`neckY` are the pose's head-attach point,
 * which the tie is positioned against.
 */
export function earlTorso(
  source: DecodedImage,
  poseID: number,
  neckX: number,
  neckY: number
): DecodedImage {
  const { width: W, height: H } = source;
  const cells = toCells(source);
  blackenFeet(cells, W, H, ANKLE_Y[poseID]);
  const offset = BOLO_OFFSET[poseID];
  drawBolo(cells, W, H, neckX + offset.dx, neckY + offset.dy, 0);
  return toImage(cells, W, H);
}
