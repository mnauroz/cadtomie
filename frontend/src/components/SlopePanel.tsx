import React from "react";
import type { SlopeStep } from "../slope/types";
import styles from "./SlopePanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  step: SlopeStep;
  slope: number | null;
  onStart: () => void;
  onReset: () => void;
}

export default function SlopePanel({ step, slope, onStart, onReset }: Props) {
  const { t } = useTranslation();

  const STEP_LABELS: Record<SlopeStep, string> = {
    idle:         "",
    plateau_1:    t("slope_step_plateau_1"),
    plateau_2:    t("slope_step_plateau_2"),
    cortex1_ant:  t("slope_step_c1_ant"),
    cortex1_post: t("slope_step_c1_post"),
    cortex2_ant:  t("slope_step_c2_ant"),
    cortex2_post: t("slope_step_c2_post"),
    done:         "",
  };

  const STEP_GROUPS: Partial<Record<SlopeStep, string>> = {
    plateau_1:    t("slope_group_plateau"),
    plateau_2:    t("slope_group_plateau"),
    cortex1_ant:  t("slope_group_c1"),
    cortex1_post: t("slope_group_c1"),
    cortex2_ant:  t("slope_group_c2"),
    cortex2_post: t("slope_group_c2"),
  };

  const isActive = step !== "idle" && step !== "done";
  const isDone   = step === "done";
  const isNormal = slope !== null && slope >= 5 && slope <= 10;

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>{t("slope_title")}</h3>

      {step === "idle" && (
        <>
          <p className={styles.methodNote}>
            {t("slope_method_note")}
          </p>
          <button className={styles.startBtn} onClick={onStart}>
            {t("slope_start")}
          </button>
        </>
      )}

      {isActive && (
        <>
          <div className={styles.group}>{STEP_GROUPS[step]}</div>
          <div className={styles.instruction}>{STEP_LABELS[step]}</div>
        </>
      )}

      {isDone && slope !== null && (
        <div className={styles.result}>
          <span className={styles.resultLabel}>{t("slope_result_label")}</span>
          <span className={`${styles.value} ${isNormal ? styles.normal : styles.abnormal}`}>
            {slope > 0 ? "+" : ""}{slope.toFixed(1)}°
          </span>
          <span className={styles.range}>{t("slope_normal_range")}</span>
          <span className={`${styles.badge} ${isNormal ? styles.normal : styles.abnormal}`}>
            {isNormal ? t("slope_badge_normal") : t("slope_badge_abnormal")}
          </span>
        </div>
      )}

      {step !== "idle" && (
        <button className={styles.resetBtn} onClick={onReset}>
          {t("slope_reset")}
        </button>
      )}
    </div>
  );
}
