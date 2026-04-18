import os
import uuid
import json
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psutil
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HOME"] = "/mnt/d/hf-cache"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

OLLAMA_BASE = "http://localhost:11434"
LLAMA_CPP_CONVERT = Path("/mnt/d/llama.cpp/convert_hf_to_gguf.py")
PYTHON = "/usr/bin/python3"
TRAINING_DIR = Path(__file__).parent / "data" / "training"
MODELS_DIR = Path(__file__).parent / "data" / "models"
JOBS_FILE = Path(__file__).parent / "data" / "jobs.json"
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


class ChatRequest(BaseModel):
    message: str
    model: str


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

    except Exception as exc:
        _update_job(job_id, status="failed", error=str(exc))


def run_merge(job_id: str) -> None:
    """
    Blocking function executed in FastAPI's threadpool via BackgroundTasks.
    Merges the LoRA adapter into the base model, converts to GGUF via
    llama.cpp, then registers the result in Ollama via CLI.
    """
    import shutil

    adapter_dir = MODELS_DIR / job_id
    merged_hf_dir = adapter_dir / "merged_hf"
    gguf_dir = adapter_dir / "gguf"
    gguf_path = gguf_dir / "model-f16.gguf"
    modelfile_path = gguf_dir / "Modelfile"
    model_name = f"nexus-{job_id[:8]}"

    print(f"[merge] adapter_dir:   {adapter_dir}")
    print(f"[merge] merged_hf_dir: {merged_hf_dir}")
    print(f"[merge] gguf_dir:      {gguf_dir}")
    print(f"[merge] gguf_path:     {gguf_path}")

    assert adapter_dir is not None, "adapter_dir is None"
    assert merged_hf_dir is not None, "merged_hf_dir is None"
    assert gguf_dir is not None, "gguf_dir is None"
    assert gguf_path is not None, "gguf_path is None"

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

    except Exception as exc:
        _update_job(job_id, status="merge_failed", error=str(exc))


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
async def train(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    """Save the uploaded .jsonl file then kick off a background training job."""
    if not file.filename or not file.filename.endswith(".jsonl"):
        raise HTTPException(status_code=400, detail="Only .jsonl files are accepted.")

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
async def list_jobs():
    """Return all jobs sorted by most recent first."""
    with _jobs_lock:
        snapshot = dict(jobs)
    result = [{"job_id": k, **v} for k, v in snapshot.items()]
    result.sort(key=lambda j: j.get("created_at", ""), reverse=True)
    return result


@app.post("/train/{job_id}/merge")
async def merge(job_id: str, background_tasks: BackgroundTasks):
    """Merge the trained LoRA adapter, export to GGUF, and register in Ollama as 'nexus'."""
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
