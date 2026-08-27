export async function synchronizeLiveSnapshot<T>({
  loadSnapshot,
  applySnapshotAndResumeEvents,
  refreshQueries,
}: {
  loadSnapshot(): Promise<T>;
  applySnapshotAndResumeEvents(snapshot: T): boolean;
  refreshQueries(): Promise<void>;
}): Promise<boolean> {
  const snapshot = await loadSnapshot();
  if (!applySnapshotAndResumeEvents(snapshot)) return false;
  await refreshQueries();
  return true;
}
