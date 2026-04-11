/**
 * Osteotomy geometry engine — pure functions, no side effects.
 * Mirror of backend/osteotomy/engine.py for real-time overlay computation.
 *
 * Coordinate system: image coords (x right, y DOWN).
 * Positive angle = clockwise.
 */

import type { Landmarks, Point, JointLine, DiaphysisLevel } from "../types";
import type { OstLine, OsteotomyPlan } from "./types";

// ---------------------------------------------------------------------------
// Primitive geometry
// ---------------------------------------------------------------------------

export function rotatePoint(p: Point, hinge: Point, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = p.x - hinge.x;
  const dy = p.y - hinge.y;
  return {
    x: Math.cos(rad) * dx - Math.sin(rad) * dy + hinge.x,
    y: Math.sin(rad) * dx + Math.cos(rad) * dy + hinge.y,
  };
}

function dot(a: Point, b: Point) { return a.x * b.x + a.y * b.y; }
function cross2d(a: Point, b: Point) { return a.x * b.y - a.y * b.x; }
function len(v: Point) { return Math.hypot(v.x, v.y); }
function sub(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y }; }
function norm(v: Point): Point { const l = len(v) || 1e-9; return { x: v.x / l, y: v.y / l }; }

// ---------------------------------------------------------------------------
// Miniaci correction angle
// ---------------------------------------------------------------------------

/** Signed correction angle (degrees). Returns 0 for degenerate geometry. */
export function computeMiniaciAngle(
  hip: Point, ankle: Point, hinge: Point, target: Point,
): number {
  const v = sub(ankle, hinge);
  const r = len(v);
  if (r < 1e-6) return 0;
  const alpha = Math.atan2(v.y, v.x);

  const t = sub(target, hip);
  const tLen = len(t);
  if (tLen < 1e-6) return 0;

  const c = cross2d(sub(hinge, hip), t);
  const K = -c / (r * tLen);
  if (Math.abs(K) > 1) return 0;

  const phi = Math.atan2(t.x, t.y);
  const normAngle = (a: number) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const s1 = normAngle(Math.acos(K) - alpha - phi);
  const s2 = normAngle(-Math.acos(K) - alpha - phi);
  return (Math.abs(s1) <= Math.abs(s2) ? s1 : s2) * (180 / Math.PI);
}

// ---------------------------------------------------------------------------
// Overlay geometry (all image-space, caller scales to canvas)
// ---------------------------------------------------------------------------

export interface PlanOverlay {
  /** New Mikulicz line (hip→new_ankle) for both HTO and DFO. */
  newAxis: [Point, Point] | null;
  /** DFO only: new tibial segment new_knee→ankle. */
  newAxisDistal: [Point, Point] | null;
  /** Faded reference: original Mikulicz line hip→ankle. */
  origAxis: [Point, Point] | null;
  /** Wedge triangle: [freeEnd, hinge, rotatedFreeEnd] */
  wedge: [Point, Point, Point] | null;
  /** True when this is a closing wedge (bone removal, not distraction). */
  isClosingWedge: boolean;
  /** Correction arc: center, radius(px), startAngle(rad), endAngle(rad) */
  arc: { center: Point; radius: number; start: number; end: number } | null;
  /** New tibia/femur segment after correction */
  newSegment: [Point, Point] | null;
  /** Rotated DFL endpoints (DFO only) */
  rotatedDFL: [Point, Point] | null;
  /** New knee position (DFO) or new ankle position (HTO) */
  movedPoint: Point | null;
}

