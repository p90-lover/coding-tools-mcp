export function installLinkPreview(doc: Document = document): () => void {
  const preview = doc.createElement("div");
  preview.className = "cx-link-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.dir = "ltr";
  preview.hidden = true;
  doc.body.append(preview);
  let hovered = "", focused = "";

  const hrefAt = (target: EventTarget | null): string => {
    const element = target as Element | null;
    const link = typeof element?.closest === "function" ? element.closest("a[href]") : null;
    const href = link?.getAttribute("href");
    if (!href) return "";
    try { return new URL(href, doc.baseURI).href; } catch { return href; }
  };
  const render = () => {
    const href = hovered || focused;
    if (preview.textContent !== href) preview.textContent = href;
    if (preview.hidden !== !href) preview.hidden = !href;
  };
  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = hrefAt(event.target);
    render();
  };
  const out = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = hrefAt(event.relatedTarget);
    render();
  };
  const focus = (event: FocusEvent) => {
    const target = event.target as Element | null;
    focused = target?.matches?.(":focus-visible") ? hrefAt(target) : "";
    render();
  };
  const unfocus = () => { focused = ""; render(); };
  const clear = () => { hovered = focused = ""; render(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
  const visibility = () => { if (doc.hidden) clear(); };
  const scroll = () => { hovered = ""; render(); };

  doc.addEventListener("pointerover", over);
  doc.addEventListener("pointerout", out);
  doc.addEventListener("focusin", focus);
  doc.addEventListener("focusout", unfocus);
  doc.addEventListener("keydown", key);
  doc.addEventListener("visibilitychange", visibility);
  doc.addEventListener("scroll", scroll, true);
  doc.defaultView?.addEventListener("blur", clear);
  return () => {
    doc.removeEventListener("pointerover", over);
    doc.removeEventListener("pointerout", out);
    doc.removeEventListener("focusin", focus);
    doc.removeEventListener("focusout", unfocus);
    doc.removeEventListener("keydown", key);
    doc.removeEventListener("visibilitychange", visibility);
    doc.removeEventListener("scroll", scroll, true);
    doc.defaultView?.removeEventListener("blur", clear);
    preview.remove();
  };
}
