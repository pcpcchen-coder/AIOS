// 看著說話時同步辨識已登記的家人（docs/14 ID-02 §2、§3；ADR-0001 §2.1）。頁面端只負責「什麼時候取樣」與「頁面看得到的條件」：
// - 只在既有 look_to_talk 的面向停留期間（SenseSnapshot.dwelling）開始取樣，條件是在場＋近距離（AMBIENT_NEAR_M）＋面向＋鏡頭 ok，
//   而且頁面端的啟用條件成立（看著說話、打招呼、稱名三個設定都開、macOS App、settings.identity 可用、家人辨識畫面沒開）
//   並且核心說有可比對的家人（ambient_status）。看著說話的計時完全不看這裡（SenseController 照原時間 startTalk）。
// - 互動開始後（startRealtime 建立互動 ID、綁定當下的追蹤世代）繼續取樣，直到問候送出或取消；之後停止。不做背景常駐辨識。
// - 追蹤世代（track）：離開在場、轉開、離開近距離、鏡頭不是 ok、設定關閉、辨識出錯都加一。舊世代的證據與互動都不能沿用
//   （docs/14 §3：換人重置、不把新出現的人套入已開始的舊互動）。PresenceTracker 要 60 秒才判離開，不能拿它維持身分。
// - 每一格經 IPC 送核心（ambient_probe）；回應不含任何結果。比對、證據、名稱與組句都在核心，頁面拿不到 person_id 與分數。
// - 送出問候前（GreetingOnce.take → decide）把核心發出的互動 ID（即時語音開始時核心回的 interaction）、綁定的追蹤世代與
//   頁面端條件（eligible）交給核心；核心再核對那個 ID 屬於真的連上的工作階段。核心回傳 API key 路徑要用的 instructions
//   （只含已組好的短句），live 路徑只回互動 ID（短句留在核心）。頁面這裡的互動鍵只用來綁定追蹤世代，不會被核心接受。
// 取樣器沿用 IdentityClient：≤4 Hz、同時最多一個推論；推論在 worker，不阻塞 80 ms 的感測迴圈。

import { AMBIENT_NEAR_M, type FaceModelVersion, type GreetingRoute, type IdentityRequest, type IdentityResponse } from "../../shared/identity.ts";
import { plainGreetingInstructions } from "../../shared/sense.ts";
import { getLocale, type Locale } from "../i18n.ts";
import type { SenseSnapshot } from "./controller.ts";
import type { ClientFrame, ClientState } from "./identity-client.ts";

/** 互動開始後最多再取樣多久（語音連線很慢時不無限取樣；之後問候照常，只是不帶名字）。 */
export const INTERACTION_SAMPLE_MAX_MS = 20_000;
/** API key 路徑的 instructions 最長多少字（核心組的固定格式約 150 字；超過就當成異常，改用「我在」）。 */
const INSTRUCTIONS_MAX = 1_000;

/** IdentityClient 用到的部分（測試用假的）。 */
export interface AmbientSampler {
  readonly generation: number;
  start(): void;
  /** 停止取樣、保留模型（下次不用冷啟動）。 */
  pause(): void;
  /** 停止取樣並結束 worker（模型一起釋放）。 */
  stop(): void;
}

export interface AmbientBridge {
  identity(request: IdentityRequest): Promise<IdentityResponse>;
}

export interface AmbientDeps {
  /** macOS App 的 IPC；瀏覽器版為 null（不辨識，只說「我在」）。 */
  bridge: AmbientBridge | null;
  /** 頁面端的啟用條件（設定、settings.identity、家人辨識畫面沒開）；每次都重新讀。 */
  enabled(): boolean;
  createSampler(onFrame: (frame: ClientFrame) => void, onState: (state: ClientState) => void): AmbientSampler;
  model: FaceModelVersion;
  now(): number;
}

/** 核心對同步辨識的回答（ambient_status）；unknown＝還沒問過。重新確認期間保留上一次的答案，不中斷取樣。 */
type Readiness = "unknown" | "ready" | "blocked";

