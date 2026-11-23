import { INTENT_IDS, MUSIC_SERVICES, type VoiceRelayPart } from "../../../shared/voice-relay.ts";
import type { VoiceRelayAdapter } from "../adapters/voice-relay.ts";
import type { DiagnosticOptions, RelayRequest } from "./resolver.ts";
import { VoiceRelayStoreError } from "./store.ts";

// VCR-2：設定頁「語音中繼（實驗）」的 HTTP 路由（server/app.ts 轉進來；voice_relay 沒註冊時 app.ts 直接 404）。
// 和其他設定 POST 一樣只靠 http-guard（同源、本機）。每個 body 嚴格驗證：不認得的鍵、型別不對一律 400，訊息固定、不回顯值。
// 播放只在使用者按下按鈕時由這裡觸發；沒有自動播放。

export const BAD_BODY = "語音中繼請求格式不正確。";
const NO_STORE = "語音中繼設定無法寫入。";

type Body = Record<string, unknown>;
type Kind = "string" | "int" | "number" | "boolean" | "object";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const bad = (): never => {
  throw new VoiceRelayStoreError(400, BAD_BODY);
};

/** 鍵必須剛好在 required＋optional 裡，型別都對。 */
function strict(body: Body, required: Record<string, Kind>, optional: Record<string, Kind> = {}): Body {
  for (const k of Object.keys(body)) if (!Object.hasOwn(required, k) && !Object.hasOwn(optional, k)) bad();
  for (const k of Object.keys(required)) if (body[k] === undefined) bad();
  for (const [k, kind] of [...Object.entries(required), ...Object.entries(optional)]) {
    const v = body[k];
    if (v === undefined) continue;
    const ok =
      kind === "string" ? typeof v === "string" && v.length > 0 && v.length <= 128 && !CONTROL.test(v)
      : kind === "int" ? typeof v === "number" && Number.isInteger(v)
      : kind === "number" ? typeof v === "number" && Number.isFinite(v)
      : kind === "boolean" ? typeof v === "boolean"
      : !!v && typeof v === "object" && !Array.isArray(v);
    if (!ok) bad();
  }
  return body;
}

const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (values.includes(v as T) ? (v as T) : bad());

const SLOT_KINDS: Record<string, Kind> = { genre: "string", device: "string", on: "boolean", percent: "int", seconds: "int" };
const RESOLVE_KEYS: Record<string, Kind> = { slots: "object", template_id: "string", voice_profile_id: "string" };

function relayRequest(body: Body): { request: RelayRequest; diagnostic: DiagnosticOptions } {
  const slots = body.slots === undefined ? {} : strict(body.slots as Body, {}, SLOT_KINDS);
  const diagnostic: DiagnosticOptions = {
    ...(body.template_id !== undefined ? { candidateTemplateId: body.template_id as string } : {}),
    ...(body.voice_profile_id !== undefined ? { candidateVoiceId: body.voice_profile_id as string } : {}),
  };
  return { request: { targetId: body.target_id as string, intentId: body.intent_id as string, slots }, diagnostic };
}

/**
 * 處理 /api/voice-relay*。回 undefined＝不是這組路由。錯誤丟 VoiceRelayStoreError（status＋固定訊息）。
 * readBody 只在 POST 呼叫；signal 在 HTTP 連線關閉時中止（播放跟著停）。
 */
