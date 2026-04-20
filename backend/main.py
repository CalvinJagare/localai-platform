import ast
import operator
import os
import re
import sys
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
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# ---------------------------------------------------------------------------
# Bootstrap: settings.json is always at this fixed location so we can read
# path overrides before any other constants are defined.
# ---------------------------------------------------------------------------
SETTINGS_FILE = Path(__file__).parent / "data" / "settings.json"
SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)

def _read_startup_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except Exception:
        return {}

_startup = _read_startup_settings()

# Configurable paths — read from settings.json, fall back to hardcoded defaults
DATA_ROOT          = Path(_startup.get("DATA_ROOT",          Path(__file__).parent / "data"))
HF_CACHE_PATH      = Path(_startup.get("HF_CACHE_PATH",      "/mnt/d/hf-cache"))
OLLAMA_MODELS_PATH = Path(_startup.get("OLLAMA_MODELS_PATH", "/mnt/d/ollama-models"))
LLAMA_CPP_PATH     = Path(_startup.get("LLAMA_CPP_PATH",     "/mnt/d/llama.cpp"))

# Apply path settings to environment
os.environ["HF_HOME"]      = str(HF_CACHE_PATH)
os.environ["OLLAMA_MODELS"] = str(OLLAMA_MODELS_PATH)
OLLAMA_MODELS_PATH.mkdir(parents=True, exist_ok=True)

OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
LLAMA_CPP_CONVERT = LLAMA_CPP_PATH / "convert_hf_to_gguf.py"
PYTHON = "/usr/bin/python3"

# Data paths — all rooted at DATA_ROOT
TRAINING_DIR     = DATA_ROOT / "training"
MODELS_DIR       = DATA_ROOT / "models"
JOBS_FILE        = DATA_ROOT / "jobs.json"
PROFILES_FILE    = DATA_ROOT / "profiles.json"
INSTRUCTIONS_DIR = DATA_ROOT / "instructions"
RAG_DIR          = DATA_ROOT / "rag"

SETUP_FILE = DATA_ROOT / "setup.json"

TRAINING_DIR.mkdir(parents=True, exist_ok=True)
MODELS_DIR.mkdir(parents=True, exist_ok=True)
INSTRUCTIONS_DIR.mkdir(parents=True, exist_ok=True)
RAG_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Supported base models — used by setup wizard and training pipeline
# ---------------------------------------------------------------------------

SUPPORTED_MODELS: dict[str, dict] = {
    "phi3-mini": {
        "id":      "unsloth/Phi-3-mini-4k-instruct",
        "name":    "Phi-3 Mini 3.8B",
        "vram_gb": 4,
        "size_gb": 2.2,
    },
    "llama32-3b": {
        "id":      "unsloth/Llama-3.2-3B-Instruct",
        "name":    "Llama 3.2 3B",
        "vram_gb": 4,
        "size_gb": 2.0,
    },
    "mistral-7b": {
        "id":      "unsloth/mistral-7b-instruct-v0.3",
        "name":    "Mistral 7B",
        "vram_gb": 8,
        "size_gb": 4.1,
    },
    "llama31-8b": {
        "id":      "unsloth/Meta-Llama-3.1-8B-Instruct",
        "name":    "Llama 3.1 8B",
        "vram_gb": 8,
        "size_gb": 4.7,
    },
}

def _hf_cache_dir_name(model_id: str) -> str:
    """Convert a HuggingFace repo ID to its local cache directory name."""
    return "models--" + model_id.replace("/", "--")

def _load_setup() -> dict:
    try:
        return json.loads(SETUP_FILE.read_text())
    except Exception:
        return {}

def _save_setup(data: dict) -> None:
    tmp = SETUP_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(SETUP_FILE)

# Read chosen base model from setup.json; default to Phi-3 Mini
BASE_MODEL: str = _load_setup().get("base_model", SUPPORTED_MODELS["phi3-mini"]["id"])

app = FastAPI(title="skAIler")

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
                "base_profile_id": None,
                "enabled_tools": [],
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
# Settings store — backed by /data/settings.json
# ---------------------------------------------------------------------------

_settings_lock = threading.Lock()


def _load_settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except Exception:
        return {}


def _save_settings(data: dict) -> None:
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(SETTINGS_FILE)


# ---------------------------------------------------------------------------
# RAG store — per-profile document chunks + lazy BM25 index
# ---------------------------------------------------------------------------

_rag_lock = threading.Lock()
_rag_chunks: dict[str, list[str]] = {}   # profile_id → flat chunk list (loaded lazily)
_rag_bm25:   dict[str, object]    = {}   # profile_id → BM25Okapi (invalidated on change)

# In-memory only — loss values captured during active training, not persisted
_job_loss_history: dict[str, list[float]] = {}


def _rag_manifest_path(profile_id: str) -> Path:
    return RAG_DIR / profile_id / "manifest.json"


def _rag_chunks_path(profile_id: str) -> Path:
    return RAG_DIR / profile_id / "chunks.json"


def _load_rag_manifest(profile_id: str) -> list[dict]:
    try:
        return json.loads(_rag_manifest_path(profile_id).read_text())
    except Exception:
        return []


