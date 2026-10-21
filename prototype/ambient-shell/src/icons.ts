// 統一的圖示。確認圖示（「用說的確認」）：琥珀色對話框＋打勾，只用在需要使用者說「確認執行」的地方，
// 與設計稿 docs/design/distance-ui-18in/ConfirmIcon.dc.html 相同。

const SVG_NS = "http://www.w3.org/2000/svg";

/** 對話框外形（viewBox 0 0 64 64）：圓角框、左下角說話尾巴。 */
export const CONFIRM_BUBBLE_PATH =
  "M14 6H50Q58 6 58 14V38Q58 46 50 46H29L17 57.5V46H14Q6 46 6 38V14Q6 6 14 6Z";
/** 打勾。 */
export const CONFIRM_CHECK_PATH = "M19.5 26.5L28.5 35.5L45 18.5";

export const CONFIRM_AMBER = "#FFB547";
export const CONFIRM_INK = "#070B16";

/** 確認圖示；size 為 CSS 像素。裝飾用（aria-hidden），旁邊一定有「請確認」文字。 */
export function confirmIcon(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "confirm-icon");
  const bubble = document.createElementNS(SVG_NS, "path");
  bubble.setAttribute("d", CONFIRM_BUBBLE_PATH);
  bubble.setAttribute("fill", CONFIRM_AMBER);
  const check = document.createElementNS(SVG_NS, "path");
  check.setAttribute("d", CONFIRM_CHECK_PATH);
  check.setAttribute("fill", "none");
  check.setAttribute("stroke", CONFIRM_INK);
  check.setAttribute("stroke-width", "7");
  check.setAttribute("stroke-linecap", "round");
  check.setAttribute("stroke-linejoin", "round");
  svg.append(bubble, check);
  return svg;
}
