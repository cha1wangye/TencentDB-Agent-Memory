/**
 * headless-default-assignment.ts — opt-in default identity binding for headless
 * dsh (deepseek-harness) sessions.
 *
 * 背景
 * ────
 * dsh 在 headless / 未挂 ask-user preset 时，`body.tools` 里没有
 * `ask_user_question`。proxy 判定这种请求是 headless 后完全跳过 session-init
 * （`_dshHeadless`，见 `agent-adapters/dsh.ts` + 两个 runner），于是：
 *   - 会话从未登记 team/agent/task；
 *   - session trace 上传（`/v3/session/add`）缺 `x-tdai-team-id`，MemoryCore 只能
 *     把每一轮写到 `sessions/online/_unassigned/<user>/<session>/`；
 *   - 该目录下的会话永远不会被归并成 L1/L2 记忆，后续也检索不到。
 *
 * 本模块提供 opt-in 的默认身份绑定：
 *   `sessionInit.defaultTeamId` + `sessionInit.defaultAgentId`（可选
 *   `sessionInit.defaultTaskId`）同时配置后，proxy 在
 *   "dsh headless 请求" 或 "sessionInit.enabled=false 的 dsh 请求" 上按该身份
 *   直接登记会话 —— 走的是和「走完表单」完全相同的 `completeRegistration`
 *   路径（同一个 SessionInitState / L2a 状态 / L2b binding / sessionInfo），
 *   只是不弹表单、不改写请求 prompt。
 *
 * 边界（与 ticket 约定一致）
 * ──────────────────────────
 *   1. 只有 dsh 会命中；其它 agentSource 永远返 null（行为零变化）。
 *   2. 交互式 dsh 请求（带 `ask_user_question` 且 `sessionInit.enabled=true`）
 *      永远返 null —— 原表单流程一字不动。
 *   3. 未配置默认值 → 返 null，调用方保持历史行为（headless 仍然 bypass）。
 *   4. 已有绑定（`status=initialized`，无论是否 bypass）→ 原绑定优先，不覆盖。
 *   5. 任何异常 / 内核不可达 / team|agent 校验失败 → 只打 warn 并返空结果，
 *      绝不向调用方抛错，也不回退弹表单（headless 弹表单客户端会报 unknown tool）。
 */

import type { ProxyConfig, SessionInitConfig } from "../types.js";
import type { AgentEntity, MetadataClient, TaskEntity, TeamEntity } from "../meta/client.js";
import type { SessionInfo, SessionInitState, TeamOption } from "./types.js";
import { getSessionStore, type SessionStore } from "./store.js";
import { completeRegistration } from "./codebuddy/init.js";
import { emitSessionInitTelemetryIfCompleted } from "./init-telemetry.js";

/** Structured log prefix (grep-friendly). */
const TAG = "[session-init:dsh-default]";

/**
 * `sessionInit.defaultTaskId` 的内置默认值。该字面量是「不绑定任何 Task」的
 * 虚拟哨兵（见 config.ts DEFAULT_CONFIG / meta/client.ts 的 DEFAULT_TASK_SENTINEL
 * 注释），不是内核里真实存在的 task。用于默认绑定时同样表示"只绑 team+agent"。
 */
const DEFAULT_TASK_SENTINEL = "default";

/** 解析出的默认绑定三元组（task 可选）。 */
export interface HeadlessDefaultIdentity {
  teamId: string;
  agentId: string;
  taskId?: string;
}

/** `resolveHeadlessDefaultAssignment` 的入参。 */
export interface ResolveHeadlessDefaultAssignmentInput {
  config: ProxyConfig;
  /** 请求路径判出的 agentSource，如 "dsh"。 */
  agentSource: string;
  /** 本请求是否被判定为 dsh headless（tools 非空但无 ask_user_question）。 */
  dshHeadless: boolean;
  /** `config.sessionInit.enabled`（显式传值，便于测试与日志一致）。 */
  sessionInitEnabled: boolean;
}

