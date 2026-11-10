// 架構重整 S6：server/routes/settings.ts 的路由表本身（不經 HTTP）。對外行為由 tests/settings-routes.test.ts 經真的 HTTP 驗證；
// 這裡只守表的形狀與每一條的先後（store 在不在 → 讀 body → 格式 → 拒絕 → 寫入）。全部是假的 store，不是產品 gate。
import { describe, expect, it } from "vitest";
import { HttpError } from "../server/http-error.ts";
import { findSettingsWrite, type SettingsWriteStores } from "../server/routes/settings.ts";

const PATHS = [
  "/api/settings/provider", "/api/settings/camera", "/api/settings/camera-tuning", "/api/settings/voice", "/api/settings/audio", "/api/settings/wake",
  "/api/settings/clock", "/api/settings/day-night", "/api/settings/home-corner", "/api/settings/proactive", "/api/settings/memories", "/api/settings/realtime",
];
/** 沒有 store 時不存在的路由（旗標關閉）；其餘沒有 store 時是 409。 */
const FLAGGED = ["/api/settings/wake", "/api/settings/clock", "/api/settings/day-night", "/api/settings/home-corner", "/api/settings/proactive", "/api/settings/memories"];
const bare: SettingsWriteStores = { settings: { select: () => {} } };

async function caught(run: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return { status: (err as HttpError).status, message: (err as Error).message };
  }
  throw new Error("expected an HttpError");
}

describe("設定寫入路由表（server/routes/settings.ts）", () => {
  it("只比對 POST 與完整路徑；/api/settings/alarms 不在表上（留在 app.ts）", () => {
    for (const path of PATHS) {
      expect(findSettingsWrite("POST", path), path).toBeTypeOf("function");
      for (const method of ["GET", "HEAD", "PUT", "DELETE", "post"]) expect(findSettingsWrite(method, path), `${method} ${path}`).toBeUndefined();
      expect(findSettingsWrite("POST", `${path}/`), path).toBeUndefined();
    }
    for (const path of ["/api/settings", "/api/settings/alarms", "/api/settings/nope", "/api/memories/google/pick", "/api/alarms/stop"]) expect(findSettingsWrite("POST", path), path).toBeUndefined();
  });

  it("沒有 store：旗標路由回 false（不存在）、其餘 409；都不讀 body", async () => {
    let reads = 0;
    const readBody = async () => {
      reads += 1;
      return {};
    };
    const missing: Record<string, string> = {
      "/api/settings/camera": "鏡頭未設定", "/api/settings/camera-tuning": "鏡頭未啟用", "/api/settings/voice": "語音設定未設定",
      "/api/settings/audio": "聲音裝置設定未設定", "/api/settings/realtime": "即時語音路徑設定未設定",
    };
    for (const path of PATHS.filter((p) => p !== "/api/settings/provider")) {
      const write = findSettingsWrite("POST", path)!;
      if (FLAGGED.includes(path)) expect(await write(bare, readBody), path).toBe(false);
      else expect(await caught(() => write(bare, readBody)), path).toEqual({ status: 409, message: missing[path] });
    }
    expect(reads).toBe(0);
  });

  it("一致的那一種：格式錯誤 400 不寫入；寫入失敗 500 帶原因；成功回 true 且 this 是 store 本身", async () => {
    const store = {
      patches: [] as unknown[],
      fail: false,
      update(patch: unknown) {
        if (this.fail) throw new Error("disk full");
        this.patches.push(patch);
      },
    };
    const write = findSettingsWrite("POST", "/api/settings/voice")!;
    const stores: SettingsWriteStores = { ...bare, voice: store };
    expect(await caught(() => write(stores, async () => ({ voice_idle_s: 5 })))).toEqual({ status: 400, message: "voice_idle_s 必須是 30–600 秒、間隔 10" });
    expect(store.patches).toEqual([]);
    expect(await write(stores, async () => ({ voice_idle_s: 120 }))).toBe(true);
    expect(store.patches).toEqual([{ voice_idle_s: 120 }]);
    store.fail = true;
    expect(await caught(() => write(stores, async () => ({ voice_idle_s: 120 })))).toEqual({ status: 500, message: "語音設定沒有保存（無法寫入設定檔：disk full）" });
    // 讀 body 丟的錯（例如 413、不是 JSON 物件）原樣往外丟。
    const tooLarge = new HttpError(413, "body too large");
    await expect(write(stores, async () => { throw tooLarge; })).rejects.toBe(tooLarge);
  });

  it("store 自己丟的格式錯誤：只有主動提醒是 400，其他路由一律當成寫入失敗（500）", async () => {
    const { ProactivePatchError } = await import("../shared/proactive.ts");
    const { VoicePatchError } = await import("../shared/voice-prefs.ts");
    const proactive = { update: () => { throw new ProactivePatchError("時段的開始要早於結束"); } };
    const voice = { update: () => { throw new VoicePatchError("x"); } };
    expect(await caught(() => findSettingsWrite("POST", "/api/settings/proactive")!({ ...bare, proactive }, async () => ({})))).toEqual({ status: 400, message: "時段的開始要早於結束" });
    expect(await caught(() => findSettingsWrite("POST", "/api/settings/voice")!({ ...bare, voice }, async () => ({})))).toEqual({ status: 500, message: "語音設定沒有保存（無法寫入設定檔：x）" });
  });
});