def _save_rag_manifest(profile_id: str, manifest: list[dict]) -> None:
    path = _rag_manifest_path(profile_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    tmp.replace(path)


def _load_rag_chunks_from_disk(profile_id: str) -> list[str]:
    try:
        return json.loads(_rag_chunks_path(profile_id).read_text())
    except Exception:
        return []


def _save_rag_chunks_to_disk(profile_id: str, chunks: list[str]) -> None:
    path = _rag_chunks_path(profile_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(chunks))
    tmp.replace(path)


def _chunk_text(text: str, chunk_size: int = 400, overlap: int = 50) -> list[str]:
    """Split text into overlapping word-level chunks."""
    words = text.split()
    if not words:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(words):
        end = min(start + chunk_size, len(words))
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start += chunk_size - overlap
    return chunks


def _parse_document(path: Path) -> str:
    """Extract plain text from PDF, .txt, or .md file."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path))
            parts = [page.extract_text() or "" for page in reader.pages]
            return "\n\n".join(p for p in parts if p.strip())
        except Exception as exc:
            raise ValueError(f"Could not parse PDF: {exc}")
    elif suffix in (".txt", ".md"):
        return path.read_text(errors="replace")
    raise ValueError(f"Unsupported file type: {suffix}")


def _ensure_rag_loaded(profile_id: str) -> None:
    """Load chunks from disk into memory if not already loaded. Call under _rag_lock."""
    if profile_id not in _rag_chunks:
        _rag_chunks[profile_id] = _load_rag_chunks_from_disk(profile_id)


def _get_bm25(profile_id: str):
    """Return BM25 index for a profile, building it if needed. Call under _rag_lock."""
    _ensure_rag_loaded(profile_id)
    if profile_id not in _rag_bm25:
        chunks = _rag_chunks.get(profile_id, [])
        if chunks:
            from rank_bm25 import BM25Okapi
            _rag_bm25[profile_id] = BM25Okapi([c.lower().split() for c in chunks])
    return _rag_bm25.get(profile_id)


def _retrieve_context(profile_id: str, query: str, top_k: int = 3) -> tuple[str, list[str]]:
    """Return (context_text, source_filenames) for top-K BM25 chunks."""
    if not query.strip():
        return "", []
    with _rag_lock:
        index = _get_bm25(profile_id)
        if index is None:
            return "", []
        chunks = _rag_chunks.get(profile_id, [])
        scores = index.get_scores(query.lower().split())
        top_indices = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:top_k]
        selected_indices = [i for i in top_indices if scores[i] > 0]
        selected_chunks = [chunks[i] for i in selected_indices]

    if not selected_chunks:
        return "", []

    # Map chunk indices back to document filenames
    manifest = _load_rag_manifest(profile_id)
    sources: list[str] = []
    for idx in selected_indices:
        for doc in manifest:
            if doc["chunk_start"] <= idx < doc["chunk_start"] + doc["chunk_count"]:
                if doc["filename"] not in sources:
                    sources.append(doc["filename"])
                break

    return "\n\n---\n\n".join(selected_chunks), sources


# ---------------------------------------------------------------------------
# Tool registry — add new tools here, no other changes needed
# ---------------------------------------------------------------------------

TOOL_REGISTRY = [
    {
        "id": "datetime",
        "name": "Date & Time",
        "description": "Provides the current date and time to the model.",
        "requires_key": None,
        "definition": {
            "type": "function",
            "function": {
                "name": "get_datetime",
                "description": "Get the current date and time.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
    },
    {
        "id": "calculator",
        "name": "Calculator",
        "description": "Evaluates mathematical expressions (no API key required).",
        "requires_key": None,
        "definition": {
            "type": "function",
            "function": {
                "name": "calculate",
                "description": "Evaluate a mathematical expression and return the numeric result.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "expression": {"type": "string", "description": "e.g. '12 * 3.5 + 7'"}
                    },
                    "required": ["expression"],
                },
            },
        },
    },
    {
        "id": "web_search",
        "name": "Web Search",
        "description": "Search the internet via Brave Search API.",
        "requires_key": "BRAVE_API_KEY",
        "definition": {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": (
                    "Search the web for current information — news, prices, facts, "
                    "or anything that may have changed recently."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The search query"}
                    },
                    "required": ["query"],
                },
            },
        },
    },
    {
        "id": "wiki_search",
        "name": "Wikipedia",
        "description": "Look up factual information from Wikipedia. No API key required.",
        "requires_key": None,
        "definition": {
            "type": "function",
            "function": {
                "name": "wiki_search",
                "description": "Look up a topic on Wikipedia and return a summary.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Topic or question to look up"}
                    },
                    "required": ["query"],
                },
            },
        },
    },
    {
        "id": "weather",
        "name": "Weather",
        "description": "Get current weather for any city via OpenWeatherMap.",
        "requires_key": "OPENWEATHER_API_KEY",
        "definition": {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather conditions for a location.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City name, e.g. 'Stockholm' or 'New York, US'"}
                    },
                    "required": ["location"],
                },
            },
        },
    },
]

TOOL_BY_ID = {t["id"]: t for t in TOOL_REGISTRY}


def _safe_calc(expr: str) -> str:
    """Evaluate a math expression using only AST — no eval()."""
    _ops: dict = {
        ast.Add: operator.add, ast.Sub: operator.sub,
        ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.Pow: operator.pow, ast.Mod: operator.mod,
        ast.USub: operator.neg, ast.UAdd: operator.pos,
    }

    def _eval(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp):
            op = _ops.get(type(node.op))
            if op is None:
                raise ValueError(f"Unsupported operator {type(node.op).__name__}")
            return op(_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp):
            op = _ops.get(type(node.op))
            if op is None:
                raise ValueError(f"Unsupported operator {type(node.op).__name__}")
            return op(_eval(node.operand))
        raise ValueError(f"Unsupported expression node {type(node).__name__}")

    try:
        tree = ast.parse(expr.strip(), mode="eval")
        result = _eval(tree.body)
        return f"{expr} = {result}"
    except Exception as exc:
        return f"Could not evaluate '{expr}': {exc}"


async def _execute_tool(name: str, arguments: dict, settings: dict) -> str:
    if name == "get_datetime":
        return datetime.now().strftime("Current date and time: %A, %B %d, %Y at %H:%M:%S")

    if name == "calculate":
        return _safe_calc(arguments.get("expression", ""))

    if name == "web_search":
        query = arguments.get("query", "")
        api_key = settings.get("BRAVE_API_KEY", "")
        if not api_key:
            return "Web search is not configured — no Brave API key found."
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params={"q": query, "count": 3},
                    headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
                )
                resp.raise_for_status()
                results = resp.json().get("web", {}).get("results", [])
                if not results:
                    return "No results found."
                lines = []
                for r in results[:3]:
                    lines.append(f"**{r.get('title','')}**\n{r.get('description','')}\n{r.get('url','')}")
                return "\n\n".join(lines)
        except Exception as exc:
            return f"Search failed: {exc}"

    if name == "wiki_search":
        query = arguments.get("query", "")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                # Step 1: find best matching article title
                search_resp = await client.get(
                    "https://en.wikipedia.org/w/api.php",
                    params={"action": "query", "format": "json", "list": "search",
                            "srsearch": query, "srlimit": 1},
                )
                search_resp.raise_for_status()
                results = search_resp.json().get("query", {}).get("search", [])
                if not results:
                    return "No Wikipedia article found for that query."
                title = results[0]["title"]
                # Step 2: fetch intro extract
                extract_resp = await client.get(
                    "https://en.wikipedia.org/w/api.php",
                    params={"action": "query", "format": "json", "titles": title,
                            "prop": "extracts", "exintro": True, "explaintext": True,
                            "exsectionformat": "plain"},
                )
                extract_resp.raise_for_status()
                pages = extract_resp.json().get("query", {}).get("pages", {})
                extract = next(iter(pages.values()), {}).get("extract", "").strip()
                if len(extract) > 600:
                    extract = extract[:600] + "…"
                return f"**{title}**\n{extract}" if extract else f"No summary found for '{title}'."
        except Exception as exc:
            return f"Wikipedia lookup failed: {exc}"

    if name == "get_weather":
        location = arguments.get("location", "")
        api_key = settings.get("OPENWEATHER_API_KEY", "")
        if not api_key:
            return "Weather is not configured — add an OpenWeatherMap API key in Settings."
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://api.openweathermap.org/data/2.5/weather",
                    params={"q": location, "appid": api_key, "units": "metric"},
                )
                if resp.status_code == 404:
                    return f"Location '{location}' not found."
                resp.raise_for_status()
                data = resp.json()
                temp     = data["main"]["temp"]
                feels    = data["main"]["feels_like"]
                desc     = data["weather"][0]["description"].capitalize()
                humidity = data["main"]["humidity"]
                wind     = data["wind"]["speed"]
                city     = data.get("name", location)
                return f"{city}: {desc}, {temp:.1f}°C (feels like {feels:.1f}°C), humidity {humidity}%, wind {wind} m/s"
        except Exception as exc:
            return f"Weather lookup failed: {exc}"

    return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class ChatRequest(BaseModel):
    messages: list[dict]
    model: str
    profile_id: str = ""


class ProfileCreate(BaseModel):
    display_name: str
    color: str = "indigo"
    base_profile_id: str | None = None
    enabled_tools: list[str] = []


class ProfileUpdate(BaseModel):
    display_name: str | None = None
    base_profile_id: str | None = None
    enabled_tools: list[str] | None = None


class DatasetFetchRequest(BaseModel):
    url: str
    filename: str


class SettingsUpdate(BaseModel):
    data: dict[str, str]


class TrainFromFileRequest(BaseModel):
    filename: str
    profile_id: str = ""
    epochs: int = 3
    start_fresh: bool = False


# ---------------------------------------------------------------------------
# Training helper
# ---------------------------------------------------------------------------

def _format_record(record: dict, tokenizer) -> str:
    """Convert a .jsonl record to a training string."""
    if "messages" in record:
        return tokenizer.apply_chat_template(record["messages"], tokenize=False)
    if "instruction" in record:
        text = f"### Instruction:\n{record['instruction']}\n"
        ctx = record.get("input") or record.get("context")
        if ctx:
            text += f"### Input:\n{ctx}\n"
        output = record.get("output") or record.get("response", "")
        text += f"### Response:\n{output}"
        return text
    return record.get("text", json.dumps(record))


def run_training(job_id: str, data_path: Path) -> None:
    """
    Blocking function executed in FastAPI's threadpool via BackgroundTasks.
    Loads the configured base model with Unsloth, fine-tunes with QLoRA, saves the adapter.
    If base_model_override is set on the job, trains on top of that model instead.
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

        with _jobs_lock:
            base_model_override = jobs[job_id].get("base_model_override")

        base_model = base_model_override or BASE_MODEL
        print(f"[train] base_model: {base_model}")

        # -- Load base model with 4-bit quantisation --------------------------
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=base_model,
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
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

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
                        # Capture latest loss value (in-memory only)
                        if state.log_history:
                            loss_vals = [h["loss"] for h in state.log_history if "loss" in h]
                            if loss_vals:
                                _job_loss_history.setdefault(job_id, []).append(round(loss_vals[-1], 4))
                        last_pct[0] = pct

        with _jobs_lock:
            epochs = jobs[job_id].get("epochs", 3)

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
                num_train_epochs=epochs,
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

    base_model_override = job_snapshot.get("base_model_override")

    if not adapter_dir.exists():
        _update_job(job_id, status="merge_failed",
                    error=f"Adapter directory not found: {adapter_dir}")
        return

    try:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["HF_HOME"] = str(HF_CACHE_PATH)
        os.environ["TRANSFORMERS_OFFLINE"] = "1"

        from peft import PeftModel
        from transformers import AutoModelForCausalLM, AutoTokenizer

        # Use the same base the training job started from
        if base_model_override and Path(base_model_override).exists():
            base_model_path = base_model_override
            print(f"[merge] continuing from: {base_model_path}")
        else:
            # Resolve the base model to its absolute snapshot path on disk so we
            # never pass a repo-ID string through transformers' cache lookup
            # (which can hit a NoneType.endswith error on certain cached metadata).
            snapshots_dir = (
                Path(os.environ["HF_HOME"])
                / "hub"
                / _hf_cache_dir_name(BASE_MODEL)
                / "snapshots"
            )
            if not snapshots_dir.exists():
                raise RuntimeError(f"Base model cache not found at {snapshots_dir}")
            snapshots = sorted(snapshots_dir.iterdir())
            if not snapshots:
                raise RuntimeError(f"No snapshots in {snapshots_dir}")
            base_model_path = str(snapshots[-1])
            print(f"[merge] base_model_path: {base_model_path}")

        _update_job(job_id, merge_step="Loading base model and LoRA adapter…")
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
        _update_job(job_id, merge_step="Merging LoRA weights into base model…")
        model = PeftModel.from_pretrained(model, str(adapter_dir))
        model = model.merge_and_unload()

        if merged_hf_dir.exists():
            shutil.rmtree(merged_hf_dir)
        merged_hf_dir.mkdir(parents=True)
        model.save_pretrained(str(merged_hf_dir))
        tokenizer.save_pretrained(str(merged_hf_dir))
        del model

        _update_job(job_id, merge_step="Converting to GGUF (this takes a few minutes)…")
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

        _update_job(job_id, merge_step="Registering model in Ollama…")
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
    """Stream a response from Ollama, injecting system instructions and executing tools as needed."""
    # Build message list — prepend system prompt from profile's .md instruction files
    messages: list[dict] = list(req.messages)
    system_parts: list[str] = []
    if req.profile_id:
        profile_instr_dir = INSTRUCTIONS_DIR / req.profile_id
        if profile_instr_dir.exists():
            for md_file in sorted(profile_instr_dir.glob("*.md")):
                try:
                    text = md_file.read_text().strip()
                    if text:
                        system_parts.append(text)
                except Exception:
                    pass

    # Inject RAG context for the last user query
    rag_sources: list[str] = []
    if req.profile_id:
        last_user = next((m["content"] for m in reversed(req.messages) if m["role"] == "user"), "")
        rag_context, rag_sources = _retrieve_context(req.profile_id, last_user)
        if rag_context:
            system_parts.append(f"Relevant document excerpts (use these to answer if applicable):\n\n{rag_context}")

    if system_parts:
        messages = [{"role": "system", "content": "\n\n---\n\n".join(system_parts)}] + messages

    # Build tools list from profile's enabled tools
    tools: list[dict] = []
    if req.profile_id:
        with _profiles_lock:
            profile_data = profiles.get(req.profile_id, {})
        settings = _load_settings()
        for tool_id in profile_data.get("enabled_tools", []):
            entry = TOOL_BY_ID.get(tool_id)
            if not entry:
                continue
            req_key = entry.get("requires_key")
            if req_key is None or settings.get(req_key):
                tools.append(entry["definition"])

    async def generate():
        current_messages = list(messages)

        if rag_sources:
            yield f"data: {json.dumps({'type': 'rag_sources', 'sources': rag_sources})}\n\n"

        async with httpx.AsyncClient(timeout=120) as client:
            if tools:
                # Non-streaming first call — detect tool use
                first = await client.post(
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": req.model, "messages": current_messages, "stream": False, "tools": tools},
                )
                if first.status_code != 200:
                    yield f"data: {json.dumps({'error': 'Ollama returned ' + str(first.status_code)})}\n\n"
                    return

                msg = first.json().get("message", {})

                if msg.get("tool_calls"):
                    current_messages.append(msg)
                    tool_settings = _load_settings()

                    for tc in msg["tool_calls"]:
                        fn_name = tc["function"]["name"]
                        fn_args = tc["function"].get("arguments", {})
                        yield f"data: {json.dumps({'type': 'tool_call', 'tool': fn_name, 'args': fn_args})}\n\n"
                        result = await _execute_tool(fn_name, fn_args, tool_settings)
                        yield f"data: {json.dumps({'type': 'tool_result', 'tool': fn_name, 'result': result})}\n\n"
                        current_messages.append({"role": "tool", "content": result})

                    # Stream final answer after tool execution
                    async with client.stream(
                        "POST", f"{OLLAMA_BASE}/api/chat",
                        json={"model": req.model, "messages": current_messages, "stream": True},
                    ) as resp:
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
                else:
                    # Model chose not to use any tools — emit content as single chunk
                    content = msg.get("content", "")
                    yield f"data: {json.dumps({'token': content, 'done': False})}\n\n"
                    yield f"data: {json.dumps({'token': '', 'done': True})}\n\n"
            else:
                # No tools enabled — stream directly
                async with client.stream(
                    "POST", f"{OLLAMA_BASE}/api/chat",
                    json={"model": req.model, "messages": current_messages, "stream": True},
                ) as resp:
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


def _resolve_base_model(resolved_profile_id: str, start_fresh: bool) -> str | None:
    """Return the best base model path for a new training job, or None to use BASE_MODEL."""
    base_model_override: str | None = None
    if not start_fresh and resolved_profile_id:
        with _jobs_lock:
            merged_jobs = [
                (k, v) for k, v in jobs.items()
                if v.get("profile_id") == resolved_profile_id and v.get("status") == "merged"
            ]
        if merged_jobs:
            latest_job_id = max(merged_jobs, key=lambda x: x[1].get("created_at", ""))[0]
            candidate = MODELS_DIR / latest_job_id / "merged_hf"
            if candidate.exists():
                base_model_override = str(candidate)

    if base_model_override is None and resolved_profile_id:
        with _profiles_lock:
            base_profile_id = profiles.get(resolved_profile_id, {}).get("base_profile_id")
        if base_profile_id:
            with _jobs_lock:
                base_merged = [
                    (k, v) for k, v in jobs.items()
                    if v.get("profile_id") == base_profile_id and v.get("status") == "merged"
                ]
            if base_merged:
                latest_base = max(base_merged, key=lambda x: x[1].get("created_at", ""))[0]
                candidate = MODELS_DIR / latest_base / "merged_hf"
                if candidate.exists():
                    base_model_override = str(candidate)

    return base_model_override


@app.post("/train")
async def train(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    profile_id: str = Form(""),
    epochs: int = Form(3),
    start_fresh: bool = Form(False),
):
    """Save the uploaded .jsonl file then kick off a background training job."""
    if not file.filename or not file.filename.endswith(".jsonl"):
        raise HTTPException(status_code=400, detail="Only .jsonl files are accepted.")

    resolved_profile_id = profile_id or ""
    with _profiles_lock:
        if resolved_profile_id and resolved_profile_id not in profiles:
            raise HTTPException(status_code=400, detail="Profile not found.")
        if not resolved_profile_id:
            resolved_profile_id = _get_default_profile_id() or ""
        model_name = profiles[resolved_profile_id]["slug"] if resolved_profile_id in profiles else "nexus"

    base_model_override = _resolve_base_model(resolved_profile_id, start_fresh)

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
            "base_model_override": base_model_override,
            "epochs": max(1, min(epochs, 20)),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_jobs()
    background_tasks.add_task(run_training, job_id, dest)

    return {
        "job_id": job_id,
        "filename": file.filename,
        "size_bytes": len(contents),
        "status": "queued",
        "base_model_override": base_model_override,
    }


@app.post("/train/from-file")
async def train_from_file(body: TrainFromFileRequest, background_tasks: BackgroundTasks):
    """Start a training job against an already-stored file in the training library."""
    safe = Path(body.filename).name
    data_path = TRAINING_DIR / safe
    if not data_path.exists():
        raise HTTPException(status_code=404, detail=f"Training file not found: {safe}")

    resolved_profile_id = body.profile_id or ""
    with _profiles_lock:
        if resolved_profile_id and resolved_profile_id not in profiles:
            raise HTTPException(status_code=400, detail="Profile not found.")
        if not resolved_profile_id:
            resolved_profile_id = _get_default_profile_id() or ""
        model_name = profiles[resolved_profile_id]["slug"] if resolved_profile_id in profiles else "nexus"

    base_model_override = _resolve_base_model(resolved_profile_id, body.start_fresh)

    # Display name strips the leading uuid_ prefix if present
    display_name = safe[37:] if len(safe) > 37 and safe[36] == "_" else safe

    job_id = str(uuid.uuid4())
    with _jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "progress": 0,
            "error": None,
            "filename": display_name,
            "model_name": model_name,
            "profile_id": resolved_profile_id,
            "base_model_override": base_model_override,
            "epochs": max(1, min(body.epochs, 20)),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_jobs()
    background_tasks.add_task(run_training, job_id, data_path)

    return {
        "job_id": job_id,
        "filename": display_name,
        "status": "queued",
        "base_model_override": base_model_override,
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
        "merge_step": job.get("merge_step"),
        "loss_history": _job_loss_history.get(job_id, []),
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
        result.append({
            "id": pid,
            **p,
            "job_count": job_count,
            "base_profile_id": p.get("base_profile_id"),
            "enabled_tools": p.get("enabled_tools", []),
        })
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
        if body.base_profile_id and body.base_profile_id not in profiles:
            raise HTTPException(status_code=400, detail="Base profile not found.")
        pid = str(uuid.uuid4())
        profiles[pid] = {
            "slug": slug,
            "display_name": body.display_name,
            "color": body.color,
            "current_model": None,
            "base_profile_id": body.base_profile_id,
            "enabled_tools": body.enabled_tools,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        _save_profiles()
    return {"id": pid, **profiles[pid]}


@app.patch("/profiles/{profile_id}")
async def update_profile(profile_id: str, body: ProfileUpdate):
    """Update a profile's display name and/or base profile. Slug is immutable."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
        updated = body.model_fields_set
        if "display_name" in updated and body.display_name:
            profiles[profile_id]["display_name"] = body.display_name
        if "base_profile_id" in updated:
            if body.base_profile_id and body.base_profile_id not in profiles:
                raise HTTPException(status_code=400, detail="Base profile not found.")
            if body.base_profile_id == profile_id:
                raise HTTPException(status_code=400, detail="A profile cannot be its own base.")
            profiles[profile_id]["base_profile_id"] = body.base_profile_id
        if "enabled_tools" in updated:
            profiles[profile_id]["enabled_tools"] = body.enabled_tools or []
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

    # Clean up instruction files for this profile
    profile_instr_dir = INSTRUCTIONS_DIR / profile_id
    if profile_instr_dir.exists():
        shutil.rmtree(profile_instr_dir, ignore_errors=True)

    # Clean up RAG docs and invalidate in-memory index
    profile_rag_dir = RAG_DIR / profile_id
    if profile_rag_dir.exists():
        shutil.rmtree(profile_rag_dir, ignore_errors=True)
    with _rag_lock:
        _rag_chunks.pop(profile_id, None)
        _rag_bm25.pop(profile_id, None)

    return {"deleted": profile_id}


# ---------------------------------------------------------------------------
# Instruction routes
# ---------------------------------------------------------------------------

@app.get("/profiles/{profile_id}/instructions")
async def list_instructions(profile_id: str):
    """List all .md instruction files for a profile."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
    profile_instr_dir = INSTRUCTIONS_DIR / profile_id
    profile_instr_dir.mkdir(exist_ok=True)
    files = []
    for path in sorted(profile_instr_dir.glob("*.md")):
        try:
            content = path.read_text()
        except Exception:
            content = ""
        files.append({
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "word_count": len(content.split()),
            "content": content,
        })
    return files


@app.post("/profiles/{profile_id}/instructions", status_code=201)
async def create_instruction(
    profile_id: str,
    file: UploadFile | None = File(None),
    filename: str = Form(""),
    content: str = Form(""),
):
    """Upload a .md file or create one inline. Accepts multipart (file upload) or form fields (inline)."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")

    profile_instr_dir = INSTRUCTIONS_DIR / profile_id
    profile_instr_dir.mkdir(exist_ok=True)

    if file is not None:
        safe = Path(file.filename or "instruction.md").name
        if not safe.endswith(".md"):
            safe += ".md"
        dest = profile_instr_dir / safe
        dest.write_bytes(await file.read())
    else:
        if not filename.strip():
            raise HTTPException(status_code=400, detail="filename is required for inline creation.")
        safe = Path(filename.strip()).name
        if not safe.endswith(".md"):
            safe += ".md"
        dest = profile_instr_dir / safe
        dest.write_text(content)

    return {
        "filename": dest.name,
        "size_bytes": dest.stat().st_size,
        "word_count": len(dest.read_text().split()),
        "content": dest.read_text(),
    }


@app.put("/profiles/{profile_id}/instructions/{filename}")
async def update_instruction(profile_id: str, filename: str, content: str = Form(...)):
    """Overwrite the content of an existing instruction file."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
    safe = Path(filename).name
    path = INSTRUCTIONS_DIR / profile_id / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="Instruction file not found.")
    path.write_text(content)
    return {
        "filename": safe,
        "size_bytes": path.stat().st_size,
        "word_count": len(content.split()),
        "content": content,
    }


@app.delete("/profiles/{profile_id}/instructions/{filename}")
async def delete_instruction(profile_id: str, filename: str):
    """Delete an instruction file."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
    safe = Path(filename).name
    path = INSTRUCTIONS_DIR / profile_id / safe
    if not path.exists():
        raise HTTPException(status_code=404, detail="Instruction file not found.")
    path.unlink()
    return {"deleted": safe}


# ---------------------------------------------------------------------------
# RAG / Document routes
# ---------------------------------------------------------------------------

@app.get("/profiles/{profile_id}/rag")
async def list_rag_docs(profile_id: str):
    """Return the document manifest for a profile."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")
    return _load_rag_manifest(profile_id)


@app.post("/profiles/{profile_id}/rag", status_code=201)
async def upload_rag_doc(profile_id: str, file: UploadFile = File(...)):
    """Upload a PDF, .txt, or .md document. Text is chunked and indexed for BM25 retrieval."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")

    original_name = Path(file.filename or "document").name
    suffix = Path(original_name).suffix.lower()
    if suffix not in (".pdf", ".txt", ".md"):
        raise HTTPException(status_code=400, detail="Only PDF, .txt, and .md files are accepted.")

    doc_id = str(uuid.uuid4())
    doc_dir = RAG_DIR / profile_id / "docs"
    doc_dir.mkdir(parents=True, exist_ok=True)
    doc_path = doc_dir / f"{doc_id}_{original_name}"

    contents = await file.read()
    doc_path.write_bytes(contents)

    try:
        text = _parse_document(doc_path)
    except ValueError as exc:
        doc_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=str(exc))

    new_chunks = _chunk_text(text)

    with _rag_lock:
        _ensure_rag_loaded(profile_id)
        manifest = _load_rag_manifest(profile_id)
        chunk_start = len(_rag_chunks.get(profile_id, []))
        _rag_chunks.setdefault(profile_id, []).extend(new_chunks)
        _save_rag_chunks_to_disk(profile_id, _rag_chunks[profile_id])
        # Invalidate stale BM25 index
        _rag_bm25.pop(profile_id, None)

    entry = {
        "doc_id": doc_id,
        "filename": original_name,
        "chunk_start": chunk_start,
        "chunk_count": len(new_chunks),
        "size_bytes": len(contents),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest.append(entry)
    _save_rag_manifest(profile_id, manifest)

    return entry


@app.delete("/profiles/{profile_id}/rag/{doc_id}")
async def delete_rag_doc(profile_id: str, doc_id: str):
    """Remove a document and its chunks from the index."""
    with _profiles_lock:
        if profile_id not in profiles:
            raise HTTPException(status_code=404, detail="Profile not found.")

    manifest = _load_rag_manifest(profile_id)
    entry = next((d for d in manifest if d["doc_id"] == doc_id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    # Delete raw file
    doc_dir = RAG_DIR / profile_id / "docs"
    for f in doc_dir.glob(f"{doc_id}_*"):
        f.unlink(missing_ok=True)

    # Remove chunks from memory + disk; fix chunk_start offsets for subsequent docs
    with _rag_lock:
        _ensure_rag_loaded(profile_id)
        start = entry["chunk_start"]
        count = entry["chunk_count"]
        chunks = _rag_chunks.get(profile_id, [])
        chunks[start:start + count] = []
        _rag_chunks[profile_id] = chunks
        _save_rag_chunks_to_disk(profile_id, chunks)
        _rag_bm25.pop(profile_id, None)

    # Rebuild chunk_start offsets for all docs after the deleted one
    updated_manifest = [d for d in manifest if d["doc_id"] != doc_id]
    offset = 0
    for d in updated_manifest:
        d["chunk_start"] = offset
        offset += d["chunk_count"]
    _save_rag_manifest(profile_id, updated_manifest)

    return {"deleted": doc_id}


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


@app.post("/data/fetch")
async def fetch_dataset(req: DatasetFetchRequest):
    """Download a dataset from a URL, auto-convert JSON arrays to JSONL, save to training dir."""
    safe_name = Path(req.filename).name
    if not safe_name.endswith(".jsonl"):
        safe_name = safe_name.rsplit(".", 1)[0] + ".jsonl"
    dest = TRAINING_DIR / safe_name

    try:
        async with httpx.AsyncClient(timeout=180, follow_redirects=True) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
            content = resp.content
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}")

    # Auto-convert JSON arrays to JSONL
    try:
        data = json.loads(content)
        if isinstance(data, list):
            lines = [json.dumps(item) for item in data]
            content = ("\n".join(lines) + "\n").encode()
    except (json.JSONDecodeError, ValueError):
        pass  # already JSONL, use as-is

    dest.write_bytes(content)
    line_count = sum(1 for line in dest.open() if line.strip())

    return {
        "filename": safe_name,
        "size_bytes": len(content),
        "line_count": line_count,
    }


# ---------------------------------------------------------------------------
# Tool & settings routes
# ---------------------------------------------------------------------------

@app.get("/tools")
async def list_tools():
    """Return all registered tools with availability status."""
    with _settings_lock:
        settings = _load_settings()
    result = []
    for entry in TOOL_REGISTRY:
        req_key = entry.get("requires_key")
        result.append({
            "id": entry["id"],
            "name": entry["name"],
            "description": entry["description"],
            "requires_key": req_key,
            "key_configured": req_key is None or bool(settings.get(req_key)),
        })
    return result


_PATH_KEYS = {"DATA_ROOT", "HF_CACHE_PATH", "OLLAMA_MODELS_PATH", "LLAMA_CPP_PATH"}

@app.get("/settings")
async def get_settings():
    """Return settings — API keys are masked, path keys are returned as-is."""
    with _settings_lock:
        data = _load_settings()
    masked = {}
    for k, v in data.items():
        if k in _PATH_KEYS:
            masked[k] = v
        else:
            masked[k] = ("•" * max(0, len(v) - 4) + v[-4:]) if v and len(v) > 4 else v
    return masked


@app.put("/settings")
async def update_settings(body: SettingsUpdate):
    """Update settings. Values starting with '•' are treated as unchanged (masked)."""
    with _settings_lock:
        current = _load_settings()
        for k, v in body.data.items():
            if v and not v.startswith("•"):
                current[k] = v
            elif not v:
                current.pop(k, None)
        _save_settings(current)
    return {"updated": [k for k, v in body.data.items() if v and not v.startswith("•")]}


@app.get("/config")
async def get_config():
    """Return the currently active runtime paths (reflect what's running now)."""
    return {
        "DATA_ROOT":          str(DATA_ROOT),
        "HF_CACHE_PATH":      str(HF_CACHE_PATH),
        "OLLAMA_MODELS_PATH": str(OLLAMA_MODELS_PATH),
        "LLAMA_CPP_PATH":     str(LLAMA_CPP_PATH),
    }


@app.post("/restart")
async def restart_backend(background_tasks: BackgroundTasks):
    """Replace the running process with a fresh copy — applies saved settings."""
    import time

    def _do_restart():
        time.sleep(0.4)  # let the response flush before we replace the process
        os.execv(sys.executable, [sys.executable] + sys.argv)

    background_tasks.add_task(_do_restart)
    return {"message": "Restarting…"}


# ---------------------------------------------------------------------------
# Misc routes
# ---------------------------------------------------------------------------

@app.get("/models")
async def models():
    """Return models available in Ollama with size and associated profile."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            resp.raise_for_status()
            raw = resp.json().get("models", [])
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Cannot reach Ollama: {exc}")

    with _profiles_lock:
        profiles_snap = dict(profiles)

    # Build a map: model_name → profile
    model_to_profile: dict[str, dict] = {}
    for pid, p in profiles_snap.items():
        if p.get("current_model"):
            model_to_profile[p["current_model"]] = {"id": pid, "display_name": p["display_name"], "color": p["color"]}

    result = []
    for m in raw:
        name = m["name"]
        result.append({
            "name": name,
            "size_bytes": m.get("size", 0),
            "modified_at": m.get("modified_at", ""),
            "profile": model_to_profile.get(name),
        })
    return result


@app.delete("/models/{model_name:path}")
async def delete_model(model_name: str):
    """Remove a model from Ollama and clear it from any profile that references it."""
    result = subprocess.run(
        ["/usr/local/bin/ollama", "rm", model_name],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=result.stderr.strip() or "Failed to delete model")

    # Clear from any profile that was using this model
    with _profiles_lock:
        changed = False
        for p in profiles.values():
            if p.get("current_model") == model_name:
                p["current_model"] = None
                changed = True
        if changed:
            _save_profiles()

    return {"deleted": model_name}


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


# ---------------------------------------------------------------------------
# Setup endpoints — used by the setup wizard on first launch
# ---------------------------------------------------------------------------

import queue as _queue_mod


class DownloadModelRequest(BaseModel):
    key: str  # one of the SUPPORTED_MODELS keys


@app.get("/setup/status")
async def setup_status():
    """Return whether initial setup has been completed and which base model was chosen."""
    data = _load_setup()
    return {
        "complete":   data.get("complete", False),
        "mode":       data.get("mode", "local"),
        "base_model": data.get("base_model", SUPPORTED_MODELS["phi3-mini"]["id"]),
    }


@app.get("/setup/models")
async def setup_models():
    """Return the list of supported base models with VRAM/size metadata."""
    return [{"key": k, **v} for k, v in SUPPORTED_MODELS.items()]


@app.get("/setup/disk-info")
async def disk_info(path: str = str(DATA_ROOT)):
    """Return free and total disk space for the given path."""
    import shutil
    try:
        usage = shutil.disk_usage(path)
        return {
            "path":     path,
            "free_gb":  round(usage.free  / 1e9, 1),
            "total_gb": round(usage.total / 1e9, 1),
            "used_gb":  round(usage.used  / 1e9, 1),
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/setup/download-model")
async def download_model(body: DownloadModelRequest):
    """
    Stream the download of a base model from HuggingFace as SSE progress events.
    Temporarily disables HF_HUB_OFFLINE during download, then re-enables it.
    Writes setup.json on completion.

    # TODO v2: add POST /setup/cancel-download to interrupt and clean up partial downloads.
    """
    if body.key not in SUPPORTED_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model key: {body.key}")

    model_info = SUPPORTED_MODELS[body.key]
    model_id   = model_info["id"]
    expected_bytes = int(model_info["size_gb"] * 1e9)

    async def stream():
        done_q: _queue_mod.Queue = _queue_mod.Queue()

        def do_download():
            # Temporarily allow HF downloads
            os.environ.pop("HF_HUB_OFFLINE",       None)
            os.environ.pop("TRANSFORMERS_OFFLINE",  None)
            try:
                from huggingface_hub import snapshot_download
                snapshot_download(repo_id=model_id, cache_dir=str(HF_CACHE_PATH))
                done_q.put(("done", None))
            except Exception as exc:
                done_q.put(("error", str(exc)))
            finally:
                # Always restore offline mode
                os.environ["HF_HUB_OFFLINE"]      = "1"
                os.environ["TRANSFORMERS_OFFLINE"] = "1"

        thread = threading.Thread(target=do_download, daemon=True)
        thread.start()

        cache_dir = HF_CACHE_PATH / "hub" / _hf_cache_dir_name(model_id)

        while True:
            try:
                msg_type, msg = done_q.get(timeout=1.0)
                if msg_type == "done":
                    global BASE_MODEL
                    BASE_MODEL = model_id
                    _save_setup({"complete": True, "mode": "local", "base_model": model_id})
                    yield f"data: {json.dumps({'type': 'done', 'model_id': model_id})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'error', 'message': msg})}\n\n"
                break
            except _queue_mod.Empty:
                current_bytes = (
                    sum(f.stat().st_size for f in cache_dir.rglob("*") if f.is_file())
                    if cache_dir.exists() else 0
                )
                pct = min(99, int(current_bytes / expected_bytes * 100)) if expected_bytes else 0
                yield f"data: {json.dumps({'type': 'progress', 'pct': pct})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
