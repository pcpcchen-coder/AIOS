import { getLocale, onLocaleChange } from "./i18n.ts";
import { convertsLocale } from "../shared/zh-tw.ts";

// 頁面的語音逐字稿 → 台灣繁體（規則見 shared/zh-tw.ts）。OpenCC 字典約 450 KB（gzip），不放進主 bundle：
// 中文介面載入頁面時就以動態 import 先載（獨立 chunk），載好後在閒置時建好字典；英文介面不載，切到中文時再載。
// 開始即時語音（openRealtime）與按下說話時最多等 1 秒讓它載好；還沒載好時照原樣回傳（不假裝已轉換）。
// 只用在語音辨識與模型的逐字稿；使用者打的字不經過這裡。

let impl: ((text: string) => string) | null = null;
let loading: Promise<void> | null = null;

/** 閒置時先建好字典（第一次轉換約 0.15 秒）。 */
function warm(): void {
  const run = () => { impl?.(""); };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (idle) idle(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

/** 載入轉換器（只載一次；失敗時下次再試）。 */
export function preloadTaiwan(): Promise<void> {
  loading ??= import("../shared/zh-tw-opencc.ts").then(
    (mod) => {
      impl = mod.taiwanize;
      warm();
    },
    (err: unknown) => {
      loading = null;
      console.warn("[zh-tw] 無法載入繁體轉換", err instanceof Error ? err.message : "");
    },
  );
  return loading;
}

/** 轉換器已載好。 */
export function taiwanReady(): boolean {
  return impl !== null;
}

/** 中文時等轉換器載好，最多 capMs 毫秒（逾時照常繼續，逐字稿原樣顯示）；英文或已載好時立刻完成。 */
export function whenTaiwanReady(capMs = 1000, locale: string = getLocale()): Promise<void> {
  if (!convertsLocale(locale) || impl) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs); });
  return Promise.race([preloadTaiwan(), cap]).finally(() => clearTimeout(timer));
}

/** 語音逐字稿：中文介面（或指定的語音語言是中文）把簡體轉成台灣繁體；英文、或轉換器還沒載好時原樣。 */
export function taiwanText(text: string, locale: string = getLocale()): string {
  if (!convertsLocale(locale)) return text;
  return impl ? impl(text) : text;
}

if (convertsLocale(getLocale())) void preloadTaiwan();
onLocaleChange((locale) => {
  if (convertsLocale(locale)) void preloadTaiwan();
});