interface Interaction {
  locale: Locale;
  id: string;
  /** startRealtime 當下的追蹤世代。 */
  track: number;
  startedAt: number;
}

/** 距離在近距離範圍內；未知（null）不算。 */
export function isNear(distance: number | null): boolean {
  return distance !== null && distance >= AMBIENT_NEAR_M.min && distance <= AMBIENT_NEAR_M.max;
}

export class AmbientIdentity {
  private trackGen = 1;
  /** 上一次狀態是否「在場＋近距離＋面向＋鏡頭 ok」。 */
  private ok = false;
  private dwelling = false;
  private readiness: Readiness = "unknown";
  /** 每次查 ambient_status 加一；晚到的回應若不是最新一次就丟掉。 */
  private statusSeq = 0;
  private checking = false;
  private sampler: AmbientSampler | null = null;
  private sampling = false;
  /** 正在取樣的那一段是在哪個追蹤世代開始的（取樣中途換世代會先暫停）。 */
  private samplingTrack: number | null = null;
  /** 目前的追蹤世代看到多張臉：不稱名。 */
  private multi = false;
  /** 辨識出錯（模型載入或推論失敗）：到下一次 refresh 前不再取樣。 */
  private errored = false;
  private interaction: Interaction | null = null;

  constructor(private readonly deps: AmbientDeps) {}

  /** 目前的追蹤世代（測試與互動綁定用）。 */
  get track(): number {
    return this.trackGen;
  }

  get isSampling(): boolean {
    return this.sampling;
  }

  /** SenseController.onSense：每次事件與 tick 之後。 */
  update(snapshot: SenseSnapshot): void {
    const ok = snapshot.sensor_ok && snapshot.present && snapshot.facing && isNear(snapshot.distance_m);
    // 轉開、離開、遠離、鏡頭停止：舊世代作廢（換人重置），之後看到的人從新的世代開始。
    if (this.ok && !ok) this.bumpTrack();
    this.ok = ok;
    this.dwelling = snapshot.dwelling;
    this.sync();
  }

  /**
   * 設定或 settings.identity 改變、家人辨識畫面開關：清掉錯誤狀態並重新向核心確認。確認期間保留上一次的答案，
   * 所以開始對話時的 settings.updated 不會打斷正在進行的取樣。
   */
  refresh(): void {
    this.errored = false;
    if (this.deps.bridge && this.deps.enabled()) this.checkStatus();
    this.sync();
  }

  /**
   * startRealtime("look_to_talk")：綁定這次互動與當下的追蹤世代。回傳互動 ID（GreetingOnce 用它向核心要決策）。
   * 互動開始時不在近距離面向也照常建立，決策時頁面端條件不成立，就只說「我在」。
   */
  beginInteraction(id: string, locale: Locale = getLocale()): void {
    this.interaction = { id, locale, track: this.trackGen, startedAt: this.deps.now() };
    this.sync();
  }

  /** 問候送出或取消、對話結束：這次互動不再需要辨識。 */
  endInteraction(id?: string): void {
    if (id !== undefined && this.interaction?.id !== id) return;
    this.interaction = null;
    this.sync();
  }

  /**
   * GreetingOnce 送出前的決策（語音就緒＋600 ms 緩衝之後）。頁面端條件：同一互動與追蹤世代、仍在近距離面向、
   * 這個世代沒有多張臉、辨識沒有出錯、仍在啟用中。其餘條件（證據新鮮、person 仍存在、gallery 版本、稱名設定）在核心。
   * api_key 回 instructions；live 回互動 ID。IPC 失敗時照常問候、不帶名字。
   */
  async decide(id: string, route: GreetingRoute, coreInteraction: string | null): Promise<string> {
    // live 的 plain：核心沒有這個 ID 的決策，就送「我在」。
    const it = this.interaction;
    const locale = it?.locale ?? getLocale();
    const plain = route === "api_key" ? plainGreetingInstructions(locale) : (coreInteraction ?? id);
    const eligible =
      !!it && it.id === id && it.track === this.trackGen && this.ok && !this.multi && !this.errored && this.readiness === "ready" && this.deps.enabled();
    if (!this.deps.bridge || !coreInteraction) {
      this.endInteraction(id);
      return plain;
    }
    try {
      const res = await this.deps.bridge.identity({ op: "greeting", interaction: coreInteraction, track: it?.id === id ? it.track : this.trackGen, eligible, route });
      if (!res.ok || res.op !== "greeting") return plain;
      if (route === "live") return coreInteraction;
      return typeof res.text === "string" && res.text.length > 0 && res.text.length <= INSTRUCTIONS_MAX ? res.text : plain;
    } catch {
      return plain;
    } finally {
      this.endInteraction(id);
    }
  }

