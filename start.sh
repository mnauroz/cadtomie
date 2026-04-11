#!/bin/bash
# CADtomie – Start Backend + Frontend

echo "Starting CADtomie..."

# Kill any existing instances on these ports
lsof -ti:8000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Start Backend
cd "$ROOT/backend"
/usr/local/bin/python3 -m uvicorn main:app --port 8000 &
BACKEND_PID=$!
echo "Backend started (PID $BACKEND_PID)"

# Wait briefly for backend to be ready
sleep 2

# Start Frontend
cd "$ROOT/frontend"
npm run dev &
FRONTEND_PID=$!
echo "Frontend started (PID $FRONTEND_PID)"

echo ""
echo "CADtomie running:"
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop both."

# Wait and handle Ctrl+C
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Stopped.'; exit" INT
wait
