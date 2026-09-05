/**
 * Word-balloon outline construction, ported from Microsoft Comic Chat's
 * balloon.cpp (the CBWoodring* classes) and spline.cpp.
 *
 * The original works in MM_TWIPS with y pointing up. This module keeps that
 * convention in its own local space — origin at the top-left of the text block,
 * y decreasing downwards — so the geometry can be ported line for line. The
 * caller flips y when mapping into canvas pixels.
 *
 * Constants are the originals divided by 15 (1440 twips/inch over 96 px/inch),
 * which lines up because the original's 180-twip balloon font is our 12px one.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface SRect {
  left: number;
  bottom: number;
  right: number;
  top: number;
}

// balloon.cpp, in pixels.
export const XBORDER = 6.67;
export const YBORDER = 2.67;
export const TOPBORDER = -1.33;
export const THRESH1 = -4.67;
export const THRESH2 = 4.67;
export const HWAVEHEIGHT = 4.67;
export const HWAVEINTERVAL = 20;
export const VWAVEHEIGHT = 4.67;
export const VWAVEINTERVAL = 20;
export const XBOXDELTA = 6;
export const YBOXDELTA = 3.33;
export const BUBBLEHEIGHT = 10;
export const INTERBUBBLE = 6.67;
export const ENDBUBBLEWIDTH = 26.67;
export const MINTAILHEIGHT = 6.67;
export const SMALLDELTA = 10;
export const LARGEDELTA = 23.33;
export const TAIL_GAP_HALF = 5.33;
export const MAXLINES = 10;

// ---------------------------------------------------------------------------
// Beta spline (spline.cpp CBeta, tension 5.0, bias 1.0)

type Matrix = number[][];

function betaMatrix(tension: number, bias: number): Matrix {
  const b2 = bias * bias;
  const b3 = bias * b2;
  const d = 1.0 / (tension + 2.0 * b3 + 4.0 * (b2 + bias) + 2.0);
  const m: Matrix = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  m[0][0] = -2.0 * b3;
  m[0][1] = 2.0 * (tension + b3 + b2 + bias);
  m[0][2] = -2.0 * (tension + b2 + bias + 1.0);
  m[1][0] = 6.0 * b3;
  m[1][1] = -3.0 * (tension + 2.0 * (b3 + b2));
  m[1][2] = 3.0 * (tension + 2.0 * b2);
  m[2][0] = -6.0 * b3;
  m[2][1] = 6.0 * (b3 - bias);
  m[2][2] = 6.0 * bias;
  m[3][0] = 2.0 * b3;
  m[3][1] = tension + 4.0 * (b2 + bias);
  m[0][3] = m[3][2] = 2.0;
  m[1][3] = m[2][3] = m[3][3] = 0.0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[i][j] *= d;
  return m;
}

const BETA_MATRIX = betaMatrix(5.0, 1.0);

export class BetaSpline {
  cps: Pt[];
  closed: boolean;
  bezpts: Pt[] = [];

  constructor(cps: Pt[], closed: boolean) {
    this.cps = cps.map((p) => ({ ...p }));
    this.closed = closed;
    this.computeBezpts();
  }

  /** CSpline::KnotCount — beta splines triple up the endpoints when open. */
  private knotCount(): number {
    return this.closed ? this.cps.length + 3 : this.cps.length + 4;
  }

  private getKnot(index: number): Pt {
    const n = this.cps.length;
    if (this.closed) {
      if (index === 0) return this.cps[n - 1];
      if (index === n + 1) return this.cps[0];
      if (index === n + 2) return this.cps[1];
      return this.cps[index - 1];
    }
    const dups = 3;
    if (index < dups) return this.cps[0];
    if (index >= n + dups - 2) return this.cps[n - 1];
    return this.cps[index - dups + 1];
  }

  private computeBezpts(): void {
    const nKnots = this.knotCount();
    const bez: Pt[] = [];
    const m = BETA_MATRIX;
    if (this.cps.length < 2) {
      this.bezpts = [];
      return;
    }
    let k0 = this.getKnot(0);
    let k1 = this.getKnot(1);
    let k2 = this.getKnot(2);
    let k3 = this.getKnot(3);
    for (let i = 0; ; i++) {
      // CvertsToCubic, then CubicToBezier.
      const c3 = {
        x: m[0][0] * k0.x + m[0][1] * k1.x + m[0][2] * k2.x + m[0][3] * k3.x,
        y: m[0][0] * k0.y + m[0][1] * k1.y + m[0][2] * k2.y + m[0][3] * k3.y,
      };
      const c2 = {
        x: m[1][0] * k0.x + m[1][1] * k1.x + m[1][2] * k2.x + m[1][3] * k3.x,
        y: m[1][0] * k0.y + m[1][1] * k1.y + m[1][2] * k2.y + m[1][3] * k3.y,
      };
      const c1 = {
        x: m[2][0] * k0.x + m[2][1] * k1.x + m[2][2] * k2.x + m[2][3] * k3.x,
        y: m[2][0] * k0.y + m[2][1] * k1.y + m[2][2] * k2.y + m[2][3] * k3.y,
      };
      const c0 = {
        x: m[3][0] * k0.x + m[3][1] * k1.x + m[3][2] * k2.x + m[3][3] * k3.x,
        y: m[3][0] * k0.y + m[3][1] * k1.y + m[3][2] * k2.y + m[3][3] * k3.y,
      };
      const b0 = c0;
      const b1 = { x: c0.x + c1.x / 3, y: c0.y + c1.y / 3 };
      const b2 = { x: b1.x + (c1.x + c2.x) / 3, y: b1.y + (c1.y + c2.y) / 3 };
      const b3 = { x: c0.x + c1.x + c2.x + c3.x, y: c0.y + c1.y + c2.y + c3.y };
      if (i === 0) bez.push(b0);
      bez.push(b1, b2, b3);
      if (i + 4 === nKnots) break;
      k0 = k1;
      k1 = k2;
      k2 = k3;
      k3 = this.getKnot(i + 4);
    }
    this.bezpts = bez;
  }

  /** Bounding box over the control points (CBalloon::ComputeCloudBBox). */
  controlBounds(): SRect {
    const r: SRect = { left: Infinity, right: -Infinity, top: -Infinity, bottom: Infinity };
    for (const p of this.cps) {
      r.left = Math.min(r.left, p.x);
      r.right = Math.max(r.right, p.x);
      r.top = Math.max(r.top, p.y);
      r.bottom = Math.min(r.bottom, p.y);
    }
    return r;
  }

  /** Closest point on the curve to `toPt`, plus the segment it lies on. */
  closestPoint(toPt: Pt): { point: Pt; segment: number } {
    let minDist = Infinity;
    let best: Pt = this.bezpts[0] ?? { x: 0, y: 0 };
    let bestSeg = 0;
    for (let i = 0, seg = 0; i + 3 < this.bezpts.length; i += 3, seg++) {
      const STEPS = 24;
      for (let s = 0; s <= STEPS; s++) {
        const p = bezierAt(this.bezpts, i, s / STEPS);
        const d = Math.abs(p.x - toPt.x) + Math.abs(p.y - toPt.y);
        if (d < minDist) {
          minDist = d;
          best = p;
          bestSeg = seg;
        }
      }
    }
    return { point: best, segment: bestSeg };
  }

  /** CSpline::WalkHorizontalDistance — walk forward until x reaches goalX. */
  walkHorizontalDistance(fromSegment: number, goalX: number): { point: Pt; segment: number } {
    const nSegments = Math.max(1, Math.floor((this.bezpts.length - 1) / 3));
    let furthest: Pt = { x: -Infinity, y: 0 };
    let furthestSeg = fromSegment;
    for (let n = 0; n < nSegments; n++) {
      const seg = (fromSegment + n) % nSegments;
      const base = seg * 3;
      const STEPS = 24;
      for (let s = 0; s <= STEPS; s++) {
        const p = bezierAt(this.bezpts, base, s / STEPS);
        if (p.x >= goalX) return { point: p, segment: seg };
        if (p.x > furthest.x) {
          furthest = p;
          furthestSeg = seg;
        }
      }
    }
    return { point: furthest, segment: furthestSeg };
  }

  /** Append to a canvas path. `tx` maps local points into canvas pixels. */
  addToPath(
    ctx: CanvasRenderingContext2D,
    tx: (p: Pt) => [number, number],
    moveToFirst: boolean
  ): void {
    const b = this.bezpts;
    if (b.length < 4) return;
    if (moveToFirst) ctx.moveTo(...tx(b[0]));
    else ctx.lineTo(...tx(b[0]));
    for (let i = 1; i + 2 < b.length; i += 3) {
      ctx.bezierCurveTo(...tx(b[i]), ...tx(b[i + 1]), ...tx(b[i + 2]));
    }
  }
}

