import { describe, expect, it } from "vitest";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import { mergeSessionSnapshot } from "../../apps/server/src/session-service.js";

function thread(turns: Thread["turns"]): Thread {
  return {
    id: "thread-1",
    preview: "test",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "notLoaded" },
    path: null,
    cwd: "/tmp/project",
    cliVersion: "test",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "test",
    ephemeral: false,
    forkedFromId: null,
    turns,
  };
}

describe("session snapshot merge", () => {
  it("keeps live tool items that stable thread history omits", () => {
    const stable = thread([{
      id: "turn-1",
      status: "completed",
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
      items: [
        { type: "userMessage", id: "user-1", content: [{ type: "text", text: "run it", text_elements: [] }] },
        { type: "agentMessage", id: "agent-1", text: "done", phase: "final_answer" },
      ],
    }]);
    const live = thread([{
      ...stable.turns[0]!,
      items: [
        { ...stable.turns[0]!.items[0]!, id: "live-user-1" },
        { type: "agentMessage", id: "live-preamble-1", text: "I will run it.", phase: "commentary" },
        {
          type: "commandExecution",
          id: "command-1",
          command: "/bin/zsh -lc 'printf ok'",
          cwd: "/tmp/project",
          processId: null,
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 10,
        },
        { ...stable.turns[0]!.items[1]!, id: "live-agent-1" },
      ],
    }]);

    const merged = mergeSessionSnapshot(stable, live);

    expect(merged.turns[0]?.items.map((item) => item.type)).toEqual([
      "userMessage",
      "agentMessage",
      "commandExecution",
      "agentMessage",
    ]);
    expect(merged.turns[0]?.items[2]).toMatchObject({ type: "commandExecution", aggregatedOutput: "ok", exitCode: 0 });
    expect(merged.turns[0]?.items).toHaveLength(4);
  });

  it("preserves stable ordering and deduplicates tools whose ids changed", () => {
    const command = {
      type: "commandExecution" as const,
      id: "stable-command",
      command: "printf ok",
      cwd: "/tmp/project",
      processId: null,
      status: "completed" as const,
      commandActions: [],
      aggregatedOutput: "ok",
      exitCode: 0,
      durationMs: 10,
    };
    const stable = thread([{ id: "turn-1", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000, items: [
      { type: "userMessage", id: "stable-user", content: [{ type: "text", text: "run", text_elements: [] }] },
      command,
      { type: "agentMessage", id: "stable-agent", text: "done", phase: "final_answer" },
    ] }]);
    const live = thread([{ ...stable.turns[0]!, items: [
      { ...stable.turns[0]!.items[0]!, id: "live-user" },
      { ...command, id: "live-command", aggregatedOutput: null, exitCode: null, durationMs: null },
      { ...stable.turns[0]!.items[2]!, id: "live-agent" },
    ] }]);

    const merged = mergeSessionSnapshot(stable, live).turns[0]!.items;

    expect(merged.map((item) => item.type)).toEqual(["userMessage", "commandExecution", "agentMessage"]);
    expect(merged.filter((item) => item.type === "commandExecution")).toHaveLength(1);
    expect(merged[1]).toMatchObject({ aggregatedOutput: "ok", exitCode: 0 });
  });

  it("merges streamed command output with a completion item that omits its first delta", () => {
    const completed = thread([{ id: "turn-1", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000, items: [{
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp/project", processId: null,
      status: "completed", commandActions: [], aggregatedOutput: "LINE_2\nLINE_3\n", exitCode: 0, durationMs: 10,
    }] }]);
    const streamed = thread([{ ...completed.turns[0]!, status: "inProgress", completedAt: null, durationMs: null, items: [{
      type: "commandExecution", id: "command-1", command: "run", cwd: "/tmp/project", processId: null,
      status: "inProgress", commandActions: [], aggregatedOutput: "LINE_1\nLINE_2\nLINE_3\n", exitCode: null, durationMs: null,
    }] }]);

    expect(mergeSessionSnapshot(completed, streamed).turns[0]?.items[0]).toMatchObject({
      status: "completed",
      aggregatedOutput: "LINE_1\nLINE_2\nLINE_3\n",
      exitCode: 0,
    });
  });

  it("coalesces plan updates with the same item id and keeps the live final state", () => {
    const stable = thread([{ id: "turn-1", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000, items: [{
      type: "plan", id: "turn-plan:turn-1", text: "[~] Run command\n[ ] Report result",
    }] }]);
    const live = thread([{ ...stable.turns[0]!, items: [{
      type: "plan", id: "turn-plan:turn-1", text: "[x] Run command\n[x] Report result",
    }] }]);

    const items = mergeSessionSnapshot(stable, live).turns[0]!.items;
    expect(items).toEqual([{ type: "plan", id: "turn-plan:turn-1", text: "[x] Run command\n[x] Report result" }]);
  });

  it("keeps a second identical command after an exact-id command match", () => {
    const command = (id: string) => ({
      type: "commandExecution" as const, id, command: "npm test", cwd: "/tmp/project", processId: null,
      status: "completed" as const, commandActions: [], aggregatedOutput: "ok", exitCode: 0, durationMs: 10,
    });
    const stable = thread([{ id: "turn-1", status: "completed", itemsView: "full", error: null, startedAt: 1, completedAt: 2, durationMs: 1_000, items: [command("command-1")] }]);
    const live = thread([{ ...stable.turns[0]!, items: [command("command-1"), command("command-2")] }]);

    expect(mergeSessionSnapshot(stable, live).turns[0]?.items.map((item) => item.id)).toEqual(["command-1", "command-2"]);
  });
});
