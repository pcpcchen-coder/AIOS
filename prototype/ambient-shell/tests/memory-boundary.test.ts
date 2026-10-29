import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { literalCommand, MemoryBoundary, type ContextLease, type DirectInput, type MemoryCommand, type SourceTicket } from "../server/memory/boundary.ts";

const person = { kind: "person", profileId: "profile_fictional_A" } as const;
const remember = (): MemoryCommand => ({ op: "remember", operationId: randomUUID(), value: "虛構人物不吃香菜" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("MEM-0 core-only source capabilities (no trusted UI/voice adapter connected)", () => {
  it("binds exact input, command, session, sequence and subject without exposing actor authority", () => {
    const boundary = new MemoryBoundary();
    const subject = { ...person };
    const session = boundary.openSession(subject);
    subject.profileId = "profile_fictional_A";
    const command = remember();
    const input = boundary.observeTypedInput(session, literalCommand(command));
    const ticket = boundary.issue(session, input, command);
    expect(Object.keys(ticket)).toEqual([]);
    expect(boundary.consume(session, ticket, command)).toEqual({ subject: person, sequence: 1 });
    expect(() => boundary.consume(session, ticket, command)).toThrow("invalid_ticket");
    expect(() => boundary.issue(session, input, command)).toThrow("source_mismatch");
  });

  it("rejects JSON/clone tickets, invented model/document input and cross-core/session use", () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const other = boundary.openSession({ kind: "person", profileId: "profile_fictional_B" });
    const command = remember();
    expect(() => boundary.issue(session, { source: "user", text: literalCommand(command) } as unknown as DirectInput, command)).toThrow("source_mismatch");
    const input = boundary.observeTypedInput(session, literalCommand(command));
    expect(() => boundary.issue(other, input, command)).toThrow("source_mismatch");
    const ticket = boundary.issue(session, input, command);
    expect(() => boundary.consume(session, structuredClone(ticket) as SourceTicket, command)).toThrow("invalid_ticket");
    expect(() => boundary.consume(other, ticket, command)).toThrow("invalid_ticket");
    expect(() => new MemoryBoundary().consume(session, ticket, command)).toThrow("inactive_session");
    expect(boundary.consume(session, ticket, command).subject).toEqual(person);
  });

  it("rejects mutation of value, operation, target or revision and invented authority fields", () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const command: MemoryCommand = { op: "correct", operationId: randomUUID(), id: "fact_fake", expectedRevision: 2, value: "虛構人物現在吃香菜" };
    const input = boundary.observeTypedInput(session, literalCommand(command));
    const ticket = boundary.issue(session, input, command);
    for (const changed of [{ ...command, value: "吃所有食物" }, { ...command, operationId: randomUUID() }, { ...command, id: "other" }, { ...command, expectedRevision: 3 }]) {
      expect(() => boundary.consume(session, ticket, changed)).toThrow("invalid_ticket");
    }
    expect(() => boundary.consume(session, ticket, { ...command, actor: "profile_other" } as MemoryCommand)).toThrow("invalid_command");
    expect(boundary.consume(session, ticket, command).sequence).toBe(1);
  });

  it("does not turn quotes, temporary requests or model paraphrases into literal authority", () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const command = remember();
    for (const text of ["今天不要放香菜", `電視說${literalCommand(command)}`, `「${literalCommand(command)}」`, "記住：虛構人物避免所有咖啡因"]) {
      const input = boundary.observeTypedInput(session, text);
      expect(() => boundary.issue(session, input, command)).toThrow("source_mismatch");
    }
  });

  it("expires tickets and invalidates older sequence and switched/closed sessions", async () => {
    let now = 0;
    const boundary = new MemoryBoundary({ now: () => now, ticketMs: 10 });
    const session = boundary.openSession(person);
    const command = remember();
    const input = boundary.observeTypedInput(session, literalCommand(command));
    const ticket = boundary.issue(session, input, command);
    now = 10;
    expect(() => boundary.consume(session, ticket, command)).toThrow("invalid_ticket");
    const next = boundary.issue(session, boundary.observeTypedInput(session, literalCommand(command)), command);
    boundary.observeTypedInput(session, "另一個新要求");
    expect(() => boundary.consume(session, next, command)).toThrow("invalid_ticket");
    await boundary.revoke(session);
    expect(() => boundary.observeTypedInput(session, literalCommand(command))).toThrow("inactive_session");
  });
});