  private interactionPending(): boolean {
    const it = this.interaction;
    return !!it && it.track === this.trackGen && this.deps.now() - it.startedAt <= INTERACTION_SAMPLE_MAX_MS;
  }

  private bumpTrack(): void {
    this.trackGen++;
    this.multi = false;
    this.pauseSampling();
  }

  private pauseSampling(): void {
    if (this.sampling) this.sampler?.pause();
    this.sampling = false;
    this.samplingTrack = null;
  }

  /** 啟用條件不成立：結束 worker（模型一起釋放），世代加一。 */
  private shutdown(): void {
    if (this.sampler) {
      this.sampler.stop();
      this.sampler = null;
      this.bumpTrack();
    }
    this.sampling = false;
    this.samplingTrack = null;
  }

  private checkStatus(): void {
    const bridge = this.deps.bridge;
    if (!bridge) return;
    const seq = ++this.statusSeq;
    this.checking = true;
    void bridge
      .identity({ op: "ambient_status" })
      .then((res): Readiness => (res.ok && res.op === "ambient_status" && res.ready ? "ready" : "blocked"))
      .catch((): Readiness => "blocked")
      .then((next) => {
        if (seq !== this.statusSeq) return;
        this.checking = false;
        this.readiness = next;
        this.sync();
      });
  }

  private sync(): void {
    if (!this.deps.bridge || !this.deps.enabled()) {
      this.shutdown();
      this.readiness = "unknown";
      this.statusSeq++;
      this.checking = false;
      return;
    }
    if (this.readiness === "unknown" && !this.checking) this.checkStatus();
    const want = this.readiness === "ready" && !this.errored && this.ok && (this.dwelling || this.interactionPending());
    if (!want) {
      this.pauseSampling();
      return;
    }
    if (this.sampling && this.samplingTrack === this.trackGen) return;
    this.pauseSampling();
    this.sampler ??= this.deps.createSampler(
      (frame) => this.onFrame(frame),
      (state) => this.onState(state),
    );
    this.sampler.start();
    this.sampling = true;
    this.samplingTrack = this.trackGen;
  }

  private onFrame(frame: ClientFrame): void {
    const sampler = this.sampler;
    const track = this.samplingTrack;
    if (!sampler || !this.sampling || track === null || frame.gen !== sampler.generation) {
      frame.feature?.fill(0);
      return;
    }
    if (frame.face_count > 1 || frame.quality === "multi_face") this.multi = true;
    const feature = frame.feature ? Array.from(frame.feature) : undefined;
    frame.feature?.fill(0);
    void this.deps.bridge
      ?.identity({ op: "ambient_probe", track, face_count: frame.face_count, quality: frame.quality, model: this.deps.model, ...(feature ? { feature } : {}) })
      .then((res) => {
        // 核心說不能做（設定剛關、鏡頭關、管理畫面打開、gallery 解不開…）：停止取樣，等下一次 refresh。
        if (!res.ok && res.code === "unavailable" && this.samplingTrack === track) {
          this.readiness = "blocked";
          this.sync();
        }
      })
      .catch(() => undefined)
      .finally(() => feature?.fill(0));
  }

  private onState(state: ClientState): void {
    if (state.kind !== "error") return;
    // 模型或推論錯誤：不沿用這個世代的任何證據，結束 worker，到下一次 refresh 前不再取樣（docs/14 I5）。
    this.errored = true;
    this.shutdown();
    this.bumpTrack();
  }
}
