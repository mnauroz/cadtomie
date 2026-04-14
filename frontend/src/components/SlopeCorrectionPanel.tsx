import React from "react";
import type { SagittalStep, SagittalOsteotomy, ConfirmedSagittalOst } from "../slope/types";
import type { SagittalResult } from "../slope/sagittal_engine";
import styles from "./SlopeCorrectionPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  step: SagittalStep;
  originalSlope: number;
  ost: SagittalOsteotomy;
  result: SagittalResult | null;
  confirmedOsts: ConfirmedSagittalOst[];
  onStart: () => void;
  onReset: () => void;
  onConfirm: () => void;
  onCorrectionChange: (deg: number) => void;
  onDeleteConfirmed: (id: string) => void;
}

function slopeColor(v: number, normalStyle: string, abnormalStyle: string): string {
  return v >= 5 && v <= 10 ? normalStyle : abnormalStyle;
}

export default function SlopeCorrectionPanel({
  step,
  originalSlope,
  ost,
  result,
  confirmedOsts,
  onStart,
  onReset,
  onConfirm,
  onCorrectionChange,
  onDeleteConfirmed,
}: Props) {
  const { t } = useTranslation();

  const STEP_INSTRUCTIONS: Partial<Record<SagittalStep, string>> = {
    cut_p1: t("slope_corr_cut_p1"),
    cut_p2: t("slope_corr_cut_p2"),
    hinge:  t("slope_corr_hinge"),
  };

  const STEP_LABELS: Partial<Record<SagittalStep, string>> = {
    cut_p1: t("slope_corr_step_1"),
    cut_p2: t("slope_corr_step_2"),
    hinge:  t("slope_corr_step_3"),
  };

  const isIdle    = step === "idle";
  const isActive  = step === "active";
  const isPlacing = !isIdle && !isActive;

  const corrDeg = ost.correctionDeg;

  const canConfirm =
    isActive &&
    ost.cutP1 !== null &&
    ost.cutP2 !== null &&
    ost.hingePoint !== null &&
    corrDeg !== 0;

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>{t("slope_correction_title")}</h3>

      {confirmedOsts.length > 0 && (
        <div className={styles.confirmedList}>
          {confirmedOsts.map((co, i) => {
            const isNormal = co.slopeAfter >= 5 && co.slopeAfter <= 10;
            return (
              <div key={co.id} className={styles.confirmedItem}>
                <span className={styles.confirmedIndex}>{i + 1}</span>
                <span className={styles.confirmedSlopes}>
                  {co.slopeBefore > 0 ? "+" : ""}{co.slopeBefore.toFixed(1)}°
                  {" → "}
                  <span className={isNormal ? styles.normal : styles.abnormal}>
                    {co.slopeAfter > 0 ? "+" : ""}{co.slopeAfter.toFixed(1)}°
                  </span>
                </span>
                <button
                  className={styles.deleteBtn}
                  onClick={() => onDeleteConfirmed(co.id)}
                  title="Delete"
                >×</button>
              </div>
            );
          })}
        </div>
      )}

      {isIdle && (
        <button className={styles.startBtn} onClick={onStart}>
          {t("slope_correction_start")}
        </button>
      )}

      {isPlacing && (
        <>
          <div className={styles.stepLabel}>{STEP_LABELS[step]}</div>
          <div className={styles.instruction}>{STEP_INSTRUCTIONS[step]}</div>
          <button className={styles.resetBtn} onClick={onReset}>{t("slope_corr_cancel")}</button>
        </>
      )}

      {isActive && (
        <>
          <div className={styles.sliderRow}>
            <div className={styles.sliderLabel}>
              <span className={styles.sliderName}>{t("slope_corr_angle")}</span>
              <span className={styles.sliderValue}>
                {corrDeg > 0 ? "+" : ""}{corrDeg.toFixed(1)}°
              </span>
            </div>
            <input
              type="range"
              className={styles.slider}
              min={-15}
              max={15}
              step={0.5}
              value={corrDeg}
              onChange={e => onCorrectionChange(parseFloat(e.target.value))}
            />
          </div>

          <div className={styles.results}>
            <div className={styles.card}>
              <div className={styles.cardLabel}>{t("slope_before")}</div>
              <div className={`${styles.cardValue} ${slopeColor(originalSlope, styles.normal, styles.abnormal)}`}>
                {originalSlope > 0 ? "+" : ""}{originalSlope.toFixed(1)}°
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardLabel}>{t("slope_after")}</div>
              <div className={`${styles.cardValue} ${result ? slopeColor(result.correctedSlope, styles.normal, styles.abnormal) : styles.muted}`}>
                {result
                  ? `${result.correctedSlope > 0 ? "+" : ""}${result.correctedSlope.toFixed(1)}°`
                  : "—"}
              </div>
            </div>

            <div className={`${styles.card} ${styles.cardDelta}`}>
              <div className={styles.cardLabel}>{t("slope_delta")}</div>
              <div className={`${styles.cardValue} ${styles.delta}`}>
                {result
                  ? `${result.delta > 0 ? "+" : ""}${result.delta.toFixed(1)}°`
                  : "—"}
              </div>
            </div>
          </div>

          {canConfirm && (
            <button className={styles.confirmBtn} onClick={onConfirm}>
              {t("slope_confirm")}
            </button>
          )}

          <button className={styles.resetBtn} onClick={onReset}>{t("slope_reset_btn")}</button>
        </>
      )}
    </div>
  );
}