/**
 * 纯函数判定：本次请求是否应该走 headless 默认绑定，以及要绑定的身份。
 *
 * 返回 null = 不介入（调用方保持历史行为）。
 *
 * 触发条件（同时满足）：
 *   - agentSource === "dsh"
 *   - 会话本来就不会走表单：`dshHeadless` 为 true，或 sessionInit 被整体关闭
 *   - `defaultTeamId` + `defaultAgentId` 均已配置
 */
export function resolveHeadlessDefaultAssignment(
  input: ResolveHeadlessDefaultAssignmentInput,
): HeadlessDefaultIdentity | null {
  if (input.agentSource !== "dsh") return null;
  // 交互式会话（有 ask_user_question + sessionInit 开启）继续走表单，不介入。
  if (!input.dshHeadless && input.sessionInitEnabled) return null;

  const sessionInit = input.config.sessionInit;
  const teamId = sessionInit?.defaultTeamId?.trim();
  const agentId = sessionInit?.defaultAgentId?.trim();
  // 只配一个视为未启用（避免半截配置绑定出 team/agent 不匹配的会话）。
  if (!teamId || !agentId) return null;

  const taskId = resolveDefaultTaskId(sessionInit);
  return { teamId, agentId, ...(taskId ? { taskId } : {}) };
}

/**
 * 默认绑定的 task 维度：`defaultTaskId` 是虚拟哨兵（"default" / 空）时表示
 * "不绑定 task"；其它取值视为候选真实 task_id，登记前还会按内核列表校验。
 */
function resolveDefaultTaskId(sessionInit: SessionInitConfig | undefined): string | undefined {
  const raw = sessionInit?.defaultTaskId?.trim();
  if (!raw || raw === DEFAULT_TASK_SENTINEL) return undefined;
  return raw;
}

/**
 * dsh headless 判定：agentSource=dsh 且 body.tools 非空、但不含
 * `ask_user_question`。
 *
 * tools 为空数组时表示纯对话 / aux 请求（title-gen 等），不属于 headless，
 * 保持既有分类；tools 里就有 ask_user_question 说明客户端挂了 UI 工具，
 * 正常走表单。
 *
 * opencode 不走这里：它支持 `question` 工具、走独立的 header-driven 分支。
 */
export function isDshHeadlessRequest(agentSource: string, body: unknown): boolean {
  if (agentSource !== "dsh") return false;
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return !tools.some((t) => {
    const fn = (t as { function?: { name?: string }; name?: string })?.function;
    const name = fn?.name ?? (t as { name?: string })?.name;
    return name === "ask_user_question";
  });
}

/** `ensureHeadlessDefaultAssignment` 的入参。 */
export interface EnsureHeadlessDefaultAssignmentInput {
  /** 会话 key（`resolveConversationId` 的产物）。 */
  sessionKey: string;
  /** auth/verify 解析出的 user_id；缺失时无法登记，直接返空。 */
  userId: string | null;
  spaceId?: string;
  /** 状态机分派的 agentSource（dsh）。 */
  agentSource: string;
  config: ProxyConfig;
  /** 校验 team/agent/task 与登记后拉详情用的内核客户端。 */
  metadataClient?: MetadataClient | null;
  /** sk-mem-* user_key（随 SessionInfo 持久化，供下游注入器复用）。 */
  userKey?: string;
  /** 当前请求的 messages（只用于 recover 判定，不会被改写）。 */
  messages?: Record<string, unknown>[];
  /** 测试注入点；默认用进程级 `getSessionStore()`。 */
  store?: SessionStore;
  defaults: HeadlessDefaultIdentity;
}

/** `ensureHeadlessDefaultAssignment` 的结果。 */
export interface HeadlessDefaultAssignmentResult {
  /** 可供 runner 使用的会话绑定；null = 本次没有（或无法）绑定。 */
  sessionInfo: SessionInfo | null;
  /** true = 本次请求新登记了绑定。 */
  assigned: boolean;
  /** true = 会话已有绑定并被原样保留（未覆盖）。 */
  keptExisting: boolean;
}

const EMPTY_RESULT: HeadlessDefaultAssignmentResult = {
  sessionInfo: null,
  assigned: false,
  keptExisting: false,
};

