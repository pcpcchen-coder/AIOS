import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_CLIENT_VERSION, loadConfig } from "../server/config.ts";

// 實機（2026-10-23）：帶 Nous 自己的版本（0.1.0）查 Codex /models 拿到空清單，交辦一律失敗。
describe("Codex client_version", () => {
  it("defaults to a Codex version, not Nous's own version", () => {
    const config = loadConfig({});
    expect(config.codexClientVersion).toBe(DEFAULT_CODEX_CLIENT_VERSION);
    expect(config.codexClientVersion).not.toBe(config.nousVersion);
  });

  it("can be overridden with NOUS_CODEX_CLIENT_VERSION", () => {
    expect(loadConfig({ NOUS_CODEX_CLIENT_VERSION: " 0.170.0 " }).codexClientVersion).toBe("0.170.0");
  });
});
