// duck-link v0 的訊息型別（TypeScript 端的對照）。
// DUCK-1：唯一的契約是 shared/duck-link.v0.schema.json（正本在 Nous Duck repo（pcpcchen-coder/Open_Duck_Mini） 的 nous_duck/protocol/schemas/）；這裡的型別只是方便寫程式，
// 收到與送出的訊息一律先過 schema 驗證（shared/validator.ts），不靠這些型別保證格式。

export const PROTOCOL_VERSION = "0.1";

export const DUCK_ACTIONS = [
  "status", "stop", "resume",
  "walk", "look", "track", "gesture",
  "express", "antennas", "sound", "presence",
  "where", "places", "mission_status",
  "go_to", "find_person", "return_home", "follow_me", "wait_here", "cancel_mission",
] as const;
export type DuckAction = (typeof DUCK_ACTIONS)[number];

export const PRESENCE_STATES = ["idle", "wake", "listening", "thinking", "speaking", "working", "error", "sleeping"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const ACK_REASONS = [
  "unsupported", "invalid", "expired", "out_of_range",
  "estop_latched", "fallen", "not_standing", "paused",
  "controller_active", "link_degraded", "busy_mission", "no_mission",
  "unknown_name", "privacy", "hardware_fault", "low_battery", "overheat", "not_localized", "internal",
] as const;
export type AckReason = (typeof ACK_REASONS)[number];

export const CAPABILITY_NAMES = ["walk", "head", "antennas", "eyes", "speaker", "microphone", "camera", "tracking_face", "tracking_sound", "navigation", "dock", "imu", "feet", "battery"] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];
export type CapabilityStatus = "available" | "degraded" | "unsupported" | "mock";
export type Capabilities = Partial<Record<CapabilityName, { status: CapabilityStatus; reason?: string }>>;

interface Base {
  protocol_version: typeof PROTOCOL_VERSION;
  sent_at_ms: number;
}

export interface HelloMessage extends Base {
  type: "hello";
  role: "duck" | "nous";
  software: string;
  duck_id?: string;
  mock?: boolean;
  capabilities?: Capabilities;
  gestures?: string[];
  expressions?: string[];
  sounds?: string[];
}

export interface HeartbeatMessage extends Base {
  type: "heartbeat";
  seq: number;
  echo_of?: number;
}

export interface CommandMessage extends Base {
  type: "command";
  request_id: string;
  action: DuckAction;
  ttl_ms: number;
  params?: Record<string, unknown>;
}

export interface AckMessage extends Base {
  type: "ack";
  request_id: string;
  status: "accepted" | "rejected";
  reason?: AckReason;
  detail?: string;
  applied?: Record<string, unknown>;
  clamped?: boolean;
  mission_id?: string;
  data?: Record<string, unknown>;
}

export type DuckMode = "booting" | "limp" | "holding" | "standing" | "walking" | "paused" | "fallen" | "estop" | "docked" | "waiting";
export type HeadJoint = "neck_pitch" | "head_pitch" | "head_yaw" | "head_roll";
export const HEAD_JOINTS: readonly HeadJoint[] = ["neck_pitch", "head_pitch", "head_yaw", "head_roll"];

export interface StateMessage extends Base {
  type: "state";
  mock?: boolean;
  mode: DuckMode;
  control_source: "none" | "duck_link" | "controller" | "console" | "mission" | "local";
  capabilities: Capabilities;
  faults: string[];
  presence?: PresenceState;
  expression?: string;
  tracking?: "none" | "face" | "sound";
  head?: Partial<Record<HeadJoint, number>> & { age_ms?: number };
  velocity_cmd?: { vx?: number; vy?: number; yaw_rate?: number; remaining_s?: number };
  battery?: { voltage_v?: number; source?: "servo_bus" | "sensor" | "none"; charging?: boolean | null };
  temperature_c?: { servo_max?: number; cpu?: number };
  tilt_deg?: number | null;
  mission?: { mission_id?: string; kind?: "go_to" | "find_person" | "return_home" | "follow_me"; phase?: string; progress?: number } | null;
  location?: { place?: string | null; localized?: boolean; uncertainty_m?: number | null; on_dock?: boolean | null } | null;
  link?: { lease_ok?: boolean; rtt_ms?: number | null };
  loop?: { hz?: number; overruns?: number };
}

export const DUCK_EVENTS = [
  "fell", "picked_up", "estop", "estop_cleared", "battery_low", "overheat", "motor_error",
  "link_lost", "link_restored", "controller_takeover",
  "gesture_done", "walk_done", "tracking_lost", "tracking_acquired",
  "mission_progress", "mission_done", "mission_failed",
  "wake_word", "docked", "undocked", "charging_started", "charging_stopped",
  "privacy_switch", "capability_changed",
] as const;
export type DuckEventName = (typeof DUCK_EVENTS)[number];

export interface EventMessage extends Base {
  type: "event";
  event: DuckEventName;
  event_id: string;
  request_id?: string;
  mission_id?: string;
  reason?: string;
  data?: Record<string, unknown>;
}

export type DuckLinkMessage = HelloMessage | HeartbeatMessage | CommandMessage | AckMessage | StateMessage | EventMessage;
