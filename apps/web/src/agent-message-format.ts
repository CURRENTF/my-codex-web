export interface CodeCommentBlock {
  kind: "codeComment";
  title: string;
  body: string;
  file: string;
  start: number | null;
  end: number | null;
  priority: number | null;
  confidence: number | null;
}

export interface GitReceiptBlock {
  kind: "gitReceipt";
  action: string;
  cwd: string | null;
  branch: string | null;
  url: string | null;
  draft: boolean | null;
}

export type AgentMessageBlock =
  | { kind: "text"; text: string }
  | CodeCommentBlock
  | GitReceiptBlock;

export type InlineMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; target: string; localFile: boolean };

interface ParsedDirective {
  name: string;
  attributes: Record<string, string>;
}

const gitReceiptActions = new Set(["stage", "commit", "push", "create-branch", "create-pr"]);

function parseFiniteNumber(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDirective(line: string): ParsedDirective | null {
  const match = /^::([a-z][a-z0-9-]*)\{/.exec(line);
  if (!match || !line.endsWith("}")) return null;
  const attributes: Record<string, string> = {};
  let cursor = match[0].length;
  const end = line.length - 1;
  while (cursor < end) {
    while (cursor < end && /\s/.test(line[cursor]!)) cursor += 1;
    if (cursor >= end) break;
    const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(line.slice(cursor));
    if (!keyMatch) return null;
    const key = keyMatch[0];
    cursor += key.length;
    while (cursor < end && /\s/.test(line[cursor]!)) cursor += 1;
    if (line[cursor] !== "=") return null;
    cursor += 1;
    while (cursor < end && /\s/.test(line[cursor]!)) cursor += 1;
    let value = "";
    if (line[cursor] === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < end) {
        const character = line[cursor]!;
        cursor += 1;
        if (character === '"') { closed = true; break; }
        if (character !== "\\") { value += character; continue; }
        if (cursor >= end) return null;
        const escaped = line[cursor]!;
        cursor += 1;
        value += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[escaped] ?? escaped;
      }
      if (!closed) return null;
    } else {
      const valueMatch = /^[^\s}]+/.exec(line.slice(cursor));
      if (!valueMatch) return null;
      value = valueMatch[0];
      cursor += value.length;
    }
    attributes[key] = value;
  }
  return { name: match[1]!, attributes };
}

function directiveBlock(line: string): CodeCommentBlock | GitReceiptBlock | null {
  const parsed = parseDirective(line);
  if (!parsed) return null;
  if (parsed.name === "code-comment") {
    const { title, body, file } = parsed.attributes;
    if (!title || !body || !file) return null;
    return {
      kind: "codeComment",
      title,
      body,
      file,
      start: parseFiniteNumber(parsed.attributes.start),
      end: parseFiniteNumber(parsed.attributes.end),
      priority: parseFiniteNumber(parsed.attributes.priority),
      confidence: parseFiniteNumber(parsed.attributes.confidence),
    };
  }
  const action = parsed.name.startsWith("git-") ? parsed.name.slice(4) : "";
  if (gitReceiptActions.has(action)) {
    const url = parsed.attributes.url;
    return {
      kind: "gitReceipt",
      action,
      cwd: parsed.attributes.cwd ?? null,
      branch: parsed.attributes.branch ?? null,
      url: url && /^https?:\/\//.test(url) ? url : null,
      draft: parsed.attributes.isDraft === undefined ? null : parsed.attributes.isDraft === "true",
    };
  }
  return null;
}

export function parseAgentMessage(text: string): AgentMessageBlock[] {
  const blocks: AgentMessageBlock[] = [];
  let textLines: string[] = [];
  let fenced = false;
  const flushText = () => {
    const value = textLines.join("\n").replace(/^\n+|\n+$/g, "");
    if (value) blocks.push({ kind: "text", text: value });
    textLines = [];
  };
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      textLines.push(line);
      continue;
    }
    const directive = fenced ? null : directiveBlock(line.trim());
    if (!directive) {
      textLines.push(line);
      continue;
    }
    flushText();
    blocks.push(directive);
  }
  flushText();
  return blocks;
}

export function parseInlineMessageLinks(text: string): InlineMessageSegment[] {
  const segments: InlineMessageSegment[] = [];
  const pattern = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ kind: "text", text: text.slice(cursor, index) });
    const target = match[2]!;
    const localFile = target.startsWith("/");
    if (localFile || /^https?:\/\//.test(target)) segments.push({ kind: "link", label: match[1]!, target, localFile });
    else segments.push({ kind: "text", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments.length ? segments : [{ kind: "text", text }];
}
