import { clockIcon, type WeatherIconKind } from "../shared/clock.ts";

// CLK-1：右上角時鐘的天氣圖示。手繪的 24×24 線條圖示（線寬 1.6、圓角端點），全部是程式裡的固定字串：
// 沒有外部檔案、字型或網址，也不含任何資料（只依 WMO 代碼與白天／夜晚選一個）。
// 顏色：太陽 --amber、月亮 #c9d6ff、雲 #b8c7d9、雨 --cyan、雪 --text、閃電 #ffd75c、霧 --muted。

const STROKE = 1.6;
const SUN = "var(--amber, #ffb35c)";
const MOON = "#c9d6ff";
const CLOUD = "#b8c7d9";
const RAIN = "var(--cyan, #5ce1ff)";
const SNOW = "var(--text, #e6f4ff)";
const BOLT = "#ffd75c";
const FOG = "var(--muted, #8ba3bd)";

/** 雲的外形（約占 x 3.4–21.5、y 7.2–19）：左小弧、上大弧、右中弧，底部平直。 */
const CLOUD_PATH = "M7.5 19h9.5a4.25 4.25 0 0 0 .55-8.46A5.75 5.75 0 0 0 6.6 12.1 3.5 3.5 0 0 0 7.5 19z";
/** 月亮（新月，凹口朝右上）。 */
const MOON_PATH = "M20.2 13.6A8.4 8.4 0 1 1 10.4 3.8a6.6 6.6 0 0 0 9.8 9.8z";

interface Place {
  x: number;
  y: number;
  s: number;
}
const n = (v: number) => String(Math.round(v * 1000) / 1000);
/** 縮放後的群組：線寬除以比例，讓每個圖示的線條粗細一致。 */
const group = (p: Place, body: string, extra = "") => `<g transform="translate(${n(p.x)} ${n(p.y)}) scale(${n(p.s)})" stroke-width="${n(STROKE / p.s)}"${extra}>${body}</g>`;

function cloud(p: Place, opts: { fill?: string; opacity?: number } = {}): string {
  return group(p, `<path d="${CLOUD_PATH}" stroke="${CLOUD}" fill="${opts.fill ?? "rgba(184,199,217,0.1)"}"/>`, opts.opacity !== undefined ? ` opacity="${opts.opacity}"` : "");
}

/** 把雲的位置（含一圈間隙）從遮罩挖掉：雲後面的太陽、月亮或另一朵雲不會透出來。 */
function cloudCut(p: Place, gap = 1.3): string {
  return `<g transform="translate(${n(p.x)} ${n(p.y)}) scale(${n(p.s)})"><path d="${CLOUD_PATH}" fill="#000" stroke="#000" stroke-width="${n((STROKE + 2 * gap) / p.s)}" stroke-linejoin="round"/></g>`;
}

