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
const displayMathCommand = /\\(?:frac|dfrac|tfrac|text|mathrm|mathbf|mathit|operatorname|sqrt|sum|prod|int|begin|left|right|mathbb|mathcal|bm|cdot|times|top|infty)(?:\b|(?=[{[]))/;
const maxLooseDisplayMathLines = 24;
const maxLooseDisplayMathCharacters = 4_000;

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

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function displayMathContent(contentLines: string[], indent: string): string {
  return contentLines
    .map((line) => line.startsWith(indent) ? line.slice(indent.length) : line)
    .join("\n")
    .trim();
}

function displayMathBlock(content: string, indent: string): string[] {
  return [indent + "$$", ...content.split("\n").map((line) => indent + line), indent + "$$"];
}

export function normalizeLooseDisplayMath(text: string): string {
  const lines = text.split("\n");
  const normalized: string[] = [];
  let fence: string | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      normalized.push(line);
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1]!;
      normalized.push(line);
      continue;
    }

    const texOpening = /^( {0,3})\\\[\s*/.exec(line);
    if (texOpening) {
      const indent = texOpening[1]!;
      const openColumn = line.indexOf("\\[", indent.length);
      let closingLine = -1;
      let closingColumn = -1;
      let candidateCharacters = 0;
      const lastCandidateLine = Math.min(lines.length - 1, lineIndex + maxLooseDisplayMathLines - 1);
      for (let candidateLine = lineIndex; candidateLine <= lastCandidateLine; candidateLine += 1) {
        const candidate = lines[candidateLine]!;
        candidateCharacters += candidate.length + 1;
        if (candidateCharacters > maxLooseDisplayMathCharacters) break;
        const firstColumn = candidateLine === lineIndex ? openColumn + 2 : 0;
        for (let column = firstColumn; column < candidate.length - 1; column += 1) {
          if (candidate[column] !== "\\" || candidate[column + 1] !== "]" || isEscaped(candidate, column)) continue;
          if (!candidate.slice(column + 2).trim()) {
            closingLine = candidateLine;
            closingColumn = column;
          }
          break;
        }
        if (closingLine >= 0) break;
      }
      if (closingLine >= 0) {
        const contentLines = lines.slice(lineIndex, closingLine + 1);
        contentLines[0] = contentLines[0]!.slice(openColumn + 2);
        contentLines[contentLines.length - 1] = contentLines.at(-1)!.slice(0, closingLine === lineIndex ? closingColumn - openColumn - 2 : closingColumn);
        const content = displayMathContent(contentLines, indent);
        if (content) {
          normalized.push(...displayMathBlock(content, indent));
          lineIndex = closingLine;
          continue;
        }
      }
    }

    const opening = /^( {0,3})\[\s*/.exec(line);
    if (!opening) {
      normalized.push(line);
      continue;
    }
    const indent = opening[1]!;
    const openColumn = line.indexOf("[", indent.length);
    let depth = 0;
    let closingLine = -1;
    let closingColumn = -1;
    let candidateCharacters = 0;
    const lastCandidateLine = Math.min(lines.length - 1, lineIndex + maxLooseDisplayMathLines - 1);
    for (let candidateLine = lineIndex; candidateLine <= lastCandidateLine; candidateLine += 1) {
      const candidate = lines[candidateLine]!;
      candidateCharacters += candidate.length + 1;
      if (candidateCharacters > maxLooseDisplayMathCharacters) break;
      const firstColumn = candidateLine === lineIndex ? openColumn : 0;
      for (let column = firstColumn; column < candidate.length; column += 1) {
        if (isEscaped(candidate, column)) continue;
        if (candidate[column] === "[") depth += 1;
        else if (candidate[column] === "]") {
          depth -= 1;
          if (depth === 0) {
            if (!candidate.slice(column + 1).trim()) {
              closingLine = candidateLine;
              closingColumn = column;
            }
            break;
          }
        }
      }
      if (depth <= 0) break;
    }
    if (closingLine < 0) {
      normalized.push(line);
      continue;
    }

    const contentLines = lines.slice(lineIndex, closingLine + 1);
    contentLines[0] = contentLines[0]!.slice(openColumn + 1);
    contentLines[contentLines.length - 1] = contentLines.at(-1)!.slice(0, closingLine === lineIndex ? closingColumn - openColumn - 1 : closingColumn);
    const content = displayMathContent(contentLines, indent);
    if (!displayMathCommand.test(content)) {
      normalized.push(line);
      continue;
    }
    normalized.push(...displayMathBlock(content, indent));
    lineIndex = closingLine;
  }
  return normalized.join("\n");
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
