import base64
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

import pymupdf  # PyMuPDF
import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
RUNS_DIR = BASE_DIR / "runs"
STATIC_DIR = BASE_DIR / "static"
RUNS_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR.mkdir(parents=True, exist_ok=True)

# Official prompt for Unlimited-OCR
DEFAULT_PROMPT = "<image>document parsing."

# Official OmniDocBench / Unlimited-OCR post-processing cleaner
DET_RE = re.compile(r"<\|det\|>([^<\s]+)(?:\s*\[[^\]]*\])?\s*<\|/det\|>(.*)", re.DOTALL)
LINE_BOX_RE = re.compile(
    r"^([a-zA-Z_]+)\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*(.*)$"
)

SETTINGS = {
    "base_url": os.getenv("VLLM_BASE_URL", "http://213.173.105.27:16666/v1"),
    "model": os.getenv("MODEL_NAME", "sahilchachra/Unlimited-OCR-NVFP4"),
    "api_key": os.getenv("VLLM_API_KEY", "EMPTY"),
}
JOBS: Dict[str, dict] = {}

app = FastAPI(title="Unlimited-OCR NVFP4 Runner")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/runs_data", StaticFiles(directory=str(RUNS_DIR)), name="runs_data")


class SettingsUpdate(BaseModel):
    base_url: Optional[str] = None
    model: Optional[str] = None


def get_client():
    return OpenAI(base_url=SETTINGS["base_url"], api_key=SETTINGS["api_key"])


def encode_image(file_path: Path) -> str:
    ext = file_path.suffix.lower()
    mime = "image/jpeg" if ext in [".jpg", ".jpeg"] else "image/png"
    with open(file_path, "rb") as f:
        data = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{data}"


def clean_markdown_from_raw(raw: str) -> str:
    """Official post-processing function from Unlimited-OCR repo to convert output to clean text/markdown."""
    blocks = []
    cur = None
    for line in raw.splitlines():
        line = line.rstrip()
        if not line:
            continue

        # Check standard <|det|> format
        m = DET_RE.match(line)
        if m:
            category, content = m.group(1).strip(), m.group(2).strip()
            if category.lower() == "image":
                continue
            if cur is not None:
                blocks.append(cur)
            cur = [content] if content else []
            continue

        # Check raw line box format (label [x1, y1, x2, y2] text)
        m2 = LINE_BOX_RE.match(line)
        if m2:
            category, content = m2.group(1).strip(), m2.group(6).strip()
            if category.lower() == "image":
                continue
            if cur is not None:
                blocks.append(cur)
            cur = [content] if content else []
            continue

        if cur is None:
            cur = []
        cur.append(line)

    if cur is not None:
        blocks.append(cur)
    return "\n\n".join("\n".join(b) for b in blocks).strip()


def parse_output(raw_text: str):
    """Extracts bounding box objects for UI overlays and extracts clean markdown."""
    blocks = []
    for line in raw_text.splitlines():
        line_str = line.strip()
        if not line_str:
            continue

        m = LINE_BOX_RE.match(line_str)
        if m:
            label = m.group(1).strip()
            bbox = [int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))]
            content = m.group(6).strip()
            if label.lower() != "image" and content:
                blocks.append({"label": label, "bbox": bbox, "text": content})
        else:
            if blocks and line_str:
                blocks[-1]["text"] += "\n" + line_str

    parsed_markdown = clean_markdown_from_raw(raw_text)
    return blocks, parsed_markdown


