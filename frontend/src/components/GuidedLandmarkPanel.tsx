import React from "react";
import type { JointLine, MeasureStep, Point } from "../types";
import styles from "./GuidedLandmarkPanel.module.css";
import { useTranslation } from "../i18n/LanguageContext";

interface Props {
  measureStep: MeasureStep;
  hipPoints: Point[];
  femurPts: Point[];
  tibiaPts: Point[];
  anklePtM: Point | null;
  hipCenter: Point | null;
  dfl: JointLine | null;
  kneeCenter: Point | null;
  ptl: JointLine | null;
  ankleCenter: Point | null;
  onResetSection: (to: MeasureStep) => void;
}

export default function GuidedLandmarkPanel({
  measureStep,
  hipPoints,
  femurPts,
  tibiaPts,
  anklePtM,
  hipCenter,
  dfl,
  kneeCenter,
  ptl,
  ankleCenter,
  onResetSection,
}: Props) {
  const { t } = useTranslation();

  const hipDone    = !["hip_1","hip_2","hip_3"].includes(measureStep) && measureStep !== "idle";
  const femurDone  = ["tibia_1","tibia_2","tibia_3","tibia_4","ankle_m","ankle_l","done"].includes(measureStep);
  const tibiaDone  = ["ankle_m","ankle_l","done"].includes(measureStep);
  const ankleDone  = measureStep === "done";

  const hipActive   = measureStep === "hip_1" || measureStep === "hip_2" || measureStep === "hip_3";
  const femurActive = measureStep === "femur_1" || measureStep === "femur_2" || measureStep === "femur_3" || measureStep === "femur_4";
  const tibiaActive = measureStep === "tibia_1" || measureStep === "tibia_2" || measureStep === "tibia_3" || measureStep === "tibia_4";
  const ankleActive = measureStep === "ankle_m" || measureStep === "ankle_l";

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t("guided_title")}</span>
      </div>
      <p className={styles.hint}>
        {t("guided_hint")}
      </p>

      {/* 1. Hip */}
      <Section
        label={t("guided_hip")}
        done={hipDone}
        active={hipActive}
        onReset={hipDone ? () => onResetSection("hip_1") : undefined}
        resetLabel={t("guided_reset")}
      >
        <Step idx={1} label={t("guided_hip_p1")} done={hipPoints.length >= 1 || hipDone} active={measureStep === "hip_1"} />
        <Step idx={2} label={t("guided_hip_p2")} done={hipPoints.length >= 2 || hipDone} active={measureStep === "hip_2"} inactive={hipPoints.length < 1 && !hipDone} />
        <Step idx={3} label={t("guided_hip_p3")} done={hipDone} active={measureStep === "hip_3"} inactive={hipPoints.length < 2 && !hipDone} />
        {hipDone && hipCenter && (
          <div className={styles.result}>{t("guided_center")}{hipCenter.x.toFixed(0)}, {hipCenter.y.toFixed(0)})</div>
        )}
      </Section>

      {/* 2. Femur base */}
      <Section
        label={t("guided_femur")}
        done={femurDone}
        active={femurActive}
        inactive={!hipDone}
        onReset={femurDone ? () => onResetSection("femur_1") : undefined}
        resetLabel={t("guided_reset")}
      >
        <Step idx={1} label={t("guided_knee_jl_p1")} done={femurPts.length >= 1 || femurDone} active={measureStep === "femur_1"} inactive={!hipDone} />
        <Step idx={2} label={t("guided_knee_jl_p2")} done={femurPts.length >= 2 || femurDone} active={measureStep === "femur_2"} inactive={femurPts.length < 1 && !femurDone} />
        <Step idx={3} label={t("guided_knee_med_lat")} done={femurPts.length >= 3 || femurDone} active={measureStep === "femur_3"} inactive={femurPts.length < 2 && !femurDone} />
        <Step idx={4} label={t("guided_knee_med_lat")} done={femurDone} active={measureStep === "femur_4"} inactive={femurPts.length < 3 && !femurDone} />
        {femurDone && dfl && (
          <div className={styles.result}>
            DFL-M: ({dfl.medial.x.toFixed(0)}, {dfl.medial.y.toFixed(0)})<br />
            DFL-L: ({dfl.lateral.x.toFixed(0)}, {dfl.lateral.y.toFixed(0)})
            {kneeCenter && <><br />Kniezentrum: ({kneeCenter.x.toFixed(0)}, {kneeCenter.y.toFixed(0)})</>}
          </div>
        )}
      </Section>

      {/* 3. Tibia base */}
      <Section
        label={t("guided_tibia")}
        done={tibiaDone}
        active={tibiaActive}
        inactive={!femurDone}
        onReset={tibiaDone ? () => onResetSection("tibia_1") : undefined}
        resetLabel={t("guided_reset")}
      >
        <Step idx={1} label={t("guided_knee_jl_p1")} done={tibiaPts.length >= 1 || tibiaDone} active={measureStep === "tibia_1"} inactive={!femurDone} />
        <Step idx={2} label={t("guided_knee_jl_p2")} done={tibiaPts.length >= 2 || tibiaDone} active={measureStep === "tibia_2"} inactive={tibiaPts.length < 1 && !tibiaDone} />
        <Step idx={3} label={t("guided_knee_med_lat")} done={tibiaPts.length >= 3 || tibiaDone} active={measureStep === "tibia_3"} inactive={tibiaPts.length < 2 && !tibiaDone} />
        <Step idx={4} label={t("guided_knee_med_lat")} done={tibiaDone} active={measureStep === "tibia_4"} inactive={tibiaPts.length < 3 && !tibiaDone} />
        {tibiaDone && ptl && (
          <div className={styles.result}>
            PTL-M: ({ptl.medial.x.toFixed(0)}, {ptl.medial.y.toFixed(0)})<br />
            PTL-L: ({ptl.lateral.x.toFixed(0)}, {ptl.lateral.y.toFixed(0)})
          </div>
        )}
      </Section>

      {/* 4. Ankle */}
      <Section
        label={t("guided_ankle")}
        done={ankleDone}
        active={ankleActive}
        inactive={!tibiaDone}
        onReset={ankleDone ? () => onResetSection("ankle_m") : undefined}
        resetLabel={t("guided_reset")}
      >
        <Step idx={1} label={t("guided_ankle_med")} done={!!anklePtM || ankleDone} active={measureStep === "ankle_m"} inactive={!tibiaDone} />
        <Step idx={2} label={t("guided_ankle_lat")} done={ankleDone} active={measureStep === "ankle_l"} inactive={!anklePtM && !ankleDone} />
        {ankleDone && ankleCenter && (
          <div className={styles.result}>{t("guided_mid")}{ankleCenter.x.toFixed(0)}, {ankleCenter.y.toFixed(0)})</div>
        )}
      </Section>
    </div>
  );
}

function Section({
  label, done, active, inactive, onReset, resetLabel, children,
}: {
  label: string; done: boolean; active: boolean; inactive?: boolean;
  onReset?: () => void; resetLabel?: string; children: React.ReactNode;
}) {
  return (
    <div className={`${styles.section} ${done ? styles.sectionDone : active ? styles.sectionActive : styles.sectionInactive}`}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>
          {done ? "✓ " : active ? "▶ " : ""}{label}
        </span>
        {done && onReset && (
          <button className={styles.resetBtn} onClick={onReset} title={resetLabel ?? "Reset"}>↺</button>
        )}
      </div>
      {!inactive && <div className={styles.steps}>{children}</div>}
    </div>
  );
}

function Step({ idx, label, done, active, inactive }: {
  idx: number; label: string; done: boolean; active: boolean; inactive?: boolean;
}) {
  const cls = done ? styles.stepDone : active ? styles.stepActive : styles.stepInactive;
  return (
    <div className={`${styles.step} ${cls}`}>
      {done ? "✓" : idx}. {label}
      {active && <span className={styles.blink}> ◀</span>}
    </div>
  );
}
