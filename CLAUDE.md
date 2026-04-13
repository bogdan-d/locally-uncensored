# Locally Uncensored — Developer Guide

## Project Overview
Plug and Play for the Mass Desktop AI app (Tauri + React + TypeScript) for local LLM chat, image and video generation via ComfyUI.
- **Repo:** PurpleDoubleD/locally-uncensored (35+ stars)
- **Current version:** v2.2.3 (released 2026-04-05)
- **Active branch:** `full-comfyui-fix` — v2.3.0 ComfyUI Plug & Play feature (DO NOT PUSH until ready)

## Tech Stack
- **Frontend:** React 19, Zustand, Tailwind CSS 4, Framer Motion, Vite 8
- **Backend:** Tauri 2 (Rust), tokio, reqwest
- **Testing:** Vitest 4, pattern `src/**/__tests__/**/*.test.ts`, node environment
- **Build:** `npm run dev` (frontend), `npm run tauri:dev` (full app)

## Key Architecture
```
src/api/comfyui.ts          — Model classification, ComfyUI API, workflow builders, uploadImage()
src/api/dynamic-workflow.ts — Strategy detection + dynamic workflow building (14 strategies)
src/api/comfyui-nodes.ts    — Node discovery + categorization from ComfyUI /object_info
src/api/discover.ts         — Model bundles (14 video, 6 image), CUSTOM_NODE_REGISTRY, downloads
src/api/preflight.ts        — Pre-generation validation (VAE/CLIP/node checks)
src/api/backend.ts          — Tauri IPC abstraction (backendCall, localFetch, comfyuiUrl)
src/api/workflows.ts        — Workflow validation, format conversion, parameter injection
src/stores/downloadStore.ts — Unified download tracking (Zustand) for ComfyUI model downloads
src-tauri/src/commands/      — Rust commands: install, process, download, proxy, etc.
```

## Current Work: v2.3.0 (branch: full-comfyui-fix)

### What's DONE (607 tests passing):
1. **7 new ModelTypes:** mochi, cosmos, cogvideo, svd, framepack, pyramidflow, allegro
2. **7 new WorkflowStrategies** with complete node chains for each model
3. **14 video bundles + 6 image bundles** in discover.ts with HuggingFace URLs
4. **CUSTOM_NODE_REGISTRY** — 5 custom node repos (AnimateDiff, CogVideoX, FramePack, PyramidFlow, Allegro)
5. **install_custom_node** Rust command — git clone + pip install into ComfyUI/custom_nodes/
6. **Onboarding 'comfyui' step** — auto-detect, one-click install, re-scan button, manual path input
7. **Onboarding polish** — window drag region + controls, accent dots (Agent Tutorial style), step indicator dots, tool calling badges, hardware-aware model filtering (VRAM), uncensored/mainstream tabs
8. **Settings ComfyUI section** — status indicator (Running/Stopped/Not Installed), start/stop/restart, install button
9. **Preflight** — all 15 ModelTypes handled (needsUnet check covers all new types)
10. **I2V Image Upload UI** — drag & drop in CreateView for SVD/FramePack, uploadImage() to ComfyUI, filename passed to workflow builders
11. **Unified downloadStore** — Zustand store replaces component-local polling, tracks all ComfyUI downloads globally
12. **DownloadBadge unified** — shows text + image + video downloads, grouped by bundle name with sub-file progress
13. **VRAM tier filter tabs** — All / Lightweight / Mid-Range / High-End for video bundles
14. **installBundleComplete()** — one-click: custom nodes + all model files + ComfyUI restart
15. **isInstalled fix** — exact name match (was: base-name comparison, caused Gemma 4 variant bug)
16. **Default view = chat homepage** (Startseite with LU logo), not Model Manager
17. **6 uncensored video bundles** (Wan 2.1 x2, HunyuanVideo, CogVideoX x2, FramePack)
18. **LTX bug fixed** — workflow was 'wan' instead of 'ltx'
19. **Text model download UX complete** — Ollama pull with streaming progress, HF GGUF with auto-fallback path, both tracked in unified DownloadBadge
20. **isInstalled prefix-match** — Ollama models without tag (hermes3) match installed variants (hermes3:8b)
21. **All 3 download flows Tauri-verified** — Ollama pull (events), HF GGUF (invoke), ComfyUI bundles (invoke) — all arg mappings, command registrations, progress polling confirmed