function bezierAt(bez: Pt[], base: number, t: number): Pt {
  const p0 = bez[base];
  const p1 = bez[base + 1];
  const p2 = bez[base + 2];
  const p3 = bez[base + 3];
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// ---------------------------------------------------------------------------
// The staircase outline (GetFilters / PermuteFilters)

/** Metrics the outline builder needs from the balloon font. */
export interface BalloonFontMetrics {
  lineHeight: number;
  /** Half the external leading, added above the first line. */
  topOffset: number;
  /** Comic Sans' vertical kern, added below a line that steps inward. */
  baseAdd: number;
}

export interface BalloonFormatInfo {
  /** Width of each wrapped line. */
  widths: number[];
  /** Left edge of each line within the wrap box. */
  leftX: number[];
  nLines: number;
  /** Text block: left 0, top 0, right wrapWidth, bottom -nLines*lineHeight. */
  bbox: SRect;
}

interface Range {
  x: number;
  y: number;
  start: number;
  end: number;
}

/**
 * Group the lines into runs whose edges are close enough to share one vertical
 * side, producing the staircase the balloon outline is drawn around. A step is
 * only taken when a line's edge moves outward past THRESH2, or inward past
 * THRESH1 with the following line agreeing.
 */
function getFilters(fInfo: BalloonFormatInfo): { l: Range[]; r: Range[] } {
  const l: Range[] = [{ x: fInfo.leftX[0], y: 0, start: 0, end: 0 }];
  const r: Range[] = [{ x: fInfo.leftX[0] + fInfo.widths[0], y: 0, start: 0, end: 0 }];

  for (let i = 1; i < fInfo.nLines; i++) {
    const thisLeft = fInfo.leftX[i];
    const thisRight = fInfo.leftX[i] + fInfo.widths[i];
    const lTop = l[l.length - 1];
    const rTop = r[r.length - 1];
    const leftDelta = thisLeft - lTop.x;
    const rightDelta = thisRight - rTop.x;

    if (leftDelta <= THRESH1) {
      lTop.end = i - 1;
      l.push({ x: thisLeft, y: 0, start: i, end: i });
    } else if (leftDelta <= 0) {
      lTop.x = thisLeft;
    } else if (leftDelta >= THRESH2) {
      const nextLeft = i + 1 < fInfo.nLines ? fInfo.leftX[i + 1] : thisLeft;
      if (nextLeft - lTop.x >= THRESH2) {
        lTop.end = i - 1;
        l.push({ x: Math.min(thisLeft, nextLeft), y: 0, start: i, end: i });
      }
    }

    if (rightDelta >= -THRESH1) {
      rTop.end = i - 1;
      r.push({ x: thisRight, y: 0, start: i, end: i });
    } else if (rightDelta >= 0) {
      rTop.x = thisRight;
    } else if (rightDelta <= -THRESH2) {
      const nextRight =
        i + 1 < fInfo.nLines ? fInfo.leftX[i + 1] + fInfo.widths[i + 1] : thisRight;
      if (nextRight - rTop.x <= -THRESH2) {
        rTop.end = i - 1;
        r.push({ x: Math.max(thisRight, nextRight), y: 0, start: i, end: i });
      }
    }
  }

  l[l.length - 1].end = fInfo.nLines - 1;
  r[r.length - 1].end = fInfo.nLines - 1;
  return { l, r };
}

/** Push each run out by the borders and assign it a y, returning the final y. */
function permuteFilters(font: BalloonFontMetrics, l: Range[], r: Range[]): number {
  const LARGE = 1e9;
  let baseY = 0;
  let lastX = LARGE;
  for (let i = 0; i < l.length; i++) {
    l[i].x -= XBORDER;
    if (i === 0) l[i].y = baseY + TOPBORDER + YBORDER + font.topOffset;
    else if (l[i].x < lastX) l[i].y = baseY + YBORDER;
    else l[i].y = baseY - YBORDER - font.baseAdd;
    baseY -= (l[i].end - l[i].start + 1) * font.lineHeight;
    lastX = l[i].x;
  }

  baseY = 0;
  lastX = -LARGE;
  for (let i = 0; i < r.length; i++) {
    r[i].x += XBORDER;
    if (i === 0) r[i].y = baseY + TOPBORDER + YBORDER + font.topOffset;
    else if (r[i].x > lastX) r[i].y = baseY + YBORDER;
    else r[i].y = baseY - YBORDER - font.baseAdd;
    baseY -= (r[i].end - r[i].start + 1) * font.lineHeight;
    lastX = r[i].x;
  }
  return baseY - TOPBORDER - YBORDER - font.baseAdd;
}

/** Scallop a straight run, which is what gives the outline its hand-drawn edge. */
function addWavies(pt1: Pt, pt2: Pt, pts: Pt[], waveDiam: number, interval: number): void {
  const dist = Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y);
  const nWaves = dist / interval;
  if (nWaves < 2) return;
  const iWaves = Math.floor(nWaves);
  const waveLen = dist / iWaves;
  const ux = (pt2.x - pt1.x) / dist;
  const uy = (pt2.y - pt1.y) / dist;
  const incX = waveLen * ux;
  const incY = waveLen * uy;
  const exX = waveDiam * uy; // normal is (uy, -ux)
  const exY = waveDiam * -ux;
  let bx = pt1.x;
  let by = pt1.y;
  for (let i = 0; i < iWaves - 1; i++) {
    bx += incX;
    by += incY;
    if (!(i & 1)) pts.push({ x: bx + exX, y: by + exY });
    else pts.push({ x: bx, y: by });
  }
}

