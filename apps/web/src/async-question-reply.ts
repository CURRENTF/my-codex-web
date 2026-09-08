import type { AsyncUserInputQuestion } from "@codex-web/shared-types";

export function questionReplyText(questions: AsyncUserInputQuestion[], answers: string[]): string {
  return `回复问题：\n\n${questions.map((question, index) => `${index + 1}. ${question.title}\n回答：${answers[index]?.trim() ?? ""}`).join("\n\n")}`;
}

export function appendQuestionReply(draft: string, reply: string): string {
  if (draft.includes(reply)) return draft;
  return draft.trim() ? `${draft}\n\n${reply}` : reply;
}