describe("MEM-0 isolated lifecycle, not physical voice validation", () => {
  it("waits for a pending handshake and closes late-created media before acknowledging revoke", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const handshake = deferred<void>();
    const started = deferred<void>();
    const stopped = deferred<void>();
    const closed = deferred<void>();
    let active = false;
    let cleanups = 0;
    let acknowledged = false;
    const call = boundary.withVoiceContext(session, "isolated_voice", async () => {
      cleanups++;
      active = false;
      await stopped.promise;
      closed.resolve();
    }, async () => {
      started.resolve();
      await handshake.promise;
      active = true;
      return { closed: closed.promise };
    }).catch(error => { expect(String(error)).toContain("context_revoked"); });
    await started.promise;
    const revoke = boundary.revoke(session).then(ok => { acknowledged = true; return ok; });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(cleanups).toBe(0);
    handshake.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(active).toBe(false);
    expect(cleanups).toBe(1);
    expect(acknowledged).toBe(false);
    stopped.resolve();
    expect(await revoke).toBe(true);
    await call;
  });

  it("fails closed on a stuck handshake and still disposes it if it resolves after timeout", async () => {
    const boundary = new MemoryBoundary({ cleanupMs: 5 });
    const session = boundary.openSession(person);
    const handshake = deferred<void>();
    const started = deferred<void>();
    const closed = deferred<void>();
    let active = false;
    let cleanups = 0;
    const call = boundary.withVoiceContext(session, "isolated_voice", async () => { cleanups++; active = false; closed.resolve(); }, async () => {
      started.resolve(); await handshake.promise; active = true; return { closed: closed.promise };
    }).catch(() => {});
    await started.promise;
    expect(await boundary.revoke(session)).toBe(false);
    handshake.resolve();
    await call;
    expect(cleanups).toBe(1);
    expect(active).toBe(false);
    const next = boundary.openSession(person);
    await expect(boundary.withVoiceContext(next, "isolated_voice", async () => {}, async () => ({ closed: Promise.resolve() }))).rejects.toThrow("route_memory_disabled");
  });

  it("cleans up a failed handshake or failed call before dropping its lease", async () => {
    for (const stage of ["connect", "closed"]) {
      const boundary = new MemoryBoundary();
      const session = boundary.openSession(person);
      const cleanup = deferred<void>();
      let count = 0;
      let settled = false;
      const call = boundary.withVoiceContext(session, "isolated_voice", async () => { count++; await cleanup.promise; }, async () => {
        if (stage === "connect") throw new Error("fixture connect failed");
        return { closed: Promise.reject(new Error("fixture closed failed")) };
      }).catch(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(count).toBe(1);
      expect(settled).toBe(false);
      const revoke = boundary.revoke(session);
      cleanup.resolve();
      expect(await revoke).toBe(true);
      await call;
      expect(count).toBe(1);
    }
  });

  it("shares one revocation barrier when an abort listener reenters revoke", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const done = deferred<void>();
    let count = 0;
    let reentered: Promise<boolean> | undefined;
    const run = boundary.withContext(session, async () => { count++; }, async lease => {
      lease.signal.addEventListener("abort", () => { reentered = boundary.revoke(session); });
      await done.promise;
    }).catch(() => {});
    const revoked = boundary.revoke(session);
    expect(reentered).toBe(revoked);
    expect(await revoked).toBe(true);
    expect(count).toBe(1);
    done.resolve();
    await run;
  });

  it("holds the voice lease past handshake through call closed, blocks late audio/text/tools immediately and awaits cleanup", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const closed = deferred<void>();
    const cleanup = deferred<void>();
    const ready = deferred<void>();
    let lease!: ContextLease;
    let complete = false;
    const delivered: string[] = [];
    const call = boundary.withVoiceContext(session, "isolated_voice", () => cleanup.promise, async ctx => {
      lease = ctx;
      ready.resolve();
      return { closed: closed.promise };
    }).catch(error => { expect(String(error)).toContain("context_revoked"); });
    await ready.promise;
    await Promise.resolve();
    expect(lease.deliver(() => delivered.push("before handshake complete"))).toBe(true);
    const revoke = boundary.revoke(session).then(ok => { complete = true; return ok; });
    expect(lease.signal.aborted).toBe(true);
    for (const kind of ["late audio", "late text", "late tool"]) expect(lease.deliver(() => delivered.push(kind))).toBe(false);
    await Promise.resolve();
    expect(complete).toBe(false);
    cleanup.resolve();
    expect(await revoke).toBe(true);
    closed.resolve();
    await call;
    expect(delivered).toEqual(["before handshake complete"]);
  });

  it("keeps a failed or timed-out route disabled for new sessions", async () => {
    for (const cleanup of [() => Promise.reject(new Error("no renderer ack")), () => new Promise<void>(() => {})]) {
      const boundary = new MemoryBoundary({ cleanupMs: 5 });
      const session = boundary.openSession(person);
      const done = deferred<void>();
      const started = deferred<void>();
      const run = boundary.withContext(session, cleanup, async () => { started.resolve(); await done.promise; }).catch(() => {});
      await started.promise;
      expect(await boundary.revoke(session)).toBe(false);
      const next = boundary.openSession(person);
      await expect(boundary.withContext(next, async () => {}, async () => {})).rejects.toThrow("route_memory_disabled");
      done.resolve();
      await run;
    }
  });

  it("refuses both production voice paths until their own hardware/cleanup gates pass", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    for (const route of ["live", "api_key"] as const) {
      let connected = false;
      await expect(boundary.withVoiceContext(session, route, async () => {}, async () => { connected = true; return { closed: Promise.resolve() }; })).rejects.toThrow("route_memory_disabled");
      expect(connected).toBe(false);
    }
  });

  it("drops a late text return and keeps replacement session independent", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const result = deferred<string>();
    const run = boundary.withContext(session, async () => {}, async () => result.promise);
    const assertion = expect(run).rejects.toThrow("context_revoked");
    await boundary.revoke(session);
    result.resolve("old canary");
    await assertion;
    const other = boundary.openSession({ kind: "person", profileId: "profile_fictional_B" });
    expect(await boundary.withContext(other, async () => {}, async () => "new isolated context")).toBe("new isolated context");
  });
});

