export function installLinkPreview(doc: Document = document): () => void {
  const preview = doc.createElement("div");
  preview.className = "cx-link-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.dir = "ltr";
  preview.hidden = true;
  doc.body.append(preview);
  type Destination = { href: string; link: Element };
  let hovered: Destination | null = null, focused: Destination | null = null;
  let paletteSource: Element | null = null;

  const hrefAt = (target: EventTarget | null): Destination | null => {
    const element = target as Element | null;
    const link = typeof element?.closest === "function" ? element.closest("a[href]") : null;
    const href = link?.getAttribute("href");
    if (!href || !link) return null;
    try { return { href: new URL(href, doc.baseURI).href, link }; } catch { return { href, link }; }
  };
  const render = () => {
    const destination = hovered || focused;
    const href = destination?.href || "";
    if (destination && paletteSource !== destination.link) {
      const palette = doc.defaultView?.getComputedStyle(destination.link);
      for (const name of ["--color-background-elevated", "--color-text-secondary", "--color-border-heavy"]) {
        const value = palette?.getPropertyValue(name).trim();
        if (value) preview.style.setProperty(name, value);
        else preview.style.removeProperty(name);
      }
      paletteSource = destination.link;
    }
    if (!destination) paletteSource = null;
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
    focused = target?.matches?.(":focus-visible") ? hrefAt(target) : null;
    render();
  };
  const unfocus = () => { focused = null; render(); };
  const clear = () => { hovered = focused = null; render(); };
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
  const visibility = () => { if (doc.hidden) clear(); };
  const scroll = () => { hovered = null; render(); };

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