22. **Tauri .exe download fix (camelCase)** — Rust commands used snake_case params but JS sent camelCase. Downloads silently failed in .exe, worked in dev. Fixed: download_model, download_model_to_path, install_custom_node all use camelCase params now.
23. **Retry button for failed downloads** — per-file retry in DownloadBadge + bundle-level retry in DiscoverModels. Only retries failed files, not completed ones.
24. **Download speed display** — MB/s shown per file and per bundle in DownloadBadge
25. **External links open system browser** — all `target="_blank"` links replaced with `openExternal()` via Tauri shell plugin. Added `shell:allow-open` capability.
26. **Bundle installed detection fixed** — error files no longer count as "complete", bundleStatuses refresh after download, 50% threshold for check_model_sizes (sizeGB values are estimates)
27. **LM Studio not auto-started** — openai provider default changed to `enabled: false`, only activated if detectLocalBackends finds it
28. **Download polling race fix** — first download after app restart now shows immediately (min 5 poll cycles before auto-stop)
29. **All 20 bundle file sizes verified** — 13 files had wrong sizeGB values (up to 95% off), all corrected against real Content-Length
30. **Mochi missing T5-XXL** — text encoder was completely missing from bundle, model would fail at CLIPLoader. Added as 3rd file.
31. **AnimateDiff v3 wrong file** — was downloading adapter (97 MB) instead of motion model (1.6 GB). Fixed URL to v3_sd15_mm.ckpt
32. **Onboarding typo** — `qwen2.5-abliterated` doesn't exist on Ollama, fixed to `qwen2.5-abliterate`
33. **All 30 Ollama models verified**, all 24 HF GGUF URLs verified, all 20 ComfyUI bundle URLs verified
34. **HuggingFace GGUF as single download source** — replaced Ollama pull with HF GGUF for ALL text model downloads. Works with all 23 provider presets. Removed Ollama/HF tab switcher, VariantPullButton, Ollama search. Unified getUncensoredTextModels (34 GGUFs) + getMainstreamTextModels (30 GGUFs). Onboarding uses startModelDownloadToPath instead of pullModel. All 64 URLs verified HTTP 200. Net -238 lines. pullModel() preserved for chat page Ollama pulls.

35. **E2E Image+Video Gen fixes (6 bugs)** — Error handling shows real ComfyUI errors (not generic HTTP 500). Direct fetch fallback when Tauri proxy fails. Legacy builder uses correct FLUX 2 nodes (EmptyFlux2LatentImage + separate negative prompt). Stale localStorage model names auto-reset against current ComfyUI list. Polling heartbeat catches missed WebSocket completion events. ComfyUI critical functions (submit/history/cancel/free) use direct fetch bypassing broken Tauri proxy.
36. **tqdm crash fix confirmed** — TQDM_DISABLE=1 env var in start_comfyui/auto_start_comfyui prevents KSampler [Errno 22] crash. Both image and video KSampler confirmed working in .exe.

37. **Think-Mode guard for non-thinking models** — isThinkingCompatible() in model-compatibility.ts checks if model supports Ollama's `think` parameter. ChatView shows amber hint toast instead of crashing with HTTP 400. useChat.ts double-guards by not sending `think=true` to incompatible models. Supports: QwQ, DeepSeek-R1, Qwen3/3.5, Qwen3-Coder, Gemma3/4. Cloud providers always pass through.

