/**
 * Headless dsh default assignment — unit tests.
 *
 * Covers the three behaviours the ticket asks for:
 *   1. defaults set + headless dsh request        → session gets assigned
 *   2. defaults set + interactive dsh request     → form path untouched
 *   3. defaults unset                             → behaviour unchanged
 *
 * Plus the guard rails of the assignment itself (existing binding kept, kernel
 * visibility check, optional task, kernel failures degrade silently).
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, buildConfig } from "../../config.js";
import type { ProxyConfig, SessionInitConfig } from "../../types.js";
import type { MetadataClient } from "../../meta/client.js";
import { SessionStore } from "../store.js";
import {
  isDshHeadlessRequest,
  resolveHeadlessDefaultAssignment,
  ensureHeadlessDefaultAssignment,
} from "../headless-default-assignment.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SessionInitConfig> = {}): ProxyConfig {
  return {
    ...DEFAULT_CONFIG,
    sessionInit: {
      ...DEFAULT_CONFIG.sessionInit,
      enabled: true,
      ...overrides,
    },
  };
}

interface MetadataStub {
  client: MetadataClient;
  listTeams: ReturnType<typeof vi.fn>;
  listAgents: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  getAgent: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
}

function makeMetadata(opts: {
  teams?: Array<{ team_id: string; name: string }>;
  agents?: Array<{ agent_id: string; team_id: string; name: string }>;
  tasks?: Array<{ task_id: string; team_id: string; title: string }>;
} = {}): MetadataStub {
  const teams = opts.teams ?? [{ team_id: "team-1", name: "Team One" }];
  const agents = opts.agents ?? [{ agent_id: "agt-1", team_id: "team-1", name: "Agent One" }];
  const tasks = opts.tasks ?? [];
  const listTeams = vi.fn().mockResolvedValue(teams);
  const listAgents = vi.fn().mockResolvedValue(agents);
  const listTasks = vi.fn().mockResolvedValue(tasks);
  const getAgent = vi.fn().mockImplementation((agentId: string) => {
    const found = agents.find((a) => a.agent_id === agentId);
    return Promise.resolve(found ?? { agent_id: agentId, team_id: "team-1", name: agentId });
  });
  const getTask = vi.fn().mockImplementation((taskId: string) => {
    const found = tasks.find((t) => t.task_id === taskId);
    if (!found) return Promise.reject(new Error(`task not found: ${taskId}`));
    return Promise.resolve(found);
  });
  const client = {
    listTeams,
    listAgents,
    listTasks,
    getAgent,
    getTask,
  } as unknown as MetadataClient;
  return { client, listTeams, listAgents, listTasks, getAgent, getTask };
}

const HEADLESS_DEFAULTS = { teamId: "team-1", agentId: "agt-1" };

// ── Config parsing: the new sessionInit options ──────────────────────────────

describe("sessionInit default identity config", () => {
  function buildFromYaml(body: string): ProxyConfig {
    const dir = mkdtempSync(join(tmpdir(), "dsh-default-config-"));
    const file = join(dir, "config.yaml");
    writeFileSync(file, body, "utf-8");
    try {
      return buildConfig({ configFile: file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("parses defaultTeamId / defaultAgentId / defaultTaskId", () => {
    const config = buildFromYaml([
      "sessionInit:",
      "  enabled: true",
      "  defaultTeamId: team-abc",
      "  defaultAgentId: agt-abc",
      "  defaultTaskId: task-abc",
      "",
    ].join("\n"));
    expect(config.sessionInit.defaultTeamId).toBe("team-abc");
    expect(config.sessionInit.defaultAgentId).toBe("agt-abc");
    expect(config.sessionInit.defaultTaskId).toBe("task-abc");
  });

  it("leaves the defaults disabled when absent or set to an empty string", () => {
    const absent = buildFromYaml("sessionInit:\n  enabled: true\n");
    expect(absent.sessionInit.defaultTeamId).toBeUndefined();
    expect(absent.sessionInit.defaultAgentId).toBeUndefined();

    const empty = buildFromYaml([
      "sessionInit:",
      "  enabled: true",
      "  defaultTeamId: \"\"",
      "  defaultAgentId: \"\"",
      "",
    ].join("\n"));
    expect(empty.sessionInit.defaultTeamId).toBeUndefined();
    expect(empty.sessionInit.defaultAgentId).toBeUndefined();
  });
});

// ── resolveHeadlessDefaultAssignment: when to intervene ──────────────────────

describe("resolveHeadlessDefaultAssignment", () => {
  it("assigns defaults for a headless dsh request", () => {
    const config = makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" });
    const resolved = resolveHeadlessDefaultAssignment({
      config,
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    });
    expect(resolved).toEqual({ teamId: "team-1", agentId: "agt-1" });
  });

  it("keeps the interactive form path untouched for a non-headless dsh request", () => {
    const config = makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" });
    const resolved = resolveHeadlessDefaultAssignment({
      config,
      agentSource: "dsh",
      dshHeadless: false,
      sessionInitEnabled: true,
    });
    expect(resolved).toBeNull();
  });

  it("does nothing when the defaults are not configured", () => {
    const config = makeConfig();
    expect(resolveHeadlessDefaultAssignment({
      config,
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    })).toBeNull();
    // Only one half configured is also "not configured".
    expect(resolveHeadlessDefaultAssignment({
      config: makeConfig({ defaultTeamId: "team-1" }),
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    })).toBeNull();
    expect(resolveHeadlessDefaultAssignment({
      config: makeConfig({ defaultAgentId: "agt-1" }),
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    })).toBeNull();
  });

  it("never touches non-dsh agents", () => {
    const config = makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" });
    for (const agentSource of ["claude-code", "codebuddy", "codex", "opencode", "workbuddy"]) {
      expect(resolveHeadlessDefaultAssignment({
        config,
        agentSource,
        dshHeadless: true,
        sessionInitEnabled: true,
      })).toBeNull();
    }
  });

  it("assigns when sessionInit is disabled for dsh requests", () => {
    const config = makeConfig({ enabled: false, defaultTeamId: "team-1", defaultAgentId: "agt-1" });
    expect(resolveHeadlessDefaultAssignment({
      config,
      agentSource: "dsh",
      dshHeadless: false,
      sessionInitEnabled: false,
    })).toEqual({ teamId: "team-1", agentId: "agt-1" });
  });

  it("treats the virtual defaultTaskId sentinel as 'no task' but binds a real task id", () => {
    const base = { defaultTeamId: "team-1", defaultAgentId: "agt-1" };
    const withSentinel = resolveHeadlessDefaultAssignment({
      config: makeConfig({ ...base }), // defaultTaskId defaults to "default"
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    });
    expect(withSentinel?.taskId).toBeUndefined();

    const withRealTask = resolveHeadlessDefaultAssignment({
      config: makeConfig({ ...base, defaultTaskId: "task-1" }),
      agentSource: "dsh",
      dshHeadless: true,
      sessionInitEnabled: true,
    });
    expect(withRealTask).toEqual({ teamId: "team-1", agentId: "agt-1", taskId: "task-1" });
  });
});

// ── isDshHeadlessRequest: the shared detection predicate ─────────────────────

describe("isDshHeadlessRequest", () => {
  const openaiTools = (names: string[]) => names.map((name) => ({ type: "function", function: { name } }));
  const anthropicTools = (names: string[]) => names.map((name) => ({ name }));

  it("detects dsh requests whose tools lack ask_user_question", () => {
    expect(isDshHeadlessRequest("dsh", { tools: openaiTools(["bash", "edit"]) })).toBe(true);
    expect(isDshHeadlessRequest("dsh", { tools: anthropicTools(["bash", "edit"]) })).toBe(true);
  });

  it("does not treat dsh requests carrying ask_user_question as headless", () => {
    expect(isDshHeadlessRequest("dsh", { tools: openaiTools(["bash", "ask_user_question"]) })).toBe(false);
    expect(isDshHeadlessRequest("dsh", { tools: anthropicTools(["ask_user_question"]) })).toBe(false);
  });

  it("ignores empty / missing tool lists and non-dsh agents", () => {
    expect(isDshHeadlessRequest("dsh", { tools: [] })).toBe(false);
    expect(isDshHeadlessRequest("dsh", {})).toBe(false);
    expect(isDshHeadlessRequest("dsh", null)).toBe(false);
    expect(isDshHeadlessRequest("claude-code", { tools: openaiTools(["bash"]) })).toBe(false);
  });
});

// ── ensureHeadlessDefaultAssignment: the assignment itself ───────────────────

describe("ensureHeadlessDefaultAssignment", () => {
  it("registers a headless session with the configured team + agent", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata();

    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-1",
      userId: "usr-1",
      spaceId: "mem-1",
      agentSource: "dsh",
      config: makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" }),
      metadataClient: metadata.client,
      userKey: "sk-mem-test",
      messages: [],
      store,
      defaults: HEADLESS_DEFAULTS,
    });

    expect(result.assigned).toBe(true);
    expect(result.keptExisting).toBe(false);
    expect(result.sessionInfo).toMatchObject({
      session_id: "session-1",
      team_id: "team-1",
      agent_id: "agt-1",
      user_id: "usr-1",
      space_id: "mem-1",
    });
    // task not configured (virtual sentinel) → no task dimension
    expect(result.sessionInfo?.task_id).toBeUndefined();

    // The persisted state is the same shape a completed form produces, so later
    // turns / injectors / session-trace see the identity.
    const state = store.get("dsh:session-1");
    expect(state?.status).toBe("initialized");
    expect(state?.presetSource).toBe("config_default");
    expect(state?.sessionInfo?.team_id).toBe("team-1");
    expect(state?.sessionInfo?.agent_id).toBe("agt-1");

    // Kernel visibility is checked before binding.
    expect(metadata.listTeams).toHaveBeenCalledWith("usr-1");
    expect(metadata.listAgents).toHaveBeenCalledWith("team-1");
    expect(metadata.getAgent).toHaveBeenCalledWith("agt-1");
  });

  it("keeps an existing assignment instead of overwriting it", async () => {
    const store = new SessionStore();
    await store.set("dsh:session-1", {
      status: "initialized",
      keyId: "session-1",
      startedAt: Date.now(),
      attemptCount: 0,
      sessionInfo: {
        session_id: "session-1",
        team_id: "team-existing",
        agent_id: "agt-existing",
        user_id: "usr-1",
      },
    });
    const metadata = makeMetadata();

    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-1",
      userId: "usr-1",
      agentSource: "dsh",
      config: makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: HEADLESS_DEFAULTS,
    });

    expect(result.keptExisting).toBe(true);
    expect(result.assigned).toBe(false);
    expect(result.sessionInfo?.team_id).toBe("team-existing");
    expect(result.sessionInfo?.agent_id).toBe("agt-existing");
    // Existing binding → no kernel validation / no re-registration.
    expect(metadata.listTeams).not.toHaveBeenCalled();
  });

  it("binds the optional task when it is a real, visible task", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata({
      tasks: [{ task_id: "task-1", team_id: "team-1", title: "Task One" }],
    });

    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-2",
      userId: "usr-1",
      agentSource: "dsh",
      config: makeConfig({
        defaultTeamId: "team-1",
        defaultAgentId: "agt-1",
        defaultTaskId: "task-1",
      }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: { teamId: "team-1", agentId: "agt-1", taskId: "task-1" },
    });

    expect(result.assigned).toBe(true);
    expect(result.sessionInfo?.task_id).toBe("task-1");
    // A real task is not the virtual "default" sentinel → detail is fetched.
    expect(metadata.getTask).toHaveBeenCalledWith("task-1");
  });

  it("degrades to team+agent when the configured task is not visible", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata({ tasks: [] });

    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-3",
      userId: "usr-1",
      agentSource: "dsh",
      config: makeConfig({
        defaultTeamId: "team-1",
        defaultAgentId: "agt-1",
        defaultTaskId: "task-missing",
      }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: { teamId: "team-1", agentId: "agt-1", taskId: "task-missing" },
    });

    expect(result.assigned).toBe(true);
    expect(result.sessionInfo?.team_id).toBe("team-1");
    expect(result.sessionInfo?.task_id).toBeUndefined();
  });

  it("leaves the session unassigned when the configured team/agent is not visible", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata({
      teams: [{ team_id: "team-other", name: "Other" }],
    });

    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-4",
      userId: "usr-1",
      agentSource: "dsh",
      config: makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: HEADLESS_DEFAULTS,
    });

    expect(result).toMatchObject({ sessionInfo: null, assigned: false });
    expect(store.get("dsh:session-4")).toBeUndefined();
  });

  it("never throws when the kernel is unreachable", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata();
    metadata.listTeams.mockRejectedValue(new Error("kernel down"));

    await expect(ensureHeadlessDefaultAssignment({
      sessionKey: "session-5",
      userId: "usr-1",
      agentSource: "dsh",
      config: makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: HEADLESS_DEFAULTS,
    })).resolves.toMatchObject({ sessionInfo: null, assigned: false });

    expect(store.get("dsh:session-5")).toBeUndefined();
  });

  it("skips assignment without a user id", async () => {
    const store = new SessionStore();
    const metadata = makeMetadata();
    const result = await ensureHeadlessDefaultAssignment({
      sessionKey: "session-6",
      userId: null,
      agentSource: "dsh",
      config: makeConfig({ defaultTeamId: "team-1", defaultAgentId: "agt-1" }),
      metadataClient: metadata.client,
      messages: [],
      store,
      defaults: HEADLESS_DEFAULTS,
    });
    expect(result.assigned).toBe(false);
    expect(metadata.listTeams).not.toHaveBeenCalled();
  });
});
