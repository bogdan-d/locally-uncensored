<div align="center">

<img src="logos/LU-monogram-bw.png" alt="Locally Uncensored" width="80">

# Locally Uncensored

**Generate anything — text, images, video. Locally. Uncensored.**

No cloud. No data collection. No API keys. Auto-detects 12 local backends. Your AI, your rules.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![GitHub stars](https://img.shields.io/github/stars/PurpleDoubleD/locally-uncensored?style=social)](https://github.com/PurpleDoubleD/locally-uncensored/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/commits)
[![GitHub Discussions](https://img.shields.io/github/discussions/PurpleDoubleD/locally-uncensored)](https://github.com/PurpleDoubleD/locally-uncensored/discussions)
[![Discord](https://img.shields.io/discord/1496087522042843146?style=flat-square&logo=discord&label=Discord&color=5865F2)](https://locallyuncensored.com/discord)
[![Website](https://img.shields.io/badge/Website-locallyuncensored.com-8b5cf6)](https://locallyuncensored.com)

<img src="docs/demo.gif" alt="Locally Uncensored Demo" width="700">

*The only desktop app that runs AI chat, image, and video generation — locally, one click, no cloud.*

[Download](#-download) · [Features](#-features) · [Quick Start](#-quick-start) · [Why This App?](#-why-locally-uncensored) · [Roadmap](#-roadmap)

</div>

---

### Screenshots

| Chat with Personas | Image / Video Generation |
|:---:|:---:|
| ![Chat](docs/screenshots/chat_personas_dark.png) | ![Create](docs/screenshots/create_dark.png) |
| **Model Manager** | **Create View with Parameters** |
| ![Models](docs/screenshots/model_manager_dark.png) | ![Create Params](docs/screenshots/create_params_dark.png) |

---

## v2.4.9 — Current Release

**Five bug fixes + two leonsk29 feature requests on top of v2.4.8.** All user-reported (GH levoy1 / kj103x Discord / nightmare13740 Discord / leonsk29 Discord + GH).

Auto-update prompts on next launch.

### What's fixed
- **ComfyUI Desktop App is detected and accepted in onboarding** (Bug U — levoy1 GH #47). The Comfy-Org/desktop app installs to `%LOCALAPPDATA%\Programs\ComfyUI` with `ComfyUI.exe` but no `main.py` — the actual Working Directory with `main.py` / `models/` / `custom_nodes/` is at `~\Documents\ComfyUI` by default. Pre-v2.4.9 both auto-detect and manual path entry rejected the binary folder with "Invalid path — main.py not found". v2.4.9 follows the breadcrumb: when given a folder with `ComfyUI.exe`, it walks a probe list (`~\Documents\ComfyUI` / `%APPDATA%\ComfyUI` / `config.json basePath` / `%LOCALAPPDATA%\ComfyUI` / the app's bundled resources) until it finds `main.py`, and silently re-routes to the Working Directory.
- **Chats with attached RAG documents persist across NSIS auto-update / WebView2 data reset** (Bug V/a — kj103x Discord 2026-05-23). v2.3.4 closed the chat-message half (3-leg localStorage backup), but RAG embedding chunks live in IndexedDB (768-float vectors per chunk, can't fit in localStorage) and were never backed up. After an auto-update the document metadata restored but the chunks were lost — every RAG chat showed the document and returned no retrievals. v2.4.9 adds a separate 30 s / `beforeunload` IndexedDB backup → `%APPDATA%\Locally Uncensored\rag_chunks_backup.json`, restores on cold start AND on warm starts when IndexedDB is empty while the doc metadata isn't. Backup never clobbers newer in-app activity (only imports entries the live store is missing).
- **LU-spawned Ollama is killed when you quit LU** (Bug V/b — same kj103x report). Pre-v2.4.9 `ollama serve` lingered as a ~200 MB orphan with no tray icon. v2.4.9 stores the spawned `Child` on `AppState` and kills it on `Drop` using the same taskkill `/T /F` pattern as ComfyUI. The pre-spawn tasklist check stays — a user-managed Ollama that was already running when LU launched is left alone, so quitting LU never kills someone else's daemon. (Hide-to-tray via the `X` button is unaffected; Ollama only dies on a real Quit from the tray menu.)
- **Benchmark per-model display shows the latest session's tok/s, not a drifting historical average** (Bug W — nightmare13740 Discord 2026-05-23/24, Bug M retest). After the v2.4.8 server-eval-metric fix, ten benchmark runs on gemma4:e4b read 15.2 → 17.9 tok/s. Per-run measurements were stable; the UI was averaging every historical sample. v2.4.9 adds `getLatestSpeed` that groups runs into "sessions" via a 10 s timestamp gap and returns the mean of the most recent session only. Leaderboard keeps the cross-model average since that's the comparison that benefits from averaging out noise.
- **Thinking + Agent toggles light up for community-uncensored Gemma 4 builds** (Bug X — leonsk29 Discord 2026-05-24). Official `gemma4:e4b` worked but TrevorJS / nohurry / Stabhappy / LiconStudio / huihui-ai community variants pulled via `hf.co/<user>/<repo>:<quant>` had both toggles grayed out. Three stacked issues: the family-name normalizer only stripped one path segment (`hf.co/` but not `trevorjs/`), the dashed-family collapse was anchored to start-of-string (so `gemma-4-…` mid-string never normalized to `gemma4`), and the final match used `.startsWith` which couldn't see past a community prefix like `Huihui-Qwen3.5-…`. v2.4.9 rewrites `normalizeFamily` as a greedy strip + suffix/quant peel + family-dash collapse `/g`, then switches to a word-boundary contains-check so the family token can sit anywhere in the normalized name without false positives.

### What's new
- **Onboarding suggests `nomic-embed-text` for Document Chat / RAG** (GH #45 — leonsk29). New step between Models and Done that auto-detects existing embedding models (skipped with "✓ already installed" if any are present) or offers a one-click 274 MB pull. Skip button always available.
- **VRAM filter for text models in Discover** (GH #46 — leonsk29). The Lightweight ≤10 GB / Mid-Range 10–16 GB / High-End >16 GB chips that image and video already had now also filter the text tab, derived from each model's GGUF `sizeGB`. Cloud / `canPull:false` entries bypass the filter.

For previous release notes (v2.4.8 — 9 changes, v2.4.6 — 1 bug, v2.4.5 — 14 bugs), see [CHANGELOG.md](CHANGELOG.md).

---

<details>
<summary>v2.4.8 — superseded</summary>

**Hotfix: 8 fixes on top of v2.4.6.** All user-reported. v2.4.7 was tagged but not separately released; its six fixes ship together with v2.4.8.

### What's fixed
- **Text models in Discover keep their INSTALLED badge after restart** (Bug S — leonsk29 GH #43). Pre-v2.4.8 the badge only lit up if the download finished in the current session, so a model installed yesterday looked uninstalled today. v2.4.8 also matches against the provider model list (Ollama tags directly, plus GGUF downloads via `hf.co/<repo>:<quant>` references), so whatever Ollama / LM Studio actually have on disk is what the Discover grid shows.
- **`canPull:false` text models now get a clickable HuggingFace link** (Bug T — leonsk29 GH #44). Qwen 3.6 27B Samantha and GLM 5.1 754B MoE both have HF pages but no GGUF on day-one, so they show up as Available rather than downloadable. Before this they had no UI to open the HF page from inside LU. v2.4.8 adds the external-link button next to the Available badge.
- **LM Studio server-off banner is dismiss-able and matches the dropdown chrome** (Bug Q UX polish). The v2.4.7 banner that surfaces "Start LM Studio Server" in the model picker had amber styling that clashed with the rest of the dropdown. v2.4.8 switches to neutral white/gray and adds an X to dismiss. Dismiss sticks across dropdown re-opens within the same LU session but is not persisted, so the hint resurfaces on the next launch in case the user forgot to start the server.
- **Benchmark tok/s now matches actual chat throughput** (Bug M — nightmare13740 Discord). Pre-v2.4.7 the benchmark counted time-to-first-token + stream init in the tok/s denominator, so any local model looked slower in the Benchmark tab than in real chat. On nightmare13740's RTX 4070 Laptop 8 GB + gemma4:e4b: ollama CLI 30 tok/s, manual chat 23–25 tok/s, pre-fix benchmark 12 tok/s. v2.4.8 starts the clock at first-token-received and (for Ollama) prefers the server-reported `eval_count` / `eval_duration` from the final stream chunk, with a wall-clock fallback for OpenAI-compat providers when streaming gets buffered. End result: benchmark matches CLI / chat baselines on every provider.
- **Windows ComfyUI install probes `git --version` before clone** (Bug N — juliandiggins-stack GH #40). If a WSL / Linux-mounted git is first on PATH, the previous code let the clone start and die mid-flight with cryptic stderr. New tri-state probe (Native / NonNative / Missing) either proceeds silently, surfaces a clear "install Git for Windows" hint when missing, or logs a soft warning when a non-native git might still work.
- **Anthropic custom-proxy provider no longer double-prefixes `/v1`** (Bug O — 0yagizz Discord). Users pointing the Anthropic provider at a proxy (claude-relay-server, LiteLLM, opencode-zen) whose docs end the baseUrl with `/v1` got a silent 404 on `…/v1/v1/messages`. v2.4.8 collapses the duplicate.
- **Image / video generation timeouts now configurable in Settings** (Bug P — ake0n_official Discord). CPU-only / iGPU users finished sampling mid-run when the previous hard-coded 20-min image cap hit. v2.4.8 surfaces both image and video timeouts as numeric inputs (defaults stay 20 min / 60 min, range 1–480 min).
- **Chat model picker surfaces "Start LM Studio Server" inline when LM Studio is installed but its server is off** (Bug Q — wakeywakeynow GH #41). Symptom was "i am running lm studio but i can't choose any models i have installed!!!!" — root cause: LM Studio's HTTP server doesn't auto-start with the app, so the user has models on disk but the model picker silently dropped LM Studio. v2.4.8 detects the installed-but-off state and renders an inline banner in the picker with a working Start Server button; clicking it kicks off the LM Studio server via the existing `start_lmstudio_server` Tauri command and re-populates the model list without restarting LU.
- **Custom ComfyUI save nodes' outputs now surface in LU's gallery** (Bug R — silentrunningcaUSA GH Discussion #6). Pre-v2.4.8 LU only scraped `images` / `gifs` / `videos` from the history payload, missing every community workflow that uses a non-canonical save node (audio, custom metadata, CivitAI flows). v2.4.8 generic extractor accepts any keyed array of file-shaped objects.

### Stability
- `vitest`: **2306 tests** green.
- `cargo test --release`: **100 passed + 1 ignored** (incl. live `git_probe` host probe).
- `tsc --noEmit`: clean. `cargo check`: clean (pre-existing dead-code warnings only).
- No breaking changes, settings auto-migrate with safe defaults.

### Heads-up
v2.4.8 is a Windows + Linux release; macOS is not part of this build. `#bug-reports` / `#help-*` / GitHub will be monitored daily for regression reports.

Still investigating: OpenRouter half of 0yagizz's report (needs F12 console output to repro).

</details>

For older releases, see [CHANGELOG.md](CHANGELOG.md).

---

## Why Locally Uncensored?

| Feature | Locally Uncensored | Open WebUI | LM Studio | SillyTavern |
|---------|:-:|:-:|:-:|:-:|
| AI Chat | **Yes** | Yes | Yes | Yes |
| **Coding Agent (Codex)** | **Yes** | No | No | No |
| **14 Agent Tools + MCP** | **Yes** | No | No | No |
| **Plug & Play Setup** | **12 Backends** | No | Built-in | No |
| **Multi-Provider** (20+ Presets) | **Yes** | Yes | Yes | No |
| **A/B Model Compare** | **Yes** | No | No | No |
| **Local Benchmark** | **Yes** | No | No | No |
| Image Generation | **Yes** | No | No | No |
| **Image-to-Image** | **Yes** | No | No | No |
| **Image-to-Video** | **Yes** | No | No | No |
| Video Generation | **Yes** | No | No | No |
| **File Upload + Vision** | **Yes** | Yes | Yes | No |
| **Thinking Mode** | **Yes** | No | No | No |
| **Granular Permissions** | **7 Categories** | No | No | No |
| Uncensored by Default | **Yes** | No | No | Partial |
| Memory System | **Yes** | Plugin | No | No |
| Agent Workflows | **Yes** | No | No | No |
| Document Chat (RAG) | **Yes** | Yes | No | No |
| Voice (STT + TTS) | **Yes** | Partial | No | No |
| **Remote Access (Phone)** | **Yes** | No | No | No |
| **Plugins (Caveman + Personas)** | **Yes** | No | No | Yes |
| **Auto-Update** | **Yes** | No | Yes | No |
| Open Source | **AGPL-3.0** | MIT | No | AGPL |
| No Docker | **Yes** | No | Yes | Yes |

---

## Features

### Core
- **Plug & Play Setup** — First-launch wizard auto-detects 12 local backends. Nothing installed? One-click in-app Ollama download and install with progress bar. ComfyUI one-click install with step-by-step progress. Configurable ComfyUI port and path in Settings. Zero config needed.
- **Uncensored AI Chat** — Abliterated models with zero restrictions. Streaming + thinking display.
- **Multi-Provider** — 20+ presets. Local: Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, TabbyAPI, GPT4All, Aphrodite, SGLang, TGI. Cloud: OpenAI, Anthropic, OpenRouter, Groq, Together, DeepSeek, Mistral. Switch per conversation.
- **Codex Coding Agent** — Live streaming between tool calls, continue capability, AUTONOMY CONTRACT. File tree, folder picker, up to 50 iterations.
- **Agent Mode** — 14 tools + MCP: web search/fetch, file I/O, shell, code execution, screenshots, system info, time. Parallel execution, sub-agents, budget system.
- **Remote Access** — Access your AI from your phone via LAN or Cloudflare Tunnel. Full mobile web app with Agent Mode, Codex, plugins, file attach.
- **Image Generation** — FLUX 2 Klein, FLUX.1 (schnell/dev), Z-Image Turbo/Base, Juggernaut XL, RealVisXL, DreamShaper XL via ComfyUI. Full parameter control, no content filter.
- **Image-to-Image** — Upload a source image, adjust denoise strength, transform with any image model.
- **Video Generation** — Wan 2.1, HunyuanVideo 1.5, LTX 2.3, AnimateDiff Lightning, CogVideoX, FramePack F1 on your GPU.
- **Image-to-Video** — FramePack F1 (6 GB VRAM), CogVideoX 5B, SVD-XT. Upload an image, get video.

### Intelligence
- **Thinking Mode** — Provider-agnostic. See the AI's reasoning before the answer. Toggle from chat input.
- **File Upload + Vision** — Drag & drop, paste, clip button. Vision models analyze images.
- **Granular Permissions** — 7 tool categories, 3 permission levels, per-conversation overrides.
- **Smart Tool Selection** — Reduces tool definitions per request by ~80%. JSON repair for local LLMs.
- **Memory System** — Persistent across conversations. Auto-extraction. Export/import.
- **Agent Workflows** — Multi-step chains. 3 built-in (Research, Summarize URL, Code Review). Visual builder.

### Productivity
- **Model A/B Compare** — Same prompt, two models, side by side. Parallel streaming.
- **Local Benchmark** — One-click benchmark any model. Tokens/sec leaderboard.
- **Document Chat (RAG)** — Upload PDFs, DOCX, TXT. Hybrid search with source citations.
- **Voice Chat** — Push-to-talk STT + sentence-level TTS streaming.
- **20+ Personas** — Pre-built characters. Switch without prompt engineering.
- **Chat Export** — Markdown or JSON. Token counter. Keyboard shortcuts.

### Customization
- **Plugins Dropdown** — Caveman Mode (Off/Lite/Full/Ultra for terse responses) + 20+ Personas in one menu. Per-chat. Works in Chat, Agent, Codex.
- **Auto-Update** — Signed NSIS installer. In-app download with progress bar. User-controlled restart (no forced updates). Settings survive updates.

### Polish
- **Standalone Desktop App** — Tauri v2 Rust backend. Download .exe, run it.
- **Model Load/Unload** — iOS-style toggle in header. Load into VRAM, unload when done.
- **AE-Style Header** — Clean typography navigation. Models, Settings, Downloads at a glance.
- **Privacy First** — Zero tracking, all API calls proxied locally. ComfyUI process auto-killed on app close.

## Tech Stack

- **Desktop**: Tauri v2 (Rust backend, standalone .exe)
- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Framer Motion
- **State**: Zustand with localStorage persistence
- **AI Backend**: 20+ providers (Ollama, LM Studio, vLLM, KoboldCpp, llama.cpp, LocalAI, Jan, OpenAI, Anthropic, OpenRouter, Groq, and more), ComfyUI, faster-whisper
- **Build**: Vite 8 (dev), Tauri CLI (production)

---

## Download

### Windows
Download the installer from [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest):
- **`.exe`** — NSIS installer (recommended)
- **`.msi`** — Windows Installer

> **Other platforms:** The source code builds on Linux and macOS via `npm run tauri build`, but only Windows is officially tested and supported.

> **Plug & Play:** Just install and launch. The setup wizard auto-detects all 12 supported local backends ([Ollama](https://ollama.com/), [LM Studio](https://lmstudio.ai/), [vLLM](https://github.com/vllm-project/vllm), [KoboldCpp](https://github.com/LostRuins/koboldcpp), llama.cpp, LocalAI, Jan, GPT4All, text-generation-webui, TabbyAPI, Aphrodite, SGLang). Nothing installed yet? The wizard shows one-click install links for every backend.

> **Antivirus warning?** Some engines (ESET, Avast, Microsoft SmartScreen) flag the installer as suspicious — this is a **false positive** caused by heuristics on unsigned NSIS installers that download other binaries. The installer is built by GitHub Actions from public source on `master` (`.github/workflows/release.yml`). The auto-update channel is signed against a public minisign key. Full context, verification steps, and one-click vendor submission links: see [SECURITY.md](SECURITY.md#antivirus--browser-false-positives).

---

## Quick Start

> **New to Locally Uncensored?** Read the [Getting Started Guide](https://locallyuncensored.com/guide/) with screenshots for every step.

### From Source

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev
```

### For Contributors — Dev-Mode Setup

> ⚠️ **Just want to use the app?** Grab the installer from [Releases](https://github.com/PurpleDoubleD/locally-uncensored/releases/latest) (the `.exe` or `.msi` in the **Download** section above). That gives you the full Tauri desktop app with auto-update. The commands below start LU in **browser dev-mode** — fewer features, Vite proxy noise, meant for contributing to the codebase.

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
setup.bat   # Windows — installs Node, Git, Ollama, then npm run dev
# setup.sh  # macOS / Linux equivalent
```

Launches at `http://localhost:5173` in your default browser.

### Image & Video Generation

Open the **Create** tab. ComfyUI is auto-detected or one-click installed. Models download with one click. Workflow is set to **Auto** — just write a prompt and hit Generate.

---

## Recommended Models

### Text (any local backend)

| Model | VRAM | Best For |
|-------|------|----------|
| **Qwen 3.6 35B MoE** | 24 GB | Vision + agentic coding + thinking. Brand new. |
| **GLM-4.7-Flash IQ2** | 12 GB | Strongest 30B class. Tool calling. 198K context. |
| **Gemma 4 E4B** | 4 GB | Lightweight, fast, great for small GPUs. |
| **Qwen 3.5 35B MoE** | 16 GB | Best agentic, 256K context. SWE-bench leader. |
| **Gemma 4 31B** | 16 GB | Frontier dense model, native tools + vision. |
| Hermes 3 8B | 6 GB | Agent Mode. Uncensored + tool calling. |
| DeepSeek R1 (8B-70B) | 6-48 GB | Chain-of-thought reasoning. |

### Image (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| FLUX.1 Schnell / Dev | 8-10 GB | Best text-to-image. Fast (schnell) or quality (dev). |
| FLUX 2 Klein 4B | 8-10 GB | Next-gen, fastest FLUX model. |
| ERNIE-Image Turbo | 24 GB | Baidu DiT, 8 steps, 1024x1024. New. |
| Z-Image Turbo | 10-16 GB | Uncensored, 8-15 sec per image. |
| Juggernaut XL V9 | 6 GB | Best photorealistic SDXL. |

### Video (ComfyUI)

| Model | VRAM | Notes |
|-------|------|-------|
| Wan 2.1 T2V 1.3B | 8-10 GB | Fast entry point, 480p. |
| Wan 2.1 T2V 14B | 12+ GB | High quality, 720p. |
| FramePack F1 (I2V) | 6 GB | Image-to-video, revolutionary low VRAM. |
| AnimateDiff Lightning | 6-8 GB | Ultra-fast 4-step animation. |
| HunyuanVideo 1.5 | 12+ GB | Excellent temporal consistency. |

---

## Roadmap

- [x] **Plug & Play Setup** (auto-detect 12 local backends, one-click install links)
- [x] Codex Coding Agent
- [x] MCP Tool Registry (13 tools)
- [x] Granular Permissions (7 categories)
- [x] File Upload + Vision
- [x] Thinking Mode (provider-agnostic)
- [x] Model Load/Unload from header
- [x] Multi-Provider (20+ presets)
- [x] Agent Mode + Workflows
- [x] Memory System
- [x] A/B Compare + Local Benchmark
- [x] RAG / Document Chat
- [x] Voice Chat (STT + TTS)
- [x] ComfyUI Plug & Play (auto-detect, one-click install)
- [x] 20 Image + Video Model Bundles
- [x] Image-to-Image (I2I)
- [x] Image-to-Video (I2V) — FramePack, CogVideoX, SVD
- [x] Z-Image + FLUX 2 + ERNIE-Image support
- [x] Dynamic Workflow Builder (15 strategies)
- [x] VRAM-Aware Model Filtering
- [x] Think Mode in Chat Input
- [x] Remote Access (LAN + Cloudflare Tunnel)
- [x] Mobile Web App (Agent, Codex, Plugins, Thinking)
- [x] Codex Streaming + Continue + Autonomy Contract
- [x] Agent 13-Phase Rewrite (parallel, budget, sub-agents, MCP)
- [x] Auto-Update (signed NSIS installer)
- [x] Qwen 3.6 Day-0 Support
- [x] Plugins Dropdown (Caveman + Personas)
- [ ] Voice Mode (Qwen Omni live voice)
- [ ] Upscale + Inpainting

---

## Build from Source

```bash
git clone https://github.com/PurpleDoubleD/locally-uncensored.git
cd locally-uncensored
npm install
npm run dev          # Development
npm run tauri build  # Production binary
```

## Platform Support

| Platform | Status | Download |
|----------|--------|----------|
| **Windows** (10/11) | Fully tested | `.exe` / `.msi` |
| Linux / macOS | Build from source | `npm run tauri build` |

## Community

Join the Discord: **https://locallyuncensored.com/discord**. Ask questions, share what you built, or help others in our forum channels — chat / image gen / video gen / coding agent.

## Contributing

Check out the [Contributing Guide](CONTRIBUTING.md). See [open issues](https://github.com/PurpleDoubleD/locally-uncensored/issues) or the [Roadmap](#-roadmap).

## License

AGPL-3.0 License — see [LICENSE](LICENSE).

---

<div align="center">

**Your data stays on your machine.**

[Website](https://locallyuncensored.com) · [Report Bug](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=bug_report.yml) · [Request Feature](https://github.com/PurpleDoubleD/locally-uncensored/issues/new?template=feature_request.yml) · [Discussions](https://github.com/PurpleDoubleD/locally-uncensored/discussions)

</div>
