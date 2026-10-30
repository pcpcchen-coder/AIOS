import { t, useLocale, onLocaleChange } from "./i18n.ts";
// 成果紀錄的獨立網頁（HIST-1）：核心以 /history 提供，只在使用者自己打開時出現（不是預設頁、不從常駐介面連過來）。
// 與 App 內的成果紀錄 Surface 共用 HistoryView、同一份翻譯表與同一組 /api 路由；本機核心只接受 localhost／127.0.0.1
// 的 Host，寫入（刪除、重做）另要同源的 Origin 與 JSON content-type（server/http-guard.ts），和主畫面一樣。
import "./style.css";
import { api, newRequestId } from "./api.ts";
import { HistoryView } from "./history-view.ts";
import { languageSelector } from "./views.ts";

const params = new URLSearchParams(location.search);
const lang = params.get("lang");
// ?lang= 與頁面上的語言切換只換這一頁，不寫入共用的語言偏好：同一個本機位址的 App 頁面（瀏覽器版）不會因此換語言。
if (lang === "en" || lang === "zh-TW") useLocale(lang);

const setTitle = () => { document.title = t("Nous 成果紀錄"); };
setTitle();
onLocaleChange(setTitle);

const view = new HistoryView({
  api,
  confirm: (message) => window.confirm(message),
  requestId: newRequestId,
  redo: async (task, requestId) => {
    await api.redoTask(task.task_id, requestId);
    return t("已重新交辦這件事；進度請在 Nous 主畫面查看。");
  },
  dismiss: null,
  header: () => languageSelector({ persist: false, hint: false }),
  // MEM-4a：這一頁只經 HTTP；macOS App 加密保存的任務只有外殼（請在 App 內查看）。
  shells: true,
});
document.getElementById("history-root")!.append(view.element);
view.open(params.get("q") ?? "");