/** CBWoodringNormal::CreateBalloonSpline */
export function createBalloonSpline(
  fInfo: BalloonFormatInfo,
  font: BalloonFontMetrics
): BetaSpline {
  const { l, r } = getFilters(fInfo);
  const finalY = permuteFilters(font, l, r);
  const pts: Pt[] = [];
  let lastY = finalY;

  for (let i = 0; i < l.length; i++) {
    const thisPoint = { x: l[i].x, y: l[i].y };
    if (i > 0) addWavies(pts[pts.length - 1], thisPoint, pts, HWAVEHEIGHT, HWAVEINTERVAL);
    pts.push(thisPoint);
    const nextPoint = { x: l[i].x, y: i === l.length - 1 ? finalY : l[i + 1].y };
    addWavies(pts[pts.length - 1], nextPoint, pts, VWAVEHEIGHT, VWAVEINTERVAL);
    pts.push(nextPoint);
  }
  for (let i = r.length - 1; i >= 0; i--) {
    const thisPoint = { x: r[i].x, y: lastY };
    addWavies(pts[pts.length - 1], thisPoint, pts, HWAVEHEIGHT, HWAVEINTERVAL);
    pts.push(thisPoint);
    lastY = r[i].y;
    const nextPoint = { x: r[i].x, y: lastY };
    addWavies(pts[pts.length - 1], nextPoint, pts, VWAVEHEIGHT, VWAVEINTERVAL);
    pts.push(nextPoint);
  }
  addWavies(pts[pts.length - 1], pts[0], pts, HWAVEHEIGHT, HWAVEINTERVAL);
  return new BetaSpline(pts, true);
}

