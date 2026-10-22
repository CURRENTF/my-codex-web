import type { ModelOption } from "@codex-web/shared-types";
import { useComposerPreferences } from "../composer-preferences";
import { SettingsSelect } from "./SettingsSelect";

export function SessionDefaultsSettings({ models }: { models: ModelOption[] }) {
  const backend = useComposerPreferences((state) => state.defaultBackend);
  const askBackend = useComposerPreferences((state) => state.askBackendOnNewSession);
  const setBackend = useComposerPreferences((state) => state.setDefaultBackend);
  const setAskBackend = useComposerPreferences((state) => state.setAskBackendOnNewSession);
  const model = useComposerPreferences((state) => state.defaultModel);
  const reasoning = useComposerPreferences((state) => state.defaultReasoning);
  const setDefaults = useComposerPreferences((state) => state.setSessionDefaults);
  const selected = models.find((item) => item.model === model || item.id === model);
  const unavailable = !!model && !selected;
  const invalidEffort = !!selected && reasoning !== null && !selected.supportedReasoning.some((item) => item.effort === reasoning);
  return <section className="session-defaults-settings" aria-label="新 Session 默认设置">
    <h3>新 Session 默认设置</h3>
    <p>自动保存到此浏览器，仅影响之后新建的对话。</p>
    <label className="field-label">默认后端<SettingsSelect
      className="settings-dialog-select" variant="standard" ariaLabel="新 Session 默认后端" menuLabel="默认后端"
      value={backend} placeholder="Codex" options={[{ value: "codex", label: "Codex" }, { value: "pi", label: "pi" }]}
      onValueChange={(next) => setBackend(next === "pi" ? "pi" : "codex")}
    /></label>
    <button className="app-settings-row" role="switch" aria-checked={askBackend} aria-label="每次新建时询问后端" onClick={() => setAskBackend(!askBackend)}>
      <span><strong>每次新建时询问后端</strong><small>关闭时直接使用默认后端，无需重启。</small></span>
      <span className={`settings-toggle ${askBackend ? "enabled" : ""}`} aria-hidden="true"><span /></span>
    </button>
    <p>以下模型设置仅用于 Codex，优先于项目默认。pi 使用其自身的模型配置。</p>
    <label className="field-label">默认模型<SettingsSelect
      className="settings-dialog-select" variant="model" ariaLabel="新 Session 默认模型" menuLabel="默认模型"
      value={selected?.model ?? model ?? ""} placeholder="使用项目默认"
      options={[{ value: "", label: "使用项目默认" }, ...models.map((item) => ({ value: item.model, label: item.displayName, description: item.description }))]}
      onValueChange={(next) => setDefaults(next || null, null)}
    /></label>
    <label className="field-label">默认 effort<SettingsSelect
      className="settings-dialog-select" variant="reasoning" ariaLabel="新 Session 默认 effort" menuLabel="默认 effort"
      value={reasoning ?? ""} placeholder="模型默认" disabled={!selected}
      options={[{ value: "", label: selected ? `模型默认 (${selected.defaultReasoning})` : "使用项目默认" }, ...(selected?.supportedReasoning ?? []).map((item) => ({ value: item.effort, label: item.effort, description: item.description }))]}
      onValueChange={(next) => setDefaults(model, next || null)}
    /></label>
    {(unavailable || invalidEffort) && <p role="alert" className="session-defaults-error">{unavailable ? "已保存的模型当前不可用，请重新选择。" : "已保存的 effort 当前不可用，请重新选择。"}</p>}
  </section>;
}
