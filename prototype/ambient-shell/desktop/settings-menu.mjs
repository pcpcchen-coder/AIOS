// 選單列「鏡頭與語音設定」子選單的範本（純函式，不載入 Electron，tests/desktop-menu.test.ts 直接測）。
// 照核心給的 settings.seconds 畫：鍵、範圍、選項、標籤、單位、寫入路徑、停用原因都由核心推導（shared/seconds-menu.ts），
// 這裡不寫任何設定鍵、秒數或倍率，只依 kind 決定畫法：bool 畫成 checkbox，其餘（seconds／factor）畫成一組 radio 的子選單。
// 這個 App 的設定以選單列為主體：視窗裡的設定頁只剩帳號與登入（瀏覽器版才有完整設定畫面）。

/** 選單裡的 radio 項目。 */
export function radio(label, checked, click, enabled = true) {
  return { label, type: "radio", checked, enabled, click };
}

/** 「顯示鏡頭畫面」與「家人辨識…」接在這一段的最後（核心的 camera 分段）。 */
const PREVIEW_GROUP = "camera";

// ───────────── 常駐喚醒聆聽（WK-01a；只有核心給了 settings.wake，也就是 NOUS_WAKE=on 時才畫） ─────────────
// 文字與狀態、原因碼和 shared/wake.ts 相同（這個檔案由 App 直接執行，不能載入 .ts；tests/desktop-menu.test.ts 核對兩邊一致）。
// 狀態只來自頁面以 reportState 回報的裝置事件；勾選框只代表偏好，不代表正在收音（docs/17 §5.1）。

/** 每個狀態允許的原因碼（同 shared/wake.ts 的 WAKE_STATE_REASONS）。 */
export const WAKE_STATE_REASONS = {
  off: [null, "pref_off"],
  armed: ["starting", "auto_resume"],
  listening_local: [null],
  paused: ["user_pause", "sleep", "lock", "rate_limited", "service"],
  in_call: ["realtime"],
  released: ["web_speech"],
  error: ["permission_denied", "device_missing", "device_ended", "runtime_missing", "runtime_load_failed", "audio_failed", "unsupported"],
};

/** 頁面回報的喚醒狀態是否在白名單內（只有列舉值）。 */
export function isWakeReport(value) {
  if (!value || typeof value !== "object") return false;
  const reasons = Object.hasOwn(WAKE_STATE_REASONS, value.state) ? WAKE_STATE_REASONS[value.state] : null;
  return Array.isArray(reasons) && reasons.includes(value.reason ?? null);
}

export const WAKE_STATE_LABEL = {
  off: "未開啟",
  armed: "準備中",
  listening_local: "本機聆聽中",
  paused: "已暫停",
  in_call: "通話中",
  released: "已讓出麥克風",
  error: "無法使用",
};

export const WAKE_REASON_LABEL = {
  pref_off: "常駐喚醒聆聽已關閉",
  starting: "正在取得麥克風",
  auto_resume: "正在自動恢復",
  user_pause: "暫停到這次結束；App 重開後會自動恢復，要長期停止請關掉開關",
  sleep: "系統睡眠中",
  lock: "螢幕已鎖定",
  rate_limited: "一分鐘內已由喚醒開始 3 次通話，暫停到一分鐘後自動恢復",
  service: "服務模式中（這台 Mac 給 Pi 使用），Mac 不收音",
  realtime: "即時語音使用中，喚醒偵測暫停",
  web_speech: "按下說話或語音模式使用中，喚醒偵測暫停",
  permission_denied: "麥克風權限被拒，常駐聆聽沒有開啟",
  device_missing: "找不到上次使用的麥克風",
  device_ended: "麥克風已拔除或停止，沒有改用其他麥克風",
  runtime_missing: "喚醒引擎尚未安裝，沒有開啟麥克風",
  runtime_load_failed: "喚醒引擎載入失敗，已停止收音",
  audio_failed: "無法開始本機收音",
  unsupported: "這個環境不支援本機收音",
};

export const WAKE_MENU_TEXT = {
  group: "喚醒詞",
  statusPrefix: "喚醒聆聽",
  listen: "常駐喚醒聆聽",
  listenNote: "只在這台 Mac 本機偵測「Hello Nous」或「Hey Nous」",
  silence: "喚醒後等你開口",
  silenceNote: "喚醒後這麼久沒聽到聲音就結束這通；Nous 說話時不算",
  pause: "暫停聆聽（到這次結束）",
  resume: "繼續聆聽",
  speaker: "通話中辨認說話者",
  speakerNote: "通話中每段話在本機比對聲音；只用來問要不要用你的記憶，換人只記錄",
  voiceNameTest: "只憑聲音也叫名字（測試）",
  voiceNameTestNote: "喚醒時認不出臉，聲音認出就叫名字；門檻未校準，可能叫錯人",
  notReported: "尚未回報",
};

/** 「喚醒後等你開口」的選項與預設（同 shared/wake.ts 的 WAKE_SILENCE_OPTIONS_S、DEFAULT_WAKE_SILENCE_S）。 */
export const WAKE_SILENCE_OPTIONS_S = [3, 5, 8, 10, 15, 20];
export const DEFAULT_WAKE_SILENCE_S = 5;

/**
 * 「喚醒詞」分段。report 是頁面最後一次回報的 { state, reason }。還沒回報時不猜：偏好關著顯示「未開啟」，
 * 開著顯示「尚未回報」（不是裝置事件，所以不說「準備中」）。
 * 「通話中辨認說話者」（George 2026-10-31 D3 先放停用的一列；2026-11-01 SP-02b 啟用，選單直接勾、不跳說明）：
 * 和「喚醒後等你開口」同一條寫入路徑（setMenuPref POST { speaker_in_call } 到 /api/settings/wake）。
 */
