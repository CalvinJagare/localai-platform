import uuid
import os
import json
from pathlib import Path

import httpx
import psutil
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

OLLAMA_BASE = "http://localhost:11434"
TRAINING_DIR = Path(__file__).parent / "data" / "training"
TRAINING_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="LocalAI Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    model: str


@app.post("/chat")
async def chat(req: ChatRequest):
    """Stream a response from Ollama for the given message and model."""
    payload = {
        "model": req.model,
        "messages": [{"role": "user", "content": req.message}],
        "stream": True,
    }

    async def generate():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream("POST", f"{OLLAMA_BASE}/api/chat", json=payload) as resp:
                if resp.status_code != 200:
                    yield f"data: {json.dumps({'error': 'Ollama returned ' + str(resp.status_code)})}\n\n"
                    return
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        token = chunk.get("message", {}).get("content", "")
                        done = chunk.get("done", False)
                        yield f"data: {json.dumps({'token': token, 'done': done})}\n\n"
                        if done:
                            break
                    except json.JSONDecodeError:
                        continue

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/train")
async def train(file: UploadFile = File(...)):
    """Save an uploaded .jsonl training file and return a job_id."""
    if not file.filename or not file.filename.endswith(".jsonl"):
        raise HTTPException(status_code=400, detail="Only .jsonl files are accepted.")

    job_id = str(uuid.uuid4())
    dest = TRAINING_DIR / f"{job_id}_{file.filename}"

    contents = await file.read()
    dest.write_bytes(contents)

    return {"job_id": job_id, "filename": file.filename, "size_bytes": len(contents), "status": "uploaded"}


@app.get("/models")
async def models():
    """Return the list of models available in Ollama."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            return {"models": [m["name"] for m in data.get("models", [])]}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Cannot reach Ollama: {exc}")


@app.get("/health")
async def health():
    """Return Ollama reachability, model list, and host system metrics."""
    ollama_ok = False
    model_list = []
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            if resp.status_code == 200:
                ollama_ok = True
                model_list = [m["name"] for m in resp.json().get("models", [])]
    except Exception:
        pass

    mem = psutil.virtual_memory()
    cpu_percent = psutil.cpu_percent(interval=0.2)

    # GPU info via nvidia-smi if available
    gpu_info = None
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.used,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            gpu_info = result.stdout.strip()
    except Exception:
        pass

    return {
        "ollama": {"reachable": ollama_ok, "models": model_list},
        "system": {
            "cpu_percent": cpu_percent,
            "ram_total_gb": round(mem.total / 1e9, 2),
            "ram_used_gb": round(mem.used / 1e9, 2),
            "ram_percent": mem.percent,
        },
        "gpu": gpu_info,
    }
