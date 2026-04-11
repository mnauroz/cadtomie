import type { Point } from "../types";

export type ImageType = "long_leg_ap" | "knee_lateral";

/**
 * FSM steps for the Dejour & Bonnin tibial slope workflow.
 *
 * Step 1 — Medial tibial plateau tangent (2 clicks)
 * Step 2 — Cortex pair at ~5 cm below joint line (2 clicks: ant + post)
 * Step 3 — Cortex pair at ~15 cm below joint line (2 clicks: ant + post)
 *
 * Total: 6 clicks → shaft axis from 2 midpoints → perp → slope angle.
 */
export type SlopeStep =
  | "idle"
  | "plateau_1"    // 1st plateau tangent point
  | "plateau_2"    // 2nd plateau tangent point
  | "cortex1_ant"  // anterior cortex at ~5 cm
  | "cortex1_post" // posterior cortex at ~5 cm  → midpoint 1
  | "cortex2_ant"  // anterior cortex at ~15 cm
  | "cortex2_post" // posterior cortex at ~15 cm → midpoint 2 → compute
  | "done";

export interface SlopePoints {
  // Plateau tangent
  plateauP1: Point | null;
  plateauP2: Point | null;
  // Cortex pair at ~5 cm (proximal reference)
  cortex1Ant:  Point | null;
  cortex1Post: Point | null;
  // Cortex pair at ~15 cm (distal reference)
  cortex2Ant:  Point | null;
  cortex2Post: Point | null;
}

export const EMPTY_SLOPE_POINTS: SlopePoints = {
  plateauP1:   null,
  plateauP2:   null,
  cortex1Ant:  null,
  cortex1Post: null,
  cortex2Ant:  null,
  cortex2Post: null,
};

// ── Sagittal osteotomy simulation ─────────────────────────────────────────

/**
 * FSM for the anterior-closing osteotomy simulation workflow.
 * Order mirrors the frontal osteotomy module: cut line first, then hinge.
 */
export type SagittalStep = "idle" | "cut_p1" | "cut_p2" | "hinge" | "active";

/** User-placed geometry for the sagittal osteotomy. */
export interface SagittalOsteotomy {
  hingePoint: Point | null;
  cutP1:      Point | null;
  cutP2:      Point | null;
  correctionDeg: number;
}

export const EMPTY_SAGITTAL: SagittalOsteotomy = {
  hingePoint:    null,
  cutP1:         null,
  cutP2:         null,
  correctionDeg: 0,
};

// ── Confirmed sagittal osteotomies ────────────────────────────────────────

export interface ConfirmedSagittalOst {
  id: string;
  /** Frozen snapshot of the osteotomy geometry at confirmation. */
  ost: SagittalOsteotomy;
  slopeBefore: number;
  slopeAfter: number;
}