export function wakeMenu(wake, report, { command, setWakeListen, setVoiceNameTest, setMenuPref, servicePaused = false, translate = (source) => source }) {
  const text = (source) => translate(source);
  const reported = isWakeReport(report);
  const current = reported ? report : { state: "off", reason: null };
  const stateLabel = reported || !wake.wake_listen ? WAKE_STATE_LABEL[current.state] : WAKE_MENU_TEXT.notReported;
  const paused = current.state === "paused" && current.reason === "user_pause";
  const canPause = wake.wake_listen && reported && (current.state === "listening_local" || current.state === "armed");
  const silence = wake.wake_silence_s ?? DEFAULT_WAKE_SILENCE_S;
  // 和「鏡頭與語音設定」的秒數列同一條寫入路徑（setMenuPref POST { wake_silence_s } 到 /api/settings/wake）；關著聆聽也能先選好。
  const silenceRow = { key: "wake_silence_s", kind: "seconds", label: WAKE_MENU_TEXT.silence, write_path: "/api/settings/wake" };
  const speakerRow = { key: "speaker_in_call", kind: "bool", label: WAKE_MENU_TEXT.speaker, write_path: "/api/settings/wake" };
  const seconds = (n) => `${n} 秒${n === DEFAULT_WAKE_SILENCE_S ? "（預設）" : ""}`;
  return [
    { type: "separator" },
    { label: text(WAKE_MENU_TEXT.group), enabled: false },
    {
      label: `${text(WAKE_MENU_TEXT.statusPrefix)}${text("：")}${text(stateLabel)}`,
      sublabel: current.reason ? text(WAKE_REASON_LABEL[current.reason]) : undefined,
      enabled: false,
    },
    {
      label: text(WAKE_MENU_TEXT.listen),
      type: "checkbox",
      checked: wake.wake_listen,
      // 服務模式中停用（保存的偏好不變；返回 Mac 使用後依偏好恢復）。
      enabled: !servicePaused,
      sublabel: text(servicePaused ? SERVICE_TEXT.paused : WAKE_MENU_TEXT.listenNote),
      // 寫入與核心回應為準（打開前主程序先顯示原生說明）；失敗時重新讀取，勾選不會停在沒保存的狀態。
      click: () => void setWakeListen?.(!wake.wake_listen),
    },
    {
      label: `${text(WAKE_MENU_TEXT.silence)}${text("：")}${text(`${silence} 秒`)}`,
      sublabel: text(WAKE_MENU_TEXT.silenceNote),
      submenu: [
        ...WAKE_SILENCE_OPTIONS_S.map((n) => radio(text(seconds(n)), n === silence, () => void setMenuPref?.(silenceRow, n))),
        { type: "separator" },
        { label: text(WAKE_MENU_TEXT.silenceNote), enabled: false },
      ],
    },
    {
      label: text(paused ? WAKE_MENU_TEXT.resume : WAKE_MENU_TEXT.pause),
      enabled: !servicePaused && wake.wake_listen && (paused || canPause),
      click: () => command(paused ? "wake-resume" : "wake-pause"),
    },
    {
      label: text(WAKE_MENU_TEXT.speaker),
      type: "checkbox",
      checked: wake.speaker_in_call === true,
      enabled: true,
      sublabel: text(WAKE_MENU_TEXT.speakerNote),
      click: () => void setMenuPref?.(speakerRow, wake.speaker_in_call !== true),
    },
    // SP-02a 測試開關（George 2026-11-01）：打開前主程序先顯示原生說明；寫入經核心的同一行程呼叫，頁面只能關。
    {
      label: text(WAKE_MENU_TEXT.voiceNameTest),
      type: "checkbox",
      checked: wake.voice_name_test === true,
      enabled: true,
      sublabel: text(WAKE_MENU_TEXT.voiceNameTestNote),
      click: () => void setVoiceNameTest?.(wake.voice_name_test !== true),
    },
  ];
}

// ───────────── 聲音輸入／輸出（George 2026-11-01；不綁旗標，核心一定給 settings.audio） ─────────────
// 文字、裝置清單整理規則與 shared/audio-devices.ts 相同（這個檔案由 App 直接執行，不能載入 .ts；tests/desktop-menu.test.ts 核對）。
// 清單、使用中的裝置與兩句狀態都來自頁面以 reportState 回報的裝置事件（preload.cjs 先整理一次，這裡再整理一次）；
// 勾選只代表保存的選擇，不代表正在收音或播放。

export const AUDIO_TEXT = {
  group: "聲音",
  input: "聲音輸入",
  output: "聲音輸出",
  systemDefault: "系統預設",
  systemDefaultNow: "系統預設（目前：{0}）",
  inUse: "使用中：{0}",
  missing: "找不到「{0}」，暫用系統預設",
  noMic: "目前沒有開著的麥克風",
  nextPlayback: "播放時使用：{0}",
  notFoundOption: "{0}（目前找不到）",
  notReportedOption: "{0}（尚未回報）",
  unnamedInput: "未命名的麥克風 {0}",
  unnamedOutput: "未命名的聲音輸出 {0}",
  unknownDevice: "（名稱未知的裝置）",
  needPermission: "授權麥克風後才會列出裝置名稱",
  bluetoothHint: "藍牙耳機當麥克風會切到低音質通話模式；建議麥克風留在 Mac、聲音輸出選藍牙喇叭",
  systemSpeechHint: "按下說話與系統朗讀（語音模式、校準陌生聲音）一律用 Mac 的系統輸入／輸出",
  notReported: "尚未回報",
  processingCue: "處理中音效",
  processingCueNote: "背景任務執行中輕聲提示；Nous 說話或你開口時暫停",
};
const AUDIO_STATUS_TEXTS = [AUDIO_TEXT.inUse, AUDIO_TEXT.missing, AUDIO_TEXT.noMic, AUDIO_TEXT.nextPlayback, AUDIO_TEXT.notReported];
const AUDIO_UI_VALUES = [AUDIO_TEXT.systemDefault, AUDIO_TEXT.unknownDevice];
const DEVICE_ID = /^[\x21-\x7e]{1,256}$/;
const DEVICE_LIST_MAX = 24;
const DEVICE_LABEL_MAX = 128;

