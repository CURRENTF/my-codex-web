import type { QueryClient } from "@tanstack/react-query";
import { endpoints, type SessionPayload } from "./api";
import { mergeSessionSnapshot } from "./live-session";

export async function fetchMergedSession(
  client: QueryClient,
  threadId: string,
  signal?: AbortSignal,
): Promise<SessionPayload> {
  const incoming = await endpoints.session(threadId, signal);
  return mergeSessionSnapshot(client.getQueryData<SessionPayload>(["session", threadId]), incoming);
}
