import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { useComposerPopover } from "./AgentOrchestratorComposerControls";
import { CheckGlyph, FolderGlyph, GlobeGlyph, HandGlyph, ShieldAlertGlyph, ShieldCodeGlyph, TerminalGlyph, WarningGlyph } from "./AgentOrchestratorPermissionGlyphs";
import type { KeyboardEvent, ReactNode } from "react";
import type { AoMission, AoNode } from "./AgentOrchestratorSurface";
import { NATIVE_HARNESS, nativePermission, type AoTeam } from "./AgentOrchestratorRoleEditor";

export type PermissionCapability = {
  supported: boolean; reason?: string;
  profiles: { id: string; allowed: boolean; description?: string }[];
  approval_policies?: string[]; approvals_reviewers?: string[];
  /** Whole modes the adapter cannot honour although each part is listed (agy's Ask: its approvals stay in its terminal). */
  excluded_modes?: { profile: string; policy: string; reviewer: string; reason?: string }[];
  requirements?: Record<string, unknown>;
};
const excludedMode = (capability: PermissionCapability, selection: PermissionSelection) => capability.excluded_modes?.find(mode =>
  mode.profile === selection.profile && mode.policy === selection.policy && mode.reviewer === selection.reviewer);
export type RuntimePermissionPolicy = { policy_acknowledged: boolean; effective_policy?: { permission_profile?: string; active_permission_profile?: string; approval_policy?: string; approvals_reviewer?: string } | null };
export type PermissionSelection = { profile?: string; policy?: string; reviewer?: string };
/** The selected chat owns its role list. Include generated helpers without saving new roles. */
export function missionPermissionNodes(mission: AoMission): AoNode[] {
  const nodes = (mission.team?.nodes ?? []).map(node => ({ ...node, route: { ...node.route } }));
  for (const attempt of [...mission.nodes].reverse()) {
    const id = attempt.template_role_id || attempt.id;
    if (!nodes.some(node => node.id === id)) nodes.push({ ...attempt, id, route: { ...attempt.route } });
  }
  return nodes;
}
export function permissionSummary(nodes: AoNode[]): string {
  const values = new Set(nodes.map(node => [nativePermission(node.route), node.route.approval_policy ?? "Legacy", node.route.approvals_reviewer ?? "Legacy"].join(" · ")));
  return values.size > 1 ? "Mixed" : values.values().next().value || "Unknown";
}
/** Persist only explicit fields, never replay a historical chat's other routes or saved permissions. */
export function mergeSavedPermissions(saved: AoTeam, ids: string[], selection: PermissionSelection): AoTeam {
  if (ids.some(id => !saved.nodes.some(node => node.id === id))) throw new Error("This role no longer exists in the team. Refresh and try again.");
  return { ...saved, nodes: saved.nodes.map(node => {
    if (!ids.includes(node.id)) return node;
    const route = { ...node.route };
    if (selection.profile !== undefined) {
      route.native_permission_profile = selection.profile;
      if (route.harness_id === NATIVE_HARNESS) route.permission_profile = selection.profile;
    }
    if (selection.policy !== undefined) route.approval_policy = selection.policy;
    if (selection.reviewer !== undefined) route.approvals_reviewer = selection.reviewer;
    return { ...node, route };
  }) };
}
export function selectPermissions(team: AoTeam, ids: string[], selection: PermissionSelection): AoTeam {
  return { ...team, nodes: team.nodes.map(node => {
    if (!ids.includes(node.id)) return node;
    const route = { ...node.route };
    if (selection.profile !== undefined) { if (route.harness_id === NATIVE_HARNESS) route.permission_profile = selection.profile; route.native_permission_profile = selection.profile; }
    if (selection.policy !== undefined) route.approval_policy = selection.policy;
    if (selection.reviewer !== undefined) route.approvals_reviewer = selection.reviewer;
    return { ...node, route };
  }) };
}

// Codex's three approval modes, in its order, glyphs and wording; Full access is drawn as a warning.
export const PERMISSION_MODES = [
  { label: "Ask for approval", detail: "Always ask to edit external files and use the internet", icon: "hand", profile: ":workspace", policy: "on-request", reviewer: "user", danger: false },
  { label: "Approve for me", detail: "Only ask for actions detected as potentially unsafe", icon: "shieldCode", profile: ":workspace", policy: "on-request", reviewer: "auto_review", danger: false },
  { label: "Full access", detail: "Unrestricted access to the internet and any file on your computer", icon: "shieldAlert", profile: ":danger-full-access", policy: "never", reviewer: "user", danger: true },
] as const;
const MODE_GLYPHS = { hand: HandGlyph, shieldCode: ShieldCodeGlyph, shieldAlert: ShieldAlertGlyph };

// Codex's "Turn on Full Access?" dialog: what the agents can then do, three capability rows, Cancel and Confirm.
const FULL_ACCESS_CAPABILITIES = [
  { glyph: FolderGlyph, title: "Files and folders", detail: "Read, create, modify, upload, or delete files anywhere on this computer" },
  { glyph: TerminalGlyph, title: "Terminal commands", detail: "Run commands, install software, and change system settings" },
  { glyph: GlobeGlyph, title: "Internet and connected apps", detail: "Access websites, send data, and use enabled plugins" },
] as const;