const cleanLabel = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, DEVICE_LABEL_MAX) : "");
const cleanDevice = (value) => (value && typeof value === "object" && typeof value.id === "string" && DEVICE_ID.test(value.id) ? { id: value.id, label: cleanLabel(value.label) } : null);
const cleanInUse = (value) => {
  if (!value || typeof value !== "object") return null;
  if (value.id !== null && (typeof value.id !== "string" || !DEVICE_ID.test(value.id))) return null;
  return { id: value.id, label: cleanLabel(value.label) };
};
const cleanLine = (value) => {
  if (!value || typeof value !== "object" || !AUDIO_STATUS_TEXTS.includes(value.text)) return null;
  return { text: value.text, values: Array.isArray(value.values) ? value.values.slice(0, 1).map(cleanLabel) : [] };
};

/** 頁面回報的「聲音」清單與狀態整理成固定形狀（同 shared/audio-devices.ts 的 sanitizeAudioMenuReport）；看不懂回 null。 */
export function sanitizeAudioMenuReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const list = (items) => (Array.isArray(items) ? items.map(cleanDevice).filter((d) => d !== null).slice(0, DEVICE_LIST_MAX) : []);
  const name = (x) => (typeof x === "string" && x ? cleanLabel(x) : null);
  const input = cleanLine(value.input_status);
  const output = cleanLine(value.output_status);
  if (!input || !output) return null;
  return {
    inputs: list(value.inputs),
    outputs: list(value.outputs),
    default_input: name(value.default_input),
    default_output: name(value.default_output),
    input_in_use: cleanInUse(value.input_in_use),
    output_in_use: cleanInUse(value.output_in_use),
    input_fallback: value.input_fallback === true,
    output_fallback: value.output_fallback === true,
    labels: value.labels === true,
    input_status: input,
    output_status: output,
  };
}

/**
 * 「聲音」分段：「聲音輸入」「聲音輸出」兩個 radio 子選單（系統預設在最前，括號是它目前指向的裝置），各接一列停用的狀態
 * （「使用中：X」或「找不到「X」，暫用系統預設」，頁面以裝置事件算好）。點選後 setAudio(patch) POST 到 audio.write_path。
 * 裝置名稱是資料，不翻譯。report 是頁面最後一次回報（還沒回報時清單是空的、狀態「尚未回報」）。
 * 最後是「處理中音效」開關（背景任務執行中的聲納提示音，預設開；寫入同一個 audio.json）。
 */
export function audioMenu(audio, report, { setAudio, translate = (source) => source }) {
  const fill = (source, ...values) => translate(source, ...values).replace(/\{(\d+)\}/g, (match, i) => (Number(i) < values.length ? String(values[Number(i)]) : match));
  const value = (v) => (AUDIO_UI_VALUES.includes(v) ? translate(v) : v);
  const line = (status) => (status ? fill(status.text, ...status.values.map(value)) : translate(AUDIO_TEXT.notReported));
  const hints = [
    { type: "separator" },
    { label: translate(AUDIO_TEXT.bluetoothHint), enabled: false },
    { label: translate(AUDIO_TEXT.systemSpeechHint), enabled: false },
  ];
  const section = (kind) => {
    const input = kind === "input";
    const id = input ? audio.prefs.input_device_id : audio.prefs.output_device_id;
    const saved = input ? audio.prefs.input_label : audio.prefs.output_label;
    const devices = (input ? report?.inputs : report?.outputs) ?? [];
    const now = input ? report?.default_input : report?.default_output;
    const key = input ? "input" : "output";
    const pick = (deviceId, label) => () => void setAudio?.({ [`${key}_device_id`]: deviceId, [`${key}_label`]: deviceId === null ? null : label || null });
    const deviceName = (device, i) => device.label || fill(input ? AUDIO_TEXT.unnamedInput : AUDIO_TEXT.unnamedOutput, i + 1);
    const listed = devices.find((d) => d.id === id);
    const savedName = listed?.label || saved || translate(AUDIO_TEXT.unknownDevice);
    const choice = id === null ? translate(AUDIO_TEXT.systemDefault) : savedName;
    const status = input ? report?.input_status : report?.output_status;
    return [
      {
        label: `${translate(input ? AUDIO_TEXT.input : AUDIO_TEXT.output)}${translate("：")}${choice}`,
        submenu: [
          radio(now ? fill(AUDIO_TEXT.systemDefaultNow, now) : translate(AUDIO_TEXT.systemDefault), id === null, pick(null, null)),
          ...devices.map((device, i) => radio(deviceName(device, i), device.id === id, pick(device.id, device.label))),
          // 選定的裝置不在清單裡：仍列出來並勾著，照實顯示目前的選擇。頁面還沒回報清單時寫「尚未回報」，不說找不到。
          ...(id !== null && !listed ? [radio(fill(devices.length === 0 ? AUDIO_TEXT.notReportedOption : AUDIO_TEXT.notFoundOption, savedName), true, () => {}, false)] : []),
          ...hints,
        ],
      },
      { label: line(status), enabled: false },
    ];
  };
  return [
    { type: "separator" },
    { label: translate(AUDIO_TEXT.group), enabled: false },
    ...section("input"),
    ...section("output"),
    // 「處理中音效」（George 2026-11-02）：勾選是核心保存的值；點了寫入相反值（同其他開關，不看 Electron 切換後的狀態）。
    {
      label: translate(AUDIO_TEXT.processingCue),
      type: "checkbox",
      checked: audio.prefs.processing_cue !== false,
      sublabel: translate(AUDIO_TEXT.processingCueNote),
      click: () => void setAudio?.({ processing_cue: audio.prefs.processing_cue === false }),
    },
    ...(report && !report.labels ? [{ label: translate(AUDIO_TEXT.needPermission), enabled: false }] : []),
  ];
}

