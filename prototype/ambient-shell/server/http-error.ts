/** 帶 HTTP 狀態碼的錯誤：server/app.ts 的最外層把它變成 `{ error }` 回應（訊息依請求的語言翻譯）；其他錯誤一律 500。 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