/**
 * 确保 headless dsh 会话已绑定默认身份。
 *
 * 已有绑定直接返回（keep）；否则先按内核可见列表校验配置的 team/agent
 * （task 查不到则降级为"不绑定 task"，不阻断绑定），再走
 * `completeRegistration` —— 与表单路径生成同构的 SessionInitState / SessionInfo。
 *
 * 永不抛错：内核异常、校验失败都只打 warn 并返空结果。
 */
export async function ensureHeadlessDefaultAssignment(
  input: EnsureHeadlessDefaultAssignmentInput,
): Promise<HeadlessDefaultAssignmentResult> {
  const sessionInit = input.config.sessionInit;
  if (!sessionInit) return EMPTY_RESULT;
  if (!input.userId) {
    console.warn(`${TAG} session=${input.sessionKey} no user_id → skip default assignment`);
    return EMPTY_RESULT;
  }

  const store = input.store ?? getSessionStore();
  const compositeKey = `${input.agentSource}:${input.sessionKey}`;
  const messages = input.messages ?? [];

  // Step 1: 已有绑定优先（含 bypass 终态 —— 用户/历史明确选择过，不覆盖）。
  //
  // L1 快路径：绑定一经写入就是终态，后续每轮直接复用，不必像 session-init
  // 主链路那样每轮探测 L2a（每轮一次远端 GET）。mem:session-reset 会清掉
  // store 里的 key，届时走下面的 getOrRecover 重新判定。
  const l1 = store.get(compositeKey);
  if (l1?.status === "initialized" && !l1.bypassed && l1.sessionInfo) {
    console.log(
      `${TAG} session=${compositeKey} L1 bound team=${l1.sessionInfo.team_id} ` +
        `agent=${l1.sessionInfo.agent_id} → keep existing assignment`,
    );
    return { sessionInfo: l1.sessionInfo, assigned: false, keptExisting: true };
  }

  let existing: SessionInitState | undefined;
  try {
    existing = await store.getOrRecover(compositeKey, {
      userId: input.userId,
      agentSource: input.agentSource,
      sessionId: input.sessionKey,
      spaceId: input.spaceId,
    }, {
      metadataClient: input.metadataClient ?? undefined,
      messages,
    });
  } catch (err) {
    console.warn(
      `${TAG} session=${compositeKey} recover failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    existing = store.get(compositeKey);
  }
  if (existing?.status === "initialized") {
    if (existing.sessionInfo && !existing.bypassed) {
      console.log(
        `${TAG} session=${compositeKey} already bound team=${existing.sessionInfo.team_id} ` +
          `agent=${existing.sessionInfo.agent_id} → keep existing assignment`,
      );
      return { sessionInfo: existing.sessionInfo ?? null, assigned: false, keptExisting: true };
    }
    console.log(
      `${TAG} session=${compositeKey} already initialized (bypassed=${existing.bypassed === true}) → keep as-is`,
    );
    return { ...EMPTY_RESULT, keptExisting: true };
  }

  if (!input.metadataClient) {
    console.warn(`${TAG} session=${compositeKey} no metadata client → skip default assignment`);
    return EMPTY_RESULT;
  }

  // Step 2: 校验 team / agent 在内核可见列表里（与表单/账户默认同源校验）。
  let teams: TeamEntity[];
  try {
    teams = await input.metadataClient.listTeams(input.userId);
  } catch (err) {
    console.warn(
      `${TAG} session=${compositeKey} team list failed, skip default assignment: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return EMPTY_RESULT;
  }
  const team = teams.find((t) => t.team_id === input.defaults.teamId);
  if (!team) {
    console.warn(
      `${TAG} session=${compositeKey} defaultTeamId=${input.defaults.teamId} not visible to user → skip`,
    );
    return EMPTY_RESULT;
  }

  let agents: AgentEntity[];
  try {
    // 不传 owner：默认 agent 可以是 team 可见的他人 agent（与
    // resolveUserSessionDefault 的口径一致），只要内核返回即可用。
    agents = await input.metadataClient.listAgents(team.team_id);
  } catch (err) {
    console.warn(
      `${TAG} session=${compositeKey} agent list failed for team=${team.team_id}, skip default assignment: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return EMPTY_RESULT;
  }
  const agent = agents.find((a) => a.agent_id === input.defaults.agentId);
  if (!agent) {
    console.warn(
      `${TAG} session=${compositeKey} defaultAgentId=${input.defaults.agentId} not in team=${team.team_id} → skip`,
    );
    return EMPTY_RESULT;
  }

  // Step 3: 可选 task。配置的是真实 task_id 时校验存在性；查不到只降级为
  // "不绑定 task"（与 header preset 的 task 容错语义一致），不阻断绑定。
  let task: TaskEntity | undefined;
  if (input.defaults.taskId) {
    try {
      const tasks = await input.metadataClient.listTasks(team.team_id);
      task = tasks.find((t) => t.task_id === input.defaults.taskId);
    } catch (err) {
      console.warn(
        `${TAG} session=${compositeKey} task list failed for team=${team.team_id}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (!task) {
      console.warn(
        `${TAG} session=${compositeKey} defaultTaskId=${input.defaults.taskId} not found in team=${team.team_id} → bind team+agent only`,
      );
    }
  }

  // Step 4: completeRegistration —— 与表单路径同构的登记 / 状态持久化。
  // 合成一个只含目标 team 的 cachedTeams，让 buildRegistrationData 的
  // findTeamIdForAgent 能解析出 team。
  const cachedTeams: TeamOption[] = [{
    team_id: team.team_id,
    team_name: team.name,
    agents: [{
      agent_id: agent.agent_id,
      agent_name: agent.name,
      description: agent.description ?? undefined,
    }],
    tasks: task ? [{ task_id: task.task_id, task_name: task.title }] : [],
  }];
  const seedState: SessionInitState = {
    status: "uninitialized",
    keyId: input.sessionKey,
    startedAt: Date.now(),
    attemptCount: 0,
    userId: input.userId,
    cachedTeams,
    selectedTeamId: team.team_id,
    presetSource: "config_default",
  };

  // task 是真实内核 task 时，登记侧不能把它当虚拟哨兵跳过详情拉取 / 参与日志：
  // completeRegistration 用 `task_id !== config.defaultTaskId` 判虚拟值，而
  // `defaultTaskId` 正是我们取 task 候选的字段。这里清掉该字段，让登记的
  // 行为与「表单里选中一个真实 task」完全一致。
  const regConfig: SessionInitConfig = task
    ? { ...sessionInit, defaultTaskId: undefined }
    : sessionInit;

  const prevStatus = existing?.status ?? "uninitialized";
  try {
    const result = await completeRegistration(
      { agent_id: agent.agent_id, ...(task ? { task_id: task.task_id } : {}) },
      seedState,
      cachedTeams,
      compositeKey,
      input.sessionKey,
      input.userId,
      regConfig,
      store,
      messages,
      input.metadataClient,
      input.userKey,
      input.spaceId,
    );
    if (result.sessionInfo) {
      console.log(
        `${TAG} session=${compositeKey} assigned team=${result.sessionInfo.team_id} ` +
          `agent=${result.sessionInfo.agent_id} task=${result.sessionInfo.task_id ?? "-"} ` +
          `user=${result.sessionInfo.user_id} (config default)`,
      );
    } else {
      console.warn(`${TAG} session=${compositeKey} registration returned no sessionInfo (bypassed)`);
    }
    return {
      sessionInfo: result.sessionInfo ?? null,
      assigned: !!result.sessionInfo,
      keptExisting: false,
    };
  } catch (err) {
    console.warn(
      `${TAG} session=${compositeKey} registration failed, leaving session unassigned: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return EMPTY_RESULT;
  } finally {
    // 与 handleSessionInit 的装饰器一致：只在非 initialized → initialized 时埋点。
    // 注意这是 headless 的配置默认绑定（preset_source="config_default"），
    // 不代表用户看到了任何表单。
    emitSessionInitTelemetryIfCompleted({
      store,
      compositeKey,
      prevStatus,
      agentSource: input.agentSource,
    });
  }
}
