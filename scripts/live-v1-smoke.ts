import assert from "node:assert/strict";
import path from "node:path";
import { requireIsolatedCodexHome } from "./isolated-codex-home.js";

const baseUrl = process.env.CODEX_WEB_SMOKE_URL ?? "http://127.0.0.1:7373";
const expectedCodexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_SMOKE_CODEX_HOME, "CODEX_WEB_SMOKE_CODEX_HOME");
const origin = new URL(baseUrl).origin;
const turnTimeoutMs = Number(process.env.CODEX_WEB_SMOKE_TURN_TIMEOUT_MS ?? 600_000);
assert.ok(Number.isFinite(turnTimeoutMs) && turnTimeoutMs > 0, "CODEX_WEB_SMOKE_TURN_TIMEOUT_MS must be a positive number");
let cookie = "";
let csrfToken = "";

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  if (init.body) headers.set("content-type", "application/json");
  if (init.method && !new Set(["GET", "HEAD"]).has(init.method)) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} failed (${response.status}): ${JSON.stringify(body)}`);
  return body as T;
}

function mutation(body: Record<string, unknown> = {}): RequestInit {
  return { method: "POST", body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }) };
}

type Settings = { model: string | null; reasoning: string | null; accessMode: "fullAccess" | "workspaceWrite" | "readOnly" };
type Turn = { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" };
type SessionPayload = { thread: { id: string; turns: Turn[] }; goal: { objective: string } | null; settings: Settings };
type SessionSummary = { threadId: string; origin: string; parentThreadId: string | null; forkTurnId: string | null };

async function readSession(threadId: string): Promise<SessionPayload> { return request(`/api/sessions/${threadId}`); }
async function waitForTurn(threadId: string, turnId: string): Promise<Turn> {
  const deadline = Date.now() + turnTimeoutMs;
  while (Date.now() < deadline) {
    const turn = (await readSession(threadId)).thread.turns.find((candidate) => candidate.id === turnId);
    if (turn && turn.status !== "inProgress") return turn;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for a test Turn to finish");
}

const health = await fetch(`${baseUrl}/api/health`, { headers: { origin } }).then((response) => response.json()) as { codexHome?: string };
assert.equal(path.resolve(health.codexHome ?? ""), expectedCodexHome, "live smoke target must use the explicitly isolated CODEX_HOME");
const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { headers: { origin } });
const bootstrap = await bootstrapResponse.json() as { authReady: boolean; csrfToken: string; projects: Array<{ id: string }>; models: Array<{ model: string; isDefault: boolean; defaultReasoning: string; supportedReasoning: Array<{ effort: string }> }> };
assert.equal(bootstrapResponse.ok, true);
assert.equal(bootstrap.authReady, true, "isolated Codex home must be authenticated");
cookie = bootstrapResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
csrfToken = bootstrap.csrfToken;
assert.ok(cookie && csrfToken);
const project = bootstrap.projects[0]; const model = bootstrap.models.find((candidate) => candidate.isDefault) ?? bootstrap.models[0];
assert.ok(project && model);
const settings: Settings = {
  model: model.model,
  reasoning: model.supportedReasoning.some((option) => option.effort === "low") ? "low" : model.defaultReasoning,
  accessMode: "readOnly",
};

const persistentThreads: string[] = [];
let sideThreadId: string | null = null;
let activeTurn: { threadId: string; turnId: string } | null = null;
try {
  const parent = await request<{ thread: { id: string } }>(`/api/projects/${project.id}/sessions`, mutation(settings));
  persistentThreads.push(parent.thread.id);
  const first = await request<{ turn: Turn }>(`/api/sessions/${parent.thread.id}/turns`, mutation({ ...settings, text: "Reply with exactly FORK_BOUNDARY_ONE. Do not use tools.", clientUserMessageId: crypto.randomUUID() }));
  activeTurn = { threadId: parent.thread.id, turnId: first.turn.id };
  assert.equal((await waitForTurn(parent.thread.id, first.turn.id)).status, "completed");
  activeTurn = null;
  const second = await request<{ turn: Turn }>(`/api/sessions/${parent.thread.id}/turns`, mutation({ ...settings, text: "Reply with exactly FORK_BOUNDARY_TWO. Do not use tools.", clientUserMessageId: crypto.randomUUID() }));
  activeTurn = { threadId: parent.thread.id, turnId: second.turn.id };
  assert.equal((await waitForTurn(parent.thread.id, second.turn.id)).status, "completed");
  activeTurn = null;

  const parentPayload = await readSession(parent.thread.id);
  assert.deepEqual(parentPayload.settings, settings);
  await request(`/api/sessions/${parent.thread.id}/goal`, { method: "PUT", body: JSON.stringify({ objective: "V1 smoke Goal", tokenBudget: 20_000, status: "paused", clientRequestId: crypto.randomUUID() }) });

  const afterFirst = await request<{ thread: { id: string } }>(`/api/sessions/${parent.thread.id}/forks`, mutation({ lastTurnId: first.turn.id, inheritGoal: false, empty: false }));
  persistentThreads.push(afterFirst.thread.id);
  const afterFirstPayload = await readSession(afterFirst.thread.id);
  assert.deepEqual(afterFirstPayload.thread.turns.map((turn) => turn.id), [first.turn.id]);
  assert.equal(afterFirstPayload.goal, null);
  assert.deepEqual(afterFirstPayload.settings, settings);

  const beforeFirst = await request<{ thread: { id: string } }>(`/api/sessions/${parent.thread.id}/forks`, mutation({ lastTurnId: null, inheritGoal: false, empty: true }));
  persistentThreads.push(beforeFirst.thread.id);
  const beforeFirstPayload = await readSession(beforeFirst.thread.id);
  assert.equal(beforeFirstPayload.thread.turns.length, 0);
  assert.equal(beforeFirstPayload.goal, null);
  assert.deepEqual(beforeFirstPayload.settings, settings);

  const inherited = await request<{ thread: { id: string } }>(`/api/sessions/${parent.thread.id}/forks`, mutation({ lastTurnId: second.turn.id, inheritGoal: true, empty: false }));
  persistentThreads.push(inherited.thread.id);
  const inheritedPayload = await readSession(inherited.thread.id);
  assert.deepEqual(inheritedPayload.thread.turns.map((turn) => turn.id), [first.turn.id, second.turn.id]);
  assert.equal(inheritedPayload.goal?.objective, "V1 smoke Goal");
  assert.deepEqual(inheritedPayload.settings, settings);

  const side = await request<{ threadId: string }>(`/api/sessions/${parent.thread.id}/side-chat`, mutation({ anchorTurnId: first.turn.id }));
  sideThreadId = side.threadId;
  const sidePayload = await readSession(side.threadId);
  assert.equal(sidePayload.goal, null);
  assert.deepEqual(sidePayload.settings, settings);
  const summaries = await request<SessionSummary[]>("/api/sessions?sortDirection=desc&search=");
  assert.equal(summaries.some((summary) => summary.threadId === side.threadId), false);
  const beforeFirstSummary = summaries.find((summary) => summary.threadId === beforeFirst.thread.id);
  assert.ok(beforeFirstSummary);
  assert.equal(beforeFirstSummary.origin, "forked");
  assert.equal(beforeFirstSummary.parentThreadId, parent.thread.id);
  assert.equal(beforeFirstSummary.forkTurnId, null);

  console.log(JSON.stringify({
    turnsCompleted: 2,
    afterFirstTurnCount: afterFirstPayload.thread.turns.length,
    beforeFirstTurnCount: beforeFirstPayload.thread.turns.length,
    inheritedTurnCount: inheritedPayload.thread.turns.length,
    defaultForkGoal: afterFirstPayload.goal,
    inheritedGoal: inheritedPayload.goal?.objective,
    sideChatGoal: sidePayload.goal,
    sideChatVisibleInSidebar: false,
    inheritedSettings: inheritedPayload.settings,
  }, null, 2));
} finally {
  if (activeTurn) {
    const pending = activeTurn;
    await request(`/api/sessions/${pending.threadId}/interrupt`, mutation()).catch(() => undefined);
    await waitForTurn(pending.threadId, pending.turnId).catch(() => undefined);
  }
  if (sideThreadId) await request(`/api/side-chats/${sideThreadId}`, { method: "DELETE", body: JSON.stringify({ clientRequestId: crypto.randomUUID() }) }).catch(() => undefined);
  for (const threadId of persistentThreads.reverse()) await request(`/api/sessions/${threadId}/archive`, mutation()).catch(() => undefined);
}
