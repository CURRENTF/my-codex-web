import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackendId, BackendOption, BootstrapPayload } from "@codex-web/shared-types";
import { api } from "./api";

export const backendCatalogKey = (backend: BackendId) => ["backend-catalog", backend] as const;
const CATALOG_STALE_MS = 30_000;

export function useBackendCatalog(backend: BackendId) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: backendCatalogKey(backend),
    queryFn: ({ signal }) => api<BackendOption>(`/api/backends/${backend}?refresh=1`, { signal }),
    initialData: () => client.getQueryData<BootstrapPayload>(["bootstrap"])?.backends?.find((item) => item.id === backend),
    initialDataUpdatedAt: () => client.getQueryState(["bootstrap"])?.dataUpdatedAt,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  return { ...query, refreshIfStale: () => {
    if (Date.now() - query.dataUpdatedAt >= CATALOG_STALE_MS) void query.refetch();
  } };
}