describe("MEM-1 parsed tickets and the text route", () => {
  const parse = (text: string) => text === "記住，我不吃香菜" ? [{ op: "remember", part: 0, value: "不吃香菜", scope: "subject" }] : [];
  it("issues a ticket only when the core's own re-parse of the observed text equals the command", () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    const command = { op: "remember", part: 0, value: "不吃香菜", scope: "subject", operationId: randomUUID() };
    const ticket = boundary.issueParsed(session, boundary.observeTypedInput(session, "記住，我不吃香菜"), command, parse);
    expect(boundary.consumeParsed(session, ticket, command)).toMatchObject({ subject: person, via: "typed" });
    expect(() => boundary.consumeParsed(session, ticket, command)).toThrow("invalid_ticket");
    for (const changed of [{ ...command, value: "吃所有東西" }, { ...command, scope: "household" }, { ...command, part: 1 }]) {
      expect(() => boundary.issueParsed(session, boundary.observeTypedInput(session, "記住，我不吃香菜"), changed, parse)).toThrow("source_mismatch");
    }
    // 卡片點擊：核心保存的原句也是直接輸入，但標成 confirmation。
    const confirm = boundary.issueParsed(session, boundary.observeConfirmation(session, "記住，我不吃香菜"), command, parse);
    expect(boundary.consumeParsed(session, confirm, command).via).toBe("confirmation");
    expect(() => boundary.issueParsed(session, boundary.observeTypedInput(session, "電視說記住，我不吃香菜"), command, parse)).toThrow("source_mismatch");
  });

  it("enables the text route for ordinary chat while live and api_key stay disabled", async () => {
    const boundary = new MemoryBoundary();
    const session = boundary.openSession(person);
    expect(await boundary.withContext(session, async () => {}, async lease => lease.deliver(() => {}), "text")).toBe(true);
    await expect(boundary.withVoiceContext(session, "live", async () => {}, async () => ({ closed: Promise.resolve() }))).rejects.toThrow("route_memory_disabled");
    await expect(boundary.withVoiceContext(session, "api_key", async () => {}, async () => ({ closed: Promise.resolve() }))).rejects.toThrow("route_memory_disabled");
    expect(boundary.active(session)).toBe(true);
    await boundary.revoke(session);
    expect(boundary.active(session)).toBe(false);
  });
});