export async function handleVoiceRelayRoute(adapter: VoiceRelayAdapter, method: string, path: string, readBody: () => Promise<Body>, signal: AbortSignal): Promise<unknown | undefined> {
  if (path === "/api/voice-relay" && method === "GET") return adapter.view();
  if (method !== "POST" || !path.startsWith("/api/voice-relay/")) return undefined;
  const action = path.slice("/api/voice-relay/".length);
  const store = adapter.store;
  const write = <T>(fn: () => T): T => {
    if (!store) throw new VoiceRelayStoreError(409, NO_STORE);
    return fn();
  };
  switch (action) {
    case "refresh": {
      strict(await readBody(), {});
      await adapter.refresh();
      return adapter.view();
    }
    case "preview": {
      const body = strict(await readBody(), { target_id: "string", intent_id: "string" }, RESOLVE_KEYS);
      const { request, diagnostic } = relayRequest(body);
      return { result: adapter.preview(request, diagnostic) };
    }
    case "play": {
      const body = strict(await readBody(), { target_id: "string", intent_id: "string", part: "string" }, RESOLVE_KEYS);
      const part = oneOf<VoiceRelayPart>(body.part, ["wake", "full"]);
      const { request, diagnostic } = relayRequest(body);
      return adapter.playDiagnostic(request, diagnostic, part, signal);
    }
    case "adopt": {
      const b = strict(await readBody(), { target_id: "string", intent_id: "string", template_id: "string", template_version: "int", voice_profile_id: "string" });
      write(() => store!.adopt({ target_id: b.target_id as string, intent_id: oneOf(b.intent_id, INTENT_IDS), template_id: b.template_id as string, template_version: b.template_version as number, voice_profile_id: b.voice_profile_id as string }));
      return adapter.view();
    }
    case "unadopt": {
      const b = strict(await readBody(), { target_id: "string", template_id: "string", template_version: "int" });
      write(() => store!.unadopt({ target_id: b.target_id as string, template_id: b.template_id as string, template_version: b.template_version as number }));
      return adapter.view();
    }
    case "target": {
      const b = strict(await readBody(), { locale: "string", output_device_id: "string", voice_id: "string", music_service: "string" }, { id: "string" });
      write(() => store!.createTarget({ ...(b.id !== undefined ? { id: b.id as string } : {}), locale: oneOf(b.locale, ["zh-TW", "en-US"] as const), output_device_id: b.output_device_id as string, voice_id: b.voice_id as string, music_service: oneOf(b.music_service, MUSIC_SERVICES) }));
      return adapter.view();
    }
    case "profile": {
      const b = strict(await readBody(), { target_id: "string", voice_id: "string", rate: "number", gain_db: "number", pause_ms: "int", lead_ms: "int", tail_ms: "int" }, { id: "string" });
      write(() => store!.upsertProfile({ target_id: b.target_id as string, ...(b.id !== undefined ? { id: b.id as string } : {}), voice_id: b.voice_id as string, rate: b.rate as number, gain_db: b.gain_db as number, pause_ms: b.pause_ms as number, lead_ms: b.lead_ms as number, tail_ms: b.tail_ms as number }));
      return adapter.view();
    }
    case "trial": {
      const b = strict(await readBody(), { target_id: "string", template_id: "string", template_version: "int", voice_profile_id: "string", kind: "string", wake: "string", command: "string", evidence: "string" });
      write(() =>
        store!.recordTrial(
          {
            target_id: b.target_id as string, template_id: b.template_id as string, template_version: b.template_version as number, voice_profile_id: b.voice_profile_id as string,
            kind: oneOf(b.kind, ["positive", "negative"] as const), wake: oneOf(b.wake, ["WAKE_OK", "NO_WAKE", "UNKNOWN"] as const),
            command: oneOf(b.command, ["COMMAND_OK", "WRONG_COMMAND", "NO_COMMAND", "UNKNOWN"] as const),
            // 設定頁只能記「目視」或「人工確認」；device_state_api 要有真的下游狀態讀取，這裡不能宣稱。
            evidence: oneOf(b.evidence, ["visual", "human_confirmed"] as const),
          },
          adapter.currentCatalog(),
        ),
      );
      return adapter.view();
    }
    case "enabled": {
      const b = strict(await readBody(), { target_id: "string", enabled: "boolean" });
      write(() => store!.setEnabled({ target_id: b.target_id as string, enabled: b.enabled as boolean }));
      return adapter.view();
    }
  }
  return undefined;
}
