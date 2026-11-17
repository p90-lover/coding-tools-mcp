import type { ChatMenuItem } from "./ChatMenu";
import { resolveResponseStyle, responseStyleOverride, RESPONSE_STYLES,
  type ResponseStyle, type ResponseStyleContext, type ResponseStylePreferences, type ResponseStyleScope } from "./chat-response-style";

export function responseStyleMenu(preferences: ResponseStylePreferences, context: ResponseStyleContext,
  save: (scope: ResponseStyleScope, style: ResponseStyle | null) => void, settings: () => void): ChatMenuItem {
  const effective = resolveResponseStyle(preferences, context);
  const label = (value: ResponseStyle) => RESPONSE_STYLES.find(style => style.id === value)?.label ?? value;
  const scope = (id: ResponseStyleScope, name: string, available: boolean): ChatMenuItem => {
    const own = responseStyleOverride(preferences, id, context);
    return { label: name, detail: own === undefined ? "Inherited" : label(own),
      ...(available ? { items: [
        ...(id === "global" ? [] : [{ label: "Use inherited default", checked: own === undefined, run: () => save(id, null) }]),
        ...RESPONSE_STYLES.map(style => ({ label: style.label, detail: style.hint, checked: own === style.id, run: () => save(id, style.id) })),
      ] } : { reason: id === "chat" ? "Open a saved chat first" : "Provider or model identity is not available yet" }) };
  };
  return { label: "Response style", detail: `${label(effective.style)} · ${effective.source}`, items: [
    scope("chat", "This chat", Boolean(context.chat)),
    scope("model", `This model${context.model ? ` · ${context.model}` : ""}`, Boolean(context.provider && context.model)),
    scope("provider", `All models from${context.provider ? ` ${context.provider}` : " this provider"}`, Boolean(context.provider)),
    scope("global", "Global default", true),
    { kind: "separator" }, { label: "Response style settings…", icon: "settings", run: settings },
  ] };
}
