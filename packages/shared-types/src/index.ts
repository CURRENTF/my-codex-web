export type AccessMode = "fullAccess" | "workspaceWrite" | "readOnly";
export type RuntimeState =
  | "idle"
  | "running"
  | "waitingForInput"
  | "justFinished"
  | "interrupted"
  | "failed"
  | "disconnected";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  canonicalPath: string;
  orderIndex: number;
  defaultModel: string | null;
  defaultReasoning: string | null;
  defaultAccessMode: AccessMode;
  createdAt: number;
  lastOpenedAt: number | null;
  available: boolean;
}

export interface SessionSummary {
  threadId: string;
  projectId: string;
  title: string;
  preview: string;
  cwd: string;
  sourceKind: string;
  createdAt: number;
  updatedAt: number;
  origin: "discovered" | "created" | "forked" | "manual";
  parentThreadId: string | null;
  forkTurnId: string | null;
  forkSourceTitle: string | null;
  forkTurnNumber: number | null;
  runtimeState: RuntimeState;
  hasGoal: boolean;
}

export interface ThreadRuntime {
  threadId: string;
  activeTurnId?: string;
  uncertainTurnStart?: boolean;
  state: RuntimeState;
  activeFlags: string[];
  pendingRequestIds: string[];
  lastCompletedAt?: number;
  lastTerminalStatus?: "completed" | "interrupted" | "failed";
}

export interface SideChatRuntime extends ThreadRuntime {
  parentThreadId: string;
  anchorTurnId?: string;
  createdAt: number;
}

export interface UiEvent {
  seq: number;
  type: string;
  threadId?: string;
  sideChatId?: string;
  emittedAt: number;
  payload: unknown;
}

export interface PendingRequestSummary {
  id: string;
  method: string;
  params: {
    type: "userInput";
    questions: Array<{
      id: string;
      header: string;
      question: string;
      isOther: boolean;
      isSecret: boolean;
      options: Array<{ label: string; description: string }> | null;
    }>;
    autoResolutionMs: number | null;
  } | {
    type: "elicitation";
    mode: "form" | "openai/form" | "url";
    serverName: string;
    message: string;
    url: string | null;
    fields: Array<{
      id: string;
      title: string;
      description: string;
      valueType: "string" | "number" | "integer" | "boolean" | "singleSelect" | "multiSelect";
      required: boolean;
      options: Array<{ value: string; label: string }> | null;
      defaultValue: string | string[] | boolean | number | null;
    }>;
  } | null;
}

export interface Goal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionItem =
  | { type: "userMessage"; id: string; clientId?: string | null; content: Array<{ type: string; text?: string; path?: string }> }
  | { type: "agentMessage"; id: string; text: string; phase?: string }
  | { type: "reasoning"; id: string; summary: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; cwd: string; status: string; aggregatedOutput: string | null; exitCode: number | null; durationMs: number | null }
  | { type: "fileChange"; id: string; changes: Array<{ path: string; kind: string; diff?: string }>; status: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; durationMs: number | null; details?: string }
  | { type: "genericToolCall"; id: string; title: string; status: string; details?: string };

export interface SessionTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items: SessionItem[];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface SessionThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  ephemeral: boolean;
  forkedFromId: string | null;
  turns: SessionTurn[];
}

export interface TurnUiEventPayload { turn: SessionTurn }
export interface ItemUiEventPayload { turnId: string; item: SessionItem; startedAtMs?: number; completedAtMs?: number; completed?: boolean }
export interface ItemDeltaUiEventPayload { itemId: string; delta: string; kind: "agentMessage" | "plan" | "reasoningSummary" | "commandOutput" }

export interface ModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoning: string;
  supportedReasoning: Array<{ effort: string; description?: string }>;
  inputModalities: string[];
}

export interface Preferences {
  sidebarMode: "recent" | "projects";
  sortDirection: "asc" | "desc";
  sideChatWidth: number;
  lastProjectId: string | null;
  lastThreadId: string | null;
  fullAccessNoticeSeenProjects: string[];
}

export interface BootstrapPayload {
  eventSeq: number;
  connection: { state: "connected" | "connecting" | "disconnected"; codexVersion: string | null };
  authReady: boolean;
  csrfToken: string;
  vscodeRemoteAuthority: string | null;
  projects: Project[];
  preferences: Preferences;
  models: ModelOption[];
  runtimeStates: ThreadRuntime[];
  activeSideChats: SideChatRuntime[];
  itemDeltas: Record<string, string>;
  sessionPrefills: Record<string, string>;
  pendingRequests: PendingRequestSummary[];
}

export function mergeStreamingText(base: string | null | undefined, update: string | null | undefined): string {
  const current = base ?? "";
  const incoming = update ?? "";
  if (!incoming) return current;
  if (!current) return incoming;
  if (current.endsWith(incoming)) return current;

  const overlapLimit = Math.min(current.length, incoming.length);
  for (let overlap = overlapLimit; overlap > 0; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) return current + incoming.slice(overlap);
  }
  return current + incoming;
}
