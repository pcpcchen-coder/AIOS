// opencc-js 1.4.2 的子路徑（"./*" → dist/esm-lib/*.js）沒有附型別；這裡只宣告用到的四個。
declare module "opencc-js/from/cn" {
  const dictGroups: readonly (readonly (string | readonly (readonly [string, string])[])[])[];
  export default dictGroups;
}
declare module "opencc-js/to/tw" {
  const dictGroups: readonly (readonly (string | readonly (readonly [string, string])[])[])[];
  export default dictGroups;
}
declare module "opencc-js/dict/STCharacters" {
  const dict: string;
  export default dict;
}
declare module "opencc-js/dict/TSCharacters" {
  const dict: string;
  export default dict;
}
