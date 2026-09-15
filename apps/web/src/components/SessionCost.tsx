import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { CurrencyDollar, X } from "@phosphor-icons/react";
import type { SessionCost as SessionCostData } from "@codex-web/shared-types";
import { api } from "../api";
import { useSessionCostPreferences } from "../session-cost-preferences";
import { formatSessionCostUsd } from "../session-cost-presentation";

export function SessionCostSetting() {
  const { enabled, setEnabled } = useSessionCostPreferences();
  return <button className="app-settings-row" role="switch" aria-checked={enabled} aria-label="显示 API 费用" onClick={() => setEnabled(!enabled)}>
    <CurrencyDollar size={18} /><span><strong>显示 API 费用</strong><small>在 Session 顶部显示累计美元估算。仅保存到此浏览器。</small></span>
    <span className={`settings-toggle ${enabled ? "enabled" : ""}`} aria-hidden="true"><span /></span>
  </button>;
}

export function SessionCost({ threadId, revision }: { threadId: string; revision: string }) {
  const enabled = useSessionCostPreferences((state) => state.enabled);
  return enabled ? <SessionCostContent key={threadId} threadId={threadId} revision={revision} /> : null;
}

const tokens = (value: string | null) => value === null ? "未知" : BigInt(value).toLocaleString("en-US");

function SessionCostContent({ threadId, revision }: { threadId: string; revision: string }) {
  const query = useQuery({
    queryKey: ["session-cost", threadId],
    queryFn: ({ signal }) => api<SessionCostData>(`/api/sessions/${encodeURIComponent(threadId)}/cost`, { signal, cache: "no-store" }),
    refetchInterval: (query) => query.state.data?.status === "unsupported" ? false : 30_000,
    refetchIntervalInBackground: false, staleTime: 10_000, retry: false,
  });
  const { refetch } = query;
  // Fetch once on mount and again as a turn starts/settles, including after reconnect.
  useEffect(() => { void refetch(); }, [revision, refetch]);
  const data = query.data;
  const amount = data?.estimatedUsd;
  const label = query.isError ? "费用待更新" : query.isPending ? "费用加载中"
    : amount != null ? `≈ ${formatSessionCostUsd(amount)}` : "费用未知";
  return <Popover.Root>
    <Popover.Trigger asChild><button className="session-cost-trigger" aria-label={`Session API 费用：${label}，点击查看明细`}>
      {query.isPending ? <span className="session-cost-skeleton" aria-hidden="true" /> : label}
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="session-cost-detail menu-content" sideOffset={8} align="end" collisionPadding={12} aria-label="Session API 费用明细">
      <div className="session-cost-heading"><h2>累计 API 费用</h2><Popover.Close asChild><button className="icon-button" aria-label="关闭费用明细"><X size={16} /></button></Popover.Close></div>
      <p className="session-cost-amount">{amount != null ? formatSessionCostUsd(amount) : "暂不可用"}<small>USD 估算{query.isError && amount != null ? "，上次成功读取" : ""}</small></p>
      <p className="session-cost-note">由 Codex 按此 Session 的计费路径返回，可能延迟更新，不代表实际账单。子会话以各自返回的用量为准。</p>
      {query.isPending && <p role="status">正在读取累计用量…</p>}
      {query.isError && <p role="status">费用读取失败，请重试。</p>}
      {data?.status === "unsupported" && <p role="status">当前 Codex 版本不支持会话费用查询。</p>}
      {data?.status === "unavailable" && <p role="status">当前计费路径未提供美元估算，暂时无法显示总价。</p>}
      {!!data?.groups.length && <div className="session-cost-groups">{data.groups.map((group, index) => <section className="session-cost-group" key={index}>
        <h3>{group.model ?? "未知模型"}</h3>
        {(group.reasoningEffort || group.speed) && <p className="session-cost-note">{[group.reasoningEffort, group.speed].filter(Boolean).join(" / ")}</p>}
        <dl><div><dt>输入 tokens</dt><dd>{tokens(group.inputTokens)}</dd></div><div><dt>缓存输入 tokens</dt><dd>{tokens(group.cachedInputTokens)}</dd></div><div><dt>输出 tokens</dt><dd>{tokens(group.outputTokens)}</dd></div></dl>
      </section>)}</div>}
      <div className="session-cost-footer"><small>{query.dataUpdatedAt ? `更新于 ${new Date(query.dataUpdatedAt).toLocaleTimeString()}` : "尚未读取"}</small><button className="session-cost-refresh" disabled={query.isFetching} onClick={() => void refetch()}>{query.isFetching ? "读取中…" : "刷新"}</button></div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
