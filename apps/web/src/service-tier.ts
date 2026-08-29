import type { ModelOption } from "@codex-web/shared-types";

export function serviceTierForModel(model: ModelOption | undefined, requested: string | null | undefined): string | null {
  if (requested === null) return null;
  if (requested && model?.serviceTiers.some((tier) => tier.id === requested)) return requested;
  const fallback = model?.defaultServiceTier;
  return fallback && model.serviceTiers.some((tier) => tier.id === fallback) ? fallback : null;
}

export function fastServiceTierForModel(model: ModelOption | undefined) {
  return model?.serviceTiers.find((tier) => tier.id === "priority" || tier.name.trim().toLocaleLowerCase() === "fast");
}
