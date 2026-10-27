declare const sessionBrand: unique symbol;
declare const inputBrand: unique symbol;
declare const ticketBrand: unique symbol;
export type MemorySession = { readonly [sessionBrand]: true };
export type DirectInput = { readonly [inputBrand]: true };
export type SourceTicket = { readonly [ticketBrand]: true };
export type Subject = { kind: "household" } | { kind: "person"; profileId: string };
export type MemoryCommand =
  | { op: "remember"; operationId: string; value: string }
  | { op: "correct"; operationId: string; id: string; expectedRevision: number; value: string }
  | { op: "forget"; operationId: string; id: string; expectedRevision: number };
export type ContextRoute = "isolated_text" | "isolated_voice" | "live" | "api_key";
export interface ContextLease {
  readonly signal: AbortSignal;
  deliver(output: () => void): boolean;
}
type SessionState = {
  phase: "selected" | "suspended" | "closed";
  subject: Subject;
  epoch: number;
  sequence: number;
  leases: Set<Lease>;
  cleanupFailed?: boolean;
  revocation?: Promise<boolean>;
};
type InputState = { session: MemorySession; epoch: number; sequence: number; text: string; expires: number };
type TicketState = InputState & { command: string; used: boolean };
type Lease = { route: ContextRoute; abort: AbortController; cleanup: () => Promise<void>; active: boolean; cleaned?: Promise<boolean> };

