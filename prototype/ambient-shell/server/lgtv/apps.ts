// LGTV-1：使用者說的 App 名稱與輸入源 → 電視上的 ID。移植自 LGTVG3 apps.py：
// 先用電視 listLaunchPoints 回的清單（App ID 會因地區、韌體不同），順序是 App ID → 標題完全相同 → 內建別名 → 包含／相似度。

export interface LaunchPoint {
  id: string;
  title: string;
}

export interface AppMatch {
  id: string;
  title: string;
  source: "id" | "title" | "alias" | "fuzzy";
}

/** 別名 → 常見 App ID（社群回報值；實際以電視清單為準，清單上沒有的不會開）。 */
const ALIASES: Record<string, string> = {
  youtube: "youtube.leanback.v4",
  yt: "youtube.leanback.v4",
  "油管": "youtube.leanback.v4",
  netflix: "netflix",
  "網飛": "netflix",
  "prime video": "amazon",
  amazon: "amazon",
  "disney+": "com.disney.disneyplus-prod",
  "disney plus": "com.disney.disneyplus-prod",
  disney: "com.disney.disneyplus-prod",
  "迪士尼": "com.disney.disneyplus-prod",
  "apple tv": "com.apple.appletv",
  browser: "com.webos.app.browser",
  "瀏覽器": "com.webos.app.browser",
  "網頁瀏覽器": "com.webos.app.browser",
  "live tv": "com.webos.app.livetv",
  "第四台": "com.webos.app.livetv",
  "電視頻道": "com.webos.app.livetv",
  "設定": "com.palm.app.settings",
  settings: "com.palm.app.settings",
};

export function normalizeName(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

/** 兩字串的相似度（0–1，Dice 係數，用雙字元組）。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const grams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return 0;
  const pool = [...gb];
  let hit = 0;
  for (const g of ga) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (ga.length + gb.length);
}

/** 只在電視回的清單裡找；找不到回 null（不會開清單外的 ID）。 */
export function resolveApp(query: string, points: readonly LaunchPoint[]): AppMatch | null {
  const q = normalizeName(query);
  if (!q) return null;
  for (const p of points) if (p.id === query.trim() || normalizeName(p.id) === q) return { id: p.id, title: p.title, source: "id" };
  for (const p of points) if (normalizeName(p.title) === q) return { id: p.id, title: p.title, source: "title" };
  const alias = ALIASES[q];
  if (alias) {
    const p = points.find((x) => x.id === alias);
    if (p) return { id: p.id, title: p.title, source: "alias" };
  }
  let best: { p: LaunchPoint; score: number } | null = null;
  for (const p of points) {
    const t = normalizeName(p.title);
    if (!t) continue;
    const score = t.includes(q) || q.includes(t) ? 0.9 : similarity(q, t);
    if (!best || score > best.score) best = { p, score };
  }
  return best && best.score >= 0.6 ? { id: best.p.id, title: best.p.title, source: "fuzzy" } : null;
}

export interface InputDevice {
  id: string;
  label: string;
  appId: string | null;
  connected: boolean | null;
}

/** 「HDMI 2」「hdmi2」「HDMI_2」「2」→ HDMI_2；也比對電視上的名稱（例如改名成 Apple TV）。 */
export function resolveInput(query: string, devices: readonly InputDevice[]): InputDevice | null {
  const q = normalizeName(query).replace(/\s+/g, "");
  if (!q) return null;
  const digits = /^(?:hdmi)?(\d)$/.exec(q)?.[1];
  for (const d of devices) {
    const id = normalizeName(d.id).replace(/\s+/g, "");
    if (id === q || (digits && id === `hdmi${digits}`)) return d;
  }
  for (const d of devices) if (normalizeName(d.label).replace(/\s+/g, "") === q) return d;
  return null;
}

/** 前景 App 是 HDMI 輸入時回輸入 ID（com.webos.app.hdmi2 → HDMI_2）。 */
export function inputOfApp(appId: string | null): string | null {
  const m = /^com\.webos\.app\.hdmi(\d)$/.exec(appId ?? "");
  return m ? `HDMI_${m[1]}` : null;
}

/** Spotify（SP-2 BLOCKED，docs/18 §5）：Spotify 開發者政策 III.3 限制語音控制；在 George 決定前不用語音開 Spotify。 */
export function isSpotifyApp(p: { id: string; title: string }): boolean {
  return /spotify/i.test(p.id) || /spotify/i.test(p.title);
}
