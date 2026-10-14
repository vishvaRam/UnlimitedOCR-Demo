# Unlimited-OCR NVFP4 Viewer

A web viewer and inference interface for **Unlimited-OCR NVFP4** (`sahilchachra/Unlimited-OCR-NVFP4` based on `baidu/Unlimited-OCR`), served via an OpenAI-compatible **vLLM** backend.

This tool enables document parsing for single images and multi-page PDFs, providing interactive side-by-side layout grounding, bounding-box inspection, and formatted Markdown rendering.

---

## Features

* **Interactive Layout Grounding**: Visualizes bounding boxes directly on rendered document pages with synchronized card selection, hover highlighting, and category chips filtering (`title`, `text`, `table`, etc.).
* **Two Core Parsing Modes**:
* **Native Unlimited-OCR**: Preserves detection markers and overlays bounding boxes side-by-side with recognized text cards.
* **Markdown View**: Automatically runs OmniDocBench/Unlimited-OCR post-processing to strip token markers and bounding coordinates, delivering clean Markdown.
* **Asynchronous PDF Processing**: Background job execution with live status and progress polling for multi-page PDF documents.
* **Zero Custom Parser Bloat**: Direct OpenAI-compatible API interaction using standard PyMuPDF page rendering—no reliance on external packages like `dots_ocr`.
* **Math & Markdown Support**: Native formatting powered by `marked.js` and `KaTeX`.

---

## Project Structure

```text
Unlimited-OCR-NVFP4/
├── static/
│   ├── app.css            # Dark/light adaptive dashboard styling
│   └── app.js             # Viewer interactions, bounding-box overlays, and API polling
│   └── index.html         # Main dashboard UI and run configuration dialog
├── api.py                 # FastAPI backend handling PyMuPDF rendering and vLLM calls
├── ocr_engine.py          # Standalone inference client / CLI testing tool
└── requirements.txt       # Project dependencies

```

---

## Prerequisites

* Python 3.12+
* An active **vLLM** instance serving `sahilchachra/Unlimited-OCR-NVFP4` (e.g., `[http://213.173.105.27:16666/v1](http://213.173.105.27:16666/v1)`)

---

## Installation

1. **Install dependencies**:

```bash
pip install -r requirements.txt

```

*(or using `uv`)*:

```bash
uv pip install -r requirements.txt

```

---

## Configuration & Usage

1. **Environment Configuration**:
   Create a `.env` file or export your environment variables:

```ini
VLLM_BASE_URL=http://vLLM-url/v1
MODEL_NAME=sahilchachra/Unlimited-OCR-NVFP4
VLLM_API_KEY=EMPTY

```

(Endpoints can also be updated dynamically in the UI via the **Model server** settings dialog).

2. **Start the API & Viewer**:

```bash
python api.py

```

3. **Access the Interface**:
   Open `http://localhost:8003` in your browser.

* Click **New run** or drag and drop a PDF or image into the window.
* Choose **Native Unlimited-OCR** (with bounding boxes) or **Markdown View** (clean document layout).
* Inspect bounding boxes, extracted text, and rendered markdown side-by-side.
