// Nous macOS App（Electron 主程式）：內建本機核心，視窗顯示電子腦，選單列圖示提供常用動作與設定。
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import { radio, settingsMenu } from "./settings-menu.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name) => join(here, "assets", name);

if (!app.requestSingleInstanceLock()) app.exit(0);

// ───────────── 路徑與偏好設定 ─────────────

const userData = app.getPath("userData"); // ~/Library/Application Support/Nous
const envFile = join(userData, ".env");
const dataDir = join(userData, "data");
const prefsFile = join(userData, "desktop.json");
const logFile = join(userData, "nous.log");

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
    return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsFile, "utf8")) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
let prefs = loadPrefs();
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
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
  });
}

async function api(path, body) {
  const res = await fetch(`${core.url}${path}`, body === undefined
    ? undefined
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
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
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["重新啟動", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: `要重新啟動 Nous 核心來套用「${reason}」嗎？`,
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
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
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
    title: "Nous 語音指令表",
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
  target.loadURL(`${core.url}/help/commands`).catch((err) => {
    // ⌘R 或核心重啟後的 loadCommands 取代了還在載入的那一次：舊的載入以 ERR_ABORTED 結束，新的照常進行。
    if (err?.code === "ERR_ABORTED") return;
    log(`語音指令表載入失敗：${err.message ?? err}`);
    if (target.isDestroyed()) return;
    dialog.showErrorBox("無法打開語音指令表", `本機核心沒有回應（${err.message ?? err}）。稍後再試，或在「設定與資料」重新啟動核心。`);
    target.destroy();
  });
}

/** 把選單動作交給網頁（開始語音、看進度…）。 */
function command(name) {
  showWindow();
  win.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent("nous:command", { detail: ${JSON.stringify(name)} }))`)
    .catch(() => {});
}

// ───────────── 選單列圖示 ─────────────

let tray = null;
let pageState = { voice: "off", activeTasks: 0 };
let settings = null;

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
  try {
    settings = await api("/api/settings");
  } catch {
    // 核心重啟中，下次再更新
  }
  rebuildMenu();
}

/** 「鏡頭與語音設定」子選單：範本在 settings-menu.mjs（純函式，有測試）。 */
function secondsMenu() {
  return settingsMenu(settings, { command, setMenuPref });
}

/** 即時語音用的 Codex 登入：核心開好回呼（1455，被占用時 1457，再不行改裝置代碼），系統瀏覽器開登入頁。 */
async function codexLogin() {
  try {
    const result = await api("/api/auth/codex/login", { method: "browser" });
    if (result.method === "browser") void shell.openExternal(result.authorize_url);
    else {
      void shell.openExternal(result.verification_url);
      dialog.showMessageBox({ message: "ChatGPT 方案（Codex）裝置代碼登入", detail: `${result.note ? `${result.note}。\n` : ""}在開啟的頁面輸入代碼：${result.user_code}` });
    }
  } catch (err) {
    dialog.showErrorBox("無法開始 ChatGPT 方案登入", String(err.message ?? err));
  }
  await refreshSettings();
}

/** 送出後直接套用回應（不等 15 秒的輪詢）；失敗時說明真實原因，並重新讀取實際保存的值（checkbox 不會停在沒保存的狀態）。 */
async function setMenuPref(row, value) {
  try {
    settings = await api(row.write_path, { [row.key]: value });
  } catch (err) {
    const title = row.kind === "bool" ? `「${row.label}」沒有保存` : row.kind === "factor" ? "倍率沒有保存" : "秒數沒有保存";
    dialog.showErrorBox(title, String(err.message ?? err));
    await refreshSettings();
    return;
  }
  rebuildMenu();
}

function rebuildMenu() {
  if (!tray) return;
  const voiceOn = pageState.voice !== "off";
  tray.setImage(trayImage(voiceOn));
  tray.setTitle(pageState.activeTasks > 0 ? ` ${pageState.activeTasks}` : "", { fontType: "monospacedDigit" });
  tray.setToolTip(voiceOn ? `Nous · 語音${VOICE_LABEL[pageState.voice] ?? ""}` : "Nous 電子腦");

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
      ? `${realtime.active.billing_line}（進行中）${realtime.billing_line && realtime.billing_line !== realtime.active.billing_line ? `；下次：${realtime.billing_line}` : ""}`
      : realtime.billing_line ?? `不可用（${realtime.detail}）`;

  const template = [
    { label: `Nous · 引擎：${PROVIDER_LABEL[provider] ?? "讀取中…"}`, enabled: false },
    {
      label: `即時語音：${realtimeLine} · 語音${VOICE_LABEL[pageState.voice] ?? ""}`,
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
          radio(`${PROVIDER_LABEL[p.id] ?? p.label}${p.available ? "" : "（不可用）"}`, p.id === provider, async () => {
            try {
              await api("/api/settings/provider", { provider: p.id });
            } catch (err) {
              dialog.showErrorBox("無法切換引擎", String(err.message ?? err));
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
              dialog.showErrorBox("即時語音路徑沒有保存", String(err.message ?? err));
              await refreshSettings();
              return;
            }
            rebuildMenu();
          }, !!realtime),
        ),
        { type: "separator" },
        {
          label: liveAccount?.signed_in ? `ChatGPT 方案（Codex）：${liveAccount.email ?? "已登入"}` : "ChatGPT 方案（Codex）登入…",
          sublabel: liveRoute && !liveRoute.available ? liveRoute.detail : undefined,
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
                dialog.showErrorBox("聲音沒有保存", String(err.message ?? err));
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
  tray.setContextMenu(Menu.buildFromTemplate(template));
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
        new Notification({ title: "Nous", body: "已套用新的設定（.env）。" }).show();
      }
    }, 1200);
  });
}

// ───────────── 啟動 ─────────────

app.setAboutPanelOptions({
  applicationName: "Nous",
  applicationVersion: app.getVersion(),
  credits: "漂浮電子腦 × 即時語音 × 背景任務",
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
ipcMain.on("nous:state", (_e, state) => {
  if (!state || typeof state !== "object") return;
  pageState = { voice: String(state.voice ?? "off"), activeTasks: Number(state.activeTasks) || 0 };
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

app.whenReady().then(async () => {
  ensureEnvFile();
  mkdirSync(dataDir, { recursive: true });
  try {
    await startCore();
  } catch (err) {
    dialog.showErrorBox("Nous 無法啟動", String(err?.stack ?? err));
    app.exit(1);
    return;
  }

  // 麥克風與鏡頭（media）只開放給本機核心的頁面；鏡頭需 NOUS_CAMERA=on，影像只在本機處理。
  const allowMedia = (url) => Boolean(core && url?.startsWith(core.url));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(permission === "media" && allowMedia(details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === "media" && allowMedia(`${origin}/`));

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Nous",
        submenu: [
          { label: "關於 Nous", click: () => app.showAboutPanel() },
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
    ]),
  );

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
