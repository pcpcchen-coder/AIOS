// Nous macOS App（Electron 主程式）：內建本機核心，視窗顯示電子腦，選單列圖示提供常用動作與設定。
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, shell, Tray } from "electron";
import { checkIdentitySender, MenuClickWindow, validateIdentityRequest } from "./identity-ipc.mjs";
import { validateMemoryRequest } from "./memory-ipc.mjs";
import { deleteConfirmed, deleteTaskDialog, validateConfirmDeleteRequest, validateTasksRequest } from "./tasks-ipc.mjs";
import { createMemorySecretBox } from "./memory-safe-storage.mjs";
import { checkTrustedSender } from "./trusted-sender.mjs";
import { isWakeReport, radio, settingsMenu } from "./settings-menu.mjs";
import { isLocale, languageMenu, localizeDialog, localizeMenu, setNativeLocale, t, trustedLocaleSender } from "./localization.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name) => join(here, "assets", name);

if (!app.requestSingleInstanceLock()) app.exit(0);

// ───────────── 路徑與偏好設定 ─────────────

const userData = app.getPath("userData"); // ~/Library/Application Support/Nous
const envFile = join(userData, ".env");
const dataDir = join(userData, "data");
const prefsFile = join(userData, "desktop.json");
const logFile = join(userData, "nous.log");
/** 家人辨識的加密 gallery（0700；Time Machine 排除）。 */
const identityDir = join(userData, "identity");
/** 家人辨識的模型與 onnxruntime wasm：只由 npm run face:setup -- --product 安裝到這裡，不在 App 包裡。 */
const faceRuntimeDir = join(userData, "face-runtime");
/**
 * 家庭記憶的加密快照（docs/16；0700；Time Machine 排除）。資料夾與 Keychain 只在使用者說「記住…」、打開「記憶…」，
 * 或上次執行時記憶是開著的（核心在 configDir 留一個不含內容的開關提示）而第一次打字時才碰；查狀態不碰。
 * 注意：settings 回報 available 時會呼叫 safeStorage.isEncryptionAvailable()；它會不會觸發 Keychain 詢問列在 Mac gate。
 */
const memoryDir = join(userData, "memory");
/**
 * WK-01a 常駐喚醒聆聽的引擎檔案（只有 NOUS_WAKE=on 時核心才看）。WK-01b 由 GitHub Actions 建置後安裝到這裡，不在 App 包裡；
 * WK-01a 的清單是空的，所以核心一律回報 runtime missing，頁面不會開麥克風。
 */
const wakeRuntimeDir = join(userData, "wake-runtime");

const REALTIME_MODELS = [
  { id: "gpt-realtime", label: "gpt-realtime（品質最好）" },
  { id: "gpt-realtime-mini", label: "gpt-realtime-mini（便宜約 3 倍、反應快）" },
];
const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
const CONCURRENCY = [2, 4, 6, 8];
const PROVIDER_LABEL = { chatgpt: "ChatGPT", claude: "Claude", mock: "模擬" };
/** 即時語音路徑（和 shared/realtime-route.ts 的 ROUTE_PREFERENCES 同一組值；核心驗證）。 */
const REALTIME_ROUTES = [
  { id: "auto", label: "自動（先用 ChatGPT 方案，不能用時改用 API key 並告知）" },
  { id: "live", label: "ChatGPT 方案（Codex 額度）" },
  { id: "api_key", label: "OpenAI API key（依用量計費）" },
];

const DEFAULT_PREFS = {
  locale: "zh-TW",
  realtimeModel: "gpt-realtime",
  realtimeVoice: "marin",
  maxConcurrent: 4,
  alwaysOnTop: false,
  showDock: true,
  openAtLogin: false,
  startHidden: false,
  bounds: { width: 1100, height: 760 },
};

