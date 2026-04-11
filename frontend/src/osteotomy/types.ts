import type { Landmarks, Point } from "../types";

export type OsteotomyKind =
  // Valgisierend
  | "HTO_OPEN_MED"   // HTO medial-öffnend
  | "HTO_CLOSE_LAT"  // HTO lateral-schließend
  | "DFO_CLOSE_LAT"  // DFO lateral-schließend
  | "DFO_CLOSE_MED"  // DFO medial-schließend
  // Varisierend
  | "HTO_CLOSE_MED"  // HTO medial-schließend
  | "DFO_OPEN_LAT"   // DFO lateral-öffnend
  | "DFO_OPEN_MED";  // DFO medial-öffnend

export const KIND_LABELS: Record<OsteotomyKind, string> = {
  HTO_OPEN_MED:  "HTO medial-öffnend",
  HTO_CLOSE_LAT: "HTO lateral-schließend",
  DFO_CLOSE_LAT: "DFO lateral-schließend",
  DFO_CLOSE_MED: "DFO medial-schließend",
  HTO_CLOSE_MED: "HTO medial-schließend",
  DFO_OPEN_LAT:  "DFO lateral-öffnend",
  DFO_OPEN_MED:  "DFO medial-öffnend",
};

export const VALGISIEREND: OsteotomyKind[] = ["HTO_OPEN_MED", "HTO_CLOSE_LAT", "DFO_CLOSE_LAT", "DFO_CLOSE_MED"];
export const VARISIEREND:  OsteotomyKind[] = ["HTO_CLOSE_MED", "DFO_OPEN_LAT", "DFO_OPEN_MED"];

export interface OstLine {
  p1: Point;
  p2: Point;
}

export interface OsteotomyPlan {
  kind: OsteotomyKind;
  osteotomy_line: OstLine | null;
  hinge_point: Point | null;
  target_point: Point | null;
  target_plateau_pct: number;
  /** Signed physical rotation angle (positive = CW in image, y-down). */
  correction_deg: number;
  /** Signed Miniaci angle from geometry. Null when geometry is incomplete. */
  miniaci_deg: number | null;
  wedge_mm: number | null;
  corrected_hka: number | null;
  corrected_mmpta: number | null;  // HTO only
  corrected_mldfa: number | null;  // DFO only
}

/** A finalized, locked osteotomy — stored on the frontend after confirmation. */
export interface ConfirmedOsteotomy {
  id: string;
  plan: OsteotomyPlan;  // frozen snapshot at time of confirmation
  /** Pre-transformation landmarks at the moment of confirmation — needed to
   *  replay the bone-fragment simulation for this osteotomy. */
  landmarksAtConfirm: Landmarks;
}

/** Which geometry element the user is currently placing on the canvas. */
export type PlanningStep =
  | "idle"
  | "ost_p1"    // placing osteotomy line point 1
  | "ost_p2"    // placing osteotomy line point 2
  | "hinge"
  | "target";
