import { useEffect, useId, useState } from "react";
import { onResponseStyles, readResponseStyles, resolveResponseStyle, responseStyleOverride, RESPONSE_STYLES, saveResponseStyle,
  type ResponseStyle, type ResponseStyleContext, type ResponseStyleScope } from "./chat-response-style";

export function ResponseStyleSettings({ context = {} }: { context?: ResponseStyleContext }) {
  const id = useId();
  const [preferences, setPreferences] = useState(readResponseStyles);
  const [provider, setProvider] = useState(context.provider ?? "");
  const [model, setModel] = useState(context.model ?? "");
  const [scope, setScope] = useState<ResponseStyleScope>("provider");
  const [notice, setNotice] = useState("");
  useEffect(() => onResponseStyles(setPreferences), []);
  const target = { provider: provider.trim(), model: model.trim() };
  const choose = (which: ResponseStyleScope, at: ResponseStyleContext, value: string) => {
    try {
      const result = saveResponseStyle(which, at, value === "inherit" ? null : value as ResponseStyle);
      setPreferences(result.preferences);
      setNotice(result.persisted ? "Saved. All open chats using this default update immediately." : "Applied in this window only. Storage is unavailable; this choice will not survive a restart.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : String(cause)); }
  };
  const options = RESPONSE_STYLES.map(style => <option key={style.id} value={style.id}>{style.label}</option>);
  const select = (which: ResponseStyleScope, at: ResponseStyleContext, label: string, disabled = false) =>
    <select className="cxs-select" aria-label={label} disabled={disabled}
      value={responseStyleOverride(preferences, which, at) ?? (which === "global" ? "auto" : "inherit")} onChange={event => choose(which, at, event.target.value)}>
      {which === "global" ? null : <option value="inherit">Use inherited default</option>}{options}
    </select>;
  const savedModels = Object.keys(preferences.models).flatMap(key => {
    try { const [provider, model] = JSON.parse(key); return typeof provider === "string" && typeof model === "string" ? [{ provider, model }] : []; }
    catch { return []; }
  });
  const providers = [...new Set([context.provider, ...Object.keys(preferences.providers), ...savedModels.map(item => item.provider)].filter(Boolean))];
  const effective = resolveResponseStyle(preferences, target);
  const rule = (which: ResponseStyleScope, at: ResponseStyleContext, label: string) =>
    <div className="cxs-row" key={JSON.stringify([which, at])}>
      <div className="cxs-row-text"><div className="cxs-row-label">{label}</div>
        <div className="cxs-row-description">{which === "provider" ? "Every model served by this provider" : which === "chat" ? "This chat only" : "Only this exact provider and model"}</div></div>
      <div className="cxs-row-control">{select(which, at, `Response style for ${label}`)}</div>
    </div>;
  return <div className="cxs-sections">
    <p>Controls how answers, thoughts and actions are displayed. It does not change the selected model or the instructions sent to it.</p>
    <section className="cxs-group"><h2 className="cxs-group-title">Global default</h2><div className="cxs-card">
      <div className="cxs-row"><div className="cxs-row-text"><div className="cxs-row-label">Response style</div>
        <div className="cxs-row-description">For all chats without a more specific override</div></div>
        <div className="cxs-row-control">{select("global", {}, "Global response style")}</div></div>
    </div></section>
    <section className="cxs-group"><h2 className="cxs-group-title">Provider and model defaults</h2><div className="cxs-card">
      <div className="cxs-row"><label className="cxs-row-text" htmlFor={`${id}-provider`}>Provider ID</label>
        <input id={`${id}-provider`} className="cxs-select" aria-label="Response style provider" list={`${id}-providers`} value={provider}
          placeholder="For example, cpa/deepseek" onChange={event => { setProvider(event.target.value); setModel(""); }} />
        <datalist id={`${id}-providers`}>{providers.map(value => <option key={value} value={value} />)}</datalist></div>
      <div className="cxs-row"><label className="cxs-row-text" htmlFor={`${id}-scope`}>Apply to</label>
        <select id={`${id}-scope`} aria-label="Response style scope" className="cxs-select" value={scope} onChange={event => setScope(event.target.value as ResponseStyleScope)}>
          <option value="provider">All models from this provider</option><option value="model">One model</option>
        </select></div>
      {scope === "model" ? <div className="cxs-row"><label className="cxs-row-text" htmlFor={`${id}-model`}>Exact model ID</label>
        <input id={`${id}-model`} className="cxs-select" aria-label="Response style model" list={`${id}-models`} value={model}
          placeholder="Use the full model ID from the chat picker" onChange={event => setModel(event.target.value)} />
        <datalist id={`${id}-models`}>{[...new Set([context.provider === target.provider ? context.model : "", ...savedModels.filter(item => item.provider === target.provider).map(item => item.model)].filter(Boolean))]
          .map(value => <option key={value} value={value} />)}</datalist></div> : null}
      <div className="cxs-row"><div className="cxs-row-text"><div className="cxs-row-label">Response style</div>
        <div className="cxs-row-description">Effective: {RESPONSE_STYLES.find(style => style.id === effective.style)?.label} · {effective.source} default. Chat overrides still take priority.</div></div>
        <div className="cxs-row-control">{select(scope, target, "Scoped response style", !target.provider || scope === "model" && !target.model)}</div></div>
    </div></section>
    <section className="cxs-group"><h2 className="cxs-group-title">Saved overrides</h2><div className="cxs-card">
      {Object.keys(preferences.providers).map(provider => rule("provider", { provider }, provider))}
      {savedModels.map(at => rule("model", at, `${at.provider} · ${at.model}`))}
      {Object.keys(preferences.chats).map(chat => rule("chat", { chat }, chat))}
      {!Object.keys(preferences.providers).length && !savedModels.length && !Object.keys(preferences.chats).length ? <div className="cxs-row">No overrides. Chats inherit the global default.</div> : null}
    </div></section>
    <p role="status">{notice || "Priority: this chat, this model, this provider, then global. Choose Use inherited default to remove an override."}</p>
  </div>;
}
