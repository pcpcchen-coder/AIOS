// PRO-1：/api/settings/proactive 與 settings.proactive 經真的核心入口（startNous）；假 Open-Meteo（fixture，不連網）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startNous, type NousHandle } from "../server/nous.ts";
import type { SettingsView } from "../shared/types.ts";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

let root: string;
let core: NousHandle | null = null;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nous-proactive-http-"));
});
afterEach(async () => {
  await core?.close();
  core = null;
  rmSync(root, { recursive: true, force: true });
});

async function boot(fetched: string[]): Promise<NousHandle> {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Nous</title>");
  core = await startNous({
    envFile: null,
    dataDir: join(root, "data"),
    distDir: dist,
    fallbackPort: true,
    overrides: { NOUS_CONFIG_DIR: join(root, "config"), NOUS_PROVIDER: "mock", PORT: String(await freePort()), ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", NOUS_AIL: "on", NOUS_AIL_SERVICES: "weather", SMARTHOME_URL: "", SMARTHOME_TOKEN: "" },
    log: () => {},
    weatherFetch: (async (url: string | URL) => {
      fetched.push(String(url));
      return new Response("{}", { status: 503 });
    }) as typeof fetch,
  });
  return core;
}

const post = (url: string, body: unknown, locale = "zh-TW") =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-nous-locale": locale }, body: JSON.stringify(body) });

describe("PRO-1 settings over HTTP", () => {
  it("settings.proactive is always there; POST saves valid patches and refuses bad ones with 400; the weather tool is registered", async () => {
    const fetched: string[] = [];
    const h = await boot(fetched);
    const view = (await (await fetch(`${h.url}/api/settings`)).json()) as SettingsView;
    expect(view.proactive?.prefs).toEqual({ enabled: true, weather: true, start_hour: 5, end_hour: 11, place: null });
    expect(view.proactive?.write_path).toBe("/api/settings/proactive");
    expect(view.integrations?.tools).toContain("app__weather__today");

    const saved = await post(`${h.url}/api/settings/proactive`, { place: "tainan", start_hour: 6 });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as SettingsView).proactive).toMatchObject({ prefs: { place: "tainan", start_hour: 6 }, place: { id: "tainan", label: "台南", auto: false } });

    for (const bad of [{ place: "https://evil.example/" }, { start_hour: 10, end_hour: 9 }, { unknown: true }]) {
      expect((await post(`${h.url}/api/settings/proactive`, bad)).status).toBe(400);
    }
    const en = await post(`${h.url}/api/settings/proactive`, { start_hour: 9, end_hour: 9 }, "en");
    expect(((await en.json()) as { error: string }).error).toBe("The window must start before it ends");
    // 設定頁讀不到天氣內容（只有狀態）。
    expect(JSON.stringify(((await (await fetch(`${h.url}/api/settings`)).json()) as SettingsView).proactive)).not.toMatch(/度|°C|percent/);
    expect(fetched).toEqual([]);
  });
});
