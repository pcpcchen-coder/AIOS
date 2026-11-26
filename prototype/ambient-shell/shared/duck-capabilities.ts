import type { CapabilityName, DuckAction } from "./duck-link.ts";

/**
 * 每個指令需要鴨子的哪些能力（duck-link capabilities 的鍵）。
 * DuckAdapter 用它在送出前檢查「鴨子自己回報 unsupported 的能力」；mock 鴨子用同一張表決定要不要拒絕。
 * 真正的判斷權在鴨子（ack rejected: unsupported）；這張表只是避免送出一定會被拒絕的指令。
 * track 依 target 決定，見 capabilitiesFor()。
 */
const ACTION_CAPABILITIES: Partial<Record<DuckAction, readonly CapabilityName[]>> = {
  walk: ["walk"],
  look: ["head"],
  gesture: ["head"],
  antennas: ["antennas"],
  express: ["eyes"],
  sound: ["speaker"],
  where: ["navigation"],
  places: ["navigation"],
  go_to: ["navigation", "walk"],
  find_person: ["navigation", "walk", "camera"],
  return_home: ["navigation", "walk", "dock"],
  follow_me: ["walk", "camera"],
};

export function capabilitiesFor(action: DuckAction, params?: Record<string, unknown>): readonly CapabilityName[] {
  if (action === "track") {
    if (params?.target === "face") return ["head", "tracking_face"];
    if (params?.target === "sound") return ["head", "tracking_sound"];
    return [];
  }
  return ACTION_CAPABILITIES[action] ?? [];
}
