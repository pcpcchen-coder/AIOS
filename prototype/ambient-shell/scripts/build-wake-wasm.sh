#!/usr/bin/env bash
# WK-01b：自建 sherpa-onnx v2.0.1 的 KWS 瀏覽器 wasm（docs/17 §14.1 D2、docs/validation/wk-01b-prep-2026-10-31.md）。
# GitHub Actions（.github/workflows/wake-wasm.yml）執行這個腳本；也可以在本機（Linux 或 macOS，需要 git、cmake、make、
# python3、node）照樣執行：
#
#   bash prototype/ambient-shell/scripts/build-wake-wasm.sh <工作資料夾> <輸出資料夾>
#
# 做的事：
#   1. 取得 emsdk（固定 commit）並安裝、啟用固定版本；確認 emcc 版本相符。設定 EMSDK_DIR 可改用已啟用的 emsdk（仍核對版本）。
#   2. 取得 sherpa-onnx v2.0.1（固定 commit），核對 HEAD。
#   3. 以 scripts/wake-wasm.mjs patch 修改 wasm/kws/CMakeLists.txt：模型不打包進 wasm、輸出 ES module、匯出 FS。
#   4. 照上游 build-wasm-simd-kws.sh 的 cmake 選項建置（TTS 關閉、只開 KWS），再以 wake-wasm.mjs package 整理出 3 個檔案。
#   5. 授權檢查：wake-wasm.mjs license-check，建置樹或產物出現 espeak-ng／piper 的檔名或符號就失敗。
#
# 版本來源：上游 v2.0.1 的 build-wasm-simd-kws.sh 寫明 "emsdk 4.0.23 is known to work"（2026-10-31 讀取）。
# 這些值同時寫在 shared/wake-runtime.json 的 build 欄位；tests/wake-wasm-build.test.ts 核對兩邊相同。

set -euo pipefail

SHERPA_ONNX_VERSION="2.0.1"
SHERPA_ONNX_COMMIT="af2d8d81dbfa61c4cea4c568da78f3982edca005"
EMSDK_VERSION="4.0.23"
EMSDK_COMMIT="c0bb220cb6e6f4e0fabb6f6db9efd53390ef5e56"

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <work-dir> <out-dir>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="$SCRIPT_DIR/wake-wasm.mjs"
mkdir -p "$1" "$2"
WORK="$(cd "$1" && pwd)"
OUT="$(cd "$2" && pwd)"
if [ -n "$(ls -A "$OUT")" ]; then
  echo "output folder must be empty: $OUT" >&2
  exit 2
fi

fetch_commit() {
  # 只抓那一個 commit（淺層），再核對 HEAD 是預期的完整 SHA。
  local url="$1" commit="$2" dir="$3"
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch -q --depth 1 origin "$commit"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  if [ "$head" != "$commit" ]; then
    echo "unexpected commit in $dir: $head (expected $commit)" >&2
    exit 1
  fi
}

# 1. emsdk
if [ -z "${EMSDK_DIR:-}" ]; then
  EMSDK_DIR="$WORK/emsdk"
  fetch_commit https://github.com/emscripten-core/emsdk.git "$EMSDK_COMMIT" "$EMSDK_DIR"
  "$EMSDK_DIR/emsdk" install "$EMSDK_VERSION"
  "$EMSDK_DIR/emsdk" activate "$EMSDK_VERSION"
fi
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
EMCC_VERSION="$(emcc --version | head -n 1)"
echo "emcc: $EMCC_VERSION"
case "$EMCC_VERSION" in
  *" $EMSDK_VERSION "* | *" $EMSDK_VERSION") ;;
  *)
    echo "emcc is not $EMSDK_VERSION" >&2
    exit 1
    ;;
esac
EMSCRIPTEN="$(dirname "$(realpath "$(command -v emcc)")")"
export EMSCRIPTEN

# 2. sherpa-onnx
SRC="$WORK/sherpa-onnx"
fetch_commit https://github.com/k2-fsa/sherpa-onnx.git "$SHERPA_ONNX_COMMIT" "$SRC"
echo "sherpa-onnx v$SHERPA_ONNX_VERSION at $SHERPA_ONNX_COMMIT"

# 3. 修改 wasm/kws/CMakeLists.txt（完全比對；上游不同就停下）
node "$TOOL" patch "$SRC"

# 4. 建置：選項與上游 build-wasm-simd-kws.sh 相同（TTS OFF、WASM_KWS ON，其他 WASM 目標維持預設 OFF）
BUILD="$SRC/build-wasm-simd-kws"
mkdir -p "$BUILD"
export SHERPA_ONNX_IS_USING_BUILD_WASM_SH=ON
cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_INSTALL_PREFIX="$BUILD/install" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$EMSCRIPTEN/cmake/Modules/Platform/Emscripten.cmake" \
  -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
  -DSHERPA_ONNX_ENABLE_TESTS=OFF \
  -DSHERPA_ONNX_ENABLE_CHECK=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
  -DSHERPA_ONNX_ENABLE_JNI=OFF \
  -DSHERPA_ONNX_ENABLE_C_API=ON \
  -DSHERPA_ONNX_ENABLE_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF \
  -DSHERPA_ONNX_ENABLE_GPU=OFF \
  -DSHERPA_ONNX_ENABLE_WASM=ON \
  -DSHERPA_ONNX_ENABLE_WASM_KWS=ON \
  -DSHERPA_ONNX_ENABLE_WASM_TTS=OFF \
  -DSHERPA_ONNX_ENABLE_BINARY=OFF \
  -DSHERPA_ONNX_LINK_LIBSTDCPP_STATICALLY=OFF
cmake --build "$BUILD" -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
cmake --install "$BUILD"
node "$TOOL" package "$SRC" "$BUILD" "$OUT"

# 5. 授權檢查（GPL espeak-ng／piper）
node "$TOOL" license-check "$BUILD" "$OUT"

ls -l "$OUT"