function masked(id: string, cuts: string, body: string): string {
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/>${cuts}</mask></defs><g mask="url(#${id})">${body}</g>`;
}

function sun(cx: number, cy: number, r: number, rayIn: number, rayOut: number): string {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return `M${n(cx + c * rayIn)} ${n(cy + s * rayIn)}L${n(cx + c * rayOut)} ${n(cy + s * rayOut)}`;
  }).join("");
  return `<g stroke="${SUN}"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="rgba(255,179,92,0.16)"/><path d="${rays}"/></g>`;
}

/** 月亮：MOON_PATH 以 (12,12) 為中心縮放後移到 (cx,cy)。 */
function moon(cx: number, cy: number, s: number): string {
  return group({ x: cx - 12 * s, y: cy - 12 * s, s }, `<path d="${MOON_PATH}" stroke="${MOON}" fill="rgba(201,214,255,0.14)"/>`);
}

/** 四角小星（線寬細一點，避免在小尺寸糊成一點）。 */
function star(cx: number, cy: number, r: number): string {
  return `<path d="M${n(cx)} ${n(cy - r)}V${n(cy + r)}M${n(cx - r)} ${n(cy)}H${n(cx + r)}" stroke="${MOON}" stroke-width="1.2"/>`;
}

/** 斜的雨線（由右上往左下）。 */
const drops = (xs: readonly number[], y1: number, y2: number, color = RAIN) =>
  `<path d="${xs.map((x) => `M${n(x)} ${n(y1)}L${n(x - (y2 - y1) * 0.36)} ${n(y2)}`).join("")}" stroke="${color}"/>`;

/** 六角雪花（較細的線，在 28–46px 時仍看得出形狀）。 */
function flake(cx: number, cy: number, r: number): string {
  const arms = [0, 60, 120].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const dx = Math.sin(a) * r;
    const dy = Math.cos(a) * r;
    return `M${n(cx - dx)} ${n(cy - dy)}L${n(cx + dx)} ${n(cy + dy)}`;
  });
  return `<path d="${arms.join("")}" stroke="${SNOW}" stroke-width="1.05"/>`;
}

/** 下雨、下雪類：雲往上移，下方留給降水。 */
const HIGH_CLOUD: Place = { x: 0, y: -3.2, s: 1 };

function body(kind: WeatherIconKind, night: boolean): string {
  const id = `wi-${kind}${night ? "-n" : ""}`;
  switch (kind) {
    case "clear":
      return night ? `${moon(11.4, 12.6, 1)}${star(18.2, 5.4, 1.5)}${star(20.6, 9.8, 0.9)}` : sun(12, 12, 4.4, 7.3, 9.7);
    case "mostly_clear": {
      const c: Place = { x: 10.9, y: 10.3, s: 0.56 };
      const back = night ? `${moon(10.2, 10.4, 0.82)}${star(19, 4.6, 1.3)}` : sun(10, 10, 4, 6.5, 8.6);
      return masked(id, cloudCut(c), back) + cloud(c);
    }
    case "partly_cloudy": {
      const c: Place = { x: 2.8, y: 4.2, s: 0.82 };
      const back = night ? moon(8.6, 8.4, 0.62) : sun(8.6, 8.4, 3.3, 5.3, 7);
      return masked(id, cloudCut(c), back) + cloud(c);
    }
    case "overcast": {
      const backCloud: Place = { x: 6.8, y: -2.6, s: 0.7 };
      const front: Place = { x: -1.3, y: 2.2, s: 1 };
      return masked(id, cloudCut(front), cloud(backCloud, { opacity: 0.6 })) + cloud(front, { fill: "rgba(184,199,217,0.16)" });
    }
    case "fog":
      return `${cloud(HIGH_CLOUD)}<path d="M4.5 18.6H19.5M7.5 21.6H16.5" stroke="${FOG}"/>`;
    case "drizzle":
      return `${cloud(HIGH_CLOUD)}${drops([9, 13, 17], 18.7, 19.9)}${drops([11, 15], 21.4, 22.6)}`;
    case "rain":
      return `${cloud(HIGH_CLOUD)}${drops([9, 13, 17], 18.4, 21.8)}`;
    case "heavy_rain":
      return `${cloud(HIGH_CLOUD)}${drops([7.6, 11, 14.4, 17.8], 18.2, 22.6)}`;
    case "showers": {
      const c: Place = { x: 2.6, y: 0.2, s: 0.82 };
      const back = night ? moon(8.8, 7.4, 0.5) : sun(8.6, 7.2, 2.9, 4.6, 6.1);
      return masked(id, cloudCut(c), back) + cloud(c) + drops([10.6, 15], 18.2, 21.6);
    }
    case "sleet":
      return `${cloud(HIGH_CLOUD)}${drops([9.2, 16.8], 18.4, 21.6)}<circle cx="12.6" cy="20.2" r="0.95" fill="${SNOW}" stroke="none"/>`;
    case "snow":
      return `${cloud(HIGH_CLOUD)}${flake(8, 19.2, 1.6)}${flake(12.4, 21.6, 1.6)}${flake(16.8, 19.2, 1.6)}`;
    case "thunder":
      return `${cloud(HIGH_CLOUD)}<path d="M13.4 15.2 10.3 19.6h3l-1.7 3.8 4.2-5.4h-3l1.6-2.8z" fill="${BOLT}" stroke="${BOLT}" stroke-width="1.1"/>${drops([8.2, 17.6], 18.2, 20.6)}`;
  }
}

/** 一個圖示的 SVG 字串（固定內容；aria-hidden，文字說明在旁邊的天氣文字）。 */
export function weatherIconSvg(kind: WeatherIconKind, night = false): string {
  return `<svg class="weather-icon" viewBox="0 0 24 24" fill="none" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-icon="${kind}${night ? "-night" : ""}">${body(kind, night)}</svg>`;
}

/** WMO 代碼 → SVG 字串；不認得的代碼回 null（只畫溫度）。 */
export function weatherIcon(code: number | null, isDay: boolean): string | null {
  const icon = clockIcon(code, isDay);
  return icon ? weatherIconSvg(icon.kind, icon.night) : null;
}
