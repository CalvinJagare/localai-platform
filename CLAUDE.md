# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 (Vite 8), at `/frontend/`
- **Backend**: Python FastAPI + Unsloth QLoRA training pipeline, at `/backend/`
- **Inference**: Ollama (runs on host at `http://localhost:11434`, outside Docker)
- **Orchestration**: Docker Compose — backend on port 8000, frontend dev server on port 5173

## Commands

### Full stack (Docker)
```bash
docker compose up -d          # start all services
docker compose down           # stop all services
docker compose build          # rebuild images after dependency changes
docker compose logs -f backend  # stream backend logs
```

### Local dev without Docker
```bash
bash start.sh                 # starts both backend (uvicorn) and frontend (vite) in background

# Backend only
cd backend && uvicorn main:app --reload --reload-exclude "data/*" --port 8000

# Frontend only
cd frontend && npm install && npm run dev
```

### Frontend
```bash
cd frontend
npm run dev        # dev server at http://localhost:5173
npm run build      # tsc + vite build
npm run lint       # eslint
npm run preview    # preview production build
```

## Architecture

### Data flow
The frontend talks directly to the FastAPI backend at `http://localhost:8000`. The backend proxies chat requests to Ollama (`OLLAMA_BASE_URL`, defaults to `http://host.docker.internal:11434` in Docker or `http://localhost:11434` locally). There is no auth layer.

### Frontend structure
- `App.tsx` — root layout: sidebar + page switcher with `Page` type union (`chat | training | data | health`)
- `components/Sidebar.tsx` — navigation only
- `pages/` — one file per page: `ChatPage`, `TrainingPage`, `DataPage`, `HealthPage`
- No router library — page state is a single `useState` in `App.tsx`
- Tailwind v4 is loaded as a Vite plugin (`@tailwindcss/vite`), not via PostCSS

### Backend structure
`backend/main.py` is the entire backend — FastAPI app with all routes and business logic in one file. Key sections:

- **Job store** — in-memory `jobs` dict, persisted atomically to `backend/data/jobs.json` after every mutation (survives `--reload`). All mutations go through `_update_job()` which acquires `_jobs_lock`.
- **Training** (`run_training`) — runs in FastAPI's background task thread pool. Loads `unsloth/Phi-3-mini-4k-instruct` with 4-bit QLoRA (r=16), trains with `SFTTrainer`, saves LoRA adapter to `backend/data/models/{job_id}/`.
- **Merge** (`run_merge`) — merges LoRA adapter into base model (CPU), converts to GGUF via `llama.cpp/convert_hf_to_gguf.py`, registers with Ollama CLI. Depends on llama.cpp being present at `/mnt/d/llama.cpp/`.
- **Training data** — `.jsonl` files in `backend/data/training/`. Supports three record formats: `messages[]` (chat template), `instruction/input/output` (Alpaca), or raw `text`.

### Key API endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Ollama reachability + system/GPU metrics |
| GET | `/models` | List Ollama models |
| POST | `/chat` | SSE stream from Ollama |
| POST | `/train` | Upload `.jsonl` + start training job |
| GET | `/train/{job_id}/status` | Poll training progress (0–100) |
| POST | `/train/{job_id}/merge` | Start LoRA→GGUF→Ollama pipeline |
| GET | `/jobs` | List all jobs |
| DELETE | `/train/{job_id}` | Delete job + files |
| GET | `/data/files` | List training files |
| DELETE | `/data/files/{filename}` | Delete training file |

### Host path dependencies (hardcoded)
The system assumes these paths exist on the host:
- `/mnt/d/hf-cache` — Hugging Face model cache (base model must be pre-downloaded)
- `/mnt/d/ollama-models` — Ollama model storage
- `/mnt/d/llama.cpp` — llama.cpp repo with `convert_hf_to_gguf.py`

All are mounted as Docker volumes and referenced directly in the backend. The base model (`unsloth/Phi-3-mini-4k-instruct`) must already exist in the HF cache — `HF_HUB_OFFLINE=1` is set at startup.

### GPU requirement
The backend Docker image is `nvidia/cuda:12.6.0-cudnn-runtime-ubuntu24.04`. The compose file requests all NVIDIA GPUs. Training will fail without a CUDA-capable GPU.
