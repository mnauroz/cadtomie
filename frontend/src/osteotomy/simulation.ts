/**
 * Image-space osteotomy simulation.
 *
 * Cuts the radiograph along the osteotomy line and rotates the moving
 * bone fragment around the hinge point using canvas 2-D transforms.
 *
 * Algorithm
 * ---------
 * 1. Extend the osteotomy line to canvas bounds.
 * 2. Classify which canvas half is stationary vs. moving using the
 *    reference landmark that belongs to the moving fragment
 *    (ankle for HTO, knee for DFO).
 * 3. Draw the stationary fragment clipped to its half-plane (no transform).
 * 4. Apply a rotation CTM around the hinge and draw the moving fragment
 *    clipped to its original half-plane.  Because the canvas clip is
 *    specified in post-CTM local coordinates, the clip rotates with the
 *    image — showing only pixels that originated in the moving half at
 *    their new rotated screen positions.
 * 5. Fill the wedge gap (opening wedge) or let the overlap composite
 *    naturally (closing wedge).
 *
 * Coordinate system: image coords, x right, y DOWN. Positive angle = CW.
 */

import type { Landmarks, Point } from "../types";
import type { OsteotomyPlan } from "./types";

type Pt = { x: number; y: number };

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

/** Signed 2-D cross product of (b-a) × (p-a). Positive = left of a→b. */
export function cross2d(a: Pt, b: Pt, p: Pt): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/** Intersection of infinite lines through (p1,p2) and (p3,p4). */
function lineLineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const denom =
    (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(denom) < 1e-9) return null;
  const t =
    ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * Extend segment p1→p2 far beyond the canvas so the direction is
 * preserved but endpoints lie well outside [0,W]×[0,H].
 */
export function extendLine(p1: Pt, p2: Pt, W: number, H: number): [Pt, Pt] {
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const d = Math.max(W, H) * 10;
  const ux = (p2.x - p1.x) / len;
  const uy = (p2.y - p1.y) / len;
  return [
    { x: p1.x - ux * d, y: p1.y - uy * d },
    { x: p1.x + ux * d, y: p1.y + uy * d },
  ];
}

/**
 * Sutherland-Hodgman clip of a convex polygon against a single half-plane.
 * "Inside" = cross2d(a, b, p) * sign >= 0.
 */
export function clipPolygonToHalfPlane(
  polygon: Pt[],
  a: Pt,
  b: Pt,
  sign: number,
): Pt[] {
  if (polygon.length === 0) return [];
  const out: Pt[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];
    const currIn = cross2d(a, b, curr) * sign >= 0;
    const nextIn = cross2d(a, b, next) * sign >= 0;
    if (currIn) out.push(curr);
    if (currIn !== nextIn) {
      const ix = lineLineIntersect(a, b, curr, next);
      if (ix) out.push(ix);
    }
  }
  return out;
}

/**
 * Intersection of the canvas rectangle [0,W]×[0,H] with the half-plane
 * defined by cross2d(a, b, p) * sign >= 0.
 */
