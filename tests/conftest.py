"""Pytest configuration for CADtomie tests."""
import sys
from pathlib import Path

# Ensure backend package is importable from any test location
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))
