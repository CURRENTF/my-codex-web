import type { Goal } from "./api";

export function goalUpdateInput(goal: Goal | null, objective: string, tokenBudget: number | null, status: Goal["status"]): Pick<Goal, "objective" | "tokenBudget" | "status"> | Partial<Pick<Goal, "objective" | "tokenBudget" | "status">> {
  const update: Partial<Pick<Goal, "objective" | "tokenBudget" | "status">> = {};
  if (!goal || objective !== goal.objective) update.objective = objective;
  if (!goal || tokenBudget !== goal.tokenBudget) update.tokenBudget = tokenBudget;
  if (!goal || status !== goal.status) update.status = status;
  return update;
}