// ───────────── 主動提醒（PRO-1；核心給了 settings.proactive 才畫） ─────────────
// 文字和 shared/proactive.ts 的 PROACTIVE_TEXT 相同（這個檔案由 App 直接執行，不能載入 .ts；tests/proactive.test.ts 核對兩邊一致）。
// 地點、整點選項與天氣狀態都由核心給；勾選只代表保存的設定，天氣狀態只說最近一次查詢的結果（不含天氣內容）。

export const PROACTIVE_TEXT = {
  group: "主動提醒",
  enabled: "早上招呼後主動提醒",
  enabledNote: "每人每天在時段內第一次打招呼時，接一句今天的天氣；關掉就只打招呼",
  weather: "說今天的天氣",
  weatherNote: "天氣資料：Open-Meteo.com（CC BY 4.0）",
  start: "時段開始",
  end: "時段結束",
  hour: "{0} 點",
  place: "天氣地點",
  auto: "依系統時區（{0}）",
  autoNone: "依系統時區（推不出地點）",
  noPlace: "還沒有地點：請選一個，否則不說天氣",
  stateOk: "天氣：已取得今天的資料",
  stateFailed: "天氣：上次查詢失敗，這次招呼不說天氣",
  stateNone: "天氣：還沒查過（看著說話或喚醒時會先查）",
  stateNoPlace: "天氣：沒有地點",
  calendar: "認出 George 時說今天的行程",
  calendarNote: "有行程先問「要不要我念今天的行程？」，說好才念；沒有行程直接說「今天沒有排行程」",
  calOk: "行事曆：已讀到今天的行程",
  calFailed: "行事曆：上次讀取失敗，這次不提行程",
  calNone: "行事曆：還沒讀過（看著說話或喚醒時會先讀）",
  calNotConnected: "行事曆：沒有連上 Google 日曆（CAL-1）",
};

const PROACTIVE_STATE_TEXT = { ok: PROACTIVE_TEXT.stateOk, failed: PROACTIVE_TEXT.stateFailed, none: PROACTIVE_TEXT.stateNone, no_place: PROACTIVE_TEXT.stateNoPlace };
const CALENDAR_STATE_TEXT = { ok: PROACTIVE_TEXT.calOk, failed: PROACTIVE_TEXT.calFailed, none: PROACTIVE_TEXT.calNone, not_connected: PROACTIVE_TEXT.calNotConnected };

/** 「主動提醒」分段：總開關、天氣開關、時段（開始／結束）、地點與天氣狀態。點選後 setProactive(patch) POST 到 proactive.write_path。 */
export function proactiveMenu(proactive, { setProactive, translate = (source) => source }) {
  const fill = (source, ...values) => translate(source, ...values).replace(/\{(\d+)\}/g, (match, i) => (Number(i) < values.length ? String(values[Number(i)]) : match));
  const prefs = proactive.prefs;
  const hour = (n) => fill(PROACTIVE_TEXT.hour, n);
  const set = (patch) => () => void setProactive?.(patch);
  const placeLabel = proactive.place ? translate(proactive.place.label) : null;
  const autoLabel = proactive.place?.auto ? fill(PROACTIVE_TEXT.auto, placeLabel) : translate(PROACTIVE_TEXT.autoNone);
  const current = prefs.place === null ? (proactive.place ? autoLabel : translate(PROACTIVE_TEXT.noPlace)) : placeLabel;
  return [
    { type: "separator" },
    { label: translate(PROACTIVE_TEXT.group), enabled: false },
    { label: translate(PROACTIVE_TEXT.enabled), type: "checkbox", checked: prefs.enabled, sublabel: translate(PROACTIVE_TEXT.enabledNote), click: set({ enabled: !prefs.enabled }) },
    { label: translate(PROACTIVE_TEXT.weather), type: "checkbox", checked: prefs.weather, enabled: prefs.enabled, sublabel: translate(PROACTIVE_TEXT.weatherNote), click: set({ weather: !prefs.weather }) },
    ...(proactive.calendar ? [{ label: translate(PROACTIVE_TEXT.calendar), type: "checkbox", checked: prefs.calendar !== false, enabled: prefs.enabled, sublabel: translate(PROACTIVE_TEXT.calendarNote), click: set({ calendar: prefs.calendar === false }) }] : []),
    {
      label: `${translate(PROACTIVE_TEXT.start)}${translate("：")}${hour(prefs.start_hour)}`,
      submenu: proactive.start_hours.map((n) => radio(hour(n), n === prefs.start_hour, set({ start_hour: n }), n < prefs.end_hour)),
    },
    {
      label: `${translate(PROACTIVE_TEXT.end)}${translate("：")}${hour(prefs.end_hour)}`,
      submenu: proactive.end_hours.map((n) => radio(hour(n), n === prefs.end_hour, set({ end_hour: n }), n > prefs.start_hour)),
    },
    {
      label: `${translate(PROACTIVE_TEXT.place)}${translate("：")}${current}`,
      submenu: [
        radio(autoLabel, prefs.place === null, set({ place: null })),
        { type: "separator" },
        ...proactive.places.map((p) => radio(translate(p.label), p.id === prefs.place, set({ place: p.id }))),
      ],
    },
    { label: translate(PROACTIVE_STATE_TEXT[proactive.weather.state] ?? PROACTIVE_TEXT.stateNone), enabled: false },
    ...(proactive.calendar ? [{ label: translate(CALENDAR_STATE_TEXT[proactive.calendar.state] ?? PROACTIVE_TEXT.calNone), enabled: false }] : []),
  ];
}

