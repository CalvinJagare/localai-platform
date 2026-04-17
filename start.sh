#!/usr/bin/env bash
# Start backend (FastAPI) and frontend (Vite) dev servers

# Backend
cd "$(dirname "$0")/backend"
pip install -r requirements.txt -q
uvicorn main:app --reload --reload-exclude "data/*" --port 8000 &
BACKEND_PID=$!

# Frontend
cd "../frontend"
npm run dev &
FRONTEND_PID=$!

echo "Backend  PID $BACKEND_PID  →  http://localhost:8000"
echo "Frontend PID $FRONTEND_PID →  http://localhost:5173"
echo "Press Ctrl+C to stop both."

wait $BACKEND_PID $FRONTEND_PID
