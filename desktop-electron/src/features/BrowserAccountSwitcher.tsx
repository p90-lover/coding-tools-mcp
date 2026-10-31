import { useCallback, useEffect, useState } from "react";
import type { Copy } from "../i18n";
import type { BrowserAccountsStatus, GptBrowserAccount, LauncherApi } from "../types";

const accountName = (account: GptBrowserAccount) => account.email ?? account.label;

/**
 * The Browser tab's ChatGPT accounts, in its own toolbar: pick one or add one. Removing accounts
 * lives in ChatGPT browser management only, where each is ticked and confirmed; a Remove button
 * here took the account shown with it. The active account is also the one new Codex WebGPT chats
 * run on. A switch keeps the account left loaded and running turns going; only a check or test of
 * the shown page holds it (`busy` greys the controls meanwhile).
 */
export function BrowserAccountSwitcher({ api, copy, busy, setError }: {
  api: LauncherApi;
  copy: Copy;
  busy: boolean;
  setError: (error: string | null) => void;
}) {
  const [status, setStatus] = useState<BrowserAccountsStatus | null>(null);

  useEffect(() => {
    let live = true;
    void api.browserAccounts().then(next => { if (live) setStatus(next); }).catch(() => {});
    const unsubscribe = api.onBrowserAccountsChanged(next => setStatus(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api]);

  const run = useCallback(async (action: () => Promise<BrowserAccountsStatus>) => {
    setError(null);
    try {
      setStatus(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [setError]);

  if (!status) return null;
  const locked = busy || status.switching;
  const full = status.accounts.length >= status.maxAccounts;
  return (
    <div className="browser-accounts" title={copy.browserAccountHint}>
      <select
        aria-label={copy.browserAccount}
        className="browser-account-select"
        disabled={locked}
        onChange={event => void run(() => api.switchBrowserAccount(event.target.value))}
        value={status.activeId}
      >
        {status.accounts.map(account => (
          <option key={account.id} value={account.id}>{accountName(account)}</option>
        ))}
      </select>
      {status.switching ? <span className="browser-account-note">{copy.browserAccountSwitching}</span> : null}
      {/* A disabled button shows no tooltip of its own: the wrapper carries why it is off. */}
      <span title={full ? copy.browserAccountFull : undefined}>
        <button
          className="toolbar-text-button"
          disabled={locked || full}
          onClick={() => void run(() => api.addBrowserAccount())}
          type="button"
        >
          {copy.browserAccountAdd}
        </button>
      </span>
    </div>
  );
}
