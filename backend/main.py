import os
import re
import uuid
import json
import glob
import shutil
import subprocess
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psutil
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HOME"] = "/mnt/d/hf-cache"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

if not os.environ.get("OLLAMA_MODELS"):
    os.environ["OLLAMA_MODELS"] = "/mnt/d/ollama-models"
Path(os.environ["OLLAMA_MODELS"]).mkdir(parents=True, exist_ok=True)

OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
LLAMA_CPP_CONVERT = Path("/mnt/d/llama.cpp/convert_hf_to_gguf.py")
PYTHON = "/usr/bin/python3"
TRAINING_DIR = Path(__file__).parent / "data" / "training"
MODELS_DIR = Path(__file__).parent / "data" / "models"
JOBS_FILE = Path(__file__).parent / "data" / "jobs.json"
PROFILES_FILE = Path(__file__).parent / "data" / "profiles.json"
TRAINING_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="LocalAI Platform")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Job store — backed by /data/jobs.json so state survives --reload restarts
# ---------------------------------------------------------------------------

_jobs_lock = threading.Lock()


def _load_jobs() -> dict[str, dict]:
    try:
        return json.loads(JOBS_FILE.read_text())
    except Exception:
        return {}


def _save_jobs() -> None:
    """Atomically write jobs dict to disk. Must be called under _jobs_lock."""
    tmp = JOBS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(jobs, indent=2))
    tmp.replace(JOBS_FILE)


def _update_job(job_id: str, **kwargs) -> None:
    """Thread-safe update of a job's fields and persist to disk."""
    with _jobs_lock:
        jobs[job_id].update(kwargs)
        _save_jobs()


# Initialise from disk so a --reload doesn't lose running jobs
jobs: dict[str, dict] = _load_jobs()

# ---------------------------------------------------------------------------
# Profile store — backed by /data/profiles.json
# ---------------------------------------------------------------------------

_profiles_lock = threading.Lock()


def _load_profiles() -> dict[str, dict]:
    try:
        return json.loads(PROFILES_FILE.read_text())
    except Exception:
        return {}


def _save_profiles() -> None:
    """Atomically write profiles dict to disk. Must be called under _profiles_lock."""
    tmp = PROFILES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(profiles, indent=2))
    tmp.replace(PROFILES_FILE)


def _get_default_profile_id() -> str | None:
    """Return the ID of the 'default' slug profile, or the first profile. Call under _profiles_lock."""
    for pid, p in profiles.items():
        if p.get("slug") == "default":
            return pid
    return next(iter(profiles), None)


