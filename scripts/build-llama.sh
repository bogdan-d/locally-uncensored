#!/usr/bin/env bash
#
# build-llama.sh — build the bundled llama.cpp `llama-server` sidecar for
# Locally Uncensored's built-in inference engine (P0 of the built-in-engine plan).
#
# The produced binary is statically linked with the GPU backend embedded, so a
# single self-contained file drops into `src-tauri/bin/llama-server-<triple>`
# and Tauri picks it up as an `externalBin` sidecar (target triple appended,
# code-signed with the app on macOS).
#
# Idempotent: clones/pins llama.cpp once into a build cache, reuses it on reruns.
# Binaries are NOT committed — see src-tauri/bin/.gitignore.
#
# Usage:
#   scripts/build-llama.sh                 # build for the host target triple
#   scripts/build-llama.sh <triple> ...    # build for one or more explicit triples
#   scripts/build-llama.sh --check         # verify already-built host binary boots
#
# Supported triples:
#   aarch64-apple-darwin      (Metal, embedded shaders)   — mac-first
#   x86_64-apple-darwin       (Metal, embedded shaders)   — mac-first
#   x86_64-pc-windows-msvc    (Vulkan)                    — P6, after launch
#   x86_64-unknown-linux-gnu  (Vulkan)                    — P6, after launch
#
set -euo pipefail

# --- Pinned, reproducible llama.cpp revision -------------------------------
# Bump deliberately and re-test; do not float. llama.cpp tags are build numbers.
LLAMA_TAG="${LLAMA_TAG:-b6231}"
LLAMA_REPO="${LLAMA_REPO:-https://github.com/ggml-org/llama.cpp.git}"

# --- Paths -----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CACHE_DIR="${LLAMA_BUILD_CACHE:-$REPO_ROOT/.llama-build}"
SRC_DIR="$CACHE_DIR/llama.cpp"
BIN_DIR="$REPO_ROOT/src-tauri/bin"

log()  { printf '\033[1;35m[build-llama]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[build-llama] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

host_triple() {
  if command -v rustc >/dev/null 2>&1; then
    rustc --print host-tuple 2>/dev/null && return
    rustc -vV 2>/dev/null | awk '/^host:/{print $2}'
  else
    # Fallback for macOS without rustc on PATH.
    case "$(uname -sm)" in
      "Darwin arm64")  echo "aarch64-apple-darwin" ;;
      "Darwin x86_64") echo "x86_64-apple-darwin" ;;
      *) die "cannot infer host triple; pass one explicitly" ;;
    esac
  fi
}

# Map a Rust target triple → cmake flags for a static, GPU-embedded llama-server.
cmake_flags_for() {
  local triple="$1"
  local common="-DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release"
  case "$triple" in
    aarch64-apple-darwin)
      echo "$common -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=arm64" ;;
    x86_64-apple-darwin)
      echo "$common -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DCMAKE_OSX_ARCHITECTURES=x86_64" ;;
    x86_64-pc-windows-msvc)
      echo "$common -DGGML_VULKAN=ON" ;;
    x86_64-unknown-linux-gnu)
      echo "$common -DGGML_VULKAN=ON" ;;
    *)
      die "unsupported target triple: $triple" ;;
  esac
}

out_name_for() {
  case "$1" in
    *-windows-*) echo "llama-server-$1.exe" ;;
    *)           echo "llama-server-$1" ;;
  esac
}

ensure_src() {
  command -v git >/dev/null 2>&1 || die "git not found"
  command -v cmake >/dev/null 2>&1 || die "cmake not found — install it (macOS: brew install cmake)"
  mkdir -p "$CACHE_DIR"
  if [ ! -d "$SRC_DIR/.git" ]; then
    log "cloning llama.cpp @ $LLAMA_TAG"
    git clone --depth 1 --branch "$LLAMA_TAG" "$LLAMA_REPO" "$SRC_DIR"
  else
    local have
    have="$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null || true)"
    if [ "$have" != "$LLAMA_TAG" ]; then
      log "updating llama.cpp checkout → $LLAMA_TAG"
      git -C "$SRC_DIR" fetch --depth 1 origin "refs/tags/$LLAMA_TAG:refs/tags/$LLAMA_TAG"
      git -C "$SRC_DIR" checkout -f "$LLAMA_TAG"
    fi
  fi
}

build_triple() {
  local triple="$1"
  local build_dir="$CACHE_DIR/build-$triple"
  local flags; flags="$(cmake_flags_for "$triple")"
  log "configuring $triple  ($flags)"
  # shellcheck disable=SC2086
  cmake -S "$SRC_DIR" -B "$build_dir" $flags
  log "building llama-server for $triple"
  cmake --build "$build_dir" --config Release --target llama-server -j
  # Locate the produced binary (path differs by generator/platform).
  local built
  built="$(find "$build_dir" -type f \( -name 'llama-server' -o -name 'llama-server.exe' \) -print -quit)"
  [ -n "$built" ] || die "llama-server binary not found under $build_dir"
  mkdir -p "$BIN_DIR"
  local out="$BIN_DIR/$(out_name_for "$triple")"
  cp "$built" "$out"
  chmod +x "$out"
  log "installed → $out"
}

# Boot the host binary and probe /health + /v1/models on an ephemeral port.
check_binary() {
  local triple; triple="$(host_triple)"
  local bin="$BIN_DIR/$(out_name_for "$triple")"
  [ -x "$bin" ] || die "no built binary at $bin — build first"
  local port=8129
  log "boot check: $bin on 127.0.0.1:$port (no model, /health only)"
  "$bin" --host 127.0.0.1 --port "$port" --models "$CACHE_DIR" >/dev/null 2>&1 &
  local pid=$!
  trap 'kill "$pid" 2>/dev/null || true' EXIT
  local ok=""
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.3
  done
  kill "$pid" 2>/dev/null || true
  trap - EXIT
  [ -n "$ok" ] || die "health endpoint never came up"
  log "OK — llama-server boots and answers /health"
}

main() {
  if [ "${1:-}" = "--check" ]; then check_binary; exit 0; fi
  local targets=("$@")
  if [ "${#targets[@]}" -eq 0 ]; then targets=("$(host_triple)"); fi
  ensure_src
  for t in "${targets[@]}"; do build_triple "$t"; done
  log "done: ${targets[*]}"
}

# Only run when executed directly, so tests can source the pure functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
