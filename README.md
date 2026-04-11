# CADtomie

Open-source orthopedic deformity analysis software for long-leg standing radiographs.

Comparable to mediCAD / TraumaCad — modular, extensible, MIT-licensed.

---

## Features

- DICOM upload and display with correct pixel spacing
- Automatic anatomical landmark detection (hip, knee, ankle)
- Mechanical and anatomical axis calculation
- Angle measurements: HKA, mLDFA, mMPTA, JLCA, JLO
- Manual landmark correction tools
- Export: PNG, PDF, JSON

---

## Architecture

```
CADtomie/
├── backend/             # Python (FastAPI)
│   ├── dicom_loader/    # DICOM reading & pixel extraction
│   ├── landmark_detection/  # CV + ML landmark detection
│   ├── axis_calculation/    # Mechanical & anatomical axes
│   ├── angle_measurement/   # HKA, mLDFA, mMPTA, JLCA, JLO
│   └── export/          # PNG, PDF, JSON export
├── frontend/            # React + Canvas
│   └── src/
│       └── components/  # Viewer, panels, overlay
├── models/              # ML model weights (placeholder)
└── tests/               # Unit tests
```

---

## Quick Start

### Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173

---

## Angle Definitions

| Angle | Definition | Normal Range |
|-------|-----------|-------------|
| HKA   | Hip-Knee-Ankle angle between femoral & tibial mechanical axis | 0° ± 3° |
| mLDFA | Mechanical Lateral Distal Femoral Angle | 85–90° |
| mMPTA | Mechanical Medial Proximal Tibial Angle | 85–90° |
| JLCA  | Joint Line Convergence Angle | < 2° |
| JLO   | Joint Line Orientation to horizontal | ~0° |

---

## Future Modules

- Osteotomy planning & wedge simulation
- Implant templating
- Deformity correction planning (CORA method)
- DICOM worklist integration

---

## License

MIT — see [LICENSE](LICENSE)
