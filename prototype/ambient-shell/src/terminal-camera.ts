import { CAMERA_PREF_KEYS, DEFAULT_CAMERA_PREFS, parseCameraPatch, type CameraPrefs, type CameraPrefsPatch } from "../shared/sense.ts";
import { cameraPreviewDisabledReason, describeMenuPrefs } from "../shared/seconds-menu.ts";
import type { SettingsView } from "../shared/types.ts";
import { DEFAULT_VOICE_PREFS } from "../shared/voice-prefs.ts";

export const TERMINAL_CAMERA_KEY = "nous.terminal.rpi4.camera.v1";
export const TERMINAL_CAMERA_SCOPE = "鏡頭設定只套用到這台 Pi。影像在 Pi 本機處理，不保存、不上傳；鏡頭權限由 Chromium 詢問。";
export const TERMINAL_CAMERA_SAVE_ERROR = "Pi 鏡頭設定沒有保存，請確認瀏覽器允許本機儲存。";
export const TERMINAL_CAMERA_STOP_ERROR = "鏡頭已在這個視窗關閉，但設定沒有保存；重新開啟頁面可能沿用上次設定。";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface TerminalCameraOptions {
  search: string;
  desktop: boolean;
  storage(): StorageLike;
}

export interface TerminalCameraUpdate {
  settings: SettingsView;
  error: string | null;
}

export class TerminalCameraPrefs {
  readonly local: boolean;
  private remote: SettingsView | null = null;
  private prefs: CameraPrefs | null = null;
  private stopped = false;

  constructor(private readonly options: TerminalCameraOptions) {
    const terminal = new URLSearchParams(options.search).getAll("terminal");
    this.local = !options.desktop && terminal.length === 1 && terminal[0] === "rpi4";
  }

  receive(remote: SettingsView): SettingsView {
    if (!this.local) return remote;
    this.remote = remote;
    if (!this.prefs && remote.camera) {
      const camera = remote.camera;
      this.prefs = { ...DEFAULT_CAMERA_PREFS, ...parseCameraPatch(Object.fromEntries(CAMERA_PREF_KEYS.map((key) => [key, camera[key]]))), active: false };
      try {
        const value = JSON.parse(this.options.storage().getItem(TERMINAL_CAMERA_KEY) ?? "null");
        if (value?.version === 1 && CAMERA_PREF_KEYS.every((key) => Object.hasOwn(value.prefs ?? {}, key))) {
          const parsed = parseCameraPatch(value.prefs);
          this.prefs = { ...DEFAULT_CAMERA_PREFS, ...parsed };
        }
      } catch {
      }
    }
    return this.project();
  }

  update(input: CameraPrefsPatch): TerminalCameraUpdate {
    if (!this.local || !this.remote?.camera || !this.prefs) throw new Error("鏡頭不能打開：App 的鏡頭功能不可用");
    const patch = parseCameraPatch(input);
    if (patch.active === false) this.stopped = true;
    const next = { ...this.prefs, ...patch };
    if (this.stopped && patch.active !== true) next.active = false;
    try {
      this.options.storage().setItem(TERMINAL_CAMERA_KEY, JSON.stringify({ version: 1, prefs: next }));
      this.prefs = next;
      if (patch.active !== undefined || !next.active) this.stopped = false;
      return { settings: this.project(), error: null };
    } catch {
      return { settings: this.project(), error: patch.active === false ? TERMINAL_CAMERA_STOP_ERROR : TERMINAL_CAMERA_SAVE_ERROR };
    }
  }

  private project(): SettingsView {
    const remote = this.remote!;
    if (!remote.camera || !this.prefs) return remote;
    const camera = {
      ...remote.camera,
      ...this.prefs,
      active: remote.camera.enabled && this.prefs.active && !this.stopped,
      enable_via: "page" as const,
    };
    return {
      ...remote,
      camera,
      seconds: describeMenuPrefs({ camera, voice: remote.voice ?? DEFAULT_VOICE_PREFS, voiceWritable: !!remote.voice, realtime: remote.realtime }),
      camera_preview_disabled_reason: cameraPreviewDisabledReason(camera),
    };
  }
}
