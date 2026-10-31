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
  paused: ["user_pause", "sleep", "lock"],
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
  listenNote: "只在這台 Mac 本機偵測「哈囉努斯」",
  pause: "暫停聆聽（到這次結束）",
  resume: "繼續聆聽",
  speaker: "通話中辨認說話者",
  speakerNote: "SP-02 之後才能使用",
  notReported: "尚未回報",
};

/**
 * 「喚醒詞」分段。report 是頁面最後一次回報的 { state, reason }。還沒回報時不猜：偏好關著顯示「未開啟」，
 * 開著顯示「尚未回報」（不是裝置事件，所以不說「準備中」）。
 * 「通話中辨認說話者」（George 2026-10-31 D3）：先放一列停用的勾選框，沒有 click，SP-02 之後才啟用。
 */
export function wakeMenu(wake, report, { command, setWakeListen, translate = (source) => source }) {
  const text = (source) => translate(source);
  const reported = isWakeReport(report);
  const current = reported ? report : { state: "off", reason: null };
  const stateLabel = reported || !wake.wake_listen ? WAKE_STATE_LABEL[current.state] : WAKE_MENU_TEXT.notReported;
  const paused = current.state === "paused" && current.reason === "user_pause";
  const canPause = wake.wake_listen && reported && (current.state === "listening_local" || current.state === "armed");
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
      enabled: true,
      sublabel: text(WAKE_MENU_TEXT.listenNote),
      // 寫入與核心回應為準（打開前主程序先顯示原生說明）；失敗時重新讀取，勾選不會停在沒保存的狀態。
      click: () => void setWakeListen?.(!wake.wake_listen),
    },
    {
      label: text(paused ? WAKE_MENU_TEXT.resume : WAKE_MENU_TEXT.pause),
      enabled: wake.wake_listen && (paused || canPause),
      click: () => command(paused ? "wake-resume" : "wake-pause"),
    },
    { label: text(WAKE_MENU_TEXT.speaker), type: "checkbox", checked: false, enabled: false, sublabel: text(WAKE_MENU_TEXT.speakerNote) },
  ];
}

/**
 * @param settings GET /api/settings 的回應（還沒讀到時是 null）
 * @param handlers command(name)：把選單動作交給頁面；setMenuPref(row, value)：POST { [row.key]: value } 到 row.write_path；
 *   openFamily(mode?)：「家人辨識…」與「校正人臉辨識…」（mode "calibrate"）。主程序先記下點擊時間，10 秒內頁面才能開管理 session，再交給頁面打開畫面；
 *   setWakeListen(value)、wakeReport：常駐喚醒聆聽（只有 settings.wake 存在時用到）
 */
export function settingsMenu(settings, { command, setMenuPref, openFamily, setWakeListen, wakeReport = null, wakeCommand, translate = (source) => source }) {
  const text = (source) => typeof source === "string" ? translate(source) : source;
  const rows = settings?.seconds;
  if (!rows) return [{ label: text("讀取中…"), enabled: false }];
  const previewReason = settings.camera_preview_disabled_reason;
  const identity = settings.identity;
  const items = [];
  let group = null;
  const closeGroup = () => {
    if (group !== PREVIEW_GROUP) return;
    // undefined：核心沒有提供這一項（不畫）；null：可以用。
    if (previewReason !== undefined) {
      items.push({
        label: text("顯示鏡頭畫面"),
        sublabel: text(previewReason) ?? undefined,
        enabled: previewReason === null,
        click: () => command("camera-preview"),
      });
    }
    // 家人辨識（ADR-0001）：停用原因與限制都由核心的 settings.identity 給（不含姓名）。
    // 停用時另外放一行灰色說明（sublabel 只有 macOS 14.4 以上才顯示）。
    if (identity !== undefined) {
      items.push({
        label: text("家人辨識…"),
        sublabel: text(identity.disabled_reason ?? identity.limited_reason) ?? undefined,
        enabled: identity.available,
        click: () => openFamily?.(),
      });
      // 校正人臉辨識（George 2026-10-31）：鏡頭換位置後量測常用位置、建議校正值；同樣經家人辨識的管理 session。
      if (settings.face_tuning) items.push({ label: text("校正人臉辨識…"), enabled: identity.available, click: () => openFamily?.("calibrate") });
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
      items.push({
        label: text(row.label),
        type: "checkbox",
        checked: row.value,
        enabled,
        sublabel: text(row.disabled_reason ?? row.note),
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
  if (settings.wake) items.push(...wakeMenu(settings.wake, wakeReport, { command: wakeCommand ?? command, setWakeListen, translate }));
  return items;
}