def _ensure_default_profile() -> None:
    """Create a Default profile if none exist, and assign orphan jobs to it."""
    with _profiles_lock:
        if not profiles:
            pid = str(uuid.uuid4())
            profiles[pid] = {
                "slug": "default",
                "display_name": "Default",
                "color": "indigo",
                "current_model": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            _save_profiles()
        default_pid = _get_default_profile_id()

    if default_pid:
        with _jobs_lock:
            changed = False
            for job in jobs.values():
                if not job.get("profile_id"):
                    job["profile_id"] = default_pid
                    changed = True
            if changed:
                _save_jobs()


def make_slug(display_name: str) -> str:
    s = display_name.lower().strip()
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "profile"


profiles: dict[str, dict] = _load_profiles()
_ensure_default_profile()

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    message: str
    model: str


class ProfileCreate(BaseModel):
    display_name: str
    color: str = "indigo"


class ProfileUpdate(BaseModel):
    display_name: str


# ---------------------------------------------------------------------------
# Training helper
# ---------------------------------------------------------------------------

def _format_record(record: dict, tokenizer) -> str:
    """Convert a .jsonl record to a training string."""
    if "messages" in record:
        return tokenizer.apply_chat_template(record["messages"], tokenize=False)
    if "instruction" in record:
        text = f"### Instruction:\n{record['instruction']}\n"
        if record.get("input"):
            text += f"### Input:\n{record['input']}\n"
        text += f"### Response:\n{record['output']}"
        return text
    return record.get("text", json.dumps(record))


def run_training(job_id: str, data_path: Path) -> None:
    """
    Blocking function executed in FastAPI's threadpool via BackgroundTasks.
    Loads Phi-3-mini with Unsloth, fine-tunes with QLoRA, saves the adapter.
    """
    _update_job(job_id, status="training")
    output_dir = MODELS_DIR / job_id
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        # unsloth must be imported before transformers / trl / peft
        from unsloth import FastLanguageModel
        import torch
        from datasets import Dataset
        from transformers import TrainingArguments, TrainerCallback
        from trl import SFTTrainer

        # -- Load base model with 4-bit quantisation --------------------------
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name="unsloth/Phi-3-mini-4k-instruct",
            max_seq_length=2048,
            load_in_4bit=True,
        )

        # -- Attach LoRA adapters ---------------------------------------------
        model = FastLanguageModel.get_peft_model(
            model,
            r=16,
            target_modules=[
                "q_proj", "k_proj", "v_proj", "o_proj",
                "gate_proj", "up_proj", "down_proj",
            ],
            lora_alpha=16,
            lora_dropout=0,
            bias="none",
            use_gradient_checkpointing="unsloth",
        )

        # -- Build dataset ----------------------------------------------------
        records = []
        with open(data_path) as fh:
            for line in fh:
                line = line.strip()
                if line:
                    records.append(json.loads(line))

        if not records:
            raise ValueError("Training file is empty.")

        dataset = Dataset.from_list(
            [{"text": _format_record(r, tokenizer)} for r in records]
        )

        # -- Progress callback — persist to disk every 5 % to limit I/O ------
        last_pct: list[int] = [-1]

        class ProgressCallback(TrainerCallback):
            def on_step_end(self, args, state, control, **kwargs):
                if state.max_steps > 0:
                    pct = min(int(state.global_step / state.max_steps * 100), 99)
                    if pct >= last_pct[0] + 5:
                        _update_job(job_id, progress=pct)
                        last_pct[0] = pct

        # -- Train ------------------------------------------------------------
        trainer = SFTTrainer(
            model=model,
            tokenizer=tokenizer,
            train_dataset=dataset,
            dataset_text_field="text",
            max_seq_length=2048,
            args=TrainingArguments(
                per_device_train_batch_size=2,
                gradient_accumulation_steps=4,
                num_train_epochs=3,
                learning_rate=2e-4,
                fp16=not torch.cuda.is_bf16_supported(),
                bf16=torch.cuda.is_bf16_supported(),
                logging_steps=1,
                output_dir=str(output_dir / "checkpoints"),
                optim="adamw_8bit",
                seed=42,
            ),
            callbacks=[ProgressCallback()],
        )

        trainer.train()

        # -- Save adapter to /data/models/{job_id}/ ---------------------------
        model.save_pretrained(str(output_dir))
        tokenizer.save_pretrained(str(output_dir))

        _update_job(job_id, status="complete", progress=100, error=None)

    except Exception:
        _update_job(job_id, status="failed", error=traceback.format_exc())