export function halfPlaneRect(
  a: Pt, b: Pt, sign: number, W: number, H: number,
): Pt[] {
  const rect: Pt[] = [
    { x: 0, y: 0 }, { x: W, y: 0 },
    { x: W, y: H }, { x: 0, y: H },
  ];
  return clipPolygonToHalfPlane(rect, a, b, sign);
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function applyClip(ctx: CanvasRenderingContext2D, poly: Pt[]): void {
  if (poly.length < 3) {
    // Clip to empty region
    ctx.beginPath();
    ctx.rect(0, 0, 0, 0);
    ctx.clip();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.clip();
}

// ---------------------------------------------------------------------------
// Main simulation renderer
// ---------------------------------------------------------------------------

/**
 * Draw the image-based osteotomy simulation onto the canvas.
 *
 * Call this *instead of* ctx.drawImage() in the main draw loop.
 * Falls back to calling drawFn when geometry is incomplete.
 *
 * @param drawFn  Callback that draws the source image/canvas onto ctx.
 *   For the original DICOM image: `(c) => c.drawImage(img, ox, oy, w*s, h*s)`.
 *   For a chained (previously simulated) offscreen canvas: `(c) => c.drawImage(offscreen, 0, 0)`.
 *
 * Fragment selection
 * ------------------
 * - HTO (proximal tibial osteotomy): distal fragment = ankle side moves.
 * - DFO (distal femoral osteotomy):  distal fragment = knee side moves.
 *
 * The moving side is determined by which half-plane contains the
 * respective reference landmark.
 */
export function drawOsteotomySimulation(
  ctx: CanvasRenderingContext2D,
  drawFn: (ctx: CanvasRenderingContext2D) => void,
  plan: OsteotomyPlan,
  lm: Landmarks,
  s: number, ox: number, oy: number,
): void {
  const { osteotomy_line: ost, hinge_point: hinge, correction_deg: cdeg, kind } = plan;

  if (!ost || !hinge) {
    // Incomplete geometry — draw source as-is
    drawFn(ctx);
    return;
  }

  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const toC = (p: Point): Pt => ({ x: p.x * s + ox, y: p.y * s + oy });

  const cp1 = toC(ost.p1);
  const cp2 = toC(ost.p2);
  const cHinge = toC(hinge);

  // Extend osteotomy line well beyond canvas bounds for robust clipping
  const [extA, extB] = extendLine(cp1, cp2, W, H);

  // Determine which side is the moving fragment:
  //   HTO → ankle (distal tibia)
  //   DFO → knee  (distal femur / condyles)
  const refLm = kind.startsWith("HTO") ? lm.ankle_center : lm.knee_center;
  let movingSign = 1;
  if (refLm) {
    const c = toC(refLm);
    movingSign = cross2d(extA, extB, c) >= 0 ? 1 : -1;
  }
  const stationarySign = -movingSign;

  // Half-plane polygons clipped to canvas
  const stationaryPoly = halfPlaneRect(extA, extB, stationarySign, W, H);
  const movingPoly     = halfPlaneRect(extA, extB, movingSign,     W, H);

  // ── Step 1: Stationary fragment ─────────────────────────────────────────
  ctx.save();
  applyClip(ctx, stationaryPoly);
  drawFn(ctx);
  ctx.restore();

  // ── Step 2: Moving fragment ──────────────────────────────────────────────
  // When a rotation CTM is active, specifying the clip polygon in local
  // (post-CTM) coords causes both the clip and the drawn pixels to be
  // rotated together.  Only pixels whose *original* canvas positions lie in
  // movingPoly are ultimately shown — at their rotated screen positions.
  ctx.save();
  if (cdeg !== 0) {
    ctx.translate(cHinge.x, cHinge.y);
    ctx.rotate((cdeg * Math.PI) / 180);
    ctx.translate(-cHinge.x, -cHinge.y);
  }
  applyClip(ctx, movingPoly);
  drawFn(ctx);
  ctx.restore();

  // ── Step 3: Wedge gap fill ───────────────────────────────────────────────
  // For an opening wedge the gap between the original and rotated cut
  // surfaces is visible as empty canvas.  Fill it with a dark tone to
  // simulate the open bone gap.
  // For a closing wedge the rotated fragment overlaps the stationary side;
  // compositing in draw order handles this naturally (no gap to fill).
  if (cdeg !== 0) {
    const d1 = Math.hypot(cp1.x - cHinge.x, cp1.y - cHinge.y);
    const d2 = Math.hypot(cp2.x - cHinge.x, cp2.y - cHinge.y);
    const free = d1 >= d2 ? cp1 : cp2;

    const rad = (cdeg * Math.PI) / 180;
    const fx = free.x - cHinge.x;
    const fy = free.y - cHinge.y;
    const rotFree: Pt = {
      x: Math.cos(rad) * fx - Math.sin(rad) * fy + cHinge.x,
      y: Math.sin(rad) * fx + Math.cos(rad) * fy + cHinge.y,
    };

    // Determine gap vs. overlap using sign of wedge triangle winding
    // (opening wedge: the gap is on the moving side)
    const gapSide = cross2d(cHinge, free, rotFree);
    const isOpeningWedge = gapSide * movingSign > 0;

    if (isOpeningWedge) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(cHinge.x, cHinge.y);
      ctx.lineTo(free.x, free.y);
      ctx.lineTo(rotFree.x, rotFree.y);
      ctx.closePath();
      ctx.fillStyle = "rgba(12, 8, 0, 0.80)";  // dark bone gap
      ctx.fill();
      ctx.strokeStyle = "rgba(249, 115, 22, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }
}
