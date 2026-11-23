// AIL-1：工具參數的 Schema 與驗證器。只支援即時語音函式工具實際用到的 JSON Schema 子集
// （平面物件、string／number／integer／boolean、enum、長度與數值範圍、required、additionalProperties:false），
// 不引入新的依賴。註冊時用 assertSupportedSchema 檢查 Adapter 的 Schema；呼叫時用 validateArgs 驗證模型的參數。

export type PropertySchema =
  | { type: "string"; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  /** AIL-2：字串、有限數字或布林值（只限 legacy Facade 工具，不給模型看；字串長度同 maxLength）。 */
  | { type: "scalar"; description?: string; maxLength?: number };

export interface InputSchema {
  type: "object";
  properties: Readonly<Record<string, PropertySchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

/** 字串參數沒有寫 maxLength 時的上限（避免模型塞長文）。 */
export const DEFAULT_MAX_STRING = 500;
const PROPERTY_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const PROPERTY_KEYS: Record<PropertySchema["type"], readonly string[]> = {
  string: ["type", "description", "enum", "minLength", "maxLength"],
  number: ["type", "description", "minimum", "maximum"],
  integer: ["type", "description", "minimum", "maximum"],
  boolean: ["type", "description"],
  scalar: ["type", "description", "maxLength"],
};

export class SchemaError extends Error {}

/** 註冊時檢查：只接受上面的子集；任何其他關鍵字（$ref、oneOf、巢狀物件…）一律拒絕。 */
export function assertSupportedSchema(schema: unknown): asserts schema is InputSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new SchemaError("inputSchema 必須是物件");
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!["type", "properties", "required", "additionalProperties"].includes(key)) throw new SchemaError(`inputSchema 不支援 ${key}`);
  if (s.type !== "object") throw new SchemaError("inputSchema.type 必須是 object");
  if (s.additionalProperties !== false) throw new SchemaError("inputSchema.additionalProperties 必須是 false");
  if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) throw new SchemaError("inputSchema.properties 必須是物件");
  const props = s.properties as Record<string, unknown>;
  for (const [name, raw] of Object.entries(props)) {
    if (!PROPERTY_NAME.test(name)) throw new SchemaError(`參數名稱不合法：${name}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SchemaError(`參數 ${name} 必須是物件`);
    const p = raw as Record<string, unknown>;
    const allowed = PROPERTY_KEYS[p.type as PropertySchema["type"]];
    if (!allowed) throw new SchemaError(`參數 ${name} 的型別不支援：${String(p.type)}`);
    for (const key of Object.keys(p)) if (!allowed.includes(key)) throw new SchemaError(`參數 ${name} 不支援 ${key}`);
    if (p.description !== undefined && typeof p.description !== "string") throw new SchemaError(`參數 ${name} 的 description 必須是字串`);
    if (p.enum !== undefined && (!Array.isArray(p.enum) || !p.enum.length || !p.enum.every((v) => typeof v === "string"))) throw new SchemaError(`參數 ${name} 的 enum 必須是非空字串陣列`);
    for (const key of ["minLength", "maxLength", "minimum", "maximum"]) {
      if (p[key] !== undefined && (typeof p[key] !== "number" || !Number.isFinite(p[key]))) throw new SchemaError(`參數 ${name} 的 ${key} 必須是數字`);
    }
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string" && r in props)) throw new SchemaError("inputSchema.required 只能列出 properties 裡的名稱");
  }
}

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * 呼叫時驗證（模型的參數是外來資料）：必須是 JSON 物件、沒有多餘欄位、必填都在、型別與範圍正確。
 * 錯誤訊息只有參數名稱與規則，不回顯參數值。
 */
export function validateArgs(schema: InputSchema, input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "參數必須是 JSON 物件" };
  const args = input as Record<string, unknown>;
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) return { ok: false, error: `不認得的參數：${key.slice(0, 32)}` };
  for (const key of schema.required ?? []) if (args[key] === undefined) return { ok: false, error: `缺少參數：${key}` };
  const value: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (prop.type === "string") {
      if (typeof v !== "string") return { ok: false, error: `${key} 必須是字串` };
      if (prop.enum && !prop.enum.includes(v)) return { ok: false, error: `${key} 不在允許的值裡` };
      if (prop.minLength !== undefined && v.length < prop.minLength) return { ok: false, error: `${key} 太短` };
      if (v.length > (prop.maxLength ?? DEFAULT_MAX_STRING)) return { ok: false, error: `${key} 太長` };
    } else if (prop.type === "number" || prop.type === "integer") {
      if (typeof v !== "number" || !Number.isFinite(v) || (prop.type === "integer" && !Number.isInteger(v))) return { ok: false, error: `${key} 必須是${prop.type === "integer" ? "整數" : "數字"}` };
      if (prop.minimum !== undefined && v < prop.minimum) return { ok: false, error: `${key} 小於下限` };
      if (prop.maximum !== undefined && v > prop.maximum) return { ok: false, error: `${key} 大於上限` };
    } else if (prop.type === "scalar") {
      const okType = typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= (prop.maxLength ?? DEFAULT_MAX_STRING));
      if (!okType) return { ok: false, error: `${key} 必須是短字串、數字或布林值` };
    } else if (typeof v !== "boolean") {
      return { ok: false, error: `${key} 必須是 true 或 false` };
    }
    value[key] = v;
  }
  return { ok: true, value };
}
