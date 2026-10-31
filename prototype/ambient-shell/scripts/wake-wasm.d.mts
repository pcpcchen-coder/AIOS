// scripts/wake-wasm.mjs 的型別（tests 使用）。
export interface WakeWasmPins {
  sherpa_onnx_version: string;
  sherpa_onnx_commit: string;
  emsdk_version: string;
  emsdk_commit: string;
}
export interface WakeWasmManifest extends WakeWasmPins {
  config_sha256: string;
  release_tag: string;
  files: { name: string; sha256: string; bytes: number }[];
  release_only: { name: string; sha256: string; bytes: number }[];
}
export function readPins(script?: string): WakeWasmPins;
export function configSha256(files?: string[]): string;
export function releaseTag(pins?: WakeWasmPins, config?: string): string;
export function patchKwsCmake(text: string): string;
export function esmApi(text: string): string;
export const OUTPUT_FILES: string[];
export function packageOutput(srcDir: string, buildDir: string, outDir: string): void;
export const GPL_PATTERN: RegExp;
export function licenseFindings(buildDir: string | null, outDir: string): string[];
export function manifestFor(outDir: string, pins?: WakeWasmPins, config?: string): WakeWasmManifest;
export const RELEASE_ONLY_FILES: string[];
