// WK-00 雲端離線評估：以 sherpa-onnx 2.0.1 的離線 TTS 在記憶體合成正例與「困難負例」。
// **這些是合成語音，不是真人**；結果只能說明引擎與設定的相對差異，不能代替家人實測（docs/17 §13.2 W5）。
// 合成的樣本只留在記憶體，不寫檔。

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { resample } from "./audio.ts";
import { ttsDir } from "./models.ts";

interface GeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}
interface OfflineTts {
  numSpeakers: number;
  sampleRate: number;
  generate(req: { text: string; sid: number; speed: number }): GeneratedAudio;
}
interface TtsModule {
  OfflineTts: new (config: unknown) => OfflineTts;
}

export type TtsVoice = "aishell3" | "melo-zh-en";

export class Synth {
  private readonly engines = new Map<TtsVoice, OfflineTts>();

  private engine(voice: TtsVoice): OfflineTts {
    let tts = this.engines.get(voice);
    if (tts) return tts;
    const dir = ttsDir(voice);
    const fsts = ["phone.fst", "date.fst", "number.fst", "new_heteronym.fst"].filter((f) => readdirSync(dir).includes(f)).map((f) => join(dir, f));
    const mod = createRequire(import.meta.url)("sherpa-onnx-node") as TtsModule;
    tts = new mod.OfflineTts({
      model: {
        vits: { model: join(dir, "model.onnx"), lexicon: join(dir, "lexicon.txt"), tokens: join(dir, "tokens.txt"), ...(voice === "melo-zh-en" ? { dictDir: join(dir, "dict") } : {}) },
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
      ruleFsts: fsts.join(","),
      maxNumSentences: 1,
    });
    this.engines.set(voice, tts);
    return tts;
  }

  speakers(voice: TtsVoice): number {
    return this.engine(voice).numSpeakers;
  }

  /** 合成並轉成 16 kHz；峰值正規化到 0.5，避免不同語者音量差太多。 */
  say(voice: TtsVoice, text: string, sid = 0, speed = 1): Float32Array {
    const out = this.engine(voice).generate({ text, sid, speed });
    const pcm = resample(out.samples, out.sampleRate, 16000);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < pcm.length; i++) pcm[i]! *= 0.5 / peak;
    return pcm;
  }
}

/** 每個候選詞的合成文字。英文的 Nous 不在 TTS 詞典裡，以同音的 noose（N UW1 S）代替。 */
export const TTS_TEXT: Record<string, { zh?: { word: string; sentence: string }; en?: { word: string; sentence: string } }> = {
  HALUO_NUSI: { zh: { word: "哈囉努斯", sentence: "哈囉努斯，今天天氣怎麼樣" } },
  HEI_NUSI: { zh: { word: "嘿努斯", sentence: "嘿努斯，幫我把燈打開" } },
  HEY_NOUS: { en: { word: "Hey noose", sentence: "Hey noose, what is the weather today" } },
};

/** 困難負例：部分音節相同或相近、像電視對白的句子（不含候選詞本身）。 */
export const HARD_NEGATIVES_ZH = [
  "哈囉，大家好，歡迎收看今天的新聞",
  "嘿，你今天有沒有努力",
  "我們一起努力吧",
  "俄羅斯總統今天發表談話",
  "斯里蘭卡的天氣很熱",
  "哈哈哈，真的好好笑",
  "他努力不懈終於成功",
  "哈囉你好，請問路怎麼走",
  "嘿嘿，我知道答案了",
  "努比亞的歷史很久",
  "這是一則新聞報導",
  "諾斯先生今天沒有來",
  "路斯說他明天會到",
  "拉斯維加斯的燈光很亮",
  "你好，努力的人最美",
];
export const HARD_NEGATIVES_EN = ["Here is the news at nine", "Hey, nice news today", "The noose was tied to the tree", "Hey Lucy, how are you", "Good news for everyone", "Hello, this is the evening news"];
