import type { ItemDeltaUiEventPayload, SessionItem, SessionThread, SessionTurn, SessionTurnError } from "@codex-web/shared-types";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import type { ThreadItem } from "@codex-web/codex-schema/v2/ThreadItem";
import type { Turn } from "@codex-web/codex-schema/v2/Turn";
import type { TurnError } from "@codex-web/codex-schema/v2/TurnError";
import type { TurnPlanUpdatedNotification } from "@codex-web/codex-schema/v2/TurnPlanUpdatedNotification";
import type { FileChangePatchUpdatedNotification } from "@codex-web/codex-schema/v2/FileChangePatchUpdatedNotification";

export function projectThreadItem(item: ThreadItem): SessionItem | null {
  if (item.type === "userMessage") return { type: "userMessage", id: item.id, clientId: item.clientId, content: item.content.map((part) => ({ type: part.type, ...("text" in part ? { text: part.text } : {}), ...("path" in part && part.type !== "skill" ? { path: part.path } : {}), ...("name" in part ? { name: part.name } : {}), ...("url" in part ? { url: part.url } : {}) })) };
  if (item.type === "agentMessage") return { type: "agentMessage", id: item.id, text: item.text, ...(item.phase ? { phase: item.phase } : {}) };
  if (item.type === "reasoning") return { type: "reasoning", id: item.id, summary: item.summary };
  if (item.type === "plan") return { type: "plan", id: item.id, text: item.text };
  if (item.type === "commandExecution") return { type: "commandExecution", id: item.id, command: item.command, cwd: item.cwd, status: item.status, aggregatedOutput: item.aggregatedOutput, exitCode: item.exitCode, durationMs: item.durationMs };
  if (item.type === "fileChange") return { type: "fileChange", id: item.id, changes: item.changes.map((change) => ({ path: change.path, kind: typeof change.kind === "string" ? change.kind : change.kind.type, ...(change.diff ? { diff: change.diff } : {}) })), status: item.status };
  if (item.type === "mcpToolCall") return { type: "mcpToolCall", id: item.id, server: item.server, tool: item.tool, status: item.status, durationMs: item.durationMs, details: detailText({ arguments: item.arguments, result: item.result, error: item.error }) };
  if (item.type === "dynamicToolCall") return { type: "genericToolCall", id: item.id, title: `${item.namespace ? `${item.namespace} / ` : ""}${item.tool}`, status: item.status, details: detailText({ arguments: item.arguments, contentItems: item.contentItems, success: item.success }) };
  if (item.type === "collabAgentToolCall") return { type: "genericToolCall", id: item.id, title: `Agent / ${item.tool}`, status: item.status, details: detailText({ receiverThreadIds: item.receiverThreadIds, prompt: item.prompt, model: item.model, reasoningEffort: item.reasoningEffort }) };
  if (item.type === "subAgentActivity") return { type: "genericToolCall", id: item.id, title: `Agent activity / ${item.kind}`, status: "completed", details: detailText({ agentPath: item.agentPath }) };
  if (item.type === "hookPrompt") return { type: "genericToolCall", id: item.id, title: "Hook prompt", status: "completed", details: detailText(item.fragments) };
  if (item.type === "webSearch") return { type: "genericToolCall", id: item.id, title: "Web Search", status: "completed" };
  if (item.type === "imageView") return { type: "imageView", id: item.id, path: item.path };
  if (item.type === "sleep") return { type: "genericToolCall", id: item.id, title: `等待 ${(item.durationMs / 1_000).toFixed(1)}s`, status: "completed" };
  if (item.type === "imageGeneration") return { type: "imageGeneration", id: item.id, status: item.status, result: item.result, revisedPrompt: item.revisedPrompt ?? null, savedPath: item.savedPath ?? null };
  if (item.type === "enteredReviewMode") return { type: "genericToolCall", id: item.id, title: "进入 Review 模式", status: "completed", details: item.review };
  if (item.type === "exitedReviewMode") return { type: "genericToolCall", id: item.id, title: "退出 Review 模式", status: "completed", details: item.review };
  if (item.type === "contextCompaction") return { type: "genericToolCall", id: item.id, title: "压缩上下文", status: "completed" };
  const fallback = item as unknown as Record<string, unknown>;
  const type = typeof fallback.type === "string" ? fallback.type : "unknown";
  return {
    type: "genericToolCall",
    id: typeof fallback.id === "string" ? fallback.id : `unknown:${type}`,
    title: `Codex action / ${type}`,
    status: typeof fallback.status === "string" ? fallback.status : "completed",
    details: detailText(fallback),
  };
}

function detailText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const text = JSON.stringify(value, null, 2);
    return text === "{}" || text === "[]" ? undefined : text;
  } catch {
    return String(value);
  }
}

export function projectTurn(turn: Turn): SessionTurn {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.error ? { errors: [projectTurnError(turn.error, false)] } : {}),
    items: (turn.items ?? []).flatMap((item) => { const projected = projectThreadItem(item); return projected ? [projected] : []; }),
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    durationMs: turn.durationMs ?? null,
  };
}

export function projectTurnError(error: TurnError, willRetry: boolean): SessionTurnError {
  const info = error.codexErrorInfo;
  const code = typeof info === "string"
    ? info
    : info && typeof info === "object" ? Object.keys(info)[0] ?? null : null;
  const value = info && typeof info === "object" && code ? (info as Record<string, unknown>)[code] : null;
  const httpStatusCode = value && typeof value === "object" && typeof (value as { httpStatusCode?: unknown }).httpStatusCode === "number"
    ? (value as { httpStatusCode: number }).httpStatusCode
    : null;
  return {
    message: error.message,
    code,
    httpStatusCode,
    additionalDetails: error.additionalDetails,
    willRetry,
  };
}

export function projectThread(thread: Thread): SessionThread {
  return {
    id: thread.id,
    preview: thread.preview,
    name: thread.name,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ephemeral: thread.ephemeral,
    forkedFromId: thread.forkedFromId,
    turns: thread.turns.map(projectTurn),
  };
}

export function projectTurnPlan(
  update: TurnPlanUpdatedNotification,
): Extract<SessionItem, { type: "plan" }> {
  const markers = { pending: "[ ]", inProgress: "[~]", completed: "[x]" } as const;
  const lines = update.plan.map((step) => `${markers[step.status]} ${step.step}`);
  return {
    type: "plan",
    id: `turn-plan:${update.turnId}`,
    text: [update.explanation, ...lines].filter((line): line is string => !!line).join("\n"),
  };
}

export function projectFileChangePatch(
  update: FileChangePatchUpdatedNotification,
): Extract<SessionItem, { type: "fileChange" }> {
  return {
    type: "fileChange",
    id: update.itemId,
    status: "inProgress",
    changes: update.changes.map((change) => ({
      path: change.path,
      kind: change.kind.type,
      ...(change.diff ? { diff: change.diff } : {}),
    })),
  };
}

const deltaKinds: Record<string, ItemDeltaUiEventPayload["kind"]> = {
  "item/agentMessage/delta": "agentMessage",
  "item/plan/delta": "plan",
  "item/reasoning/summaryTextDelta": "reasoningSummary",
  "item/commandExecution/outputDelta": "commandOutput",
};

export function projectItemDelta(method: string, params: Record<string, unknown>): ItemDeltaUiEventPayload | null {
  const kind = deltaKinds[method];
  if (!kind || typeof params.itemId !== "string" || typeof params.delta !== "string") return null;
  return { itemId: params.itemId, delta: params.delta, kind };
}
