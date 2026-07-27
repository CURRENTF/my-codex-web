import { describe, expect, it } from "vitest";
import { commandArgumentSuggestions, composerTrigger, isCompletedSkillTrigger, isSupportedSlashCommand, parseSlashCommand, referencedSkillNames, slashArgumentTrigger, slashCommands } from "../../apps/web/src/composer-commands";

const skills = [
  { name: "design-taste-frontend", description: "Frontend", path: "/skills/design/SKILL.md", scope: "user" },
  { name: "Academic Figure Prompt", description: "Figures", path: "/skills/figure/SKILL.md", scope: "user" },
];

describe("Composer $ skills and slash commands", () => {
  it("finds skill triggers at the cursor and resolves selected skill names", () => {
    expect(composerTrigger("please use $design", "please use $design".length)).toEqual({ kind: "skill", query: "design", start: 11, end: 18 });
    expect(referencedSkillNames("$design-taste-frontend polish it", skills)).toEqual(["design-taste-frontend"]);
    expect(referencedSkillNames("use $Academic Figure Prompt for this", skills)).toEqual(["Academic Figure Prompt"]);
    expect(referencedSkillNames("$design-taste-frontend-extra", skills)).toEqual([]);
    expect(referencedSkillNames("$Academic Figure Prompt now", [
      ...skills,
      { name: "Academic", description: "Prefix", path: "/skills/prefix/SKILL.md", scope: "user" },
    ])).toEqual(["Academic Figure Prompt"]);
  });

  it("keeps the Skill menu closed while typing body text after a selected Skill", () => {
    const text = "$caveman Reply exactly OK";
    const trigger = composerTrigger(text, text.length);
    expect(isCompletedSkillTrigger(text, text.length, trigger, { start: 0, text: "$caveman" })).toBe(true);
    expect(isCompletedSkillTrigger("$caveman", 9, composerTrigger("$caveman", 9), { start: 0, text: "$caveman" })).toBe(false);
    expect(isCompletedSkillTrigger("use $other", 10, composerTrigger("use $other", 10), { start: 0, text: "$caveman" })).toBe(false);
  });

  it("opens slash completion only for a leading command and parses arguments", () => {
    expect(composerTrigger("/go", 3)).toEqual({ kind: "command", query: "go", start: 0, end: 3 });
    expect(composerTrigger("explain /goal", 13)).toBeNull();
    expect(parseSlashCommand("/goal Finish the migration")).toEqual({ name: "goal", args: "Finish the migration" });
    expect(parseSlashCommand("normal prompt")).toBeNull();
    expect(slashArgumentTrigger("/model gpt-5")).toEqual({ command: "model", query: "gpt-5", start: 7, end: 12 });
    expect(isSupportedSlashCommand("compact")).toBe(true);
    expect(isSupportedSlashCommand("quit")).toBe(false);
  });

  it("advertises only commands implemented by the Web client", () => {
    expect(slashCommands.map((command) => command.name)).toEqual([
      "goal", "compact", "review", "fork", "side", "model", "reasoning", "permissions", "status", "skills",
    ]);
  });

  it("suggests model, reasoning, and permission arguments", () => {
    expect(commandArgumentSuggestions("model", "gpt", [{ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }])).toEqual([
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ]);
    expect(commandArgumentSuggestions("permissions", "full", [])).toContainEqual({ value: "fullAccess", label: "Full Access" });
  });
});
