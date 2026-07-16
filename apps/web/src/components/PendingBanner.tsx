import { ShieldWarning } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { useAppStore } from "../store";

export function PendingBanner({ threadId }: { threadId: string }) {
  const runtime = useAppStore((state) => state.runtimes[threadId]); const requests = useAppStore((state) => state.pendingRequests);
  const requestId = runtime?.pendingRequestIds[0]; const pending = requestId ? requests[requestId] : undefined;
  const respond = useMutation({ mutationFn: (allow: boolean) => api(`/api/pending-requests/${requestId}/respond`, { method: "POST", body: JSON.stringify({ allow }) }) });
  if (!requestId) return null;
  return <div className="pending-banner"><ShieldWarning size={17} weight="fill" /><span>Codex 正在等待额外确认</span><span className="pending-kind">{pending?.method}</span><button onClick={() => respond.mutate(true)} disabled={respond.isPending}>允许一次</button><button onClick={() => respond.mutate(false)} disabled={respond.isPending}>拒绝</button></div>;
}
