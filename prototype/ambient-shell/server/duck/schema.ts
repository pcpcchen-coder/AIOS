import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { DuckLinkMessage } from "../../shared/duck-link.ts";
import schema from "../../shared/duck-link.v0.schema.json" with { type: "json" };

// DUCK-1：duck-link v0 的 schema 驗證。驗證器：Ajv 8.20.0（draft 2020-12），版本鎖在 package.json。
// schema 的正本在 Nous Duck repo（pcpcchen-coder/Open_Duck_Mini 的 nous_duck/protocol/schemas/duck-link.v0.schema.json）；
// shared/duck-link.v0.schema.json 是原樣複製（tests/duck-link-schema.test.ts 用那邊的合法／不合法範例檢查）。
// 要改協定：先在那個 repo 改 schema 並升版，再把檔案複製過來，不在這裡手改。

export type Validation = { ok: true; message: DuckLinkMessage } | { ok: false; errors: string[] };

export interface DuckLinkValidator {
  /** 驗證一則已經解析成物件的訊息。 */
  validate(value: unknown): Validation;
  /** 驗證一個 WebSocket 文字框（先 JSON.parse）。 */
  parse(text: string): Validation;
}

const MESSAGE_TYPES = ["hello", "heartbeat", "command", "ack", "state", "event"];

function describe(errors: ErrorObject[] | null | undefined): string[] {
  // 錯誤說明只有欄位路徑與規則，不回顯值（值可能是外來內容）。
  const lines = (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}`);
  return [...new Set(lines)].slice(0, 8);
}

export function createValidator(): DuckLinkValidator {
  // strict:false：schema 的子定義刻意不重複寫 type:"object"（由最外層宣告），Ajv 的 strictTypes 會抱怨。
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const whole = ajv.compile(schema);
  const byType = new Map<string, ValidateFunction>();
  for (const type of MESSAGE_TYPES) byType.set(type, ajv.compile({ $ref: `${schema.$id}#/$defs/${type}` }));

  function validate(value: unknown): Validation {
    if (whole(value)) return { ok: true, message: value as unknown as DuckLinkMessage };
    // 最外層是 oneOf，錯誤訊息很難讀；知道 type 時改用該種訊息的子定義再驗一次，拿到看得懂的錯誤。
    const type = value && typeof value === "object" ? (value as Record<string, unknown>).type : undefined;
    const sub = typeof type === "string" ? byType.get(type) : undefined;
    if (sub && !sub(value)) return { ok: false, errors: describe(sub.errors) };
    return { ok: false, errors: describe(whole.errors?.filter((e) => e.keyword !== "oneOf")) };
  }

  return {
    validate,
    parse(text: string): Validation {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { ok: false, errors: ["不是合法的 JSON"] };
      }
      return validate(value);
    },
  };
}
