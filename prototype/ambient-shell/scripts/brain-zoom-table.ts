// 電子腦靠近放大的對照表（docs/validation/brain-proximity-zoom-2026-10-23.md）：數字全部由程式算出，不手寫。
// 執行：npx tsx scripts/brain-zoom-table.ts
import { brainGeometry } from "../src/brain.ts";
import { brainZoom, distanceScale } from "../src/sense/controller.ts";

const DISTANCES = [3, 2.5, 2.2, 2, 1.8, 1.55, 1.5, 1.2, 1, 0.8, 0.6, 0.5];
const VIEWPORT = { width: 1920, height: 1080 };
const base = brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", 1, 1).r;

console.log(`待機半徑以 ${VIEWPORT.width}×${VIEWPORT.height} 視窗計算；1 倍 = ${base.toFixed(1)} px。`);
console.log("");
console.log("| 距離 | 字級比例（不變） | 倍率（最大 2） | 實際半徑（最大 2） | 倍率（最大 3） | 實際半徑（最大 3） |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const d of DISTANCES) {
  const cells = [2, 3].flatMap((max) => {
    const zoom = brainZoom(d, max);
    const r = brainGeometry(VIEWPORT.width, VIEWPORT.height, "center", zoom, 1).r;
    const clamped = r < base * zoom - 1e-6 ? "，受視窗限制" : "";
    return [`${zoom}`, `${r.toFixed(1)} px（${(r / base).toFixed(2)}×${clamped}）`];
  });
  console.log(`| ${d} m | ${distanceScale(d)} | ${cells.join(" | ")} |`);
}
console.log(`| 沒有距離／鏡頭關閉／離開 | 1 | ${brainZoom(null, 2)} | ${base.toFixed(1)} px | ${brainZoom(null, 3)} | ${base.toFixed(1)} px |`);

console.log("");
console.log("各視窗的放大上限（待機；要求 3 倍時實際能到的倍率）：");
console.log("");
console.log("| 視窗 | 1 倍半徑 | 沒有進度環 | 有真實進度環 |");
console.log("| --- | --- | --- | --- |");
for (const [w, h] of [[1920, 1080], [1366, 768], [1280, 900], [390, 844], [844, 390]]) {
  const one = brainGeometry(w, h, "center", 1, 1).r;
  const cap = (ring: boolean) => (brainGeometry(w, h, "center", 3, 1, ring).r / one).toFixed(2);
  console.log(`| ${w}×${h} | ${one.toFixed(1)} px | ${cap(false)}× | ${cap(true)}× |`);
}