function loadPrefs() {
  try {
    const saved = JSON.parse(readFileSync(prefsFile, "utf8"));
    return { ...DEFAULT_PREFS, ...saved, locale: isLocale(saved.locale) ? saved.locale : "zh-TW" };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
let prefs = loadPrefs();
setNativeLocale(prefs.locale);
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
}

function showMessage(options, parent) {
  const localized = localizeDialog(options);
  return parent ? dialog.showMessageBox(parent, localized) : dialog.showMessageBox(localized);
}

function showError(title, detail) {
  dialog.showErrorBox(t(title), t(detail));
}

function setLocale(locale, { notify = true } = {}) {
  if (!isLocale(locale) || locale === prefs.locale) return false;
  const previous = prefs.locale;
  try {
    savePrefs({ locale });
  } catch (error) {
    prefs.locale = previous;
    showError("語言選擇沒有保存", t("無法寫入 App 偏好設定；語言仍維持原本的選擇。{0}", String(error.message ?? error)));
    if (win && !win.isDestroyed()) win.webContents.send("nous:locale-changed", previous);
    return false;
  }
  setNativeLocale(locale);
  settings = null;
  settingsReadGeneration++;
  rebuildMenu();
  rebuildAppMenu();
  void refreshSettings();
  app.setAboutPanelOptions({ credits: t("漂浮電子腦 × 即時語音 × 背景任務") });
  if (commandsWin && !commandsWin.isDestroyed()) {
    commandsWin.setTitle(t("Nous 語音指令表"));
    loadCommands();
  }
  if (notify && win && !win.isDestroyed()) win.webContents.send("nous:locale-changed", locale);
  return true;
}

const logLines = [];
function log(line) {
  logLines.push(`${new Date().toISOString()} ${line}`);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  try {
    writeFileSync(logFile, `${logLines.join("\n")}\n`);
  } catch {
    // 記錄失敗不影響使用
  }
}

// ───────────── 本機核心 ─────────────

let core = null; // { port, url, close }
let quitting = false;

async function startCore() {
  const { startNous } = await import(pathToFileURL(join(here, "server.mjs")).href);
  // safeStorage 包裝資料金鑰（記憶與任務加密共用同一個 secretBox；只在 darwin、App ready 且可加密時可用，失敗不退回明文）。
  const secretBox = createMemorySecretBox({ safeStorage, ready: () => app.isReady() });
  core = await startNous({
    envFile,
    dataDir,
    distDir: join(here, "web"),
    fallbackPort: true,
    overrides: {
      NOUS_REALTIME_MODEL: prefs.realtimeModel,
      NOUS_REALTIME_VOICE: prefs.realtimeVoice,
      NOUS_MAX_CONCURRENT: String(prefs.maxConcurrent),
    },
    log,
    identity: {
      dir: identityDir,
      secretBox: identitySecretBox,
      excludeFromBackup: excludeFromTimeMachine,
      confirm: confirmIdentity,
      modelDir: faceRuntimeDir,
    },
    wakeRuntimeDir,
    memory: {
      dir: memoryDir,
      secretBox,
      excludeFromBackup: excludeFromTimeMachine,
      confirm: confirmMemory,
      // 本次人物世代改變（換人、暫停、撤銷）：推一個不含內容的通知，頁面再用 status（不開記憶檔）讀新狀態。
      onPresence: () => { if (win && !win.isDestroyed()) win.webContents.send("nous:memory-changed"); },
    },
    // MEM-4a：全部任務加密保存（data/sealed/）；舊的明文在核心啟動時搬遷一次，備份保留到使用者在畫面上確認刪除。
    // MEM-4c 審查 M1：核心丟棄解密內容後（鎖定、睡眠、閒置、關閉記憶、結束），送一個不含內容的事件給主視窗清掉畫面快取。
    tasks: { secretBox, confirmDeleteBackups, excludeFromBackup: excludeFromTimeMachine, onPlaintextDropped: notifyPlaintextDropped },
    // MEM-2：記憶撤銷後頁面沒有在 1.5 秒內回報停播時，核心把主視窗的聲音強制靜音（下一次回報停播或新通話開始才解除）。
    audio: { setMuted: (muted) => { if (win && !win.isDestroyed()) win.webContents.setAudioMuted(muted); } },
  });
}

/** MEM-4c 審查 M1：只送原因（固定白名單），不含任何內容；preload 也只接受白名單裡的原因。 */
const PLAINTEXT_DROP_REASONS = ["os_lock", "suspend", "idle", "memory_off", "memory_closed", "quit"];
function notifyPlaintextDropped(reason) {
  if (!PLAINTEXT_DROP_REASONS.includes(reason)) return;
  if (win && !win.isDestroyed()) win.webContents.send("tasks:plaintext-dropped", { reason });
}

// ───────────── 家人辨識（ADR-0001；資料與比對在核心，這裡只提供 safeStorage、原生確認與 IPC 傳輸） ─────────────

/**
 * 資料金鑰的包裝：safeStorage（macOS 以 Keychain 中的應用程式金鑰加密）。只在 macOS 且可加密時可用；
 * Linux 的 basic_text 後端等於明文，一律當不可用（核心就不建立 gallery，不退回明文）。
 */
const identitySecretBox = {
  available: () => {
    if (process.platform !== "darwin" || !safeStorage.isEncryptionAvailable()) return false;
    return !(typeof safeStorage.getSelectedStorageBackend === "function" && safeStorage.getSelectedStorageBackend() === "basic_text");
  },
  seal: (plain) => safeStorage.encryptString(plain),
  open: (sealed) => safeStorage.decryptString(sealed),
};

/** 把 gallery 資料夾排除在 Time Machine 之外（黏著式排除，跟著資料夾走）。失敗只記狀態並在畫面說明。 */
function excludeFromTimeMachine(dir) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new Error("只有 macOS 有 Time Machine"));
    execFile("tmutil", ["addexclusion", dir], (err) => (err ? reject(err) : resolve()));
  });
}

const BACKUP_NOTE = "限制：在此之前已存在的 Time Machine 備份或 APFS 本機快照，可能仍保有舊的加密檔；本機的應用程式金鑰不會輪換，舊檔理論上仍可解開。Nous 無法刪除那些快照。";