export function computeOverlay(plan: OsteotomyPlan, lm: Landmarks): PlanOverlay {
  const none: PlanOverlay = {
    newAxis: null, newAxisDistal: null, origAxis: null,
    wedge: null, isClosingWedge: false,
    arc: null, newSegment: null, rotatedDFL: null, movedPoint: null,
  };

  const hinge = plan.hinge_point;
  const cdeg = plan.correction_deg;
  if (!hinge || cdeg === 0) return none;

  const hip = lm.hip_center;
  const knee = lm.knee_center;
  const ankle = lm.ankle_center;

  const isClosingWedge = plan.kind.includes("CLOSE");

  let newAxis: [Point, Point] | null = null;
  let newAxisDistal: [Point, Point] | null = null;
  let newSegment: [Point, Point] | null = null;
  let origAxis: [Point, Point] | null = null;
  let movedPoint: Point | null = null;
  let rotatedDFL: [Point, Point] | null = null;

  if (plan.kind.startsWith("HTO") && ankle && hip) {
    // HTO: distal tibial fragment (ankle side) rotates around hinge.
    // The overall mechanical axis hip→ankle changes because ankle moves.
    const newAnkle = rotatePoint(ankle, hinge, cdeg);
    movedPoint = newAnkle;
    newAxis = [hip, newAnkle];           // new mechanical axis (Mikulicz line)
    if (knee) newSegment = [knee, newAnkle];
    origAxis = [hip, ankle];             // original mechanical axis (faded)
  } else if (plan.kind.startsWith("DFO") && knee && hip) {
    // DFO: the distal femoral fragment (knee + DFL + entire lower leg) rotates.
    // newAxis = Mikulicz line hip→new_ankle (moves visibly, matches HTO pattern).
    // newSegment = femoral mechanical axis hip→new_knee (reference for mLDFA).
    const newKnee = rotatePoint(knee, hinge, cdeg);
    movedPoint = newKnee;
    if (ankle) {
      const newAnkle = rotatePoint(ankle, hinge, cdeg);
      newAxis = [hip, newAnkle];         // new Mikulicz line (moves visibly)
      origAxis = [hip, ankle];           // original Mikulicz line (faded)
    }
    newSegment = [hip, newKnee];         // new femoral mechanical axis (mLDFA ref)
    if (lm.distal_femoral_line) {
      rotatedDFL = [
        rotatePoint(lm.distal_femoral_line.medial, hinge, cdeg),
        rotatePoint(lm.distal_femoral_line.lateral, hinge, cdeg),
      ];
    }
  }

  // Wedge polygon: [freeEnd, hinge, rotatedFreeEnd]
  let wedge: [Point, Point, Point] | null = null;
  if (plan.osteotomy_line) {
    const { p1, p2 } = plan.osteotomy_line;
    const d1 = Math.hypot(p1.x - hinge.x, p1.y - hinge.y);
    const d2 = Math.hypot(p2.x - hinge.x, p2.y - hinge.y);
    const free = d1 >= d2 ? p1 : p2;
    const rotFree = rotatePoint(free, hinge, cdeg);
    wedge = [free, hinge, rotFree];
  }

  // Arc centred at hinge (radius 40 px image-space)
  let arc: PlanOverlay["arc"] = null;
  const arcRef = plan.kind.startsWith("DFO") ? knee : ankle;
  if (arcRef) {
    const d = sub(arcRef, hinge);
    const startAngle = Math.atan2(d.y, d.x);
    arc = {
      center: hinge,
      radius: 40,
      start: startAngle,
      end: startAngle + (cdeg * Math.PI) / 180,
    };
  }

  return { newAxis, newAxisDistal, origAxis, wedge, isClosingWedge, arc, newSegment, rotatedDFL, movedPoint };
}

// ---------------------------------------------------------------------------
// Confirmed-osteotomy geometric transform
// ---------------------------------------------------------------------------

/**
 * Apply the osteotomy rotation to landmark positions.
 *
 * This is the same transform used for visual simulation but applied to the
 * actual stored coordinates so subsequent osteotomies work on the corrected
 * anatomy rather than the original.
 *
 * HTO  — distal tibial fragment rotates:
 *   ankle_center, all tibia_diaphysis_levels
 *
 * DFO  — distal femoral fragment + entire lower limb rotates as a unit:
 *   knee_center, distal_femoral_line, proximal_tibial_line, ankle_center,
 *   all tibia_diaphysis_levels, femur_diaphysis_levels whose midpoint is
 *   BELOW the hinge (y > hinge.y, y-down coords).
 *
 * Returns a new Landmarks object; original is not mutated.
 */
export function applyOsteotomyTransform(lm: Landmarks, plan: OsteotomyPlan): Landmarks {
  const hinge = plan.hinge_point;
  if (!hinge || plan.correction_deg === 0) return lm;

  const cdeg = plan.correction_deg;
  const rot = (p: Point): Point => rotatePoint(p, hinge, cdeg);
  const rotLine = (jl: JointLine): JointLine => ({
    medial: rot(jl.medial),
    lateral: rot(jl.lateral),
  });
  const rotLevel = (lvl: DiaphysisLevel): DiaphysisLevel => ({
    medial: rot(lvl.medial),
    lateral: rot(lvl.lateral),
  });

  const result: Landmarks = { ...lm };

  if (plan.kind.startsWith("HTO")) {
    // Distal tibial fragment (ankle side) rotates; proximal side (knee, DFL) stays.
    if (lm.ankle_center) result.ankle_center = rot(lm.ankle_center);
    if (lm.tibia_diaphysis_levels?.length) {
      result.tibia_diaphysis_levels = lm.tibia_diaphysis_levels.map(rotLevel);
    }
    // proximal_tibial_line, knee_center, hip_center, DFL, femur levels → unchanged

  } else if (plan.kind.startsWith("DFO")) {
    // Distal femoral fragment + everything attached below rotates as one unit.
    if (lm.knee_center)             result.knee_center = rot(lm.knee_center);
    if (lm.ankle_center)            result.ankle_center = rot(lm.ankle_center);
    if (lm.distal_femoral_line)     result.distal_femoral_line = rotLine(lm.distal_femoral_line);
    if (lm.proximal_tibial_line)    result.proximal_tibial_line = rotLine(lm.proximal_tibial_line);
    if (lm.tibia_diaphysis_levels?.length) {
      result.tibia_diaphysis_levels = lm.tibia_diaphysis_levels.map(rotLevel);
    }
    if (lm.femur_diaphysis_levels?.length) {
      result.femur_diaphysis_levels = lm.femur_diaphysis_levels.map(lvl =>
        // Only levels whose midpoint is below the hinge (y-down: y > hinge.y) rotate
        (lvl.medial.y + lvl.lateral.y) / 2 > hinge.y ? rotLevel(lvl) : lvl
      );
    }
    // hip_center, femur levels above hinge → unchanged
  }

  return result;
}
