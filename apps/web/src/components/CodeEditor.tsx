import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";

function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "ts": case "tsx": case "js": case "jsx": case "mjs": case "cjs": return javascript({ typescript: extension.startsWith("ts"), jsx: extension.endsWith("x") });
    case "py": return python();
    case "json": return json();
    case "md": case "mdx": return markdown();
    case "css": return css();
    case "html": return html();
    default: return [];
  }
}

export default function CodeEditor({ content, path, line, onChange, onSave }: {
  content: string; path: string; line: number; onChange(value: string): void; onSave(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    if (!host.current) return;
    const separator = content.includes("\r\n") ? "\r\n" : "\n";
    const state = EditorState.create({ doc: content, extensions: [basicSetup, language(path), syntaxHighlighting(HighlightStyle.define([
        { tag: tags.keyword, color: "var(--code-keyword)" }, { tag: [tags.string, tags.regexp], color: "var(--code-string)" },
        { tag: [tags.number, tags.bool, tags.null], color: "var(--code-literal)" }, { tag: tags.comment, color: "var(--text-soft)" },
        { tag: [tags.typeName, tags.function(tags.variableName)], color: "var(--code-function)" },
      ])), EditorState.lineSeparator.of(separator),
      keymap.of([indentWithTab, { key: "Mod-s", preventDefault: true, run: () => { callbacks.current.onSave(); return true; } }]),
      EditorView.contentAttributes.of({ "aria-label": "文件内容" }),
      EditorView.updateListener.of((update) => { if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc()); }),
      EditorView.theme({ "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--text)" }, ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "13px", lineHeight: "1.65" }, ".cm-content": { caretColor: "var(--text)" }, ".cm-gutters": { backgroundColor: "var(--sidebar)", color: "var(--text-soft)", borderRight: "1px solid var(--line)" }, ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--accent-soft)" }, ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--accent-soft)" }, ".cm-panels, .cm-tooltip": { backgroundColor: "var(--surface-strong)", color: "var(--text)", borderColor: "var(--line)" }, ".cm-cursor": { borderLeftColor: "var(--text)" } }),
    ] });
    const editor = new EditorView({ state, parent: host.current });
    const from = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, line))).from;
    editor.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    return () => editor.destroy();
    // Parent remounts on file load, not keystrokes or saves: retain selection and undo history.
  }, []);
  return <div ref={host} className="code-editor" />;
}