/** 登記、刪除與清除的原生確認：頁面無法偽造，這是「永久刪除須當次明確確認」的實作。回 true 才寫檔。 */
async function confirmIdentity(request) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const ask = (options) => showMessage(options, parent);
  const backupNote = t(BACKUP_NOTE);
  if (request?.kind === "enroll") {
    const minor = request.minor === true;
    const { response, checkboxChecked } = await ask({
      type: "question",
      buttons: ["登記", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `要登記「${request.name}」為家人嗎？`,
      detail:
        "本人必須在場、聽過說明並同意。Nous 只在這台 Mac 上保存加密的臉部特徵（不存照片、不上傳），只用來稱呼，" +
        "不作為解鎖或授權的依據；隨時可以在「家人辨識」刪除。目前辨識門檻尚未校準。",
      ...(minor ? { checkboxLabel: "我是家長，本人在場，我確認同意登記這位未成年家人", checkboxChecked: false } : {}),
    });
    return response === 0 && (!minor || checkboxChecked === true);
  }
  if (request?.kind === "delete") {
    // 連結的記憶（docs/17 §9.4、George 決定 ⑨）：顯示筆數；成人預設不勾，未成年預設勾選。不勾只解除連結。
    // count 為 null：記憶檔這次還沒開過，不為了計數去開（不碰 Keychain），改寫「刪除時一併處理」。
    const memory = request.memory && (Number.isInteger(request.memory.count) || request.memory.count === null) ? request.memory : null;
    const { response, checkboxChecked } = await ask({
      type: "warning",
      buttons: ["永久刪除", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `要永久刪除「${request.name}」的家人資料嗎？`,
      detail: `會從加密檔移除這位家人的所有特徵與名稱，並換用新的加密金鑰；刪除後無法還原。\n\n${backupNote}`,
      ...(memory ? {
        checkboxLabel: memory.count === null
          ? t("同時刪除此人的記憶（如有；筆數在刪除時一併處理）；不勾選只解除連結，記憶保留在「記憶…」")
          : t("同時刪除此人的記憶（{0} 筆）；不勾選只解除連結，記憶保留在「記憶…」", String(memory.count)),
        checkboxChecked: memory.defaultDelete === true,
      } : {}),
    });
    if (!memory) return response === 0;
    return { confirmed: response === 0, deleteMemory: response === 0 && checkboxChecked === true };
  }
  if (request?.kind === "clear_all") {
    // 每位家人連結的記憶：未成年一併刪除；成人預設只解除連結，勾選才刪（原生對話框只有一個勾選框）。
    const people = Array.isArray(request.memory?.people) ? request.memory.people : [];
    const lines = people.map((p) => p.count === null
      ? t(p.minor ? "{0}：記憶筆數刪除時一併處理（未成年，一併刪除）" : "{0}：記憶筆數刪除時一併處理（成人，預設保留）", String(p.name))
      : t(p.minor ? "{0}：{1} 筆記憶（未成年，一併刪除）" : "{0}：{1} 筆記憶（成人，預設保留）", String(p.name), String(p.count)));
    const adults = people.some((p) => !p.minor);
    const { response, checkboxChecked } = await ask({
      type: "warning",
      buttons: ["清除全部", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: "要清除全部家人資料嗎？",
      detail: `會刪除這台 Mac 上 Nous 的家人辨識加密檔（所有家人的特徵與名稱）；清除後無法還原，需要重新登記。${lines.length ? `\n\n${t("連結的記憶：")}\n${lines.join("\n")}` : ""}\n\n${backupNote}`,
      ...(adults ? { checkboxLabel: t("同時刪除成人家人的記憶（不勾選只解除連結）"), checkboxChecked: false } : {}),
    });
    if (!people.length) return response === 0;
    return { confirmed: response === 0, deleteMemory: response === 0 && checkboxChecked === true };
  }
  return false;
}

const MEMORY_NOTE = "限制：在此之前已存在的 Time Machine 備份或 APFS 本機快照，可能仍保有舊的加密記憶檔；已送給模型服務的內容也不會因此刪除。";

/** 記憶的原生確認（docs/16 §8、§9）：刪除整個人物記憶、全部忘記、連結家人辨識。頁面無法偽造；回 true 才寫檔。 */
const PLAINTEXT_BACKUP_NOTE = "限制：刪除只移除檔案，不是安全抹除；在此之前的 Time Machine 備份或 APFS 本機快照可能仍保有明文的 tasks.json 與 artifacts.json，Nous 無法刪除那些快照。";

/** MEM-4a：刪除明文備份前的原生確認（頁面無法偽造）。回 true 才刪。 */
async function confirmDeleteBackups(count) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const { response } = await showMessage({
    type: "warning", buttons: ["刪除明文備份", "取消"], defaultId: 1, cancelId: 1,
    message: t("要刪除任務的明文備份嗎？"),
    detail: `${t("任務已加密保存並逐筆驗證；明文備份（{0} 個資料夾）刪除後無法還原。", String(count))}\n\n${t(PLAINTEXT_BACKUP_NOTE)}`,
  }, parent);
  return response === 0;
}

async function confirmMemory(request) {
  const parent = win && !win.isDestroyed() ? win : undefined;
  const ask = (options) => showMessage(options, parent);
  const note = t(MEMORY_NOTE);
  if (request?.kind === "profile_delete") {
    const { response } = await ask({
      type: "warning", buttons: ["永久刪除", "取消"], defaultId: 1, cancelId: 1,
      message: t("要永久刪除「{0}」的記憶檔嗎？", String(request.name)),
      detail: `${t("會刪除這位人物的 {0} 筆記憶、來源與同意設定；家人辨識資料不受影響。刪除後無法還原。", String(request.count))}\n\n${note}`,
    });
    return response === 0;
  }
  if (request?.kind === "forget_all") {
    const { response } = await ask({
      type: "warning", buttons: ["全部忘記", "取消"], defaultId: 1, cancelId: 1,
      message: request.scope ? t("要忘記「{0}」的全部記憶嗎？", String(request.scope)) : t("要忘記全家共用的全部記憶嗎？"),
      detail: `${t("會刪除 {0} 筆記憶；其他人物的記憶不受影響。刪除後無法還原。", String(request.count))}\n\n${note}`,
    });
    return response === 0;
  }
  if (request?.kind === "link_face") {
    const { response } = await ask({
      type: "question", buttons: ["連結", "取消"], defaultId: 1, cancelId: 1,
      message: request.person ? t("要把「{0}」的記憶檔連結到家人辨識的「{1}」嗎？", String(request.profile), String(request.person)) : t("要解除「{0}」的家人辨識連結嗎？", String(request.profile)),
      detail: t("連結後，看著說話認出這位家人時，Nous 只會問「這次用 {0} 的偏好？」，確認後才選定；認臉不是授權。同名的新登記不會自動接回舊記憶。", String(request.profile)),
    });
    return response === 0;
  }
  return false;
}

/** 選單列「記憶…」的點擊時間：10 秒內頁面才能打開記憶管理。 */
const memoryClick = new MenuClickWindow();
/** MEM-4a（George 的 D2）：選單列「成果紀錄…」的點擊時間；10 秒內第一個帶 all 的任務請求，核心才給看其他家人的帶記憶任務。 */
const historyClick = new MenuClickWindow();

function openHistoryMenu() {
  historyClick.mark(Date.now());
  command("history");
}

function openMemory() {
  memoryClick.mark(Date.now());
  command("memory");
}

/** 選單列「在瀏覽器打開成果紀錄」：只開本機核心的 /history（同一個本機位址與連接埠；沒有權杖，靠本機位址限制）。 */
function openHistoryInBrowser() {
  if (!core) return;
  void shell.openExternal(`${core.url}/history?lang=${prefs.locale}`);
}

/** 選單列「家人辨識…」的點擊時間：10 秒內頁面才能開管理 session（語音或頁面腳本不能自己開）。 */
const familyClick = new MenuClickWindow();

function openFamily(mode) {
  familyClick.mark(Date.now());
  if (mode === "calibrate") command("family-calibrate");
  else command("family");
}

async function api(path, body) {
  const headers = { "X-Nous-Locale": prefs.locale, ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
  const res = await fetch(`${core.url}${path}`, body === undefined
    ? { headers }
    : { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function activeTaskCount() {
  try {
    const tasks = await api("/api/tasks");
    return tasks.filter((t) => ["queued", "running", "cancelling"].includes(t.status)).length;
  } catch {
    return 0;
  }
}

/** 重新啟動核心以套用新設定；有任務在跑時先確認，因為重啟會中斷它們。 */
async function restartCore(reason, { ask = true } = {}) {
  const active = await activeTaskCount();
  if (active > 0 && ask) {
    const { response } = await showMessage({
      type: "question",
      buttons: ["重新啟動", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `要重新啟動 Nous 核心來套用「${t(reason)}」嗎？`,
      detail: `目前有 ${active} 個任務進行中，重新啟動會中斷它們（之後可以按「重試」）。`,
    });
    if (response !== 0) return false;
  }
  await core?.close();
  await startCore();
  if (win && !win.isDestroyed()) await win.loadURL(core.url);
  // 連接埠可能換了；指令表也重新依新核心的設定產生。
  if (commandsWin && !commandsWin.isDestroyed()) loadCommands();
  await refreshSettings();
  return true;
}

// ───────────── 視窗 ─────────────

let win = null;

function createWindow() {
  win = new BrowserWindow({
    ...prefs.bounds,
    minWidth: 720,
    minHeight: 520,
    title: "Nous",
    backgroundColor: "#03050b",
    titleBarStyle: "hiddenInset",
    alwaysOnTop: prefs.alwaysOnTop,
    show: false,
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true, additionalArguments: [`--nous-locale=${prefs.locale}`] },
  });
  win.loadURL(core.url);
  win.once("ready-to-show", () => {
    if (!prefs.startHidden) win.show();
  });
  // 關閉視窗只是隱藏：Nous 留在選單列，背景任務繼續。
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => !win.isDestroyed() && savePrefs({ bounds: win.getBounds() }), 500);
  };
  win.on("resize", rememberBounds);
  win.on("move", rememberBounds);

  // 外部連結（管理用量、登入頁）用系統瀏覽器開；視窗只顯示本機核心。
  const isLocal = (url) => core && url.startsWith(core.url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !isLocal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isLocal(url)) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  // 家人辨識的管理 session 只屬於當下這一頁：主視窗導覽、重新載入（也會觸發 did-navigate）或 renderer 結束就關掉。
  win.webContents.on("did-navigate", () => { core?.identity?.closeSessions(); core?.memory?.closeSessions(); core?.tasks?.closeSessions(); });
  win.webContents.on("render-process-gone", () => { core?.identity?.closeSessions(); core?.memory?.closeSessions(); core?.tasks?.closeSessions(); });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ───────────── 語音指令表（獨立的唯讀視窗） ─────────────
// 不經過主視窗：不呼叫 showWindow／command，主頁面收不到任何事件，正在進行的對話與回覆不受影響。
// 頁面由本機核心依目前設定產生（GET /help/commands，沒有 script、CSP 只允許自己的 style）；視窗再加一層鎖：
// 不載入 preload、sandbox、關掉 JavaScript、獨立的記憶體 session 拒絕所有權限、禁止導覽與開新視窗。

const HELP_PARTITION = "nous-help"; // 沒有 persist: 前綴：只在記憶體，不和主視窗共用（主視窗的 session 允許麥克風）
let commandsWin = null;

function openCommandsWindow() {
  if (commandsWin && !commandsWin.isDestroyed()) {
    if (commandsWin.isMinimized()) commandsWin.restore();
    commandsWin.show();
    commandsWin.focus();
    return;
  }
  const helpSession = session.fromPartition(HELP_PARTITION);
  helpSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  helpSession.setPermissionCheckHandler(() => false);
  commandsWin = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: t("Nous 語音指令表"),
    show: false,
    webPreferences: {
      partition: HELP_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  const contents = commandsWin.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("will-redirect", (e) => e.preventDefault());
  contents.on("will-attach-webview", (e) => e.preventDefault());
  commandsWin.once("ready-to-show", () => commandsWin?.show());
  commandsWin.on("closed", () => {
    commandsWin = null;
  });
  loadCommands();
}

function loadCommands() {
  const target = commandsWin;
  target.loadURL(`${core.url}/help/commands?lang=${prefs.locale}`).catch((err) => {
    // ⌘R 或核心重啟後的 loadCommands 取代了還在載入的那一次：舊的載入以 ERR_ABORTED 結束，新的照常進行。
    if (err?.code === "ERR_ABORTED") return;
    log(`語音指令表載入失敗：${err.message ?? err}`);
    if (target.isDestroyed()) return;
    showError("無法打開語音指令表", `本機核心沒有回應（${err.message ?? err}）。稍後再試，或在「設定與資料」重新啟動核心。`);
    target.destroy();
  });
}

/** 把選單動作交給網頁（開始語音、看進度…）。 */
function command(name) {
  showWindow();
  notifyPage(name);
}

/** 和 command 相同，但不打開視窗（常駐喚醒聆聽的暫停、繼續與立即停止：只改收音，不跳出畫面）。 */
function notifyPage(name) {
  if (!win || win.isDestroyed()) return;
  win.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent("nous:command", { detail: ${JSON.stringify(name)} }))`)
    .catch(() => {});
}

/** 系統電源事件交給頁面（只送列舉值）：睡眠、鎖定時停止常駐喚醒聆聽，醒來、解鎖時依偏好自動恢復（docs/17 §5.8）。 */
function notifyPower(event) {
  if (win && !win.isDestroyed()) win.webContents.send("nous:power", event);
}

// ───────────── 選單列圖示 ─────────────

let tray = null;
let pageState = { voice: "off", activeTasks: 0, wake: null };
let settings = null;
let settingsReadGeneration = 0;

const VOICE_LABEL = {
  off: "未開啟",
  connecting: "連線中",
  listening: "聆聽中",
  hearing: "正在聽你說",
  thinking: "思考中",
  speaking: "回覆中",
};

function trayImage(active) {
  // 用 @2x 的圖並指定 18pt 大小，Retina 螢幕才會清楚；設成範本圖，系統自動配合深淺色選單列。
  const base = nativeImage.createFromPath(asset(active ? "trayActiveTemplate@2x.png" : "trayTemplate@2x.png"));
  const image = base.isEmpty() ? base : base.resize({ width: 18, height: 18, quality: "best" });
  if (!base.isEmpty()) image.addRepresentation({ scaleFactor: 2, buffer: base.toPNG() });
  image.setTemplateImage(true);
  if (image.isEmpty()) log(`選單列圖示載入失敗：${asset("trayTemplate@2x.png")}`);
  return image;
}

async function refreshSettings() {
  const generation = ++settingsReadGeneration;
  const locale = prefs.locale;
  try {
    const next = await api("/api/settings");
    if (generation !== settingsReadGeneration || locale !== prefs.locale) return;
    settings = next;
  } catch {
    // 核心重啟中，下次再更新
  }
  rebuildMenu();
}

/** 「鏡頭與語音設定」子選單：範本在 settings-menu.mjs（純函式，有測試）。 */
function secondsMenu() {
  return settingsMenu(settings, { command, setMenuPref, openFamily, setWakeListen, wakeReport: pageState.wake, wakeCommand: notifyPage, translate: t });
}

/** 即時語音用的 Codex 登入：核心開好回呼（1455，被占用時 1457，再不行改裝置代碼），系統瀏覽器開登入頁。 */
async function codexLogin() {
  try {
    const result = await api("/api/auth/codex/login", { method: "browser" });
    if (result.method === "browser") void shell.openExternal(result.authorize_url);
    else {
      void shell.openExternal(result.verification_url);
      showMessage({ message: "ChatGPT 方案（Codex）裝置代碼登入", detail: `${result.note ? `${t(result.note)}。\n` : ""}在開啟的頁面輸入代碼：${result.user_code}` });
    }
  } catch (err) {
    showError("無法開始 ChatGPT 方案登入", String(err.message ?? err));
  }
  await refreshSettings();
}

/** 送出後直接套用回應（不等 15 秒的輪詢）；失敗時說明真實原因，並重新讀取實際保存的值（checkbox 不會停在沒保存的狀態）。 */
async function setMenuPref(row, value) {
  try {
    settings = await api(row.write_path, { [row.key]: value });
  } catch (err) {
    const title = row.kind === "bool" ? `「${t(row.label)}」沒有保存` : row.kind === "factor" ? "倍率沒有保存" : "秒數沒有保存";
    showError(title, String(err.message ?? err));
    await refreshSettings();
    return;
  }
  rebuildMenu();
}

/**
 * 選單列「常駐喚醒聆聽」。每次由關到開都先顯示原生說明（App 重開與睡眠回來會自動恢復、聲音只在本機記憶體），按「開啟」才保存。
 * 關掉時先叫頁面立即停止收音，再保存；保存失敗時收音仍然是停的，並顯示保存失敗（docs/17 §5.5）。
 */
async function setWakeListen(value) {
  if (value) {
    const runtimeMissing = settings?.wake?.runtime !== "ok";
    const detail = [t("開啟後麥克風會常駐開著，只在這台 Mac 本機偵測「哈囉努斯」。沒有喚醒時的聲音只留在記憶體中約 2 秒，不寫檔、不進紀錄、不上傳。App 重開與睡眠回來後會自動恢復，直到你關掉這個開關；「暫停聆聽」只到這次結束。")];
    if (runtimeMissing) detail.push(t("目前還沒有安裝喚醒引擎：開啟後會顯示「無法使用」，不會開啟麥克風。"));
    let response = 1;
    try {
      const parent = win && !win.isDestroyed() ? win : undefined;
      ({ response } = await showMessage({ type: "question", buttons: ["開啟", "取消"], defaultId: 1, cancelId: 1, message: "要開啟常駐喚醒聆聽嗎？", detail: detail.join("\n\n") }, parent));
    } catch {
      response = 1;
    }
    if (response !== 0) {
      rebuildMenu();
      return;
    }
  } else {
    notifyPage("wake-off");
  }
  // 開關只經主程序與核心之間的同一行程呼叫（core.wake），不經 HTTP：頁面腳本無法略過上面的原生說明自己打開。
  try {
    if (!core?.wake) throw new Error(t("常駐喚醒聆聽不可用"));
    core.wake.setListen(value);
  } catch (err) {
    showError("常駐喚醒聆聽沒有保存", String(err.message ?? err));
  }
  await refreshSettings();
}

function rebuildMenu() {
  if (!tray) return;
  const voiceOn = pageState.voice !== "off";
  tray.setImage(trayImage(voiceOn));
  tray.setTitle(pageState.activeTasks > 0 ? ` ${pageState.activeTasks}` : "", { fontType: "monospacedDigit" });
  tray.setToolTip(t(voiceOn ? `Nous · 語音${t(VOICE_LABEL[pageState.voice] ?? "")}` : "Nous 電子腦"));

  const realtime = settings?.realtime;
  const provider = settings?.provider;
  const providers = settings?.providers ?? [];
  const envWatchNote = "存檔後會自動重新啟動核心套用";

  const liveRoute = realtime?.routes?.find((r) => r.id === "live");
  const liveAccount = realtime?.live_account;
  // 路徑與計費一律照實顯示：進行中的工作階段用它自己的路徑；偏好改了只影響下一次開始。
  const realtimeLine = !realtime
    ? "讀取中…"
    : realtime.active
      ? `${t(realtime.active.billing_line)}（進行中）${realtime.billing_line && realtime.billing_line !== realtime.active.billing_line ? `；下次：${t(realtime.billing_line)}` : ""}`
      : t(realtime.billing_line ?? `不可用（${t(realtime.detail)}）`);

  const template = [
    { label: `Nous · 引擎：${t(PROVIDER_LABEL[provider] ?? "讀取中…")}`, enabled: false },
    {
      label: `即時語音：${t(realtimeLine)} · 語音${t(VOICE_LABEL[pageState.voice] ?? "")}`,
      enabled: false,
    },
    { label: pageState.activeTasks > 0 ? `進行中的任務：${pageState.activeTasks} 個` : "目前沒有進行中的任務", enabled: false },
    { type: "separator" },
    { label: "顯示電子腦", accelerator: "Alt+Command+N", click: showWindow },
    { label: voiceOn ? "結束語音對話" : "開始語音對話", accelerator: "Alt+Command+V", click: () => command("voice") },
    { label: "打字對話", click: () => command("type") },
    { label: "看進度", click: () => command("progress") },
    { type: "separator" },
    {
      label: "AI 引擎（執行交辦的工作）",
      submenu: [
        ...providers.map((p) =>
          radio(`${t(PROVIDER_LABEL[p.id] ?? p.label)}${p.available ? "" : t("（不可用）")}`, p.id === provider, async () => {
            try {
              await api("/api/settings/provider", { provider: p.id });
            } catch (err) {
              showError("無法切換引擎", String(err.message ?? err));
            }
            await refreshSettings();
          }, p.available),
        ),
        { type: "separator" },
        { label: "登入／帳號設定…", click: () => command("settings") },
      ],
    },
    {
      label: "即時語音",
      submenu: [
        { label: "路徑（下一次開始生效，不用重新啟動）", enabled: false },
        ...REALTIME_ROUTES.map((r) =>
          radio(r.label, realtime?.preference === r.id, async () => {
            try {
              settings = await api("/api/settings/realtime", { route: r.id });
            } catch (err) {
              showError("即時語音路徑沒有保存", String(err.message ?? err));
              await refreshSettings();
              return;
            }
            rebuildMenu();
          }, !!realtime),
        ),
        { type: "separator" },
        {
          label: liveAccount?.signed_in ? `ChatGPT 方案（Codex）：${liveAccount.email ?? t("已登入")}` : "ChatGPT 方案（Codex）登入…",
          sublabel: liveRoute && !liveRoute.available ? t(liveRoute.detail) : undefined,
          click: () => void codexLogin(),
          enabled: !!liveAccount && !liveAccount.signed_in,
        },
        {
          label: `聲音（ChatGPT 方案）：${liveRoute?.voice ?? "—"}`,
          enabled: !!liveRoute,
          submenu: (liveRoute?.voices ?? []).map((v) =>
            radio(v === "cove" ? "cove（預設）" : v, liveRoute?.voice === v, async () => {
              try {
                settings = await api("/api/settings/realtime", { live_voice: v });
              } catch (err) {
                showError("聲音沒有保存", String(err.message ?? err));
                await refreshSettings();
                return;
              }
              rebuildMenu();
            }),
          ),
        },
        { label: "ChatGPT 方案用量", click: () => shell.openExternal("https://chatgpt.com/settings/usage") },
        { type: "separator" },
        { label: "模型（API key 路徑）", enabled: false },
        ...REALTIME_MODELS.map((m) =>
          radio(m.label, prefs.realtimeModel === m.id, async () => {
            const previous = prefs.realtimeModel;
            savePrefs({ realtimeModel: m.id });
            if (!(await restartCore(`即時語音模型：${m.id}`))) savePrefs({ realtimeModel: previous });
            rebuildMenu();
          }),
        ),
        { type: "separator" },
        {
          label: `聲音（API key 路徑）：${prefs.realtimeVoice}`,
          submenu: VOICES.map((v) =>
            radio(v === "marin" ? "marin（預設）" : v, prefs.realtimeVoice === v, async () => {
              const previous = prefs.realtimeVoice;
              savePrefs({ realtimeVoice: v });
              if (!(await restartCore(`聲音：${v}`))) savePrefs({ realtimeVoice: previous });
              rebuildMenu();
            }),
          ),
        },
        { type: "separator" },
        { label: "帳號與登入…", click: () => command("settings") },
        { label: "填入 OpenAI API key…", click: openEnvFile },
        { label: "OpenAI 用量與上限", click: () => shell.openExternal("https://platform.openai.com/usage") },
      ],
    },
    {
      label: `同時處理任務數：${prefs.maxConcurrent}`,
      submenu: CONCURRENCY.map((n) =>
        radio(`${n} 個${n === 4 ? "（預設）" : ""}`, prefs.maxConcurrent === n, async () => {
          const previous = prefs.maxConcurrent;
          savePrefs({ maxConcurrent: n });
          if (!(await restartCore(`同時處理 ${n} 個任務`))) savePrefs({ maxConcurrent: previous });
          rebuildMenu();
        }),
      ),
    },
    { label: "鏡頭與語音設定", submenu: secondsMenu() },
    { label: "語音指令表", click: openCommandsWindow },
    // 成果紀錄（HIST-1）：使用者點了才打開（App 內的按需畫面，或用系統瀏覽器開核心的 /history）。
    { label: "成果紀錄…", click: openHistoryMenu },
    // MEM-4a：任務加密搬遷後的明文備份（顯示提示；刪除前另跳原生確認）。
    { label: "刪除明文備份…", click: () => command("vault"), enabled: !!core },
    { label: "在瀏覽器打開成果紀錄", click: openHistoryInBrowser, enabled: !!core },
    {
      label: "記憶…",
      sublabel: settings?.memory && !settings.memory.available ? t("此 Mac 無法安全保存，記憶停用") : settings?.memory?.enabled ? undefined : t("尚未開啟"),
      click: openMemory,
    },
    languageMenu(prefs.locale, setLocale),
    { type: "separator" },
    {
      label: "設定與資料",
      submenu: [
        { label: "編輯 API key 與進階設定（.env）…", sublabel: envWatchNote, click: openEnvFile },
        { label: "打開任務與成果資料夾", click: () => { mkdirSync(dataDir, { recursive: true }); void shell.openPath(dataDir); } },
        { label: "重新啟動核心", click: () => void restartCore("重新啟動") },
        { type: "separator" },
        { label: "ChatGPT 方案用量", click: () => shell.openExternal("https://chatgpt.com/settings/usage") },
        {
          label: "麥克風權限設定…",
          click: () => shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        },
        { label: "打開記錄檔", click: () => void shell.openPath(logFile) },
      ],
    },
    { type: "separator" },
    {
      label: "視窗永遠在最上層",
      type: "checkbox",
      checked: prefs.alwaysOnTop,
      click: (item) => {
        savePrefs({ alwaysOnTop: item.checked });
        win?.setAlwaysOnTop(item.checked);
      },
    },
    {
      label: "在 Dock 顯示圖示",
      type: "checkbox",
      checked: prefs.showDock,
      click: (item) => {
        savePrefs({ showDock: item.checked });
        applyDock();
      },
    },
    {
      label: "登入 Mac 時自動開啟",
      type: "checkbox",
      checked: prefs.openAtLogin,
      click: (item) => {
        savePrefs({ openAtLogin: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    {
      label: "開啟時只顯示選單列圖示",
      type: "checkbox",
      checked: prefs.startHidden,
      click: (item) => savePrefs({ startHidden: item.checked }),
    },
    { type: "separator" },
    { label: "關於 Nous", click: () => app.showAboutPanel() },
    { label: "結束 Nous", accelerator: "Command+Q", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(localizeMenu(template)));
}

function applyDock() {
  if (prefs.showDock) void app.dock?.show();
  else app.dock?.hide();
}

// ───────────── .env（API key） ─────────────

function ensureEnvFile() {
  mkdirSync(userData, { recursive: true });
  if (!existsSync(envFile)) copyFileSync(join(here, "env.example"), envFile);
}

function openEnvFile() {
  ensureEnvFile();
  execFile("open", ["-e", envFile]);
}

/** .env 存檔後自動重新啟動核心；有任務在跑時先問。 */
function watchEnvFile() {
  let timer = null;
  let last = readFileSync(envFile, "utf8");
  watch(userData, (_event, name) => {
    if (name !== ".env") return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let text;
      try {
        text = readFileSync(envFile, "utf8");
      } catch {
        return;
      }
      if (text === last) return;
      last = text;
      const restarted = await restartCore("新的 .env 設定");
      if (restarted && Notification.isSupported()) {
        new Notification({ title: "Nous", body: t("已套用新的設定（.env）。") }).show();
      }
    }, 1200);
  });
}

// ───────────── 啟動 ─────────────

app.setAboutPanelOptions({
  applicationName: "Nous",
  applicationVersion: app.getVersion(),
  credits: t("漂浮電子腦 × 即時語音 × 背景任務"),
});

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void core?.close();
});
app.on("window-all-closed", () => {
  // 留在選單列，不結束。
});

// 設定在頁面（帳號頁、語音或打字指令）改了：頁面收到核心的 settings.updated 後回報新的版本字串，這裡馬上重新讀取。
// 不在點選單列圖示時才讀：macOS 上 setContextMenu 的選單在 mouse-down 當下就打開，非同步的讀取趕不上這一次。
let reportedSettings = null;
ipcMain.on("nous:get-locale", (event) => {
  event.returnValue = trustedLocaleSender(event, win, core?.url) ? prefs.locale : "zh-TW";
});
ipcMain.on("nous:state", (event, state) => {
  if (!trustedLocaleSender(event, win, core?.url) || !state || typeof state !== "object") return;
  if (isLocale(state.locale)) setLocale(state.locale, { notify: false });
  pageState = { voice: String(state.voice ?? "off"), activeTasks: Number(state.activeTasks) || 0, wake: isWakeReport(state.wake) ? { state: state.wake.state, reason: state.wake.reason ?? null } : null };
  const revision = String(state.settings ?? "");
  if (revision && revision !== reportedSettings) {
    reportedSettings = revision;
    void refreshSettings(); // 讀完會 rebuildMenu
    return;
  }
  rebuildMenu();
});
ipcMain.on("nous:open-external", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) void shell.openExternal(url);
});
// 家人辨識：只接受主視窗主框架、來自本機核心頁面的請求；形狀過濾後原樣交給核心（核心再完整驗證）。
ipcMain.handle("nous:identity", async (event, request) => {
  if (!core?.identity || !checkIdentitySender(event, win, core.url)) return { ok: false, code: "unavailable", message: t("家人辨識不可用") };
  const checked = validateIdentityRequest(request);
  if (!checked.ok) return { ok: false, code: "bad_request", message: checked.error };
  const userInitiated = checked.request.op === "open_session" ? familyClick.consume(Date.now()) : false;
  return core.identity.handle(checked.request, { userInitiated });
});

// MEM-4a 加密任務：只接受主視窗主框架、來自本機核心頁面的請求；形狀過濾後交給核心（核心再完整驗證）。
ipcMain.handle("nous:tasks", async (event, request) => {
  if (!core?.tasks || !checkTrustedSender(event, win, core.url)) return { ok: false, code: "unavailable", message: t("加密任務不可用") };
  const checked = validateTasksRequest(request);
  if (!checked.ok) return { ok: false, code: "bad_request", message: checked.error };
  const userInitiated = checked.request.all === true ? historyClick.consume(Date.now()) : false;
  return core.tasks.handle(checked.request, { userInitiated });
});

// HIST-1 Mac 驗收 F4：成果紀錄刪除的原生確認（按鈕依目前語言：「刪除／取消」「Delete／Cancel」）。只接受主視窗主框架、
// 來自本機核心頁面的請求；發送者不對、形狀不對或對話框失敗一律當成取消（不刪）。
ipcMain.handle("nous:confirm-delete", async (event, request) => {
  if (!core || !checkTrustedSender(event, win, core.url)) return { confirmed: false };
  const checked = validateConfirmDeleteRequest(request);
  if (!checked.ok) return { confirmed: false };
  try {
    const parent = win && !win.isDestroyed() ? win : undefined;
    return { confirmed: deleteConfirmed(await showMessage(deleteTaskDialog(checked.request.title, t), parent)) };
  } catch {
    return { confirmed: false };
  }
});

// 記憶：只接受主視窗主框架、來自本機核心頁面的請求；形狀過濾後交給核心（核心再完整驗證）。
ipcMain.handle("nous:memory", async (event, request) => {
  if (!core?.memory || !checkTrustedSender(event, win, core.url)) return { ok: false, code: "unavailable", message: t("記憶不可用") };
  const checked = validateMemoryRequest(request);
  if (!checked.ok) return { ok: false, code: "bad_request", message: checked.error };
  const userInitiated = checked.request.op === "list" && checked.request.manage === true ? memoryClick.consume(Date.now()) : false;
  return core.memory.handle(checked.request, { userInitiated });
});

function rebuildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(localizeMenu([
      {
        label: "Nous",
        submenu: [
          { label: "關於 Nous", click: () => app.showAboutPanel() },
          languageMenu(prefs.locale, setLocale),
          { type: "separator" },
          { label: "隱藏 Nous", role: "hide" },
          { label: "隱藏其他", role: "hideOthers" },
          { label: "全部顯示", role: "unhide" },
          { type: "separator" },
          { label: "結束 Nous", role: "quit" },
        ],
      },
      {
        label: "編輯",
        submenu: [
          { label: "還原", role: "undo" },
          { label: "重做", role: "redo" },
          { type: "separator" },
          { label: "剪下", role: "cut" },
          { label: "拷貝", role: "copy" },
          { label: "貼上", role: "paste" },
          { label: "全選", role: "selectAll" },
        ],
      },
      {
        label: "顯示",
        submenu: [
          { label: "開始／結束語音對話", accelerator: "Alt+Command+V", click: () => command("voice") },
          { label: "看進度", accelerator: "Command+P", click: () => command("progress") },
          { label: "帳號與登入…", accelerator: "Command+,", click: () => command("settings") },
          { label: "語音指令表", accelerator: "Command+/", click: openCommandsWindow },
          { type: "separator" },
          { role: "reload", label: "重新載入" },
          { role: "togglefullscreen", label: "全螢幕" },
        ],
      },
      {
        label: "視窗",
        submenu: [
          { label: "最小化", role: "minimize" },
          { label: "縮放", role: "zoom" },
          { label: "關閉視窗", role: "close" },
          { type: "separator" },
          { label: "全部移到最前面", role: "front" },
        ],
      },
      {
        label: "說明",
        role: "help",
        submenu: [{ label: "語音指令表", click: openCommandsWindow }],
      },
    ])),
  );
}

app.whenReady().then(async () => {
  ensureEnvFile();
  mkdirSync(dataDir, { recursive: true });
  try {
    await startCore();
  } catch (err) {
    showError("Nous 無法啟動", String(err?.stack ?? err));
    app.exit(1);
    return;
  }

  // 麥克風與鏡頭（media）只開放給本機核心的頁面；鏡頭需 NOUS_CAMERA=on，影像只在本機處理。
  const allowMedia = (url) => Boolean(core && url?.startsWith(core.url));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === "media" && allowMedia(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && allowMedia(`${origin}/`));

  rebuildAppMenu();
  // 作業系統鎖定：暫停本次人物（記憶撤銷舊世代；解鎖後要重新選擇）。
  // MEM-4c：鎖定與睡眠時，核心也丟棄已結束受保護任務的解密內容與搜尋索引（解鎖後要用時才重新解密）。
  // 核心的 dropPlaintext 會經 onPlaintextDropped 通知主視窗；核心不在時主程序自己通知（頁面的快取一樣要清）。
  powerMonitor.on("lock-screen", () => {
    core?.memory?.suspendAll();
    if (core?.tasks) core.tasks.dropPlaintext("os_lock");
    else notifyPlaintextDropped("os_lock");
  });
  powerMonitor.on("suspend", () => (core?.tasks ? core.tasks.dropPlaintext("suspend") : notifyPlaintextDropped("suspend")));
  // WK-01a 常駐喚醒聆聽：電源事件只轉成列舉值交給頁面（鎖定、睡眠時停止收音；醒來、解鎖時要不要恢復由頁面依偏好、
  // 本次是否暫停與裝置事件決定）。和上面的處理器分開登記，既有行為不變。
  powerMonitor.on("lock-screen", () => notifyPower("lock"));
  powerMonitor.on("suspend", () => notifyPower("suspend"));
  powerMonitor.on("resume", () => notifyPower("resume"));
  powerMonitor.on("unlock-screen", () => notifyPower("unlock"));

  tray = new Tray(trayImage(false));
  setTimeout(() => log(`選單列圖示位置：${JSON.stringify(tray.getBounds())}`), 3000);
  applyDock();
  createWindow();
  await refreshSettings();
  setInterval(refreshSettings, 15_000);
  watchEnvFile();

  globalShortcut.register("Alt+Command+N", toggleWindow);
  globalShortcut.register("Alt+Command+V", () => command("voice"));
});
