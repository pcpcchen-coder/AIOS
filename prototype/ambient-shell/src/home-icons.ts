import type { HomeIconKind } from "../shared/home-corner.ts";

// HOME-1：左上角家中狀態的圖示。和 weather-icons.ts 同一種畫法：24×24 線條、線寬 1.6、圓角端點，全部是程式裡的固定字串
// （沒有外部檔案、字型或網址，也不含任何資料）。active＝有設備開著：燈與插座亮起，否則灰色。

const MUTED = "var(--muted, #8ba3bd)";
const AMBER = "var(--amber, #ffb35c)";
const CYAN = "var(--cyan, #5ce1ff)";
const MINT = "var(--mint, #5cf2b0)";
const BULB = "#ffd75c";

const BODY: Record<HomeIconKind, (active: boolean) => string> = {
  thermometer: () =>
    `<g stroke="${AMBER}"><path d="M10 13.6V5a2 2 0 0 1 4 0v8.6a4 4 0 1 1-4 0z" fill="rgba(255,179,92,0.1)"/><path d="M12 9v7.2"/><circle cx="12" cy="17.2" r="1.5" fill="${AMBER}"/></g>`,
  droplet: () => `<path d="M12 3.6c2.9 3.6 5.4 6.7 5.4 9.9a5.4 5.4 0 0 1-10.8 0c0-3.2 2.5-6.3 5.4-9.9z" stroke="${CYAN}" fill="rgba(92,225,255,0.12)"/>`,
  bulb: (on) => {
    const c = on ? BULB : MUTED;
    const rays = on ? `<path d="M12 1.6v1.2M4.6 4.6l.9.9M19.4 4.6l-.9.9M2.6 11h1.2M20.2 11h1.2" stroke="${BULB}" stroke-width="1.2"/>` : "";
    return `<g stroke="${c}">${rays}<path d="M9.2 16.4c0-1.6-2.7-3-2.7-6a5.5 5.5 0 0 1 11 0c0 3-2.7 4.4-2.7 6z" fill="${on ? "rgba(255,215,92,0.2)" : "none"}"/><path d="M9.6 19h4.8M10.6 21.4h2.8"/></g>`;
  },
  plug: (on) => {
    const c = on ? MINT : MUTED;
    return `<g stroke="${c}"><path d="M9 3.4v4M15 3.4v4"/><path d="M6.6 7.4h10.8v3.4a5.4 5.4 0 0 1-10.8 0z" fill="${on ? "rgba(92,242,176,0.16)" : "none"}"/><path d="M12 16.2v4.4"/></g>`;
  },
  home: () => `<g stroke="${MUTED}"><path d="M4 11.2 12 4.4l8 6.8"/><path d="M6.2 9.6V19.6h11.6V9.6"/></g>`,
};

export function homeIconSvg(kind: HomeIconKind, active = false): string {
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${BODY[kind](active)}</svg>`;
}
