export interface SafeErrorLog {
  name: string;
  code?: string | number;
}

/**
 * Keep diagnostics useful without serializing opaque App Server payloads,
 * prompts, command output, file contents, or stack frames into local logs.
 */
export function safeErrorForLog(value: unknown): SafeErrorLog {
  if (!(value instanceof Error)) return { name: "NonError" };

  const code = (value as Error & { code?: unknown }).code;
  return {
    name: value.name || value.constructor.name || "Error",
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
}