38. **Chat homepage null crash fix** — getProviderIdFromModel(), isThinkingCompatible(), isAgentCompatible() all crashed with "Cannot read properties of null (reading 'split')" when activeModel was null after fresh install. Added null guards to all three functions.
39. **Light Theme contrast fix** — ModelCard model names were invisible in light mode (text-gray-200 on white). Fixed: dark:text-gray-200 text-gray-800. Also fixed ModelManager buttons and ModelCard hover/active states for light theme.
40. **Gemma 4 31B Heretic download URL fix** — llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF repo was deleted (404). Replaced with Stabhappy/gemma-4-31B-it-heretic-Gguf. All 105 download URLs verified HTTP 200/302.
41. **I2V image upload fix** — uploadImage() used localFetch() which only accepts string body, not FormData. FormData was silently corrupted (sent as "[object FormData]") and Content-Type was forced to application/json instead of multipart/form-data. Fixed: use direct fetch() which handles FormData natively.
42. **FramePack workflow node names fix** — Kijai wrapper updated node names: FramePackModelLoader→LoadFramePackModel, removed FramePackEncode (image goes directly to FramePackSampler as start_latent). Updated dynamic-workflow.ts builder, comfyui-nodes.ts categorization, discover.ts CUSTOM_NODE_REGISTRY, and test fixtures.
43. **FramePack workflow validation fix** — base_precision fp8→bf16, sampler unipc→unipc_bh2, added VAEEncode between LoadImage and FramePackSampler (LATENT type required, not IMAGE).
44. **FramePack preflight custom node check** — Added framepack to customNodeModels in preflight.ts. Now checks for LoadFramePackModel + FramePackSampler before generation.
45. **FramePack DualCLIPLoader fix** — CLIPLoader type "wan" creates Llama2 with 128256 vocab but llava_llama3 has 128320 tokens. Fixed: use DualCLIPLoader (clip_l + llava_llama3) with type "hunyuan_video". Added CLIPVisionLoader + CLIPVisionEncode for image_embeds. Full I2V pipeline verified in .exe (OOM on 12GB VRAM = hardware limit, not software bug).

46. **Z-Image own ModelType + strategy** — Z-Image was classified as `flux2` but uses `qwen_3_4b` CLIP (not `qwen_3_4b_fp4_flux2`), causing KSampler shape mismatch [2560] vs [1, 77, 768]. Fixed: new ModelType `zimage`, new strategy `unet_zimage`, CLIPLoader type `qwen_image` (queried from ComfyUI /object_info). Added findMatchingVAE/CLIP for zimage (exact match `qwen_3_4b.safetensors`, excludes fp4_flux2 variant). COMPONENT_REGISTRY in both comfyui.ts and discover.ts. Defaults: 12 steps, CFG 3.5, euler/simple. Z-Image Turbo E2E verified in .exe — 5 steps generates correct 1024x1024 image.
47. **Image-to-Image (I2I) feature** — Complete I2I pipeline: LoadImage → VAEEncode → KSampler (denoise < 1.0) → VAEDecode → SaveImage. Sub-tabs in Parameters panel (Text to Image / Image to Image) matching Video's T2V/I2V pattern. Upload zone with drag & drop, denoise slider (0.0-1.0) in both main area and sidebar. Works with all image models (SDXL, FLUX, Z-Image). Store migration from old `mode: 'i2i'` to `imageSubMode`. E2E verified in .exe — Z-Image I2I with denoise 0.7 generates correct output.
48. **ComfyUI process cleanup on app kill** — Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When Tauri app is killed (even via Task Manager), OS kernel automatically terminates ComfyUI Python process. Applied to both `start_comfyui()` and `auto_start_comfyui()`. Added `windows-sys` crate dependency.

