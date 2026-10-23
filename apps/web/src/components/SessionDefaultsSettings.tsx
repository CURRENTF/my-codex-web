import { BACKEND_IDS, BACKEND_LABELS, type ModelOption } from "@codex-web/shared-types";
import { modelDefaultsForBackend, useComposerPreferences } from "../composer-preferences";
import { useBackendCatalog } from "../backend-catalog";
import { SettingsSelect } from "./SettingsSelect";

export function SessionDefaultsSettings({ models: codexModels }: { models: ModelOption[] }) {
  const backend = useComposerPreferences((state) => state.defaultBackend);
  const askBackend = useComposerPreferences((state) => state.askBackendOnNewSession);
  const setBackend = useComposerPreferences((state) => state.setDefaultBackend);
  const setAskBackend = useComposerPreferences((state) => state.setAskBackendOnNewSession);
  const model = useComposerPreferences((state) => modelDefaultsForBackend(state, backend).defaultModel);
  const reasoning = useComposerPreferences((state) => modelDefaultsForBackend(state, backend).defaultReasoning);
  const setDefaults = useComposerPreferences((state) => state.setBackendDefaults);
  const catalog = useBackendCatalog(backend);
  const models = catalog.data?.models ?? (backend === "codex" ? codexModels : []);
  const inheritedLabel = backend === "codex" ? "使用项目默认" : `使用 ${BACKEND_LABELS[backend]} 默认`;
  const selected = models.find((item) => item.model === model || item.id === model);
  const unavailable = !!model && !selected;
  const invalidEffort = !!selected && reasoning !== null && !selected.supportedReasoning.some((item) => item.effort === reasoning);
  return <section className="session-defaults-settings" aria-label="新 Session 默认设置">
    <h3>新 Session 默认设置</h3>
    <p>自动保存到此浏览器，仅影响之后新建的对话。</p>
    <label className="field-label">默认后端<SettingsSelect
      className="settings-dialog-select" variant="standard" ariaLabel="新 Session 默认后端" menuLabel="默认后端"
      value={backend} placeholder="Codex" options={BACKEND_IDS.map((id) => ({ value: id, label: BACKEND_LABELS[id] }))}
      onValueChange={(next) => setBackend(BACKEND_IDS.find((id) => id === next) ?? "codex")}
    /></label>
    <button className="app-settings-row" role="switch" aria-checked={askBackend} aria-label="每次新建时询问后端" onClick={() => setAskBackend(!askBackend)}>
      <span><strong>每次新建时询问后端</strong><small>关闭时直接使用默认后端，无需重启。</small></span>
      <span className={`settings-toggle ${askBackend ? "enabled" : ""}`} aria-hidden="true"><span /></span>
    </button>
    <label className="field-label">默认模型<SettingsSelect
      className="settings-dialog-select" variant="model" ariaLabel="新 Session 默认模型" menuLabel="默认模型"
      value={selected?.model ?? model ?? ""} placeholder={inheritedLabel}
      options={[{ value: "", label: inheritedLabel }, ...models.map((item) => ({ value: item.model, label: item.displayName, description: item.description, ...(item.isDefault ? { meta: "后端默认" } : {}) }))]}
      onValueChange={(next) => setDefaults(backend, next || null, null)}
      onOpen={catalog.refreshIfStale} onRefresh={() => void catalog.refetch()} refreshing={catalog.isFetching} error={catalog.error?.message ?? catalog.data?.message}
    /></label>
    {backend !== "agy" && (!selected || selected.supportedReasoning.length > 1) && <label className="field-label">默认 effort<SettingsSelect
      className="settings-dialog-select" variant="reasoning" ariaLabel="新 Session 默认 effort" menuLabel="默认 effort"
      value={reasoning ?? ""} placeholder="模型默认" disabled={!selected}
      options={[{ value: "", label: selected ? `模型默认 (${selected.defaultReasoning})` : inheritedLabel }, ...(selected?.supportedReasoning ?? []).map((item) => ({ value: item.effort, label: item.effort, description: item.description }))]}
      onValueChange={(next) => setDefaults(backend, model, next || null)}
    /></label>}
    {(unavailable || invalidEffort) && <p role="alert" className="session-defaults-error">{unavailable ? "已保存的模型当前不可用，请重新选择。" : "已保存的 effort 当前不可用，请重新选择。"}</p>}
  </section>;
}
