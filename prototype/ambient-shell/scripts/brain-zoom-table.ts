// 電子腦靠近放大的對照表（docs/validation/brain-proximity-zoom-2026-10-23.md；放大置中後見 small-decisions-2026-10-25.md）：數字全部由程式算出，不手寫。
// 執行：npx tsx scripts/brain-zoom-table.ts
import { brainGeometry, ZOOM_FIT_EXTENT } from "../src/brain.ts";
import { brainZoom, distanceScale } from "../src/sense/controller.ts";

const VIEWPORT = { width: 1920, height: 1080 };
const base = brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", 1, 1).r;
const BODY = ZOOM_FIT_EXTENT.body;
/** 腦形框（往上 y、往下 down）的中心：看起來的中心。 */
const visual = (g: { cy: number; r: number }) => g.cy + ((BODY.down - BODY.y) / 2) * g.r;
const atDistance = (d: number, max: number) => brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", brainZoom(d, max), 1);

/** 最大 max 倍時，從遠走近（每 1 cm）第一個符合條件的距離。 */
function firstDistance(max: number, test: (g: { cy: number; r: number }) => boolean): number | null {
  for (let cm = 300; cm >= 50; cm--) if (test(atDistance(cm / 100, max))) return cm / 100;
  return null;
}
const home = brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", 1, 1).cy;
const top = brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", 3, 1);
const startsMoving = firstDistance(3, (g) => g.cy > home + 1e-9);
const reachesLimit = firstDistance(3, (g) => Math.abs(g.r - top.r) < 1e-9);
const DISTANCES = [...new Set([3, 2.5, 2.2, 2, 1.8, 1.55, 1.5, startsMoving, 1.3, 1.2, 1.1, reachesLimit, 0.8, 0.6, 0.5].filter((d): d is number => d !== null))].sort((a, b) => b - a);

console.log(`待機半徑以 ${VIEWPORT.width}×${VIEWPORT.height} 視窗計算；1 倍 = ${base.toFixed(1)} px，原位中心 ${home.toFixed(1)} px。`);
console.log(`最大 3 倍時：${startsMoving} m 起開始往中間移，${reachesLimit} m 以內到上限（${(top.r / base).toFixed(2)} 倍，看起來的中心 ${visual(top).toFixed(1)} px）。`);
console.log("");
console.log("| 距離 | 字級比例（不變） | 倍率（最大 2） | 實際半徑（最大 2） | 倍率（最大 3） | 實際半徑（最大 3） | 中心／看起來的中心（最大 3） |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const d of DISTANCES) {
  const cells = [2, 3].flatMap((max) => {
    const zoom = brainZoom(d, max);
    const r = atDistance(d, max).r;
    const clamped = r < base * zoom - 1e-6 ? "，受視窗限制" : "";
    return [`${zoom}`, `${r.toFixed(1)} px（${(r / base).toFixed(2)}×${clamped}）`];
  });
  const g = atDistance(d, 3);
  console.log(`| ${d} m | ${distanceScale(d)} | ${cells.join(" | ")} | ${g.cy.toFixed(1)}／${visual(g).toFixed(1)} px |`);
}
console.log(`| 沒有距離／鏡頭關閉／離開 | 1 | ${brainZoom(null, 2)} | ${base.toFixed(1)} px | ${brainZoom(null, 3)} | ${base.toFixed(1)} px | ${home.toFixed(1)} px |`);

console.log("");
console.log("各視窗的放大上限（待機；要求 3 倍時實際能到的倍率）：");
console.log("");
console.log("| 視窗 | 1 倍半徑 | 沒有進度環 | 看起來的中心／視窗中間 | 有真實進度環 |");
console.log("| --- | --- | --- | --- | --- |");
for (const [w, h] of [[1920, 1080], [1512, 982], [1440, 900], [2560, 1440], [1366, 768], [1280, 900], [390, 844], [844, 390]]) {
  const one = brainGeometry(w, h, "center", 1, 1).r;
  const g = brainGeometry(w, h, "center", 3, 1);
  const ring = brainGeometry(w, h, "center", 3, 1, true);
  console.log(`| ${w}×${h} | ${one.toFixed(1)} px | ${(g.r / one).toFixed(2)}× | ${visual(g).toFixed(1)}／${(h / 2).toFixed(1)} px | ${(ring.r / one).toFixed(2)}× |`);
}
