import { writeFileSync } from "node:fs";
import path from "node:path";
import { CodexAdapter } from "@codex-web/codex-adapter";
import { requireIsolatedCodexHome } from "./isolated-codex-home.js";

const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");

type Notification = { method: string; params?: Record<string, unknown> };
const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "protocol-harness" });
const fixture: Array<{ method: string; itemType?: string; status?: string }> = [];
adapter.supervisor.on("notification", (notification: Notification) => {
  const item = notification.params?.item as { type?: string; status?: string } | undefined;
  const turn = notification.params?.turn as { status?: string } | undefined;
  fixture.push({ method: notification.method, ...(item?.type ? { itemType: item.type } : {}), ...(item?.status || turn?.status ? { status: item?.status ?? turn?.status } : {}) });
});
adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));

function waitForNotification(predicate: (notification: Notification) => boolean, timeoutMs: number): Promise<Notification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { adapter.supervisor.off("notification", onNotification); reject(new Error("Timed out waiting for App Server notification")); }, timeoutMs);
    const onNotification = (notification: Notification) => {
      if (!predicate(notification)) return;
      clearTimeout(timer); adapter.supervisor.off("notification", onNotification); resolve(notification);
    };
    adapter.supervisor.on("notification", onNotification);
  });
}

const created: string[] = [];
await adapter.start();
try {
  const account = await adapter.readAccount();
  if (!account.account) throw new Error("The isolated CODEX_HOME is not authenticated");
  const models = await adapter.listModels();
  const selected = models.find((model) => model.model === process.env.CODEX_WEB_HARNESS_MODEL) ?? models.find((model) => model.isDefault) ?? models[0];
  if (!selected) throw new Error("model/list returned no usable models");
  const reasoning = selected.supportedReasoning.some((option) => option.effort === "low") ? "low" : selected.defaultReasoning;
  const settings = { model: selected.model, reasoning, accessMode: "readOnly" as const };

  await adapter.listSessions({ limit: 5 });
  const parent = await adapter.startSession(process.cwd(), settings);
  created.push(parent.thread.id);

  const commandStarted = waitForNotification((notification) => notification.method === "item/started"
    && (notification.params?.item as { type?: string } | undefined)?.type === "commandExecution", 90_000);
  const interruptedCompletion = waitForNotification((notification) => notification.method === "turn/completed"
    && notification.params?.threadId === parent.thread.id, 120_000);
  const interruptTurn = await adapter.startTurn(parent.thread.id, process.cwd(), "Use the shell tool to run: for i in 1 2 3 4 5 6 7 8; do echo HARNESS_STEP_$i; sleep 1; done. Do not modify files.", settings, crypto.randomUUID());
  await commandStarted;
  await adapter.steerTurn(parent.thread.id, interruptTurn.turn.id, "After the command, reply with HARNESS_STEER_RECEIVED.", crypto.randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 400));
  await adapter.interruptTurn(parent.thread.id, interruptTurn.turn.id);
  const interrupted = await interruptedCompletion;
  if (!new Set(["interrupted", "completed"]).has(String((interrupted.params?.turn as { status?: string } | undefined)?.status))) throw new Error("turn/interrupt did not produce a terminal notification");
  await adapter.readSession(parent.thread.id);
  const resumed = await adapter.resumeSession(parent.thread.id);
  if (resumed.settings.model !== settings.model || resumed.settings.reasoning !== settings.reasoning || resumed.settings.accessMode !== settings.accessMode) throw new Error("thread/resume did not preserve Session settings");

  const completedNotification = waitForNotification((notification) => notification.method === "turn/completed"
    && notification.params?.threadId === parent.thread.id, 120_000);
  const completedTurn = await adapter.startTurn(parent.thread.id, process.cwd(), "Reply with exactly CODEX_WEB_HARNESS_OK. Do not call tools.", settings, crypto.randomUUID());
  const completed = await completedNotification;
  if ((completed.params?.turn as { status?: string } | undefined)?.status !== "completed") throw new Error("The completion Turn did not finish successfully");

  const goal = await adapter.setGoal({ threadId: parent.thread.id, objective: "Protocol harness goal", tokenBudget: 10_000, status: "active" });
  if ((await adapter.getGoal(parent.thread.id))?.objective !== goal.objective) throw new Error("thread/goal/get did not return the stored Goal");
  const fork = await adapter.forkSession(parent.thread.id, completedTurn.turn.id, settings, false, process.cwd());
  created.push(fork.thread.id);
  const forkSnapshot = await adapter.readSession(fork.thread.id);
  if (forkSnapshot.turns.at(-1)?.id !== completedTurn.turn.id) throw new Error("thread/fork did not stop at the selected completed Turn");
  await adapter.clearGoal(parent.thread.id);
  if (await adapter.getGoal(parent.thread.id)) throw new Error("thread/goal/clear did not clear the Goal");

  if (process.env.CODEX_WEB_WRITE_FIXTURE === "1") {
    const output = path.resolve("tests/protocol-fixtures/real-harness.events.json");
    writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
  }
  console.log(JSON.stringify({
    authenticated: true,
    modelCount: models.length,
    selectedModel: selected.model,
    reasoning,
    interruptedTurnStatus: (interrupted.params?.turn as { status?: string } | undefined)?.status,
    completedTurnStatus: (completed.params?.turn as { status?: string } | undefined)?.status,
    forkTurnCount: forkSnapshot.turns.length,
    observedNotificationKinds: [...new Set(fixture.map((event) => event.method))].sort(),
  }, null, 2));
} finally {
  for (const threadId of created.reverse()) await adapter.archiveSession(threadId).catch(() => undefined);
  adapter.stop();
}
