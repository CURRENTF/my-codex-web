import type { SkillOption } from "@codex-web/shared-types";

export interface SlashCommandSpec {
  name: "goal" | "compact" | "review" | "fork" | "side" | "model" | "reasoning" | "permissions" | "status" | "skills";
  description: string;
  usage?: string;
}

export type SlashCommandName = SlashCommandSpec["name"];

export const slashCommands: SlashCommandSpec[] = [
  { name: "goal", description: "设置、查看、暂停或清除 Goal", usage: "/goal [objective|pause|resume|clear]" },
  { name: "compact", description: "压缩当前 Session 上下文" },
  { name: "review", description: "审查未提交更改或指定基线", usage: "/review [base <branch>|commit <sha>|instructions]" },
  { name: "fork", description: "从最新完成 Turn 创建 Fork" },
  { name: "side", description: "从最新位置打开 Side Chat" },
  { name: "model", description: "选择当前 Session 模型", usage: "/model <model>" },
  { name: "reasoning", description: "选择 Reasoning 强度", usage: "/reasoning <effort>" },
  { name: "permissions", description: "选择 Full Access、Workspace Write 或 Read Only", usage: "/permissions <mode>" },
  { name: "status", description: "显示当前 Session 状态与配置" },
  { name: "skills", description: "浏览并插入可用 Skill" },
];

export interface ComposerTrigger {
  kind: "skill" | "command";
  query: string;
  start: number;
  end: number;
}

export interface CompletedSkillMention { start: number; text: string }

export function isCompletedSkillTrigger(text: string, cursor: number, trigger: ComposerTrigger | null, completed: CompletedSkillMention | null): boolean {
  if (trigger?.kind !== "skill" || !completed || trigger.start !== completed.start) return false;
  const mentionEnd = completed.start + completed.text.length;
  return text.slice(completed.start, mentionEnd) === completed.text
    && /\s/.test(text[mentionEnd] ?? "")
    && cursor > mentionEnd;
}

export function composerTrigger(text: string, cursor: number): ComposerTrigger | null {
  const before = text.slice(0, cursor);
  const slash = /^\s*\/([^\s/]*)$/.exec(before);
  if (slash) {
    const start = before.indexOf("/");
    return { kind: "command", query: slash[1] ?? "", start, end: cursor };
  }
  const dollar = /(?:^|\s)\$([^\n$]*)$/.exec(before);
  if (!dollar) return null;
  const markerOffset = dollar[0].lastIndexOf("$");
  const start = (dollar.index ?? 0) + markerOffset;
  return { kind: "skill", query: dollar[1] ?? "", start, end: cursor };
}

export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const match = /^\s*\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*?))?\s*$/i.exec(text);
  return match ? { name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? "" } : null;
}

export function referencedSkillNames(text: string, skills: readonly SkillOption[]): string[] {
  const matches: Array<{ name: string; start: number; end: number }> = [];
  for (const skill of [...skills].sort((left, right) => right.name.length - left.name.length)) {
    const expression = new RegExp(`(?:^|\\s)\\$${escapeRegExp(skill.name)}(?=$|\\s|[.,;:!?，。；：！？])`, "g");
    for (let match = expression.exec(text); match; match = expression.exec(text)) {
      const markerOffset = match[0].lastIndexOf("$");
      const start = match.index + markerOffset;
      const end = start + skill.name.length + 1;
      if (!matches.some((candidate) => start < candidate.end && end > candidate.start)) matches.push({ name: skill.name, start, end });
    }
  }
  return matches.sort((left, right) => left.start - right.start).map((match) => match.name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slashArgumentTrigger(text: string): { command: "model" | "reasoning" | "permissions"; query: string; start: number; end: number } | null {
  const match = /^\s*\/(model|reasoning|permissions)\s+([^\n]*)$/i.exec(text);
  if (!match) return null;
  return { command: match[1]!.toLowerCase() as "model" | "reasoning" | "permissions", query: match[2] ?? "", start: text.length - (match[2]?.length ?? 0), end: text.length };
}

export function isSupportedSlashCommand(name: string): name is SlashCommandName {
  return slashCommands.some((command) => command.name === name);
}

export interface ArgumentSuggestion { value: string; label: string }

const permissionSuggestions: ArgumentSuggestion[] = [
  { value: "fullAccess", label: "Full Access" },
  { value: "workspaceWrite", label: "Workspace Write" },
  { value: "readOnly", label: "Read Only" },
];

export function commandArgumentSuggestions(command: string, query: string, supplied: readonly ArgumentSuggestion[]): ArgumentSuggestion[] {
  const options = command === "permissions" ? permissionSuggestions : supplied;
  const normalized = query.trim().toLocaleLowerCase();
  return options.filter((option) => !normalized || option.value.toLocaleLowerCase().includes(normalized) || option.label.toLocaleLowerCase().includes(normalized));
}

export function removeSkillMentions(text: string, names: readonly string[]): string {
  let next = text;
  for (const name of [...names].sort((left, right) => right.length - left.length)) {
    next = next.replace(new RegExp(`(?:^|\\s)\\$${escapeRegExp(name)}(?=$|\\s|[.,;:!?，。；：！？])`, "g"), (match) => match.startsWith(" ") ? " " : "");
  }
  return next.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/gm, "").trim();
}