/**
 * Asks before Full access is armed. It covers the whole window like Codex's, so it renders into
 * document.body, carrying the chat's light or dark theme with it. Escape and a click outside cancel.
 */
export function FullAccessDialog({ dark, onCancel, onConfirm }: { dark: boolean; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus({ preventScroll: true }); }, []);
  // React events bubble out of a portal to the composer that owns it; the dialog keeps its own.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Tab") return;
    // Keep focus on the two buttons while the dialog is up.
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const first = buttons[0], last = buttons[buttons.length - 1], active = document.activeElement;
    if (event.shiftKey ? active === first : active === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
  };
  const dialog = <div className="cx-fullaccess" data-theme={dark ? "dark" : "light"} onKeyDown={onKeyDown} onClick={event => event.stopPropagation()}
    onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onCancel(); }}>
    <section className="cx-fullaccess-panel" role="dialog" aria-modal="true" aria-labelledby="cx-fullaccess-title" aria-describedby="cx-fullaccess-description">
      <form onSubmit={event => { event.preventDefault(); onConfirm(); }}>
        <div className="cx-fullaccess-section"><h2 id="cx-fullaccess-title"><WarningGlyph />Turn on Full Access?</h2></div>
        <div className="cx-fullaccess-section"><p id="cx-fullaccess-description">These agents will be able to run commands, use the internet, and create and edit files anywhere on this computer without your permission. This includes but is not limited to:</p></div>
        <div className="cx-fullaccess-section"><div className="cx-fullaccess-capabilities">
          {FULL_ACCESS_CAPABILITIES.map(({ glyph: Glyph, title, detail }) => <div key={title} className="cx-fullaccess-capability">
            <Glyph />
            <div><strong>{title}</strong><small>{detail}</small></div>
          </div>)}
        </div></div>
        <div className="cx-fullaccess-section"><p>This comes with risks like loss or exposure of sensitive data and prompt injection. You can turn this off. Project MCP access stays the same.</p></div>
        <div className="cx-fullaccess-section"><div className="cx-fullaccess-actions">
          <button ref={cancel} type="button" className="cx-fullaccess-cancel" onClick={onCancel}>Cancel</button>
          <button type="submit" className="cx-fullaccess-confirm"><WarningGlyph />Confirm</button>
        </div></div>
      </form>
    </section>
  </div>;
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}

/**
 * The permission choices a role may take before it has connected, when there is no runtime yet
 * to report its capabilities. The choice is only saved on the role's route: the connection is
 * refused later if that route's permissions don't match what the runtime grants.
 */
export function draftPermissionCapability(): PermissionCapability {
  // Every Codex mode, Full access included: choosing it still asks in FullAccessDialog first.
  const unique = (values: string[]) => [...new Set(values)];
  return { supported: true,
    profiles: unique(PERMISSION_MODES.map(mode => mode.profile)).map(id => ({ id, allowed: true })),
    approval_policies: unique(PERMISSION_MODES.map(mode => mode.policy)),
    approvals_reviewers: unique(PERMISSION_MODES.map(mode => mode.reviewer)) };
}