// ───────────── 右上角時鐘與天氣（CLK-1；核心給了 settings.clock 才畫） ─────────────
// 文字和 shared/clock.ts 的 CLOCK_TEXT 相同（這個檔案不能載入 .ts；tests/clock-settings.test.ts 核對兩邊一致）。

export const CLOCK_TEXT = {
  group: "右上角時鐘與天氣",
  main: "Mac 視窗",
  mainNote: "在 Mac 的 Nous 視窗右上角顯示時間、日期與天氣",
  terminal: "Pi 終端機",
  terminalNote: "在 Pi 等終端機畫面右上角顯示時間、日期與天氣",
  note: "只顯示時間、日期與天氣，不能點；天氣資料：Open-Meteo.com（CC BY 4.0），地點同「主動提醒」的天氣地點",
  aria: "時間、日期與天氣：{0}",
  age: "{0} 分鐘前",
  rain: "降雨 {0}%",
  today: "今日{0}",
  unavailable: "天氣暫時無法取得",
  noPlace: "設定天氣地點後顯示天氣",
};

/** 「右上角時鐘與天氣」分段：Mac 視窗、Pi 終端機兩個開關。點選後 setClock(patch) POST 到 clock.write_path。 */
export function clockMenu(clock, { setClock, translate = (source) => source }) {
  const set = (patch) => () => void setClock?.(patch);
  return [
    { type: "separator" },
    { label: translate(CLOCK_TEXT.group), enabled: false },
    { label: translate(CLOCK_TEXT.main), type: "checkbox", checked: clock.prefs.main, sublabel: translate(CLOCK_TEXT.mainNote), click: set({ main: !clock.prefs.main }) },
    { label: translate(CLOCK_TEXT.terminal), type: "checkbox", checked: clock.prefs.terminal, sublabel: translate(CLOCK_TEXT.terminalNote), click: set({ terminal: !clock.prefs.terminal }) },
  ];
}

// ───────────── 左上角家中狀態（HOME-1；核心給了 settings.home_corner 才畫） ─────────────
// 文字和 shared/home-corner.ts 的 HOME_CORNER_TEXT 相同（這個檔案不能載入 .ts；tests/home-corner.test.ts 核對兩邊一致）。

export const HOME_CORNER_TEXT = {
  group: "左上角家中狀態",
  main: "Mac 視窗",
  mainNote: "在 Mac 的 Nous 視窗左上角顯示室內溫濕度、開著的燈與冷氣",
  terminal: "Pi 終端機",
  terminalNote: "在 Pi 等終端機畫面左上角顯示室內溫濕度、開著的燈與冷氣",
  note: "只顯示武陵居中控回報的狀態，不能點、不能控制；中控沒有回報的開關顯示「—」",
  aria: "家中狀態：{0}",
  notConfigured: "智慧家庭未設定",
  unreachable: "讀不到中控",
  coreDown: "核心沒有回應",
  timeout: "中控沒有回應（逾時）",
  refused: "連不上中控",
  auth: "中控拒絕了權杖",
  badResponse: "中控回應錯誤",
  empty: "中控沒有可顯示的設備",
  age: "{0} 分鐘前",
  ageHours: "{0} 小時前",
  snapshot: "快照",
  stale: "過期資料",
  lights: "燈 {0}／{1} 開著",
  lightsUnknown: "燈 —／{0}",
  switches: "插座開關 {0}／{1} 開著",
  switchesUnknown: "插座開關 —／{0}",
  unknownCount: "{0} 個未知",
  acOn: "開",
  acOff: "關",
  acReported: "控制器回報 · {0}",
  humidity: "濕度",
};

/** 「左上角家中狀態」分段：Mac 視窗、Pi 終端機兩個開關。點選後 setHomeCorner(patch) POST 到 home_corner.write_path。 */
export function homeCornerMenu(homeCorner, { setHomeCorner, translate = (source) => source }) {
  const set = (patch) => () => void setHomeCorner?.(patch);
  return [
    { type: "separator" },
    { label: translate(HOME_CORNER_TEXT.group), enabled: false },
    { label: translate(HOME_CORNER_TEXT.main), type: "checkbox", checked: homeCorner.prefs.main, sublabel: translate(HOME_CORNER_TEXT.mainNote), click: set({ main: !homeCorner.prefs.main }) },
    { label: translate(HOME_CORNER_TEXT.terminal), type: "checkbox", checked: homeCorner.prefs.terminal, sublabel: translate(HOME_CORNER_TEXT.terminalNote), click: set({ terminal: !homeCorner.prefs.terminal }) },
  ];
}

// ───────────── 回憶模式（MEMO-1；核心給了 settings.memories 才畫） ─────────────
// 文字和 shared/memories.ts 的 MEMORIES_TEXT 相同（這個檔案不能載入 .ts；tests/memories-menu.test.ts 核對兩邊一致）。

