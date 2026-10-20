// Symbolic content categories, never measurements of model or human neural activity.
export const REGIONS = [
  { id: "language", priority: 6, label: "語言區", color: [104, 236, 164], anchor: [-0.55, 0.05, 0.55], help: "閱讀、撰寫、翻譯、整理", keywords: /翻譯|摘要|總結|整理|文章|報告|信件|寫信|email|郵件|文案|說明|解釋|回覆|簡報|大綱|校對|潤飾|句子|語言|英文|日文|中文|閱讀|對話|聊天|問答|撰寫|寫/giu },
  { id: "math", priority: 5, label: "數理區", color: [255, 200, 92], anchor: [-0.35, 0.6, -0.15], help: "計算、邏輯、資料、比較", keywords: /計算|數學|統計|數據|資料分析|分析|比較|預算|成本|價格|金額|費用|百分比|%|公式|方程|機率|邏輯|推理|程式碼|程式|code|excel|試算表|財務|報表|數字|加總|平均|估算|效率|單位|換算/giu },
  { id: "art", priority: 4, label: "藝術區", color: [255, 110, 210], anchor: [0.55, 0.05, 0.5], help: "設計、創作、美感、故事", keywords: /設計|繪|插畫|顏色|配色|色彩|風格|美術|藝術|詩|創作|故事|小說|劇本|logo|海報|裝潢|穿搭|創意|靈感|排版/giu },
  { id: "auditory", priority: 2, label: "聽覺區", color: [82, 210, 255], anchor: [-0.6, -0.35, -0.1], help: "聲音、音樂、聽覺主題（不代表正在收音）", keywords: /聲音|音訊|收音|麥克風|聽覺|聽力|音樂|歌曲|旋律|節奏|音效|噪音|audio|sound|music|microphone/giu },
  { id: "visual", priority: 1, label: "視覺區", color: [169, 144, 255], anchor: [0.1, 0.05, -0.8], help: "影像、照片、場景主題（沒有相機或影像輸入）", keywords: /影像|圖片|圖像|照片|場景|視覺|攝影|影片|相機|image|photo|picture|scene|camera|vision/giu },
  { id: "planning", priority: 3, label: "規劃區", color: [255, 148, 95], anchor: [0.15, 0.55, 0.65], help: "規劃、拆解、排程、步驟", keywords: /規劃|計畫|計劃|拆解|排程|時程|安排|步驟|策略|planning|schedule|roadmap/giu },
] as const;

export type Domain = typeof REGIONS[number]["id"];
export const DOMAINS: readonly Domain[] = REGIONS.map((r) => r.id);
export function regionMap<T>(make: (domain: Domain) => T): Record<Domain, T> {
  return Object.fromEntries(DOMAINS.map((id) => [id, make(id)])) as Record<Domain, T>;
}
export const DOMAIN_LABEL = Object.fromEntries(REGIONS.map((r) => [r.id, r.label])) as Record<Domain, string>;
export const REGION_COLOR = Object.fromEntries(REGIONS.map((r) => [r.id, r.color])) as Record<Domain, readonly [number, number, number]>;
export function isDomain(value: unknown): value is Domain {
  return typeof value === "string" && DOMAINS.includes(value as Domain);
}

// Specific sensory topics win ties; bare numbers never override an explicit topic.
const CLASSIFICATION_ORDER = [...REGIONS].sort((a, b) => a.priority - b.priority);
export function classifyDomain(text: string): Domain | null {
  let best: Domain | null = null;
  let score = 0;
  for (const region of CLASSIFICATION_ORDER) {
    const matches = text.match(region.keywords)?.length ?? 0;
    if (matches > score) { best = region.id; score = matches; }
  }
  return best ?? (/\d+(?:\.\d+)?\s*[+−×÷*/=-]\s*\d+/u.test(text) ? "math" : null);
}

/** Nearest metadata anchor partitions only the hemispheres into six symbolic patches. */
export function regionOf(node: { x: number; y: number; z: number; group: number }): Domain | null {
  if (node.group > 1) return null;
  let nearest: Domain = REGIONS[0].id;
  let distance = Infinity;
  for (const region of REGIONS) {
    const [x, y, z] = region.anchor;
    const d = (node.x - x) ** 2 + (node.y - y) ** 2 + (node.z - z) ** 2;
    if (d < distance) { distance = d; nearest = region.id; }
  }
  return nearest;
}
