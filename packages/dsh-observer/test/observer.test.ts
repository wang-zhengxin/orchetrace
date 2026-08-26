import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalEvent } from "../../protocol-ts/src/index.ts";
import type {
  HarnessAgent,
  HarnessContextLike,
  HarnessSession,
  HarnessSessionEvent,
} from "../src/harness-types.ts";
import { DshObserver } from "../src/observer.ts";

class FakeContext {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly agents: { list: () => HarnessAgent[] };
  readonly sessions: { list: () => HarnessSession[] };
  onList?: () => void;
  readonly sessionList: HarnessSession[];
  readonly agentList: HarnessAgent[];

  constructor(sessionList: HarnessSession[], agentList: HarnessAgent[] = []) {
    this.sessionList = sessionList;
    this.agentList = agentList;
    this.sessions = {
      list: () => {
        this.onList?.();
        return this.sessionList;
      },
    };
    this.agents = { list: () => this.agentList };
  }

  on(name: string, listener: (...args: never[]) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener as (...args: unknown[]) => void);
    this.listeners.set(name, listeners);
    return () => listeners.delete(listener as (...args: unknown[]) => void);
  }

  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args);
  }
}

function session(input: {
  id: string;
  parent?: string;
  seedLength?: number;
  events: HarnessSessionEvent[];
}): HarnessSession {
  return {
    id: input.id,
    header: {
      version: 0,
      id: input.id,
      createdAt: 1_777_000_000_000,
      cwd: "/workspace/demo",
      parentSession: input.parent,
      seedLength: input.seedLength,
      ...(input.parent ? { origin: "subagent" as const, delegationDepth: 1 } : {}),
    },
    events: input.events,
    firstLiveSeq: input.events.length,
    seq: input.events.length,
  };
}

test("bootstrap/live overlap is deduplicated at the session high-water mark", async () => {
  const liveEvent: HarnessSessionEvent = {
    seq: 0,
    time: 1_777_000_000_100,
    type: "turn/start",
    data: { turn: 1 },
  };
  const root = session({ id: "root", events: [liveEvent] });
  const ctx = new FakeContext([root]);
  ctx.onList = () => ctx.emit("session/event", root, liveEvent);
  const events: CanonicalEvent[] = [];
  const observer = new DshObserver(ctx as unknown as HarnessContextLike, {
    write: (event) => events.push(event),
  }, { sourceId: "test" });

  await observer.start();
  await observer.stop();

  assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
  assert.equal(events.filter((event) => event.type === "session.discovered").length, 1);
});

test("child seed is not re-attributed and descriptor upgrades child identity", async () => {
  const child = session({
    id: "child",
    parent: "root",
    seedLength: 1,
    events: [
      { seq: 0, time: 1, type: "assistant/message", data: { message: { content: "parent" } } },
      {
        seq: 1,
        time: 2,
        type: "subagent/descriptor",
        data: {
          version: 2,
          mode: "continuable",
          provider: "builtin",
          label: "contract researcher",
          agentProvider: "deepseek",
          agentModel: "deepseek-v4",
        },
      },
    ],
  });
  const events: CanonicalEvent[] = [];
  const observer = new DshObserver(
    new FakeContext([child]) as unknown as HarnessContextLike,
    { write: (event) => events.push(event) },
    { sourceId: "test" },
  );

  await observer.start();
  await observer.stop();

  assert.equal(events.some((event) => event.type === "assistant.message"), false);
  assert.equal(events.find((event) => event.type === "agent.spawned")?.data.label, "contract researcher");
  assert.equal(events.find((event) => event.type === "session.metadata_changed")?.data.model, "deepseek-v4");
});

test("an unknown required event blocks only its session and reports evidence", async () => {
  const root = session({
    id: "root",
    events: [{ seq: 0, time: 1, type: "future/semantic-change", data: {} }],
  });
  const diagnostics: string[] = [];
  const observer = new DshObserver(
    new FakeContext([root]) as unknown as HarnessContextLike,
    { write: () => undefined },
    { sourceId: "test", onDiagnostic: (item) => diagnostics.push(item.message) },
  );

  await observer.start();
  await observer.stop();

  assert.match(diagnostics[0] ?? "", /cannot map required event/);
});

test("cold persisted descendants are adopted without loading them into the live registry", async () => {
  const root = session({ id: "root", events: [] });
  const child = session({
    id: "cold-child",
    parent: "root",
    events: [
      {
        seq: 0,
        time: 2,
        type: "subagent/descriptor",
        data: { version: 2, mode: "one-shot", provider: "builtin", label: "cold reviewer" },
      },
    ],
  });
  const ctx = new FakeContext([root]) as FakeContext & HarnessContextLike;
  Object.defineProperty(ctx, "sessionPersistence", {
    value: {
      list: async () => [child.header],
      readFrom: async () => ({ meta: child.header, events: [...child.events] }),
    },
  });
  const events: CanonicalEvent[] = [];
  const observer = new DshObserver(ctx, { write: (event) => events.push(event) }, { sourceId: "test" });

  await observer.start();
  await observer.stop();

  const spawned = events.find((event) => event.session_id === "cold-child" && event.type === "agent.spawned");
  assert.equal(spawned?.data.label, "cold reviewer");
});