49. **Caveman Mode fixes (5 bugs)** — Ultra prompt added brevity constraint ("Maximum brevity. Fewest possible words. Under 3 sentences unless code."). Agent+Caveman prompt order fixed: caveman was PREPENDED before agent ReAct instructions (confused model), now APPENDED as `Response style:`. Caveman injection added to useCodex.ts and useClaudeCode.ts (was missing). Per-message CAVEMAN_REMINDERS added (short style tags like `[Terse. Fragments OK. No fluff.]` prepended to each user message) — ensures non-thinking models follow Caveman style without relying on thinking mode. Works in all 4 views: Chat, Agent, Codex, Claude Code.
50. **Think-mode comprehensive fix** — ollama-provider.ts: `body.think` only set when `thinking: true` (was always setting `think: false` which Ollama rejects). useAgentChat.ts + useCodex.ts: added `isThinkingCompatible()` guard. All 3 hooks (useChat, useAgentChat, useCodex) now retry without thinking on HTTP 400. User-friendly error message instead of raw JSON. Works with ALL models: non-thinking models get no `think` param, thinking-compatible models get `think: true`, edge cases caught by retry.
51. **Agent Tutorial trimmed** — Removed "You Stay in Control" screen (was step 3). Tutorial now 2 steps: Welcome → Available Tools. Safety info integrated into Tools screen description. "Don't show this again" checkbox on last (Tools) screen.
52. **Plugins Dropdown + Input Alignment** — Persona selector renamed to "Plugins" dropdown containing Caveman Mode (Off/Lite/Full/Ultra buttons) + Personas list. Caveman toggle removed from ChatInput. PluginsDropdown added to all 3 chat views (Chat, Codex, ClaudeCode). Input bar alignment fixed: VoiceButton p-2→p-1.5 + icon 15→14, Think py-1→py-1.5. All buttons now consistent height.

53. **Remote Access Upgrade** — 6-digit numeric passcodes (5min expiry, auto-regenerate), rate limiting (3 failed attempts → 60s cooldown), Cloudflare Tunnel with tunnel-aware QR codes (QR shows tunnel URL when active), WebSocket `/ws` auth fix, shared state fix (jwt_secret + passcode behind Arc<TokioMutex> shared between axum and Tauri), mobile landing page with numeric input + rate limit error display, frontend countdown timer with auto-regeneration.

54. **Comprehensive Test Suite** — 28 new test files, 837 new tests (607→1444 total, 0 failures). All 22 stores tested, API layer 82%, lib utilities 82%. Fixed 6 stale test assertions (tool-registry counts, ollama options, model-compatibility providers).

### What's LEFT to finish v2.3.0:
1. **Tauri proxy_localhost investigation** — reqwest in Tauri subprocess can't reach localhost. Direct fetch workaround in place but root cause unknown. Low priority since workaround works. Deferred to next release.
2. **LTX VAEDecode reference** — dynamic-workflow.ts line 263: vaeSourceId incorrectly points to UNETLoader output for LTX strategy. Fix when LTX model is installed for testing.
3. **Codex file tree auto-refresh** — File tree in Codex tab doesn't update when files are created during a session. Needs refresh button or fs watcher to auto-detect changes.
4. **Remote Access upgrade** — Currently LAN-only. Needs Cloudflare Tunnel for internet access + simpler numeric passcodes for mobile.

