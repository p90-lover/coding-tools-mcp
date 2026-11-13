import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

export function BrowserAddressBar({ url, displayAddress, targetId, disabled, navigate, setError, focusRequests = 0 }: {
  url: string;
  displayAddress: string;
  targetId?: number;
  disabled: boolean;
  navigate: (input: { url: string; targetId: number }) => Promise<unknown>;
  setError: (message: string | null) => void;
  /** Goes up each time Ctrl+L, Alt+D or F6 is pressed on the page: the address is selected for typing. */
  focusRequests?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef<string | null>(null);
  const request = useRef(0);
  const input = useRef<HTMLInputElement | null>(null);
  const locked = disabled || !Number.isSafeInteger(targetId) || !targetId || targetId < 0;
  useEffect(() => () => { request.current += 1; }, []);
  useEffect(() => {
    if (focusRequests > 0 && !locked) input.current?.focus();
  }, [focusRequests, locked]);

  const submit = async () => {
    const address = draft?.trim();
    if (locked || !address || submitting.current === address) return;
    submitting.current = address;
    const ownRequest = ++request.current;
    setPending(true);
    setError(null);
    try {
      await navigate({ url: address, targetId: targetId! });
      if (request.current !== ownRequest) return;
      // Do not erase a newer, unsubmitted edit when an earlier page finally finishes loading.
      setDraft(current => current?.trim() === address ? null : current);
    } catch (cause) {
      if (request.current === ownRequest) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === ownRequest) {
        submitting.current = null;
        setPending(false);
      }
    }
  };

  return (
    <form className="browser-address" title={url} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Icon name="globe" />
      <input
        ref={input}
        aria-label="Browser address"
        autoCapitalize="off"
        autoComplete="off"
        aria-busy={pending}
        disabled={locked}
        onFocus={event => { setDraft(url); event.currentTarget.value = url; event.currentTarget.select(); }}
        onBlur={() => { if (!submitting.current) setDraft(null); }}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
          if (event.key === "Escape") { event.preventDefault(); setDraft(null); event.currentTarget.blur(); }
        }}
        spellCheck={false}
        type="text"
        value={draft ?? displayAddress}
      />
    </form>
  );
}
