// 本機、確定性的指令判斷：只有短句且符合固定語彙時才當成控制指令，
// 其餘一律視為「交辦任務」。不用模型猜測，避免把交辦內容誤當成控制動作。

export type Intent =
  | { kind: "empty" }
  | { kind: "dismiss" }
  | { kind: "stop" }
  | { kind: "progress" }
  | { kind: "result" }
  | { kind: "voice_on" }
  | { kind: "voice_off" }
  | { kind: "settings" }
  | { kind: "use_provider"; provider: "claude" | "chatgpt" | "mock" }
  | { kind: "task"; text: string };

const MAX_COMMAND_CHARS = 14;
const POLITE_PREFIX = /^(請你?|麻煩你?|幫我|可以|能不能|我想|我要)+/;
const TRAILING = /[\s，,。.!！?？~～…]+$/;
const LEADING = /^[\s，,。.!！?？~～…]+/;

const VOICE_ON = /^(開啟|打開|啟動|進入|開)?語音(模式|對話|互動)$/;
const VOICE_OFF = /^((關閉|關掉|結束|離開|退出|停止)語音(模式|對話|互動)?|語音(模式)?(關閉|關掉))$/;
const SETTINGS = /^(設定|打開設定|開啟設定|切換(引擎|模型|AI)|(AI )?引擎(設定)?|模型設定|(打開|開啟)?鏡頭設定|登入 ?ChatGPT|ChatGPT 登入|settings)$/i;
const USE_PROVIDER = /^(改用|使用|切換到|換成|用)\s*(ChatGPT|GPT|Claude|模擬模式|模擬)(引擎|模式)?$/i;
const DISMISS = /^(收起(來)?(吧)?|回(到)?桌布(吧)?|關閉(畫面|視窗)?|隱藏|先這樣|close|dismiss|hide)$/i;
const STOP = /^((停止|取消|中止|終止)(這個|那個|目前的|剛才的)?(任務|工作)?|不要做了|別做了|stop|cancel)$/i;
const PROGRESS = /(進度|做到哪|做得怎樣|怎麼樣了|好了沒|完成了沒|完成了嗎|狀態|狀況|進展|progress|status)/i;
const RESULT = /(成果|結果|剛才那份|剛剛那份|上一份|那份報告|拿出來|給我看)/;
// 含這些動詞的句子是在交辦工作，即使提到「進度」「結果」也不是查詢。
const TASK_VERB = /(寫|撰寫|整理|規劃|分析|產生|擬定|草擬|設計|翻譯|計算|比較|列出|建立|製作|準備|研究|摘要|總結|做一份)/;

export function normalizeCommand(text: string): string {
  return text.replace(TRAILING, "").replace(LEADING, "").replace(POLITE_PREFIX, "").trim();
}

export function classify(input: string): Intent {
  const text = input.trim();
  if (!text) return { kind: "empty" };
  const command = normalizeCommand(text);
  if (command.length <= MAX_COMMAND_CHARS && !TASK_VERB.test(command)) {
    if (VOICE_OFF.test(command)) return { kind: "voice_off" };
    if (VOICE_ON.test(command)) return { kind: "voice_on" };
    const use = command.match(USE_PROVIDER);
    if (use) {
      const name = use[2].toLowerCase();
      const provider = name === "claude" ? "claude" : name.startsWith("模擬") ? "mock" : "chatgpt";
      return { kind: "use_provider", provider };
    }
    if (SETTINGS.test(command)) return { kind: "settings" };
    if (DISMISS.test(command)) return { kind: "dismiss" };
    if (STOP.test(command)) return { kind: "stop" };
    if (PROGRESS.test(command)) return { kind: "progress" };
    if (RESULT.test(command)) return { kind: "result" };
  }
  return { kind: "task", text };
}

/** 「設定」類說法指的是哪一塊：鏡頭（「鏡頭設定」）、引擎（「切換引擎」「模型設定」）或一般（「設定」「登入 ChatGPT」）。 */
export type SettingsTopic = "camera" | "engine" | "general";

export function settingsTopic(input: string): SettingsTopic {
  const command = normalizeCommand(input.trim());
  if (/鏡頭/.test(command)) return "camera";
  if (/引擎|模型|AI/i.test(command)) return "engine";
  return "general";
}

/**
 * 打開設定畫面時說的話（字幕與語音模式的播報）。瀏覽器版是完整的設定畫面；macOS App（desktop）的設定頁只有
 * 帳號與登入，其他設定在選單列，所以照實指出在選單列的哪裡。
 */
export function settingsReply(input: string, ctx: { desktop: boolean; cameraEnabled: boolean }): string {
  if (!ctx.desktop) return ctx.cameraEnabled ? "這是 AI 引擎與鏡頭設定。" : "這是 AI 引擎設定。";
  const topic = settingsTopic(input);
  if (topic === "camera") return "這是帳號與登入；鏡頭設定在選單列 Nous 圖示的「鏡頭與語音設定」。";
  if (topic === "engine") return "這是帳號與登入；切換引擎在選單列 Nous 圖示的「AI 引擎」。";
  return "這是帳號與登入；鏡頭、秒數與引擎在選單列的 Nous 圖示裡。";
}