export function AgentOrchestratorPermissions({ team, mission, busy, loadProfiles, save, runtimePolicies }: {
  team: AoTeam | null; mission?: AoMission; busy: boolean;
  loadProfiles: (roleId: string) => Promise<PermissionCapability>;
  save: (team: AoTeam, missionRevision: number | undefined, selectedRoleIds: string[], selection: PermissionSelection) => Promise<string>;
  /** Retained for legacy callers; shared grant controls deliberately do not render here. */
  shared?: ReactNode; runtimePolicies?: Record<string, RuntimePermissionPolicy>;
}) {
  const popup = useComposerPopover();
  const [metadata, setMetadata] = useState<Record<string, PermissionCapability>>({});
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Full access waiting on the dialog, and whether the chat it opened from is dark. */
  const [confirming, setConfirming] = useState<{ selection: PermissionSelection; dark: boolean } | null>(null);
  const nodes = team?.nodes ?? [];
  const supported = nodes.filter(node => metadata[node.id]?.supported);
  const key = nodes.map(node => node.id).join("|");
  useEffect(() => { popup.setOpen(false); setMetadata({}); setNotice(""); setConfirming(null); }, [mission?.id, team?.id]);
  useEffect(() => {
    if (!popup.open) return;
    let live = true;
    setMetadata({}); setNotice("");
    void Promise.all(nodes.map(async node => {
      try { return [node.id, await loadProfiles(node.id)] as const; }
      catch (cause) { return [node.id, { supported: false, profiles: [], reason: String(cause) }] as const; }
    })).then(entries => { if (live) setMetadata(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [popup.open, key, loadProfiles]);
  const capabilities = supported.map(node => metadata[node.id]);
  const available = nodes.length > 0 && nodes.every(node => metadata[node.id]?.supported === true);
  const canSelect = (selection: PermissionSelection) => available && capabilities.every(capability =>
    capability.profiles.some(profile => profile.id === selection.profile && profile.allowed) &&
    capability.approval_policies?.includes(selection.policy!) && capability.approvals_reviewers?.includes(selection.reviewer!)
    && !excludedMode(capability, selection));
  /** Why a mode is unavailable: the adapter's own reason for a mode it excludes, else the general one. */
  const unavailableReason = (selection: PermissionSelection) => capabilities.map(capability => excludedMode(capability, selection)?.reason).find(Boolean) || reason;
  const active = PERMISSION_MODES.find(mode => nodes.length > 0 && nodes.every(node =>
    nativePermission(node.route) === mode.profile && node.route.approval_policy === mode.policy && node.route.approvals_reviewer === mode.reviewer));
  const effective = mission?.nodes.filter(node => ["running", "reserved"].includes(node.state)).map(node => {
    const status = runtimePolicies?.[mission.id + ":" + node.id];
    return status?.policy_acknowledged && status.effective_policy ? "Active: " + Object.values(status.effective_policy).join(" · ")
      : "Active permissions not confirmed yet";
  }).join("; ");
  const reason = nodes.map(node => metadata[node.id]?.reason).filter(Boolean).join("; ")
    || (!nodes.length ? "Choose a model or saved team first." : !nodes.every(node => metadata[node.id] !== undefined) ? "Checking permissions…" : !supported.length ? "This agent can't change permissions. Settings are unchanged." : "This agent or your policy doesn't allow this.");
  const apply = async (selection: PermissionSelection) => {
    if (!team || !canSelect(selection) || busy || saving) return;
    setSaving(true); setNotice(""); setFailed(false);
    try {
      const ids = supported.map(node => node.id);
      setNotice(await save(selectPermissions(team, ids, selection), mission?.revision, ids, selection));
    } catch (cause) { setFailed(true); setNotice(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  // As in Codex, picking a row closes the menu at once; Full access first asks in its own dialog.
  const choose = (selection: PermissionSelection) => {
    if (!team || !canSelect(selection) || busy || saving) return;
    popup.close();
    if (selection.profile !== ":danger-full-access") { void apply(selection); return; }
    setConfirming({ selection, dark: popup.root.current?.closest("[data-theme]")?.getAttribute("data-theme") === "dark" });
  };
  const settle = (confirmed: boolean) => {
    const selection = confirming?.selection;
    setConfirming(null);
    popup.trigger.current?.focus({ preventScroll: true });
    if (confirmed && selection) void apply(selection);
  };
  const ChipGlyph = active ? MODE_GLYPHS[active.icon] : null;
  // The chip is its level's icon (each level has its own), its name in the label and tooltip; Full
  // access is tinted, so the risky level still stands out without its words.
  return <div className="ao-permissions ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
    <button type="button" className="ao-composer-chip" ref={popup.trigger} aria-expanded={popup.open} aria-haspopup="menu"
      aria-controls="ao-permissions-panel" aria-label={`Permissions: ${active?.label || "Custom"}`} data-danger={active?.danger ? "" : undefined}
      disabled={busy || saving} title={(active?.label || "Custom") + "\n" + permissionSummary(nodes) + (effective ? " · " + effective : "") + (notice && !failed ? " · " + notice : "")}
      onClick={() => popup.setOpen(value => !value)}>
      {ChipGlyph ? <ChipGlyph width="16" height="16" /> : <Icon name="shield" width="16" height="16" />}
    </button>
    {popup.open ? <section ref={popup.panel} id="ao-permissions-panel" className="ao-composer-popover ao-permissions-panel" aria-label="Access permissions" role="menu">
      <div className="ao-permissions-title">How should actions be approved?</div>
      {PERMISSION_MODES.map(mode => {
        const Glyph = MODE_GLYPHS[mode.icon];
        return <button key={mode.label} type="button" role="menuitemradio" aria-checked={active?.label === mode.label}
          className={"ao-permission-option" + (mode.danger ? " is-danger" : "")} disabled={busy || saving || !canSelect(mode)} title={canSelect(mode) ? "Applies from the next turn" : unavailableReason(mode)}
          onClick={() => choose({ profile: mode.profile, policy: mode.policy, reviewer: mode.reviewer })}>
          <span className="ao-permission-symbol"><Glyph /></span>
          <span className="ao-permission-text"><strong>{mode.label}</strong><small>{mode.detail}</small></span>
          {active?.label === mode.label ? <CheckGlyph className="ao-permission-check" /> : null}
        </button>;
      })}
    </section> : null}
    {confirming ? <FullAccessDialog dark={confirming.dark} onCancel={() => settle(false)} onConfirm={() => settle(true)} /> : null}
    {notice ? <span className="ao-permission-notice" role={failed ? "alert" : "status"}
      style={failed ? undefined : { position: "absolute", width: 1, height: 1, minWidth: 0, padding: 0, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0 }}>{notice}</span> : null}
  </div>;
}