### Files modified in this branch (30+ files):
- `src/api/comfyui.ts` — 8 new ModelTypes (incl. zimage), COMPONENT_REGISTRY, uploadImage(), inputImage/denoise in GenerateParams, findMatchingVAE/CLIP for zimage
- `src/api/dynamic-workflow.ts` — 8 new strategies (incl. unet_zimage), 5 wrapper builders, inputImage support in SVD/FramePack, I2I pipeline (LoadImage→VAEEncode→KSampler denoise)
- `src/api/comfyui-nodes.ts` — 30+ new nodes in categorization mapping
- `src/api/discover.ts` — 14 video + 6 image bundles, CUSTOM_NODE_REGISTRY, installBundleComplete(), uncensored flags, ALL sizeGB verified, HF GGUF unified text model lists (34 uncensored + 30 mainstream), removed Ollama search/fetch functions
- `src/api/backend.ts` — install_custom_node endpoint mapping, openExternal() for system browser
- `src/api/preflight.ts` — extended needsUnet check for all new model types
- `src-tauri/src/commands/install.rs` — install_custom_node command (camelCase params)
- `src-tauri/src/commands/download.rs` — download_model with resume, progress, speed tracking (camelCase params), 50% threshold for check_model_sizes
- `src-tauri/src/main.rs` — registered install_custom_node
- `src-tauri/capabilities/default.json` — added shell:allow-open for external links
- `src/components/create/CreateView.tsx` — I2V upload UI, I2I upload zone + denoise slider, Image/Video top-tabs only
- `src/components/create/WorkflowSearchModal.tsx` — openExternal for CivitAI link
- `src/components/create/WorkflowCard.tsx` — openExternal for source links
- `src/components/chat/MarkdownRenderer.tsx` — openExternal for all chat links
- `src/components/layout/DownloadBadge.tsx` — unified: text + ComfyUI downloads, bundle grouping, retry buttons, speed display
- `src/components/models/DiscoverModels.tsx` — VRAM tier tabs, downloadStore integration, retry for failed bundles, openExternal, no double "Installed", removed Ollama/HF tab switcher + VariantPullButton + useModels dependency
- `src/components/onboarding/Onboarding.tsx` — comfyui step, drag region, accent dots, VRAM filtering, tool calling badges, re-scan, openExternal, GGUF downloads via startModelDownloadToPath instead of pullModel
- `src/components/settings/SettingsPage.tsx` — ComfyUISettings component
- `src/stores/providerStore.ts` — LM Studio default disabled (auto-detect only)
- `src/stores/updateStore.ts` — openExternal for release page
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields, qwen2.5-abliterate typo fix, HF GGUF downloadUrl/filename/sizeGB for all 17 onboarding models
- `src/hooks/useCreate.ts` — i2vImage + i2iImage pass-through, I2I validation, imageSubMode-based generate logic
- `src/lib/constants.ts` — OnboardingModel: vramGB, uncensored, agent fields + mainstream models
- `src/stores/createStore.ts` — i2vImage/i2iImage/denoise/imageSubMode state, persist migration for old 'i2i' mode
- `src/components/create/ParamPanel.tsx` — Z-Image badge, Text to Image / Image to Image sub-tabs, denoise slider
- `src-tauri/src/commands/process.rs` — Windows Job Object for ComfyUI process cleanup on app kill
- `src-tauri/Cargo.toml` — windows-sys dependency for Job Object API
- `src/stores/downloadStore.ts` — NEW: unified ComfyUI download tracking (polling, bundle grouping)
- `src/stores/uiStore.ts` — default view changed to 'chat'
- `src/lib/model-compatibility.ts` — added isThinkingCompatible() + THINKING_COMPATIBLE list
- `src/components/chat/ChatView.tsx` — Think button: amber hint for non-thinking models, opacity dim
- `src/hooks/useChat.ts` — double-guard: don't send think=true to incompatible models, think-error retry with async generator fallback, user-friendly error messages
- `src/hooks/useAgentChat.ts` — isThinkingCompatible guard, think-error retry (try/catch around chatWithTools), caveman moved from prepend to append (Response style:), graceful think error message
- `src/hooks/useCodex.ts` — added isThinkingCompatible guard (was missing), caveman injection (was missing), think-error retry
- `src/hooks/useClaudeCode.ts` — caveman injection into CLI prompt (was missing)
- `src/api/providers/ollama-provider.ts` — conditional think: `if (thinking === true) body.think = true` instead of always setting field
- `src/components/chat/AgentTutorial.tsx` — removed "You Stay in Control" step, tutorial now 2 steps, safety info in Tools step
- `src/components/chat/PluginsDropdown.tsx` — NEW: Plugins dropdown (Caveman Mode + Personas), replaces old Persona selector, visible in Chat/Codex/ClaudeCode
- `src/components/chat/ChatInput.tsx` — Caveman button removed (moved to PluginsDropdown), Think button padding fixed (py-1 → py-1.5)
- `src/components/chat/VoiceButton.tsx` — Alignment fix: padding p-2 → p-1.5, icon 15 → 14 (consistent with other input bar buttons)
- `src/components/chat/CodexView.tsx` — Added PluginsDropdown to header
- `src/components/chat/ClaudeCodeView.tsx` — Added PluginsDropdown to header

