import React, { useState } from "react";
import type { Point } from "../types";
import styles from "./CalibrationPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

export type CalibMode = "none" | "p1" | "p2" | "p3";
export type CalibType = "line" | "sphere";

interface Props {
  sessionId: string | null;
  calibMode: CalibMode;
  calibType: CalibType;
  calibPoints: { p1?: Point; p2?: Point; p3?: Point };
  pixelSpacingMm: number | null;
  loading: boolean;
  onStartCalib: () => void;
  onTypeChange: (type: CalibType) => void;
  onApplyCalib: (knownMm: number) => void;
  onReset: () => void;
  onAutoDetect?: () => Promise<void>;
}

export default function CalibrationPanel({
  sessionId,
  calibMode,
  calibType,
  calibPoints,
  pixelSpacingMm,
  loading,
  onStartCalib,
  onTypeChange,
  onApplyCalib,
  onReset,
  onAutoDetect,
}: Props) {
  const [knownMm, setKnownMm] = useState<string>("25");
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const { t } = useTranslation();

  const isLine   = calibType === "line";
  const isSphere = calibType === "sphere";

  // Line: need p1 + p2; Sphere: need p1 + p2 + p3
  const lineReady   = !!(calibPoints.p1 && calibPoints.p2);
  const sphereReady = !!(calibPoints.p1 && calibPoints.p2 && calibPoints.p3);
  const canApply = isLine ? lineReady : sphereReady;

  // Pixel-distance display
  let pixelDistLabel: string | null = null;
  if (isLine && lineReady) {
    const d = Math.hypot(
      calibPoints.p2!.x - calibPoints.p1!.x,
      calibPoints.p2!.y - calibPoints.p1!.y
    );
    pixelDistLabel = `${d.toFixed(1)} px`;
  } else if (isSphere && sphereReady) {
    const r = circumscribedRadius(calibPoints.p1!, calibPoints.p2!, calibPoints.p3!);
    pixelDistLabel = r ? `⌀ ${(2 * r).toFixed(1)} px` : t("calib_collinear");
  }

  const inputLabel = isLine ? t("calib_input_line") : t("calib_input_sphere");

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t("calib_title")}</span>
        {pixelSpacingMm != null && (
          <span className={styles.badge}>{pixelSpacingMm.toFixed(4)} mm/px</span>
        )}
      </div>

      {/* Type selector — always visible */}
      <div className={styles.typeRow}>
        <button
          className={`${styles.typeBtn} ${isLine ? styles.typeActive : ""}`}
          onClick={() => onTypeChange("line")}
          disabled={loading}
        >
          {t("calib_type_line")}
        </button>
        <button
          className={`${styles.typeBtn} ${isSphere ? styles.typeActive : ""}`}
          onClick={() => onTypeChange("sphere")}
          disabled={loading}
        >
          {t("calib_type_sphere")}
        </button>
      </div>

      {/* Auto-detect button — always visible in sphere mode */}
      {isSphere && onAutoDetect && (
        <>
          <div className={styles.row} style={{ marginBottom: 4 }}>
            <button
              className={styles.calibBtn}
              style={{ background: "#238636", flex: 1 }}
              onClick={async () => {
                setAutoDetecting(true);
                setAutoError(null);
                try {
                  await onAutoDetect();
                } catch {
                  setAutoError("Messkugel nicht erkannt — bitte manuell setzen.");
                } finally {
                  setAutoDetecting(false);
                }
              }}
              disabled={loading || autoDetecting || !sessionId}
            >
              {autoDetecting ? "Erkenne…" : "⊙ Auto-Erkennung (25 mm)"}
            </button>
          </div>
          {autoError && <p className={styles.hint} style={{ color: "#f85149" }}>{autoError}</p>}
        </>
      )}

      {calibMode === "none" ? (
        <>
          {pixelSpacingMm == null && (
            <p className={styles.hint}>
              {isLine
                ? t("calib_hint_line")
                : t("calib_hint_sphere")}
            </p>
          )}
          <div className={styles.row}>
            <button
              className={styles.calibBtn}
              onClick={onStartCalib}
              disabled={loading || !sessionId}
            >
              {pixelSpacingMm != null ? t("calib_recalibrate") : t("calib_set_points")}
            </button>
            {pixelSpacingMm != null && (
              <button className={styles.resetBtn} onClick={onReset} disabled={loading}>✕</button>
            )}
          </div>
        </>
      ) : (
        <div className={styles.steps}>
          <Step idx={1} label={isLine ? t("calib_step_line_p1") : t("calib_step_sphere_p1")}
            done={!!calibPoints.p1} active={calibMode === "p1"} />
          <Step idx={2} label={isLine ? t("calib_step_line_p2") : t("calib_step_sphere_p2")}
            done={!!calibPoints.p2} active={calibMode === "p2"}
            inactive={!calibPoints.p1} />
          {isSphere && (
            <Step idx={3} label={t("calib_step_sphere_p3")}
              done={!!calibPoints.p3} active={calibMode === "p3"}
              inactive={!calibPoints.p2} />
          )}

          {canApply && (
            <div className={styles.inputRow}>
              {pixelDistLabel && (
                <span className={styles.distLabel}>
                  {isLine ? t("calib_pixel_dist") : t("calib_pixel_diam")}<strong>{pixelDistLabel}</strong>
                </span>
              )}
              <label className={styles.label}>{inputLabel}</label>
              <div className={styles.inputGroup}>
                <input
                  type="number"
                  min={1}
                  max={500}
                  step={0.5}
                  value={knownMm}
                  onChange={e => setKnownMm(e.target.value)}
                  className={styles.input}
                />
                <button
                  className={styles.applyBtn}
                  onClick={() => onApplyCalib(parseFloat(knownMm))}
                  disabled={loading || !parseFloat(knownMm)}
                >
                  {t("calib_apply")}
                </button>
              </div>
              <p className={styles.hint} style={{ marginTop: 4 }}>
                {isLine
                  ? t("calib_hint_line_typical")
                  : t("calib_hint_sphere_typical")}
              </p>
            </div>
          )}

          <button className={styles.cancelBtn} onClick={onReset} disabled={loading}>
            {t("calib_cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function Step({ idx, label, done, active, inactive }: {
  idx: number; label: string; done: boolean; active: boolean; inactive?: boolean;
}) {
  const cls = done ? styles.done : active ? styles.active : styles.inactive;
  return (
    <div className={`${styles.step} ${cls}`}>
      {done ? "✓" : idx} {label}
      {active && <span className={styles.blink}> ◀</span>}
    </div>
  );
}

/** Returns the circumscribed circle radius (px) for 3 circumference points, or null if collinear. */
export function circumscribedRadius(p1: Point, p2: Point, p3: Point): number | null {
  const D = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(D) < 1e-9) return null;
  const ux =
    ((p1.x * p1.x + p1.y * p1.y) * (p2.y - p3.y) +
      (p2.x * p2.x + p2.y * p2.y) * (p3.y - p1.y) +
      (p3.x * p3.x + p3.y * p3.y) * (p1.y - p2.y)) / D;
  const uy =
    ((p1.x * p1.x + p1.y * p1.y) * (p3.x - p2.x) +
      (p2.x * p2.x + p2.y * p2.y) * (p1.x - p3.x) +
      (p3.x * p3.x + p3.y * p3.y) * (p2.x - p1.x)) / D;
  return Math.hypot(ux - p1.x, uy - p1.y);
}

/** Returns circumscribed circle center and radius, or null if collinear. */
export function circumscribedCircle(
  p1: Point, p2: Point, p3: Point,
): { cx: number; cy: number; r: number } | null {
  const D = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
  if (Math.abs(D) < 1e-9) return null;
  const cx =
    ((p1.x * p1.x + p1.y * p1.y) * (p2.y - p3.y) +
      (p2.x * p2.x + p2.y * p2.y) * (p3.y - p1.y) +
      (p3.x * p3.x + p3.y * p3.y) * (p1.y - p2.y)) / D;
  const cy =
    ((p1.x * p1.x + p1.y * p1.y) * (p3.x - p2.x) +
      (p2.x * p2.x + p2.y * p2.y) * (p1.x - p3.x) +
      (p3.x * p3.x + p3.y * p3.y) * (p2.x - p1.x)) / D;
  return { cx, cy, r: Math.hypot(cx - p1.x, cy - p1.y) };
}
