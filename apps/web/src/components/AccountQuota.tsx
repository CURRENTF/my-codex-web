import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import type { AccountRateLimits, AccountRateLimitWindow } from "@codex-web/shared-types";
import { api } from "../api";
import { useAppStore } from "../store";

function windowLabel(window: AccountRateLimitWindow): string {
  const minutes = window.windowDurationMins;
  if (minutes === 10_080) return "每周限额";
  if (minutes && minutes > 0) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440} 天限额`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时限额`;
    return `${minutes} 分钟限额`;
  }
  return "限额";
}

function remaining(window: AccountRateLimitWindow): number {
  return Number(Math.max(0, Math.min(100, 100 - window.usedPercent)).toFixed(1));
}

function windows(limit: AccountRateLimits["limits"][number]) {
  return [limit.primary, limit.secondary].flatMap((window) => window && Number.isFinite(window.usedPercent) ? [window] : []);
}

function creditBalance(limit: AccountRateLimits["limits"][number]): string | null {
  if (limit.credits?.unlimited) return "不限额";
  return limit.credits?.balance?.trim() || null;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite",
  team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
};

export function AccountQuota() {
  const connection = useAppStore((state) => state.connectionState);
  const codexConnection = useAppStore((state) => state.codexConnectionState);
  const connected = connection === "connected" && codexConnection === "connected";
  const query = useQuery({
    queryKey: ["account-rate-limits"],
    queryFn: ({ signal }) => api<AccountRateLimits>("/api/account/rate-limits", { signal, cache: "no-store" }),
    refetchInterval: 60_000, refetchIntervalInBackground: false, staleTime: 30_000, retry: false,
    enabled: connected,
  });
  const limits = query.data?.status === "available" ? query.data.limits.filter((limit) => windows(limit).length || creditBalance(limit) !== null) : [];
  const main = limits.find((limit) => limit.id === "codex") ?? limits[0];
  if (!connected || query.isError || !main) return null;
  const mainWindows = windows(main);
  const displayed = mainWindows.find((window) => window.windowDurationMins === 10_080) ?? mainWindows[0];
  const percent = displayed ? remaining(displayed) : null;
  const label = displayed ? `${windowLabel(displayed)}，剩余 ${percent}%` : "查看 Codex 额度";
  const plan = main.planType ? PLAN_NAMES[main.planType] : undefined;
  return <Popover.Root onOpenChange={(open) => { if (open) void query.refetch(); }}>
    <Popover.Trigger asChild><button className={`icon-button account-quota${percent !== null && percent <= 10 ? " low" : ""}`} aria-label="查看 Codex 额度" data-tooltip={label}>
      <svg className="quota-ring" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="quota-ring-track" cx="16" cy="16" r="12" />
        {percent !== null && <circle className="quota-ring-value" cx="16" cy="16" r="12" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 16 16)" />}
        <rect className="quota-ring-center" x="12" y="12" width="8" height="8" rx="1.5" transform="rotate(45 16 16)" />
      </svg>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="quota-popover menu-content" side="bottom" align="start" sideOffset={8} collisionPadding={12} aria-label="Codex 额度详情">
      {plan && <div className="quota-source">额度来源：你的 {plan} 套餐</div>}
      {limits.map((limit) => <div className="quota-group" key={limit.id}>
        {limits.length > 1 && limit.name && <div className="quota-group-name">{limit.name}</div>}
        {windows(limit).map((window, index) => <div className={`quota-row${remaining(window) <= 10 ? " low" : ""}`} key={index} title={window.resetsAt == null ? undefined : `${new Date(window.resetsAt * 1_000).toLocaleString()} 重置`}>
          <span>{windowLabel(window)}</span><span>剩余 {remaining(window)}%</span>
        </div>)}
        {creditBalance(limit) !== null && <div className="quota-row"><span>额度</span><span>{creditBalance(limit)}</span></div>}
      </div>)}
      <a className="quota-manage" href="https://chatgpt.com/codex/settings/usage" target="_blank" rel="noreferrer">管理用量</a>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