### Test files (32 total, 28 new):
- `src/api/__tests__/comfyui-models.test.ts` — classifyModel, MODEL_TYPE_DEFAULTS, COMPONENT_REGISTRY, determineStrategy (79 tests)
- `src/api/__tests__/comfyui-bundles.test.ts` — bundle validation, custom node registry, shared files (15 tests)
- `src/api/__tests__/comfyui-workflows.test.ts` — strategy mapping, unavailability, workflow coverage (30 tests)
- `src/api/__tests__/comfyui-integration.test.ts` — full pipeline Bundle→Strategy verification (36 tests)
- `src/api/__tests__/agents-parsing.test.ts` — AGENT_TOOLS, buildReActPrompt, parseAgentResponse (28 tests)
- `src/api/__tests__/backend-urls.test.ts` — isTauri, ollamaUrl, comfyuiUrl, comfyuiWsUrl (22 tests)
- `src/api/__tests__/comfyui-nodes-categorize.test.ts` — categorizeNodes, detectAvailableModels (25 tests)
- `src/api/__tests__/discover-registry.test.ts` — bundles, COMPONENT_REGISTRY, lookupFileMeta (34 tests)
- `src/api/__tests__/dynamic-workflow-strategy.test.ts` — determineStrategy all 15 model types (30 tests)
- `src/api/__tests__/stream-parser.test.ts` — parseNDJSONStream (23 tests)
- `src/api/__tests__/workflows-validation.test.ts` — validateWorkflowJson, extractSearchTerms, autoDetectParameterMap (35 tests)
- `src/lib/__tests__/formatters.test.ts` — formatBytes, formatDate, truncate (29 tests)
- `src/lib/__tests__/tool-call-repair.test.ts` — repairJson, extractToolCallsFromContent (46 tests)
- `src/lib/__tests__/tool-selection.test.ts` — selectRelevantTools, TOOL_GROUPS (27 tests)
- `src/lib/__tests__/privacy.test.ts` — proxyImageUrl (16 tests)
- `src/lib/__tests__/constants-validation.test.ts` — DEFAULT_SETTINGS, BUILT_IN_PERSONAS, ONBOARDING_MODELS (36 tests)
- `src/lib/__tests__/built-in-workflows.test.ts` — BUILT_IN_WORKFLOWS structure (37 tests)
- `src/lib/__tests__/systemCheck.test.ts` — getRecommendations, detectSystem (28 tests)
- `src/lib/__tests__/storage-quota.test.ts` — getStorageUsage, createSafeStorage (38 tests)
- `src/stores/__tests__/createStore.test.ts` — clamping, gallery, prompt history, mode switching (35 tests)
- `src/stores/__tests__/providerStore.test.ts` — obfuscation, getEnabledProviders (27 tests)
- `src/stores/__tests__/updateStore.test.ts` — isNewerVersion, checkForUpdate (28 tests)
- `src/stores/__tests__/benchmarkStore.test.ts` — getAverageSpeed, getLeaderboard (26 tests)
- `src/stores/__tests__/compareStore.test.ts` — startRound, addContent, finish (35 tests)
- `src/stores/__tests__/workflowStore.test.ts` — getWorkflowForModel, cascading cleanup (35 tests)
- `src/stores/__tests__/permissionStore.test.ts` — getEffectivePermissions merging (20 tests)
- `src/stores/__tests__/agentWorkflowStore.test.ts` — startExecution, duplicateWorkflow (25 tests)
- `src/stores/__tests__/agentStore.test.ts` — nested updates, toolCall tracking (25 tests)
- `src/stores/__tests__/settingsStore.test.ts` — persona CRUD, migration (22 tests)
- `src/stores/__tests__/mcpStore.test.ts` — cascading cleanup (24 tests)
- `src/stores/__tests__/sessionStores.test.ts` — codex+claudeCode+voice stores (31 tests)
- `src/stores/__tests__/remoteStore.test.ts` — passcode, tunnel, QR refresh (28 tests)

## Conventions
- Language: Englisch only
- Commits: descriptive, semantic (`feat:`, `fix:`, `docs:`)
- No emojis in code or UI
- Run `npx vitest run` before committing
- Run `cargo check --manifest-path src-tauri/Cargo.toml` for Rust changes
- UI: Tailwind utility classes, dark mode first, lucide-react icons
- State: Zustand stores in `src/stores/`
- Tauri IPC: `backendCall()` from `src/api/backend.ts`
- Downloads: Use `downloadStore` for all ComfyUI downloads (not component-local state)


## Test Suite: 1444 tests, 0 failures (50 test files)
All pre-existing test failures have been fixed. Run `npx vitest run` to verify.