export const MEMORIES_TEXT = {
  group: "回憶模式",
  enabled: "閒置時播放回憶",
  enabledNote: "電子腦沒事一段時間後，照片與影片從電子腦浮現；有人喚醒、看著說話或有任務就立即收起",
  videoSound: "影片播放聲音",
  videoSoundNote: "預設靜音",
  dwell: "每張停留",
  idle: "閒置多久開始",
  seconds: "{0} 秒",
  minutes: "{0} 分鐘",
  stateOk: "照片來源：Mac 上的回憶資料夾，照片 {0} 張、影片 {1} 段",
  stateEmpty: "資料夾是空的：把照片放進 Mac 的回憶資料夾",
  stateMissing: "找不到回憶資料夾",
  stateFailed: "讀不到回憶資料夾",
  openFolder: "打開回憶資料夾",
  googleGroup: "Google 相簿",
  googleStatus: "Google 相簿：照片 {0} 張、影片 {1} 段（{2} / 2 GB）",
  googleUnavailable: "Google 相簿不可用：{0}",
  googlePick: "從 Google 相簿挑選…",
  googleCancel: "取消",
  googleCancelPick: "取消挑選",
  googleClear: "清除 Google 快取",
  googleClearMenu: "清除 Google 快取…",
  googleClearConfirm: "再按一次確認清除",
  googleClearAsk: "要清除 Google 相簿的快取嗎？",
  googleClearDetail: "Mac 上下載的 Google 照片與影片都會刪除；Google 相簿裡的原檔不受影響。",
  googleClearButton: "清除",
  googleOpen: "在瀏覽器開啟",
  googleQrAlt: "Google 相簿挑選連結的 QR code",
  googleScanHint: "用手機掃描，在 Google 相簿搜尋相簿名稱後選取照片，按完成",
  googleExpires: "連結在 {0} 前有效",
  googleStarting: "正在建立挑選連結…",
  googleWaiting: "等待在 Google 相簿挑選…",
  googleProgress: "正在下載 {0}/{1}",
  googleDone: "已加入 Google 相簿的照片：處理 {0} 項，略過 {1} 項",
  googleCancelled: "已取消挑選",
  googleNoSync: "Google 只讓 App 讀你挑選的照片，不能自動同步整本相簿；有新照片時再挑一次。",
  googleNoPlace: "Google 下載的照片沒有地點，只顯示時間。",
};

const MEMORIES_STATE_TEXT = { ok: MEMORIES_TEXT.stateOk, empty: MEMORIES_TEXT.stateEmpty, missing: MEMORIES_TEXT.stateMissing, failed: MEMORIES_TEXT.stateFailed };

/** 和 shared/memories.ts 的 formatCacheSize 相同：1 GB 以下用 MB（整數），以上用 GB（一位小數）。 */
// 和 shared/memories.ts 的 formatCacheSize 相同（這個檔案不能載入 .ts；tests/memories-menu.test.ts 核對）。
const formatCacheSize = (bytes) => {
  const mb = bytes / 1024 ** 2;
  if (bytes < 1024 ** 3) return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};
const GOOGLE_BUSY = new Set(["starting", "waiting_pick", "downloading"]);

/**
 * MEMO-2「Google 相簿」：快取狀態、目前階段、挑選、取消挑選、清除快取。
 * memoriesGoogle("pick")：主程序 POST pick 後用系統瀏覽器開回應裡的 picker_uri；("clear")：主程序先問原生確認對話框。
 */
function googleMenu(g, { memoriesGoogle, fill, translate }) {
  const busy = GOOGLE_BUSY.has(g.phase);
  const phase =
    g.phase === "starting" ? translate(MEMORIES_TEXT.googleStarting)
    : g.phase === "waiting_pick" ? translate(MEMORIES_TEXT.googleWaiting)
    : g.phase === "downloading" && g.progress ? fill(MEMORIES_TEXT.googleProgress, g.progress.done, g.progress.total)
    : g.phase === "done" && g.progress ? fill(MEMORIES_TEXT.googleDone, g.progress.done, g.progress.skipped)
    : g.phase === "cancelled" ? translate(MEMORIES_TEXT.googleCancelled)
    : g.phase === "failed" && g.error ? translate(g.error)
    : null;
  return [
    {
      label: g.available ? fill(MEMORIES_TEXT.googleStatus, g.photos, g.videos, formatCacheSize(g.bytes)) : fill(MEMORIES_TEXT.googleUnavailable, translate(g.unavailable_reason ?? "")),
      enabled: false,
    },
    ...(phase ? [{ label: phase, enabled: false }] : []),
    { label: translate(MEMORIES_TEXT.googlePick), enabled: !!memoriesGoogle && g.available && !busy, click: () => void memoriesGoogle?.("pick") },
    ...(busy ? [{ label: translate(MEMORIES_TEXT.googleCancelPick), enabled: !!memoriesGoogle, click: () => void memoriesGoogle?.("cancel") }] : []),
    { label: translate(MEMORIES_TEXT.googleClearMenu), enabled: !!memoriesGoogle && g.photos + g.videos > 0, click: () => void memoriesGoogle?.("clear") },
  ];
}

/**
 * 「回憶模式」分段：總開關、影片聲音、每張停留、閒置多久開始、來源狀態；核心有 memories.google 時再加「Google 相簿」。
 * 點選後 setMemories(patch) POST 到 memories.write_path。
 */
export function memoriesMenu(memories, { setMemories, memoriesGoogle, openMemoriesFolder, translate = (source) => source }) {
  const fill = (source, ...values) => translate(source, ...values).replace(/\{(\d+)\}/g, (match, i) => (Number(i) < values.length ? String(values[Number(i)]) : match));
  const prefs = memories.prefs;
  const set = (patch) => () => void setMemories?.(patch);
  const duration = (n) => (n >= 60 && n % 60 === 0 ? fill(MEMORIES_TEXT.minutes, n / 60) : fill(MEMORIES_TEXT.seconds, n));
  const state = memories.source?.state ?? "missing";
  return [
    { type: "separator" },
    { label: translate(MEMORIES_TEXT.group), enabled: false },
    { label: translate(MEMORIES_TEXT.enabled), type: "checkbox", checked: prefs.enabled, sublabel: translate(MEMORIES_TEXT.enabledNote), click: set({ enabled: !prefs.enabled }) },
    { label: translate(MEMORIES_TEXT.videoSound), type: "checkbox", checked: prefs.video_sound, enabled: prefs.enabled, sublabel: translate(MEMORIES_TEXT.videoSoundNote), click: set({ video_sound: !prefs.video_sound }) },
    {
      label: `${translate(MEMORIES_TEXT.dwell)}${translate("：")}${duration(prefs.dwell_s)}`,
      enabled: prefs.enabled,
      submenu: memories.dwell_options.map((n) => radio(duration(n), n === prefs.dwell_s, set({ dwell_s: n }))),
    },
    {
      label: `${translate(MEMORIES_TEXT.idle)}${translate("：")}${duration(prefs.idle_s)}`,
      enabled: prefs.enabled,
      submenu: memories.idle_options.map((n) => radio(duration(n), n === prefs.idle_s, set({ idle_s: n }))),
    },
    { label: fill(MEMORIES_STATE_TEXT[state] ?? MEMORIES_TEXT.stateMissing, memories.source?.photos ?? 0, memories.source?.videos ?? 0), enabled: false },
    // 只有 App 主程序知道資料夾在哪裡（不下發頁面），所以只在選單列提供。
    ...(openMemoriesFolder ? [{ label: translate(MEMORIES_TEXT.openFolder), click: () => void openMemoriesFolder() }] : []),
    ...(memories.google ? googleMenu(memories.google, { memoriesGoogle, fill, translate }) : []),
  ];
}

