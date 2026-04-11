/**
 * Sagittal osteotomy engine — anterior-closing tibial slope correction.
 *
 * Provides two functions:
 *  1. computeSagittalCorrection — pure math: rotate plateau around hinge,
 *     recompute slope against the unchanged shaft axis.
 *  2. drawSagittalSimulation   — canvas rendering: pixel-level bone rotation
 *     identical in algorithm to drawOsteotomySimulation (frontal system).
 *
 * Design rule: the proximal (plateau) segment is the moving fragment.
 *              the distal (shaft) segment is stationary.
 */

import type { Point } from "../types";
import type { SlopePoints, SagittalOsteotomy } from "./types";
import { computeSlope } from "./calculation";
import {
  extendLine,
  halfPlaneRect,
  cross2d,
  applyClip,
} from "../osteotomy/simulation";

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

export interface SagittalResult {
  /** Rotated first plateau point. */
  correctedP1: Point;
  /** Rotated second plateau point. */
  correctedP2: Point;
  /** Recomputed slope after rotation (degrees). */
  correctedSlope: number;
  /** correctedSlope − originalSlope. Negative = slope reduced. */
  delta: number;
}

/** Rotate `pt` around `center` by `angleDeg` (image coords: y-down, CW positive). */
export function rotatePointSag(pt: Point, center: Point, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = pt.x - center.x;
  const dy = pt.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * Compute the post-correction slope.
 *
 * Only the plateau tangent rotates around the hinge.
 * The shaft axis (cortex-pair midpoints) stays fixed.
 * Sign convention: negative correctionDeg reduces posterior slope.
 */
export function computeSagittalCorrection(
  slopePts: SlopePoints,
  hingePoint: Point,
  correctionDeg: number,
): SagittalResult | null {
  const { plateauP1, plateauP2 } = slopePts;
  if (!plateauP1 || !plateauP2) return null;

  const originalSlope = computeSlope(slopePts);

  const correctedP1 = rotatePointSag(plateauP1, hingePoint, correctionDeg);
  const correctedP2 = rotatePointSag(plateauP2, hingePoint, correctionDeg);

  const correctedPts: SlopePoints = {
    ...slopePts,
    plateauP1: correctedP1,
    plateauP2: correctedP2,
  };

  return {
    correctedP1,
    correctedP2,
    correctedSlope: computeSlope(correctedPts),
    delta: computeSlope(correctedPts) - originalSlope,
  };
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

/**
 * Draw the sagittal osteotomy simulation onto the canvas.
 *
 * Algorithm is identical to drawOsteotomySimulation (frontal system):
 *  1. Extend the cut line to canvas bounds.
 *  2. Classify which side is the moving fragment using the plateau midpoint.
 *  3. Draw stationary fragment (distal / shaft side) clipped to its half-plane.
 *  4. Apply rotation CTM around the hinge, draw moving fragment clipped to
 *     its original half-plane.
 *  5. Fill the wedge gap for an opening wedge.
 *
 * Call this instead of ctx.drawImage() in the main draw loop.
 */
export function drawSagittalSimulation(
  ctx: CanvasRenderingContext2D,
  drawFn: (ctx: CanvasRenderingContext2D) => void,
  ost: SagittalOsteotomy,
  slopePts: SlopePoints,
  s: number, ox: number, oy: number,
): void {
  const { hingePoint: hinge, cutP1, cutP2, correctionDeg: cdeg } = ost;
  if (!hinge || !cutP1 || !cutP2) {
    drawFn(ctx);
    return;
  }

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const toC = (p: Point) => ({ x: p.x * s + ox, y: p.y * s + oy });

  const cc1    = toC(cutP1);
  const cc2    = toC(cutP2);
  const cHinge = toC(hinge);

  const [extA, extB] = extendLine(cc1, cc2, W, H);

  // Proximal (plateau) side = moving fragment.
  // Use plateau midpoint to determine which half-plane contains it.
  let movingSign = 1;
  const { plateauP1, plateauP2 } = slopePts;
  if (plateauP1 && plateauP2) {
    const platMid = toC({
      x: (plateauP1.x + plateauP2.x) / 2,
      y: (plateauP1.y + plateauP2.y) / 2,
    });
    movingSign = cross2d(extA, extB, platMid) >= 0 ? 1 : -1;
  }
  const stationarySign = -movingSign;

  const stationaryPoly = halfPlaneRect(extA, extB, stationarySign, W, H);
  const movingPoly     = halfPlaneRect(extA, extB, movingSign,     W, H);

  // ── Step 1: Stationary fragment (distal / shaft side) ──────────────────
  ctx.save();
  applyClip(ctx, stationaryPoly);
  drawFn(ctx);
  ctx.restore();

  // ── Step 2: Moving fragment (proximal / plateau side) with rotation ─────
  ctx.save();
  if (cdeg !== 0) {
    ctx.translate(cHinge.x, cHinge.y);
    ctx.rotate((cdeg * Math.PI) / 180);
    ctx.translate(-cHinge.x, -cHinge.y);
  }
  applyClip(ctx, movingPoly);
  drawFn(ctx);
  ctx.restore();

  // ── Step 3: Wedge gap fill ──────────────────────────────────────────────
  // For an opening wedge the gap appears between original and rotated cut
  // surfaces. Fill with dark tone to simulate the open bone gap.
  // For a closing wedge the overlap composites naturally.
  if (cdeg !== 0) {
    const d1   = Math.hypot(cc1.x - cHinge.x, cc1.y - cHinge.y);
    const d2   = Math.hypot(cc2.x - cHinge.x, cc2.y - cHinge.y);
    const free = d1 >= d2 ? cc1 : cc2;

    const rad = (cdeg * Math.PI) / 180;
    const fx  = free.x - cHinge.x;
    const fy  = free.y - cHinge.y;
    const rotFree = {
      x: Math.cos(rad) * fx - Math.sin(rad) * fy + cHinge.x,
      y: Math.sin(rad) * fx + Math.cos(rad) * fy + cHinge.y,
    };

    const gapSide       = cross2d(cHinge, free, rotFree);
    const isOpeningWedge = gapSide * movingSign > 0;

    if (isOpeningWedge) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cHinge.x, cHinge.y);
      ctx.lineTo(free.x,   free.y);
      ctx.lineTo(rotFree.x, rotFree.y);
      ctx.closePath();
      ctx.fillStyle   = "rgba(12, 8, 0, 0.80)";
      ctx.fill();
      ctx.strokeStyle = "rgba(249, 115, 22, 0.55)";
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }
}
