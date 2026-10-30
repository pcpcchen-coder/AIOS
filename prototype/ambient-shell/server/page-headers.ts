/**
 * 頁面安全標頭。鏡頭啟用時（NOUS_CAMERA=on）才允許本頁使用鏡頭，並允許編譯本機的 MediaPipe wasm；
 * 影像處理仍只在本機（connect-src 'self'）。connect-src 也擋下 @mediapipe/tasks-vision 內建、
 * 每 60 秒 POST 到 odml.pa.googleapis.com 的用量紀錄：官方不提供關閉選項，建議封鎖該主機
 * （google-ai-edge/mediapipe#6291）。本機核心（server/app.ts）與 vite.config.ts 的 dev／preview 共用這份。
 */
export function pageHeaders(camera: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": `default-src 'self'; script-src 'self'${camera ? " 'wasm-unsafe-eval'" : ""}; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": `camera=(${camera ? "self" : ""}), microphone=(self), geolocation=()`,
  };
}

/**
 * 成果紀錄獨立網頁（/history）的標頭：比主畫面更嚴。不用鏡頭、麥克風，也不編譯 wasm；表單只在頁面內處理，
 * 不送到任何地方（form-action 'none'）。
 */
export function historyPageHeaders(): Record<string, string> {
  const page = pageHeaders(false);
  return {
    ...page,
    "Content-Security-Policy": `${page["Content-Security-Policy"]}; form-action 'none'`,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}