def run_ocr_task(job_id: str, run_name: str, file_path: Path, mode: str):
    job = JOBS[job_id]
    job["status"] = "running"
    run_dir = RUNS_DIR / run_name
    run_dir.mkdir(parents=True, exist_ok=True)

    try:
        pages_to_process = []
        is_pdf = file_path.suffix.lower() == ".pdf"

        if is_pdf:
            doc = pymupdf.open(file_path)
            mat = pymupdf.Matrix(2.0, 2.0)
            job["total"] = len(doc)
            for idx, page in enumerate(doc):
                img_path = run_dir / f"page_{idx + 1:04d}.png"
                page.get_pixmap(matrix=mat).save(str(img_path))
                pages_to_process.append((idx + 1, img_path))
            doc.close()
        else:
            job["total"] = 1
            dest_img = run_dir / f"page_0001{file_path.suffix.lower()}"
            shutil.copyfile(file_path, dest_img)
            pages_to_process.append((1, dest_img))

        client = get_client()
        pages_result = []

        for pno, img_path in pages_to_process:
            b64_url = encode_image(img_path)

            # Use the verified working native prompt
            response = client.chat.completions.create(
                model=SETTINGS["model"],
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": DEFAULT_PROMPT},
                            {"type": "image_url", "image_url": {"url": b64_url}},
                        ],
                    }
                ],
                temperature=0.0,
                max_tokens=8192,
            )

            raw = response.choices[0].message.content or ""
            blocks, clean_md = parse_output(raw)

            # If user selected markdown mode, clear blocks so the UI directly renders clean text
            display_blocks = [] if mode == "markdown" else blocks

            pages_result.append(
                {
                    "page": pno,
                    "image": f"/runs_data/{run_name}/{img_path.name}",
                    "raw": raw,
                    "parsed": clean_md,
                    "blocks": display_blocks,
                }
            )
            job["done"] += 1

        run_manifest = {
            "name": run_name,
            "title": file_path.name,
            "mode": mode,
            "page_count": len(pages_result),
            "modified": int(time.time()),
            "pages": pages_result,
        }
        with open(run_dir / "meta.json", "w") as f:
            json.dump(run_manifest, f, indent=2)

        job["status"] = "done"

    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
    finally:
        if file_path.exists():
            file_path.unlink()


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = BASE_DIR / "static/index.html"
    return HTMLResponse(content=index_file.read_text(encoding="utf-8"))


@app.get("/api/settings")
async def get_settings():
    reachable = False
    error = None
    try:
        client = get_client()
        client.models.list()
        reachable = True
    except Exception as e:
        error = str(e)

    return {
        "base_url": SETTINGS["base_url"],
        "model": SETTINGS["model"],
        "reachable": reachable,
        "error": error,
        "serving": "vLLM",
    }


@app.put("/api/settings")
async def update_settings(payload: SettingsUpdate):
    if payload.base_url:
        SETTINGS["base_url"] = payload.base_url.rstrip("/")
    if payload.model:
        SETTINGS["model"] = payload.model
    return await get_settings()


@app.get("/api/jobs")
async def list_jobs():
    return list(JOBS.values())


@app.delete("/api/jobs/{job_id}")
async def dismiss_job(job_id: str):
    if job_id in JOBS:
        del JOBS[job_id]
    return {"status": "ok"}


@app.get("/api/runs")
async def list_runs():
    runs = []
    for item in RUNS_DIR.iterdir():
        if item.is_dir() and (item / "meta.json").exists():
            try:
                with open(item / "meta.json") as f:
                    runs.append(json.load(f))
            except Exception:
                pass
    runs.sort(key=lambda r: r.get("modified", 0), reverse=True)
    return runs


@app.get("/api/runs/{name}")
async def get_run(name: str):
    meta_path = RUNS_DIR / name / "meta.json"
    if not meta_path.exists():
        raise HTTPException(status_code=404, detail="Run not found")
    with open(meta_path) as f:
        return json.load(f)


@app.delete("/api/runs/{name}")
async def delete_run(name: str):
    run_dir = RUNS_DIR / name
    if run_dir.exists() and run_dir.is_dir():
        shutil.rmtree(run_dir)
    return {"status": "ok"}


@app.post("/api/runs")
async def create_run(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    mode: str = Form("native"),
):
    clean_name = re.sub(
        r"[^a-zA-Z0-9_\-]+", "_", name or file.filename.rsplit(".", 1)[0]
    )
    run_name = f"{clean_name}_{int(time.time())}"
    job_id = str(uuid.uuid4())

    tmp_ext = Path(file.filename).suffix
    tmp_path = BASE_DIR / f"temp_{job_id}{tmp_ext}"
    with open(tmp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    JOBS[job_id] = {
        "id": job_id,
        "name": run_name,
        "status": "running",
        "total": 0,
        "done": 0,
        "error": None,
    }

    background_tasks.add_task(run_ocr_task, job_id, run_name, tmp_path, mode)
    return {"id": job_id, "name": run_name}


if __name__ == "__main__":
    uvicorn.run("api:app", host="0.0.0.0", port=8003, reload=True)
