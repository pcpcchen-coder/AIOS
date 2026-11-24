import { catalogMarkdown, checkCatalog, localizeCatalog, staticCatalog } from "../server/integrations/catalog.ts";

// CAP-1（docs/24 §3）：開發用的能力總表。只讀程式碼裡的定義，不需要任何設定，也不連任何服務。
//   npm run catalog -- --json [--lang en]      靜態總表（JSON）
//   npm run catalog -- --markdown [--lang en]  給人看的表（不列 hidden 工具）
//   npm run catalog -- --check                 漏寫 summary／例句、缺英文、domain 不合法、ID 撞名時失敗
// 即時總表（加上這次設定的註冊狀態）要有執行中的登記表，見 server/integrations/catalog.ts 的 liveCatalog()。

const args = process.argv.slice(2);
const locale = args.includes("--lang") && args[args.indexOf("--lang") + 1] === "en" ? "en" : "zh-TW";
const entries = staticCatalog();

if (args.includes("--check")) {
  const problems = checkCatalog(entries);
  for (const p of problems) console.error(`✗ ${p}`);
  const visible = entries.filter((e) => !e.hidden).length;
  console.log(problems.length ? `能力總表檢查失敗：${problems.length} 個問題` : `能力總表檢查通過：${entries.length} 個工具（${visible} 個列在給人看的表、${entries.length - visible} 個 hidden）`);
  process.exit(problems.length ? 1 : 0);
} else if (args.includes("--json")) {
  console.log(JSON.stringify(localizeCatalog(entries, locale), null, 2));
} else if (args.includes("--markdown")) {
  process.stdout.write(catalogMarkdown(localizeCatalog(entries, locale), locale));
} else {
  console.error("用法：npm run catalog -- --json | --check | --markdown [--lang en]");
  process.exit(2);
}
