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
  runtimeState: RuntimeState;
  hasGoal: boolean;
}

export interface ThreadRuntime {
  threadId: string;
  activeTurnId?: string;
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
  fullAccessNoticeSeen: boolean;
}

export interface BootstrapPayload {
  connection: { state: "connected" | "connecting" | "disconnected"; codexVersion: string | null };
  authReady: boolean;
  csrfToken: string;
  projects: Project[];
  preferences: Preferences;
  models: ModelOption[];
  runtimeStates: ThreadRuntime[];
  activeSideChats: SideChatRuntime[];
}