def run_merge(job_id: str) -> None:
    """
    Blocking function executed in FastAPI's threadpool via BackgroundTasks.
    Merges the LoRA adapter into the base model, converts to GGUF via
    llama.cpp, then registers the result in Ollama via CLI.
    """
    adapter_dir = MODELS_DIR / job_id
    merged_hf_dir = adapter_dir / "merged_hf"
    gguf_dir = adapter_dir / "gguf"
    gguf_path = gguf_dir / "model-f16.gguf"
    modelfile_path = gguf_dir / "Modelfile"

    with _jobs_lock:
        job_snapshot = dict(jobs[job_id])

    profile_id = job_snapshot.get("profile_id")

    # Model name = profile slug (e.g. "sales"), fallback to legacy model_name field
    if profile_id:
        with _profiles_lock:
            profile = profiles.get(profile_id)
        model_name = profile["slug"] if profile else job_snapshot.get("model_name") or f"nexus-{job_id[:8]}"
    else:
        model_name = job_snapshot.get("model_name") or f"nexus-{job_id[:8]}"

    print(f"[merge] adapter_dir:   {adapter_dir}")
    print(f"[merge] merged_hf_dir: {merged_hf_dir}")
    print(f"[merge] gguf_dir:      {gguf_dir}")
    print(f"[merge] gguf_path:     {gguf_path}")
    print(f"[merge] model_name:    {model_name}  (profile_id: {profile_id})")

    if not adapter_dir.exists():
        _update_job(job_id, status="merge_failed",
                    error=f"Adapter directory not found: {adapter_dir}")
        return

    try:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HOME"] = "/mnt/d/hf-cache"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        # Resolve the base model to its absolute snapshot path on disk so we
        # never pass a repo-ID string through transformers' cache lookup
        # (which can hit a NoneType.endswith error on certain cached metadata).
        snapshots_dir = (
            Path(os.environ["HF_HOME"])
            / "hub"
            / "models--unsloth--Phi-3-mini-4k-instruct"
            / "snapshots"
        )
        if not snapshots_dir.exists():
            raise RuntimeError(f"Base model cache not found at {snapshots_dir}")
        snapshots = sorted(snapshots_dir.iterdir())
        if not snapshots:
            raise RuntimeError(f"No snapshots in {snapshots_dir}")
        base_model_path = str(snapshots[-1])
        print(f"[merge] base_model_path: {base_model_path}")

        tokenizer = AutoTokenizer.from_pretrained(
            str(adapter_dir),
            local_files_only=True,
        )
        # Load base model in full precision on CPU to avoid bitsandbytes quant issues
        model = AutoModelForCausalLM.from_pretrained(
            base_model_path,
            torch_dtype="auto",
            device_map="cpu",
            local_files_only=True,
        )
        model = PeftModel.from_pretrained(model, str(adapter_dir))
        model = model.merge_and_unload()

        if merged_hf_dir.exists():
            shutil.rmtree(merged_hf_dir)
        merged_hf_dir.mkdir(parents=True)
        model.save_pretrained(str(merged_hf_dir))
        tokenizer.save_pretrained(str(merged_hf_dir))
        del model

        # Convert merged HF model to GGUF via llama.cpp
        gguf_dir.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            [PYTHON, str(LLAMA_CPP_CONVERT), str(merged_hf_dir),
             "--outtype", "f16",
             "--outfile", str(gguf_path)],
            capture_output=True, text=True, timeout=3600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"GGUF conversion failed:\n{result.stderr or result.stdout}")

        # Register model in Ollama via CLI
        modelfile_path.write_text(f"FROM {gguf_path}\n")
        result = subprocess.run(
            ["/usr/local/bin/ollama", "create", model_name, "-f", str(modelfile_path)],
            capture_output=True, text=True, timeout=1800,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Ollama registration failed:\n{result.stderr or result.stdout}")

        _update_job(job_id, status="merged", ollama_model=model_name, error=None)

        # Update the profile's active model
        if profile_id:
            with _profiles_lock:
                if profile_id in profiles:
                    profiles[profile_id]["current_model"] = model_name
                    _save_profiles()

    except Exception:
        _update_job(job_id, status="merge_failed", error=traceback.format_exc())


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

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
async def train(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    profile_id: str = Form(""),
):
    """Save the uploaded .jsonl file then kick off a background training job."""
    if not file.filename or not file.filename.endswith(".jsonl"):
        raise HTTPException(status_code=400, detail="Only .jsonl files are accepted.")

    # Resolve profile: validate if provided, fall back to default
    resolved_profile_id = profile_id or ""
    with _profiles_lock:
        if resolved_profile_id and resolved_profile_id not in profiles:
            raise HTTPException(status_code=400, detail="Profile not found.")
        if not resolved_profile_id:
            resolved_profile_id = _get_default_profile_id() or ""
        model_name = profiles[resolved_profile_id]["slug"] if resolved_profile_id in profiles else "nexus"

    job_id = str(uuid.uuid4())
    dest = TRAINING_DIR / f"{job_id}_{file.filename}"

    contents = await file.read()
    dest.write_bytes(contents)

    with _jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "error": None,
            "filename": file.filename,
            "model_name": model_name,
            "profile_id": resolved_profile_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_jobs()
    background_tasks.add_task(run_training, job_id, dest)

    return {
        "job_id": job_id,
        "filename": file.filename,
        "size_bytes": len(contents),
        "status": "queued",
    }


@app.get("/train/{job_id}/status")
async def train_status(job_id: str):
    """Return the current status and progress (0-100) of a training job."""
    with _jobs_lock:
        if job_id not in jobs:
            raise HTTPException(status_code=404, detail="Job not found.")
        job = dict(jobs[job_id])  # snapshot under lock
    return {
        "status": job["status"],
        "progress": job["progress"],
        "error": job.get("error"),
        "ollama_model": job.get("ollama_model"),
    }


@app.get("/jobs")
async def list_jobs(profile_id: str | None = None):
    """Return jobs sorted by most recent first, optionally filtered by profile."""
    with _jobs_lock:
        snapshot = dict(jobs)
    result = [{"job_id": k, **v} for k, v in snapshot.items()]
    if profile_id:
        result = [j for j in result if j.get("profile_id") == profile_id]
    result.sort(key=lambda j: j.get("created_at", ""), reverse=True)
    return result


@app.delete("/train/{job_id}")
async def delete_job(job_id: str):
    """Delete a job record and its associated model/training files."""
    with _jobs_lock:
        if job_id not in jobs:
            raise HTTPException(status_code=404, detail="Job not found.")
        if jobs[job_id]["status"] in ("training", "merging"):
            raise HTTPException(status_code=400, detail="Cannot delete an active job.")
        del jobs[job_id]
        _save_jobs()

    # Clean up model directory
    model_dir = MODELS_DIR / job_id
    if model_dir.exists():
        shutil.rmtree(model_dir, ignore_errors=True)

    # Clean up training file(s)
    for f in glob.glob(str(TRAINING_DIR / f"{job_id}_*")):
        try:
            Path(f).unlink()
        except Exception:
            pass

    return {"deleted": job_id}


@app.post("/train/{job_id}/merge")
async def merge(job_id: str, background_tasks: BackgroundTasks):
    """Merge the trained LoRA adapter, export to GGUF, and register in Ollama."""
    with _jobs_lock:
        if job_id not in jobs:
            raise HTTPException(status_code=404, detail="Job not found.")
        current_status = jobs[job_id]["status"]

    if current_status not in ("complete", "merge_failed"):
        raise HTTPException(
            status_code=400,
            detail=f"Job must be 'complete' or 'merge_failed' to merge (current: {current_status}).",
        )

    _update_job(job_id, status="merging", error=None)
    background_tasks.add_task(run_merge, job_id)

    return {"status": "merging"}


# ---------------------------------------------------------------------------
# Profile routes
# ---------------------------------------------------------------------------

@app.get("/profiles")
async def list_profiles():
    """Return all profiles with a denormalized job count."""
    with _profiles_lock:
        profiles_snapshot = dict(profiles)
    with _jobs_lock:
        jobs_snapshot = dict(jobs)

    result = []
    for pid, p in profiles_snapshot.items():
        job_count = sum(1 for j in jobs_snapshot.values() if j.get("profile_id") == pid)
        result.append({"id": pid, **p, "job_count": job_count})
    result.sort(key=lambda p: p.get("created_at", ""))
    return result


@app.post("/profiles", status_code=201)
async def create_profile(body: ProfileCreate):
    """Create a new profile. Slug is auto-generated from display_name."""
    base_slug = make_slug(body.display_name)
    with _profiles_lock:
        existing_slugs = {p["slug"] for p in profiles.values()}
        slug = base_slug
        n = 2
        while slug in existing_slugs:
            slug = f"{base_slug}-{n}"
            n += 1
        pid = str(uuid.uuid4())
        profiles[pid] = {
            "slug": slug,
            "display_name": body.display_name,
            "color": body.color,
            "current_model": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_profiles()
    return {"id": pid, **profiles[pid]}


@app.patch("/profiles/{profile_id}")
async def update_profile(profile_id: str, body: ProfileUpdate):
    """Rename a profile's display name. Slug is immutable."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
        profiles[profile_id]["display_name"] = body.display_name
        _save_profiles()
        return {"id": profile_id, **profiles[profile_id]}


@app.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str):
    """Delete a profile. Fails if the profile has active training or merge jobs."""
    with _jobs_lock:
        active = any(
            j.get("profile_id") == profile_id and j["status"] in ("training", "merging")
            for j in jobs.values()
        )
    if active:
        raise HTTPException(status_code=400, detail="Cannot delete a profile with active jobs.")

    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
        del profiles[profile_id]
        _save_profiles()
    return {"deleted": profile_id}


# ---------------------------------------------------------------------------
# Data routes
# ---------------------------------------------------------------------------

@app.get("/data/files")
async def list_data_files():
    """Return metadata for every .jsonl file in the training directory."""
    files = []
    for path in sorted(TRAINING_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = path.stat()
        try:
            line_count = sum(1 for line in path.open() if line.strip())
        except Exception:
            line_count = 0
        files.append({
            "filename": path.name,
            "display_name": path.name[37:] if len(path.name) > 37 and path.name[36] == "_" else path.name,
            "size_bytes": stat.st_size,
            "line_count": line_count,
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return files


@app.get("/data/files/{filename}/preview")
async def preview_data_file(filename: str):
    """Return the first 5 parsed JSON records from a training file."""
    safe = Path(filename).name
    path = TRAINING_DIR / safe
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    records = []
    try:
        with path.open() as fh:
            for line in fh:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
                if len(records) >= 5:
                    break
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not parse file: {exc}")
    return {"records": records}


@app.delete("/data/files/{filename}")
async def delete_data_file(filename: str):
    """Delete a training file from disk."""
    safe = Path(filename).name
    path = TRAINING_DIR / safe
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    path.unlink()
    return {"deleted": safe}


# ---------------------------------------------------------------------------
# Misc routes
# ---------------------------------------------------------------------------

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

    gpu_info = None
    try:
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
