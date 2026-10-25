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

/**
 * @param settings GET /api/settings 的回應（還沒讀到時是 null）
 * @param handlers command(name)：把選單動作交給頁面；setMenuPref(row, value)：POST { [row.key]: value } 到 row.write_path；
 *   openFamily()：「家人辨識…」（主程序先記下點擊時間，10 秒內頁面才能開管理 session，再交給頁面打開畫面）
 */
export function settingsMenu(settings, { command, setMenuPref, openFamily }) {
  const rows = settings?.seconds;
  if (!rows) return [{ label: "讀取中…", enabled: false }];
  const previewReason = settings.camera_preview_disabled_reason;
  const identity = settings.identity;
  const items = [];
  let group = null;
  const closeGroup = () => {
    if (group !== PREVIEW_GROUP) return;
    // undefined：核心沒有提供這一項（不畫）；null：可以用。
    if (previewReason !== undefined) {
      items.push({
        label: "顯示鏡頭畫面",
        sublabel: previewReason ?? undefined,
        enabled: previewReason === null,
        click: () => command("camera-preview"),
      });
    }
    // 家人辨識（ADR-0001）：停用原因與限制都由核心的 settings.identity 給（不含姓名）。
    // 停用時另外放一行灰色說明（sublabel 只有 macOS 14.4 以上才顯示）。
    if (identity !== undefined) {
      items.push({
        label: "家人辨識…",
        sublabel: identity.disabled_reason ?? identity.limited_reason ?? undefined,
        enabled: identity.available,
        click: () => openFamily?.(),
      });
      if (identity.disabled_reason) items.push({ label: `家人辨識：${identity.disabled_reason}`, enabled: false });
    }
  };
  for (const row of rows) {
    if (row.group !== group) {
      closeGroup();
      if (group !== null) items.push({ type: "separator" });
      items.push({ label: row.group_label, enabled: false });
      group = row.group;
      // 停用原因放在分段標題下方的說明項：sublabel 只有 macOS 14.4 以上才顯示，舊版只看得到灰色。
      const reasons = [...new Set(rows.filter((r) => r.group === group && r.disabled_reason !== null).map((r) => r.disabled_reason))];
      for (const reason of reasons) items.push({ label: reason, enabled: false });
    }
    const enabled = row.disabled_reason === null;
    if (row.kind === "bool") {
      items.push({
        label: row.label,
        type: "checkbox",
        checked: row.value,
        enabled,
        sublabel: row.disabled_reason ?? row.note,
        // 寫入與核心回應為準：送出相反的值，成功後依回應重畫，失敗時重新讀取，勾選不會停在沒保存的狀態。
        click: () => void setMenuPref(row, !row.value),
      });
      continue;
    }
    items.push({
      label: `${row.label}：${row.value_label}`,
      sublabel: row.disabled_reason ?? row.note,
      submenu: [
        ...(enabled ? [] : [{ label: row.disabled_reason, enabled: false }, { type: "separator" }]),
        ...row.options.map((o) => radio(o.label, o.checked, () => void setMenuPref(row, o.value), enabled)),
        { type: "separator" },
        { label: row.note, enabled: false },
      ],
    });
  }
  closeGroup();
  return items;
}
