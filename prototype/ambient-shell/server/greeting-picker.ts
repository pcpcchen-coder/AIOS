import { daySlot, liveGreetingText, localHour, pickGreeting } from "../shared/sense.ts";

// 看著說話的開場句挑選（George 2026-10-25）：核心從 shared/sense.ts 的固定清單隨機挑一句，依本機時段可以是「早安，George」，
// 避開上一次用過的模板（只記在記憶體）。模型只照念，不自由生成；名字由呼叫端先經 speakableName。
// 一個核心一個：IdentityService（有名字或沒名字的決策）與沒有家人辨識時的 live 保底共用，所以「上一次」是整個核心的上一次。

export interface GreetingPickerOptions {
  /** 測試注入；預設 Math.random。 */
  random?: () => number;
  now?: () => number;
  /** 未指定時用這台電腦的時區（同 server/home-bridge.ts）。 */
  timeZone?: string;
}

export interface PickedGreeting {
  /** 模板編號（log 只記它）。 */
  id: string;
  /** 要念的短句。 */
  sentence: string;
}

export class GreetingPicker {
  private last: string | null = null;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly options: GreetingPickerOptions = {}) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  pick(name: string | null): PickedGreeting {
    const picked = pickGreeting(name, daySlot(localHour(this.now(), this.options.timeZone)), this.last, this.random);
    this.last = picked.id;
    return picked;
  }

  /** live 路徑保底（沒有家人辨識或沒有決策）：挑一句不含名字的，組成送進 sideband 的整段文字。 */
  plainLive(): { text: string; sentence: string; id: string } {
    const picked = this.pick(null);
    return { ...picked, text: liveGreetingText(picked.sentence) };
  }
}