// ---------------------------------------------------------------------------
// Tail construction

/**
 * BreakSpline: open a gap in the closed outline around x, and return the opened
 * spline with its control points rotated to start just right of the gap.
 */
export function breakSpline(spline: BetaSpline, x: number, y: number): BetaSpline {
  const gap = TAIL_GAP_HALF;
  const { point: leftNearest, segment: leftSeg } = spline.closestPoint({ x: x - gap, y });
  const walked = spline.walkHorizontalDistance(leftSeg, leftNearest.x + 2 * gap);
  const rightNearest = walked.point;
  const rightSeg = walked.segment;

  // A closed spline's segment s is driven by control point s+1, so the run that
  // survives starts just past the right lip of the gap and wraps all the way
  // round to the left lip.
  const nCps = spline.cps.length;
  const spanned = (rightSeg - leftSeg + nCps) % nCps;
  const keep = Math.max(2, nCps - spanned);

  const newCps: Pt[] = [{ x: rightNearest.x, y: rightNearest.y }];
  for (let i = 0; i < keep; i++) {
    newCps.push({ ...spline.cps[(rightSeg + 1 + i) % nCps] });
  }
  newCps.push({ x: leftNearest.x, y: leftNearest.y });
  return new BetaSpline(newCps, false);
}

/** arc.cpp DrawArc2: an arc from start to end bowing out by `altitude`. */
export function arcPoints(start: Pt, end: Pt, altitude: number, out: Pt[]): void {
  if (altitude > -0.5 && altitude < 0.5) {
    out.push(end);
    return;
  }
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const e2m = { x: mid.x - end.x, y: mid.y - end.y };
  const e2mDist = Math.hypot(e2m.x, e2m.y);
  if (e2mDist < 0.5) {
    out.push(end);
    return;
  }
  const radius = (e2mDist * e2mDist + altitude * altitude) / (2 * altitude);
  const midToCenterDist = radius - altitude;
  let mc = { x: e2m.y, y: -e2m.x };
  const mcLen = Math.hypot(mc.x, mc.y) || 1;
  mc = { x: (mc.x * midToCenterDist) / mcLen, y: (mc.y * midToCenterDist) / mcLen };
  const center = { x: mid.x + mc.x, y: mid.y + mc.y };
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  let a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const ccw = altitude > 0;
  if (ccw && a1 < a0) a1 += 2 * Math.PI;
  if (!ccw && a1 > a0) a1 -= 2 * Math.PI;
  const R = Math.abs(radius);
  const steps = Math.max(4, Math.ceil((Math.abs(a1 - a0) * R) / 8));
  for (let s = 1; s <= steps; s++) {
    const a = a0 + ((a1 - a0) * s) / steps;
    out.push({ x: center.x + Math.cos(a) * R, y: center.y + Math.sin(a) * R });
  }
}

/** Everything drawing needs about a balloon's shape, built once at layout time. */
export interface BalloonOutline {
  spline: BetaSpline;
  fInfo: BalloonFormatInfo;
  /** Control-point bounds in local space (origin at the text block's top-left). */
  trueBox: SRect;
  font: BalloonFontMetrics;
}

/**
 * Wrap-independent outline build: given the measured line widths, produce the
 * spline and the box it occupies. Mirrors CBalloon::ComputeInternals.
 */
export function buildBalloonOutline(
  widths: number[],
  font: BalloonFontMetrics
): BalloonOutline {
  const maxWidth = Math.max(...widths, 1);
  const leftX = widths.map((w) => Math.floor((maxWidth - w) / 2));
  const fInfo: BalloonFormatInfo = {
    widths,
    leftX,
    nLines: widths.length,
    bbox: { left: 0, top: 0, right: maxWidth, bottom: -widths.length * font.lineHeight },
  };
  const spline = createBalloonSpline(fInfo, font);
  return { spline, fInfo, trueBox: spline.controlBounds(), font };
}