function canonical(command: MemoryCommand): string {
  if (!command || typeof command !== "object") throw new Error("invalid_command");
  const keys = command.op === "remember" ? ["op", "operationId", "value"]
    : command.op === "correct" ? ["op", "operationId", "id", "expectedRevision", "value"]
      : command.op === "forget" ? ["op", "operationId", "id", "expectedRevision"] : [];
  if (keys.length === 0 || Object.keys(command).length !== keys.length || Object.keys(command).some(key => !keys.includes(key))) throw new Error("invalid_command");
  if (typeof command.operationId !== "string" || !/^[0-9a-f-]{36}$/.test(command.operationId)) throw new Error("invalid_operation");
  if (command.op !== "remember" && (typeof command.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(command.id) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) throw new Error("invalid_target");
  if (command.op !== "forget" && (typeof command.value !== "string" || command.value.trim() !== command.value || command.value.length === 0 || [...command.value].length > 512)) throw new Error("invalid_value");
  return JSON.stringify(keys.map(key => [key, command[key as keyof MemoryCommand]]));
}

// MEM-0 uses a literal isolation grammar. Natural-language parsing and trusted UI confirmation belong to MEM-1.
export function literalCommand(command: MemoryCommand): string {
  canonical(command);
  switch (command.op) {
    case "remember": return `記住：${command.value}`;
    case "correct": return `更正：${command.id}@${command.expectedRevision}：${command.value}`;
    case "forget": return `忘記：${command.id}@${command.expectedRevision}`;
  }
}

export class MemoryBoundary {
  private readonly sessions = new WeakMap<MemorySession, SessionState>();
  private readonly inputs = new WeakMap<DirectInput, InputState>();
  private readonly tickets = new WeakMap<SourceTicket, TicketState>();
  private readonly disabledRoutes = new Set<ContextRoute>(["live", "api_key"]);

  constructor(private readonly options: { now?: () => number; ticketMs?: number; cleanupMs?: number } = {}) {}

  private now(): number { return (this.options.now ?? (() => performance.now()))(); }

  // Only a future trusted main-window adapter may call these core methods. They are not HTTP/model tools.
  openSession(subject: Subject): MemorySession {
    if (!subject || (subject.kind !== "household" && subject.kind !== "person") ||
      Object.keys(subject).length !== (subject.kind === "person" ? 2 : 1) ||
      (subject.kind === "person" && (typeof subject.profileId !== "string" || !/^profile_[a-zA-Z0-9_-]{1,80}$/.test(subject.profileId)))) throw new Error("invalid_subject");
    const session = Object.freeze({}) as MemorySession;
    this.sessions.set(session, { phase: "selected", subject: structuredClone(subject), epoch: 0, sequence: 0, leases: new Set() });
    return session;
  }

  private selected(session: MemorySession): SessionState {
    const state = this.sessions.get(session);
    if (!state || state.phase !== "selected") throw new Error("inactive_session");
    return state;
  }

  observeTypedInput(session: MemorySession, text: string): DirectInput {
    const state = this.selected(session);
    if (typeof text !== "string" || text.length === 0 || text.length > 2048) throw new Error("invalid_input");
    const input = Object.freeze({}) as DirectInput;
    this.inputs.set(input, { session, epoch: state.epoch, sequence: ++state.sequence, text, expires: this.now() + (this.options.ticketMs ?? 60_000) });
    return input;
  }

  issue(session: MemorySession, input: DirectInput, command: MemoryCommand): SourceTicket {
    const state = this.selected(session);
    const observed = this.inputs.get(input);
    const encoded = canonical(command);
    if (!observed || observed.session !== session || observed.epoch !== state.epoch || observed.sequence !== state.sequence || observed.expires <= this.now() || observed.text !== literalCommand(command)) throw new Error("source_mismatch");
    this.inputs.delete(input);
    const ticket = Object.freeze({}) as SourceTicket;
    this.tickets.set(ticket, { ...observed, command: encoded, used: false });
    return ticket;
  }

  consume(session: MemorySession, ticket: SourceTicket, command: MemoryCommand): { subject: Subject; sequence: number } {
    const state = this.selected(session);
    const source = this.tickets.get(ticket);
    if (!source || source.used || source.session !== session || source.epoch !== state.epoch || source.sequence !== state.sequence || source.expires <= this.now() || source.command !== canonical(command)) throw new Error("invalid_ticket");
    source.used = true;
    return { subject: structuredClone(state.subject), sequence: source.sequence };
  }

  withContext<T>(session: MemorySession, cleanup: () => Promise<void>, run: (lease: ContextLease) => Promise<T>): Promise<T> {
    return this.holdContext(session, "isolated_text", cleanup, run);
  }

  withVoiceContext(session: MemorySession, route: Exclude<ContextRoute, "isolated_text">, cleanup: () => Promise<void>, connect: (lease: ContextLease) => Promise<{ closed: Promise<void> }>): Promise<void> {
    let connecting: Promise<{ closed: Promise<void> }> | undefined;
    return this.holdContext(session, route, async () => {
      try { await connecting; } catch { /* Partial connection resources still require cleanup. */ }
      await cleanup();
    }, async lease => {
      connecting = Promise.resolve().then(() => {
        if (lease.signal.aborted) throw new Error("context_revoked");
        return connect(lease);
      });
      const call = await connecting;
      if (!call || !call.closed || typeof call.closed.then !== "function") throw new Error("invalid_call_lifetime");
      const closed = Promise.resolve(call.closed);
      void closed.catch(() => {});
      if (lease.signal.aborted) throw new Error("context_revoked");
      await closed;
    });
  }

  private async holdContext<T>(session: MemorySession, route: ContextRoute, cleanup: () => Promise<void>, run: (lease: ContextLease) => Promise<T>): Promise<T> {
    const state = this.selected(session);
    if (!["isolated_text", "isolated_voice"].includes(route) || this.disabledRoutes.has(route)) throw new Error("route_memory_disabled");
    const epoch = state.epoch;
    const lease: Lease = { route, cleanup, abort: new AbortController(), active: true };
    state.leases.add(lease);
    try {
      const result = await run({ signal: lease.abort.signal, deliver: output => {
        if (!lease.active || lease.abort.signal.aborted || state.phase !== "selected" || state.epoch !== epoch) return false;
        output();
        return true;
      } });
      if (lease.abort.signal.aborted || state.phase !== "selected" || state.epoch !== epoch) throw new Error("context_revoked");
      return result;
    } catch (error) {
      lease.active = false;
      lease.abort.abort();
      if (!await this.cleanLease(lease)) state.cleanupFailed = true;
      throw error;
    } finally {
      lease.active = false;
      state.leases.delete(lease);
    }
  }

  private cleanLease(lease: Lease): Promise<boolean> {
    if (lease.cleaned) return lease.cleaned;
    lease.cleaned = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(lease.cleanup),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cleanup_timeout")), this.options.cleanupMs ?? 1000); }),
        ]);
        return true;
      } catch {
        this.disabledRoutes.add(lease.route);
        return false;
      } finally { clearTimeout(timer); }
    })();
    return lease.cleaned;
  }

  revoke(session: MemorySession): Promise<boolean> {
    const state = this.sessions.get(session);
    if (!state) return Promise.resolve(false);
    if (state.revocation) return state.revocation;
    if (state.phase === "closed") return Promise.resolve(true);
    let finish!: (ok: boolean) => void;
    state.revocation = new Promise<boolean>(resolve => { finish = resolve; });
    state.phase = "suspended";
    state.epoch++;
    const leases = [...state.leases];
    for (const lease of leases) {
      lease.active = false;
      lease.abort.abort();
    }
    void Promise.all(leases.map(lease => this.cleanLease(lease))).then(results => {
      state.phase = "closed";
      finish(results.every(Boolean) && !state.cleanupFailed);
    });
    return state.revocation;
  }
}
