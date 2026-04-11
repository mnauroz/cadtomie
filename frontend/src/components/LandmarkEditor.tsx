import React, { Fragment, useState } from "react";
import type { Landmarks, Point } from "../types";
import styles from "./LandmarkEditor.module.css";

interface Props {
  landmarks: Landmarks;
  onUpdate: (target: string, point: Point, side?: "medial" | "lateral") => void;
}

function CoordRow({
  label,
  point,
  onEdit,
}: {
  label: string;
  point: Point | null;
  onEdit: (p: Point) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [xStr, setXStr] = useState(point ? String(Math.round(point.x)) : "");
  const [yStr, setYStr] = useState(point ? String(Math.round(point.y)) : "");

  const commit = () => {
    const x = parseFloat(xStr);
    const y = parseFloat(yStr);
    if (!isNaN(x) && !isNaN(y)) onEdit({ x, y });
    setEditing(false);
  };

  if (!point) return null;

  return (
    <div className={styles.coordRow}>
      <span className={styles.coordLabel}>{label}</span>
      {editing ? (
        <span className={styles.coordInputs}>
          <input
            className={styles.input}
            value={xStr}
            onChange={(e) => setXStr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            size={5}
          />
          <input
            className={styles.input}
            value={yStr}
            onChange={(e) => setYStr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            size={5}
          />
          <button className="btn-primary" style={{ padding: "3px 8px" }} onClick={commit}>✓</button>
        </span>
      ) : (
        <span
          className={styles.coordValue}
          onClick={() => {
            setXStr(String(Math.round(point.x)));
            setYStr(String(Math.round(point.y)));
            setEditing(true);
          }}
          title="Click to edit"
        >
          ({Math.round(point.x)}, {Math.round(point.y)})
        </span>
      )}
    </div>
  );
}

export default function LandmarkEditor({ landmarks, onUpdate }: Props) {
  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>Landmarks</h2>
      <p className={styles.hint}>Click coordinates to edit. Drag points on the image directly.</p>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Hip</div>
        <CoordRow
          label="Center"
          point={landmarks.hip_center}
          onEdit={(p) => onUpdate("hip_center", p)}
        />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Knee</div>
        <CoordRow
          label="Center"
          point={landmarks.knee_center}
          onEdit={(p) => onUpdate("knee_center", p)}
        />
        {landmarks.distal_femoral_line && (
          <>
            <CoordRow
              label="DFL med"
              point={landmarks.distal_femoral_line.medial}
              onEdit={(p) => onUpdate("distal_femoral_line", p, "medial")}
            />
            <CoordRow
              label="DFL lat"
              point={landmarks.distal_femoral_line.lateral}
              onEdit={(p) => onUpdate("distal_femoral_line", p, "lateral")}
            />
          </>
        )}
        {landmarks.proximal_tibial_line && (
          <>
            <CoordRow
              label="PTL med"
              point={landmarks.proximal_tibial_line.medial}
              onEdit={(p) => onUpdate("proximal_tibial_line", p, "medial")}
            />
            <CoordRow
              label="PTL lat"
              point={landmarks.proximal_tibial_line.lateral}
              onEdit={(p) => onUpdate("proximal_tibial_line", p, "lateral")}
            />
          </>
        )}
      </div>

      {landmarks.femur_diaphysis_levels && landmarks.femur_diaphysis_levels.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Femur-Diaphyse (Kortikalis)</div>
          {landmarks.femur_diaphysis_levels.map((lvl, i) => (
            <React.Fragment key={`fd_${i}`}>
              <CoordRow label={`Ebene ${i + 1} med`} point={lvl.medial}  onEdit={(p) => onUpdate(`femur_diaphysis_${i}_medial`,  p)} />
              <CoordRow label={`Ebene ${i + 1} lat`} point={lvl.lateral} onEdit={(p) => onUpdate(`femur_diaphysis_${i}_lateral`, p)} />
            </React.Fragment>
          ))}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Ankle</div>
        <CoordRow
          label="Center"
          point={landmarks.ankle_center}
          onEdit={(p) => onUpdate("ankle_center", p)}
        />
      </div>

      {landmarks.tibia_diaphysis_levels && landmarks.tibia_diaphysis_levels.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Tibia-Diaphyse (Kortikalis)</div>
          {landmarks.tibia_diaphysis_levels.map((lvl, i) => (
            <React.Fragment key={`td_${i}`}>
              <CoordRow label={`Ebene ${i + 1} med`} point={lvl.medial}  onEdit={(p) => onUpdate(`tibia_diaphysis_${i}_medial`,  p)} />
              <CoordRow label={`Ebene ${i + 1} lat`} point={lvl.lateral} onEdit={(p) => onUpdate(`tibia_diaphysis_${i}_lateral`, p)} />
            </React.Fragment>
          ))}
        </div>
      )}

      {Object.keys(landmarks.confidence).length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Confidence</div>
          {Object.entries(landmarks.confidence).map(([k, v]) => (
            <div key={k} className={styles.confRow}>
              <span>{k}</span>
              <div className={styles.confBar}>
                <div
                  className={styles.confFill}
                  style={{
                    width: `${Math.round(v * 100)}%`,
                    background: v > 0.7 ? "var(--success)" : v > 0.4 ? "var(--warning)" : "var(--danger)",
                  }}
                />
              </div>
              <span className={styles.confPct}>{Math.round(v * 100)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