/**
 * @param settings GET /api/settings 的回應（還沒讀到時是 null）
 * @param handlers command(name)：把選單動作交給頁面；setMenuPref(row, value)：POST { [row.key]: value } 到 row.write_path；
 *   openFamily(mode?)：「家人辨識…」與「校正人臉辨識…」（mode "calibrate"）。主程序先記下點擊時間，10 秒內頁面才能開管理 session，再交給頁面打開畫面；
 *   setWakeListen(value)、wakeReport：常駐喚醒聆聽（只有 settings.wake 存在時用到）；setVoiceNameTest(value)：SP-02a 只憑聲音叫名字的測試開關；
 *   setAudio(patch)、audioReport：「聲音」分段（settings.audio 存在時畫；patch 送到 settings.audio.write_path）
 *   setProactive(patch)：「主動提醒」分段（settings.proactive 存在時畫；patch 送到 settings.proactive.write_path）
 *   setClock(patch)：CLK-1「右上角時鐘與天氣」分段（settings.clock 存在時畫；patch 送到 settings.clock.write_path）
 *   setHomeCorner(patch)：HOME-1「左上角家中狀態」分段（settings.home_corner 存在時畫；patch 送到 settings.home_corner.write_path）
 *   setMemories(patch)：「回憶模式」分段（settings.memories 存在時畫；patch 送到 settings.memories.write_path）
 *   memoriesGoogle(action)：MEMO-2「Google 相簿」的 pick／cancel／clear（settings.memories.google 存在時畫）
 */
export function settingsMenu(settings, { command, setMenuPref, openFamily, setWakeListen, setVoiceNameTest, setAudio, setProactive, setClock, setHomeCorner, setMemories, memoriesGoogle, openMemoriesFolder, audioReport = null, wakeReport = null, wakeCommand, servicePaused = false, translate = (source) => source }) {
  const text = (source) => typeof source === "string" ? translate(source) : source;
  const rows = settings?.seconds;
  if (!rows) return [{ label: text("讀取中…"), enabled: false }];
  const previewReason = settings.camera_preview_disabled_reason;
  const identity = settings.identity;
  const items = servicePaused ? [{ label: text(SERVICE_TEXT.settingsPaused), enabled: false }, { type: "separator" }] : [];
  let group = null;
  const closeGroup = () => {
    if (group !== PREVIEW_GROUP) return;
    // undefined：核心沒有提供這一項（不畫）；null：可以用。
    if (previewReason !== undefined) {
      items.push({
        label: text("顯示鏡頭畫面"),
        sublabel: servicePaused ? text(SERVICE_TEXT.paused) : text(previewReason) ?? undefined,
        enabled: !servicePaused && previewReason === null,
        click: () => command("camera-preview"),
      });
    }
    // 家人辨識（ADR-0001）：停用原因與限制都由核心的 settings.identity 給（不含姓名）。
    // 停用時另外放一行灰色說明（sublabel 只有 macOS 14.4 以上才顯示）。
    if (identity !== undefined) {
      items.push({
        label: text("家人辨識…"),
        sublabel: servicePaused ? text(SERVICE_TEXT.needsWindow) : text(identity.disabled_reason ?? identity.limited_reason) ?? undefined,
        enabled: !servicePaused && identity.available,
        click: () => openFamily?.(),
      });
      // 校正人臉辨識（George 2026-10-31）：鏡頭換位置後量測常用位置、建議校正值；同樣經家人辨識的管理 session。
      if (settings.face_tuning) items.push({ label: text("校正人臉辨識…"), enabled: !servicePaused && identity.available, click: () => openFamily?.("calibrate") });
      if (identity.disabled_reason) items.push({ label: text(`家人辨識：${text(identity.disabled_reason)}`), enabled: false });
    }
  };
  for (const row of rows) {
    if (row.group !== group) {
      closeGroup();
      if (group !== null) items.push({ type: "separator" });
      items.push({ label: text(row.group_label), enabled: false });
      group = row.group;
      // 停用原因放在分段標題下方的說明項：sublabel 只有 macOS 14.4 以上才顯示，舊版只看得到灰色。
      const reasons = [...new Set(rows.filter((r) => r.group === group && r.disabled_reason !== null).map((r) => r.disabled_reason))];
      for (const reason of reasons) items.push({ label: text(reason), enabled: false });
    }
    const enabled = row.disabled_reason === null;
    if (row.kind === "bool") {
      // 服務模式中「鏡頭」開關停用（保存的設定不變；返回 Mac 使用後依設定重新開）。
      const cameraSwitch = servicePaused && row.write_path === "/api/settings/camera" && row.key === "active";
      items.push({
        label: text(row.label),
        type: "checkbox",
        checked: row.value,
        enabled: enabled && !cameraSwitch,
        sublabel: cameraSwitch ? text(SERVICE_TEXT.paused) : text(row.disabled_reason ?? row.note),
        // 寫入與核心回應為準：送出相反的值，成功後依回應重畫，失敗時重新讀取，勾選不會停在沒保存的狀態。
        click: () => void setMenuPref(row, !row.value),
      });
      continue;
    }
    items.push({
      label: `${text(row.label)}${text("：")}${text(row.value_label)}`,
      sublabel: text(row.disabled_reason ?? row.note),
      submenu: [
        ...(enabled ? [] : [{ label: text(row.disabled_reason), enabled: false }, { type: "separator" }]),
        ...row.options.map((o) => radio(text(o.label), o.checked, () => void setMenuPref(row, o.value), enabled)),
        { type: "separator" },
        { label: text(row.note), enabled: false },
      ],
    });
  }
  closeGroup();
  if (settings.audio) items.push(...audioMenu(settings.audio, audioReport, { setAudio, translate }));
  if (settings.wake) items.push(...wakeMenu(settings.wake, wakeReport, { command: wakeCommand ?? command, setWakeListen, setVoiceNameTest, setMenuPref, servicePaused, translate }));
  if (settings.proactive) items.push(...proactiveMenu(settings.proactive, { setProactive, translate }));
  if (settings.clock) items.push(...clockMenu(settings.clock, { setClock, translate }));
  if (settings.home_corner) items.push(...homeCornerMenu(settings.home_corner, { setHomeCorner, translate }));
  if (settings.memories) items.push(...memoriesMenu(settings.memories, { setMemories, memoriesGoogle, openMemoriesFolder, translate }));
  return items;
}

