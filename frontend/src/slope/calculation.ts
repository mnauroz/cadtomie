import type { Point } from "../types";
import type { SlopePoints } from "./types";

/**
 * Compute the posterior tibial slope using the Dejour & Bonnin method.
 *
 * Definition:
 *   TS = angle between the medial tibial plateau tangent and a line
 *        perpendicular to the tibial shaft axis.
 *
 * Shaft axis:
 *   Determined from two cortex-pair midpoints (NOT arbitrary shaft-center clicks):
 *     midpoint_1 = mid(cortex1Ant, cortex1Post)  @ ~5 cm below joint line
 *     midpoint_2 = mid(cortex2Ant, cortex2Post)  @ ~15 cm below joint line
 *   shaft_axis = line(midpoint_1, midpoint_2)
 *
 * Perpendicular reference = shaft_axis rotated 90°.
 *
 * Sign convention (image coordinates, y increases downward):
 *   positive = posterior slope  (posterior plateau lower → typical anatomy)
 *   negative = anterior slope
 */
export function computeSlope(pts: SlopePoints): number {
  const { plateauP1, plateauP2, cortex1Ant, cortex1Post, cortex2Ant, cortex2Post } = pts;
  if (!plateauP1 || !plateauP2 || !cortex1Ant || !cortex1Post || !cortex2Ant || !cortex2Post) {
    return 0;
  }

  // ── Shaft axis via cortex-pair midpoints ──────────────────────────────
  const mid1: Point = {
    x: (cortex1Ant.x + cortex1Post.x) / 2,
    y: (cortex1Ant.y + cortex1Post.y) / 2,
  };
  const mid2: Point = {
    x: (cortex2Ant.x + cortex2Post.x) / 2,
    y: (cortex2Ant.y + cortex2Post.y) / 2,
  };

  const dx_shaft = mid2.x - mid1.x;
  const dy_shaft = mid2.y - mid1.y;
  const len_shaft = Math.hypot(dx_shaft, dy_shaft);
  if (len_shaft < 1) return 0;

  // ── Plateau tangent direction ──────────────────────────────────────────
  const dx_plateau = plateauP2.x - plateauP1.x;
  const dy_plateau = plateauP2.y - plateauP1.y;
  const len_plateau = Math.hypot(dx_plateau, dy_plateau);
  if (len_plateau < 1) return 0;

  // ── Normalised unit vectors ────────────────────────────────────────────
  const sx = dx_shaft  / len_shaft;
  const sy = dy_shaft  / len_shaft;
  const px = dx_plateau / len_plateau;
  const py = dy_plateau / len_plateau;

  // ── Slope = 90° − angle_between(shaft, plateau) ───────────────────────
  // Treating lines as undirected: use |dot| to get angle in [0°, 90°].
  const dot = px * sx + py * sy;
  const cosAngle = Math.min(1, Math.max(-1, Math.abs(dot)));
  const angleBetweenDeg = Math.acos(cosAngle) * 180 / Math.PI;
  const magnitude = 90 - angleBetweenDeg;

  // Sign: dot > 0 → plateau has a downward component along the shaft
  //       → posterior is lower → posterior slope → positive.
  return dot >= 0 ? magnitude : -magnitude;
}

/** Convenience: return the two cortex-pair midpoints (or null if incomplete). */
export function cortexMidpoints(pts: SlopePoints): [Point, Point] | null {
  const { cortex1Ant, cortex1Post, cortex2Ant, cortex2Post } = pts;
  if (!cortex1Ant || !cortex1Post || !cortex2Ant || !cortex2Post) return null;
  return [
    { x: (cortex1Ant.x + cortex1Post.x) / 2, y: (cortex1Ant.y + cortex1Post.y) / 2 },
    { x: (cortex2Ant.x + cortex2Post.x) / 2, y: (cortex2Ant.y + cortex2Post.y) / 2 },
  ];
}
