export interface Point {
  x: number;
  y: number;
}

export interface JointLine {
  medial: Point;
  lateral: Point;
}

export interface DiaphysisLevel {
  medial: Point;
  lateral: Point;
}

export interface Landmarks {
  hip_center: Point | null;
  knee_center: Point | null;
  ankle_center: Point | null;
  distal_femoral_line: JointLine | null;
  proximal_tibial_line: JointLine | null;
  distal_tibial_line: JointLine | null;
  femur_diaphysis_levels: DiaphysisLevel[];
  tibia_diaphysis_levels: DiaphysisLevel[];
  confidence: Record<string, number>;
}

export type Side = "right" | "left" | "unknown";

export type ImageType = "long_leg_ap" | "knee_lateral";

export interface Angles {
  HKA_deg: number | null;
  mLDFA_deg: number | null;
  mMPTA_deg: number | null;
  JLCA_deg: number | null;
  side: Side;
  notes: Record<string, string>;
}

export interface UploadResponse {
  session_id: string;
  rows: number;
  cols: number;
  pixel_spacing: [number, number];
  modality: string;
  patient_id: string;
  angles: Angles;
  landmarks: Landmarks;
  image_b64: string;
  raw_image_b64: string;  // unannotated DICOM pixels — used as simulation base
  align_angle_deg: number;  // CW degrees applied at upload; 0 if image was already vertical
}

export type DragTarget =
  | "hip_center"
  | "knee_center"
  | "ankle_center"
  | "distal_femoral_line_medial"
  | "distal_femoral_line_lateral"
  | "proximal_tibial_line_medial"
  | "proximal_tibial_line_lateral"
  | null;

export type MeasureStep =
  | "idle"
  | "hip_1" | "hip_2" | "hip_3"
  | "femur_1" | "femur_2" | "femur_3" | "femur_4"
  | "tibia_1" | "tibia_2" | "tibia_3" | "tibia_4"
  | "ankle_1" | "ankle_2" | "ankle_3" | "ankle_4"
  | "done";

export type AnnotationTool = "none" | "line" | "angle" | "text";

export interface LineAnnotation {
  id: string;
  type: "line";
  p1: Point;
  p2: Point;
}
export interface AngleAnnotation {
  id: string;
  type: "angle";
  p1: Point;
  vertex: Point;
  p2: Point;
}
export interface TextAnnotation {
  id: string;
  type: "text";
  pos: Point;
  text: string;
}
export type Annotation = LineAnnotation | AngleAnnotation | TextAnnotation;