// ───────────── 服務模式（George 2026-11-03：Mac mini 只當 Pi 的核心） ─────────────
// 「Pi 已連線／已斷線」只來自核心的終端機心跳（NousHandle.terminals.status().connected），不看服務模式開關或 SSE 連線。

export const SERVICE_TEXT = {
  connected: "服務模式：Pi 已連線",
  disconnected: "服務模式：Pi 已斷線",
  note: "Mac 的電子腦、麥克風、喚醒聆聽與鏡頭已暫停；核心、登入與背景任務繼續",
  exit: "返回 Mac 使用",
  enter: "進入服務模式（給 Pi 使用）",
  enterNote: "隱藏電子腦並停止 Mac 的麥克風、喚醒聆聽與鏡頭；核心繼續服務 Pi",
  paused: "服務模式中暫停（設定不變）",
  needsWindow: "返回 Mac 使用後才能開啟",
  settingsPaused: "服務模式中：Mac 的麥克風與鏡頭已暫停（設定不變）",
};

/** 服務模式的狀態句：只看終端機心跳的 connected。 */
export function serviceStatusLine(terminal) {
  return terminal?.connected === true ? SERVICE_TEXT.connected : SERVICE_TEXT.disconnected;
}

/**
 * 選單列的服務模式部分。head 放在選單最上面；actions 取代「動作」分段。
 * 服務模式：head 是狀態句、說明與「返回 Mac 使用」，actions 是空的（不畫會打開電子腦或開始語音的項目）。
 * 一般：head 是空的，actions 是顯示電子腦、語音、打字、看進度與「進入服務模式」。
 */
export function serviceTray({ serviceMode, terminal = null, voiceOn = false, showWindow, command, enterService, exitService }) {
  if (serviceMode) {
    return {
      head: [
        { label: serviceStatusLine(terminal), enabled: false },
        { label: SERVICE_TEXT.note, enabled: false },
        { label: SERVICE_TEXT.exit, click: () => exitService() },
        { type: "separator" },
      ],
      actions: [],
    };
  }
  return {
    head: [],
    actions: [
      { label: "顯示電子腦", accelerator: "Alt+Command+N", click: () => showWindow() },
      { label: voiceOn ? "結束語音對話" : "開始語音對話", accelerator: "Alt+Command+V", click: () => command("voice") },
      { label: "打字對話", click: () => command("type") },
      { label: "看進度", click: () => command("progress") },
      { label: SERVICE_TEXT.enter, sublabel: SERVICE_TEXT.enterNote, click: () => enterService() },
    ],
  };
}

// 費用防護（George 2026-11-06）：選單列「即時語音」那一行的通話時間與約略用量（核心 settings.realtime.active）。
// 和頁面的 shared/call-meter.ts 同樣格式（main.mjs 不能 import shared/）。Pi 上的通話也在這裡看得到（page 不是 main）。
export const REALTIME_METER_TEXT = {
  tokens: "約 {0} tokens",
  liveUnknown: "ChatGPT 方案：用量不明",
  terminal: "終端機 {0}",
};

/** 「3:07」「1:02:05」。 */
export function formatCallClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 「3:07 / 20:00 · 約 3,400 tokens」或「3:07 / 20:00 · ChatGPT 方案：用量不明」，Pi 的通話前面加「終端機 rpi4 · 」。
 * 還沒連上（started_at 為 null）或舊的核心沒有這些欄位時回空字串。tokens 是頁面報到的加總（不是帳單）。
 */
export function realtimeMeter(active, now, translate = (source, ...values) => values.reduce((text, value, i) => text.replace(`{${i}}`, String(value)), source)) {
  if (!active || typeof active.started_at !== "number" || typeof active.max_call_s !== "number") return "";
  const clock = `${formatCallClock(now - active.started_at)} / ${formatCallClock(active.max_call_s * 1000)}`;
  const usage = active.route === "live"
    ? ` · ${translate(REALTIME_METER_TEXT.liveUnknown)}`
    : active.usage && typeof active.usage.total_tokens === "number"
      ? ` · ${translate(REALTIME_METER_TEXT.tokens, active.usage.total_tokens.toLocaleString("en-US"))}`
      : "";
  const page = typeof active.page === "string" && active.page !== "main" ? `${translate(REALTIME_METER_TEXT.terminal, active.page)} · ` : "";
  return `${page}${clock}${usage}`;
}
