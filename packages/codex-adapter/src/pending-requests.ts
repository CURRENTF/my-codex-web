import type { PendingRequestSummary } from "@codex-web/shared-types";
import type { RpcServerRequest } from "./json-rpc-transport.js";

export interface AdapterPendingRequest {
  id: string;
  threadId?: string;
  summary: PendingRequestSummary;
}

const supportedMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "item/tool/requestUserInput",
]);

export function projectPendingRequest(request: RpcServerRequest): AdapterPendingRequest | null {
  if (!supportedMethods.has(request.method)) return null;
  const id = String(request.id);
  const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
  const threadId = typeof params.threadId === "string" ? params.threadId : typeof params.conversationId === "string" ? params.conversationId : undefined;
  return { id, ...(threadId ? { threadId } : {}), summary: { id, method: request.method, params: projectRequestParams(request.method, params) } };
}

export function pendingRequestResponse(request: RpcServerRequest, allow: boolean, answers: Record<string, string[]> = {}): unknown {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": return { decision: allow ? "accept" : "decline" };
    case "applyPatchApproval":
    case "execCommandApproval": return { decision: allow ? "approved" : "denied" };
    case "item/permissions/requestApproval": {
      const requested = (request.params as { permissions?: { network?: unknown; fileSystem?: unknown } } | undefined)?.permissions;
      return { permissions: allow ? { ...(requested?.network ? { network: requested.network } : {}), ...(requested?.fileSystem ? { fileSystem: requested.fileSystem } : {}) } : {}, scope: "turn" };
    }
    case "mcpServer/elicitation/request": return elicitationResponse(request.params, allow, answers);
    case "item/tool/requestUserInput": {
      if (!allow) return { answers: {} };
      const questionIds = new Set(Array.isArray((request.params as { questions?: unknown } | undefined)?.questions)
        ? ((request.params as { questions: Array<{ id?: unknown }> }).questions).flatMap((question) => typeof question.id === "string" ? [question.id] : []) : []);
      return { answers: Object.fromEntries(Object.entries(answers).filter(([id, values]) => questionIds.has(id) && values.length > 0).map(([id, values]) => [id, { answers: values }])) };
    }
    default: return null;
  }
}

function projectRequestParams(method: string, params: Record<string, unknown>): PendingRequestSummary["params"] {
  if (method === "item/tool/requestUserInput" && Array.isArray(params.questions)) {
    const questions = params.questions.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const question = value as Record<string, unknown>;
      if (typeof question.id !== "string" || typeof question.header !== "string" || typeof question.question !== "string") return [];
      const options = Array.isArray(question.options) ? question.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const candidate = option as Record<string, unknown>;
        return typeof candidate.label === "string" && typeof candidate.description === "string" ? [{ label: candidate.label, description: candidate.description }] : [];
      }) : null;
      return [{ id: question.id, header: question.header, question: question.question, isOther: question.isOther === true, isSecret: question.isSecret === true, options }];
    });
    return { type: "userInput", questions, autoResolutionMs: typeof params.autoResolutionMs === "number" ? params.autoResolutionMs : null };
  }
  if (method === "mcpServer/elicitation/request" && typeof params.mode === "string" && ["form", "openai/form", "url"].includes(params.mode)) {
    return {
      type: "elicitation",
      mode: params.mode as "form" | "openai/form" | "url",
      serverName: typeof params.serverName === "string" ? params.serverName : "MCP",
      message: typeof params.message === "string" ? params.message : "MCP Server 请求额外输入",
      url: typeof params.url === "string" ? params.url : null,
      fields: params.mode === "url" ? [] : projectFormFields(params.requestedSchema),
    };
  }
  return null;
}

function projectFormFields(schema: unknown): NonNullable<Extract<PendingRequestSummary["params"], { type: "elicitation" }>>["fields"] {
  if (!schema || typeof schema !== "object") return [];
  const root = schema as Record<string, unknown>;
  const properties = root.properties && typeof root.properties === "object" ? root.properties as Record<string, unknown> : {};
  const required = new Set(Array.isArray(root.required) ? root.required.filter((value): value is string => typeof value === "string") : []);
  return Object.entries(properties).flatMap(([id, value]) => {
    if (!value || typeof value !== "object") return [];
    const field = value as Record<string, unknown>;
    const options = enumOptions(field);
    const type = field.type;
    const valueType = type === "boolean" ? "boolean" : type === "number" ? "number" : type === "integer" ? "integer" : type === "array" ? "multiSelect" : options ? "singleSelect" : "string";
    const fallback = valueType === "multiSelect" ? [] : valueType === "boolean" ? false : null;
    const defaultValue = typeof field.default === "string" || typeof field.default === "number" || typeof field.default === "boolean" || (Array.isArray(field.default) && field.default.every((item) => typeof item === "string")) ? field.default : fallback;
    return [{ id, title: typeof field.title === "string" ? field.title : id, description: typeof field.description === "string" ? field.description : "", valueType, required: required.has(id), options, defaultValue }];
  });
}

function enumOptions(field: Record<string, unknown>): Array<{ value: string; label: string }> | null {
  const direct = Array.isArray(field.enum) ? field.enum : null;
  const items = field.items && typeof field.items === "object" ? field.items as Record<string, unknown> : null;
  const values = direct ?? (items && Array.isArray(items.enum) ? items.enum : null);
  const titled = Array.isArray(field.oneOf) ? field.oneOf : items && Array.isArray(items.anyOf) ? items.anyOf : null;
  if (titled) return titled.flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).const === "string" ? [{ value: String((item as Record<string, unknown>).const), label: typeof (item as Record<string, unknown>).title === "string" ? String((item as Record<string, unknown>).title) : String((item as Record<string, unknown>).const) }] : []);
  if (!values) return null;
  const labels = Array.isArray(field.enumNames) ? field.enumNames : [];
  return values.flatMap((value, index) => typeof value === "string" ? [{ value, label: typeof labels[index] === "string" ? String(labels[index]) : value }] : []);
}

function elicitationResponse(params: unknown, allow: boolean, answers: Record<string, string[]>): unknown {
  if (!allow) return { action: "decline", content: null, _meta: null };
  const request = params && typeof params === "object" ? params as Record<string, unknown> : {};
  if (request.mode === "url") return { action: "accept", content: null, _meta: null };
  const fields = projectFormFields(request.requestedSchema);
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const values = answers[field.id] ?? [];
    if (!values.length) {
      if (field.required) throw new Error(`Missing required MCP field: ${field.title}`);
      continue;
    }
    if (field.valueType === "multiSelect") content[field.id] = values;
    else if (field.valueType === "boolean") content[field.id] = values[0] === "true";
    else if (field.valueType === "number" || field.valueType === "integer") {
      const number = Number(values[0]);
      if (!Number.isFinite(number) || (field.valueType === "integer" && !Number.isInteger(number))) throw new Error(`Invalid MCP number: ${field.title}`);
      content[field.id] = number;
    } else content[field.id] = values[0];
  }
  return { action: "accept", content, _meta: null };
}
