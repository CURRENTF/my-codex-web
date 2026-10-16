import type { AsyncUserInputQuestion, SessionItem, SessionTurn } from "@codex-web/shared-types";

function answeredQuestionTitles(text: string): string[] {
  // Recognize the reply format we put in the composer, not incidental mentions
  // of a question in an ordinary user message.
  return text.replace(/\r\n/g, "\n").split(/(?:^|\n)回复问题：[ \t]*\n/).slice(1).flatMap((reply) =>
    [...reply.matchAll(/(?:^|\n)\d+\. ([\s\S]*?)\n回答：[ \t]*([^\n]*(?:\n(?!\d+\. )[^\n]*)*)/g)]
      .filter((match) => match[2]!.trim())
      .map((match) => match[1]!.trim()),
  );
}

/** Draft/queued replies hide their forms; persisted user replies survive reloads. */
export function pendingAsyncQuestionItems(turns: SessionTurn[], replyTexts: string[] = []) {
  const answered = new Set(replyTexts.flatMap(answeredQuestionTitles));
  const pending: Array<Extract<SessionItem, { type: "agentMessage" }> & { questions: AsyncUserInputQuestion[] }> = [];
  // Match only replies after a question, consuming each title so an older reply
  // cannot silently dismiss a newly asked question with the same title.
  for (const turn of turns.toReversed()) {
    for (const item of turn.items.toReversed()) {
      if (item.type === "userMessage") {
        const text = item.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
        for (const title of answeredQuestionTitles(text)) answered.add(title);
      } else if (item.type === "agentMessage" && item.delivery === "async" && item.questions?.length) {
        const questions = item.questions.filter((question) => !answered.delete(question.title.trim()));
        if (questions.length) pending.push({ ...item, questions });
      }
    }
  }
  return pending;
}

export function questionReplyText(questions: AsyncUserInputQuestion[], answers: string[]): string {
  return `回复问题：\n\n${questions.map((question, index) => `${index + 1}. ${question.title}\n回答：${answers[index]?.trim() ?? ""}`).join("\n\n")}`;
}

export function appendQuestionReply(draft: string, reply: string): string {
  if (draft.includes(reply)) return draft;
  return draft.trim() ? `${draft}\n\n${reply}` : reply;
}
