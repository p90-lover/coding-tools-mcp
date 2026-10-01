(() => {
  const HELPER_VERSION = '0.0.11';
  if (globalThis.__codingToolsMcpExtensionV001Loaded) return;
  globalThis.__codingToolsMcpExtensionV001Loaded = true;
  const STRINGS = {
    settings: ['settings', '設定', '设置'],
    apps: ['apps', 'connectors', '插件', '應用', '应用'],
    create: ['create', 'add', 'new app', 'new plugin', '新增', '建立', '創建', '创建', '添加'],
    manage: ['manage', 'settings', '管理', '設定', '设置'],
    // Delete and Uninstall are different actions. Uninstall only drops the app from the installed
    // list; an app you own stays in Personal. Only Delete removes it, so Delete is listed first and
    // matched first.
    // "disconnect" is deliberately absent: the Manage menu offers Reconnect/Disconnect/Delete side
    // by side, and with two menus open at once a loose match hits Disconnect first in DOM order —
    // dropping the app's authorization instead of removing it.
    remove: ['delete', 'remove', '刪除', '删除', '移除'],
    deleteApp: ['delete', '刪除', '删除'],
    confirmRemove: ['delete', 'remove', 'confirm', '刪除', '删除', '移除', '確認', '确认'],
    scan: ['scan tools', 'scan', 'discover tools', '掃描工具', '扫描工具', '掃描', '扫描'],
    createFinal: ['create', 'save', '建立', '創建', '创建', '儲存', '保存'],
    oauth: ['oauth'],
    noAuth: ['none', 'no authentication', 'no auth', '無', '无', '不驗證', '不验证'],
    advancedOauth: ['advanced oauth', 'oauth settings', 'advanced settings', '進階 oauth', '高级 oauth', '進階設定', '高级设置'],
    serverUrlMode: ['server url', 'server address', '伺服器網址', '服务器地址'],
    manualOauth: ['manual', 'static', 'client credentials', '手動', '手动', '靜態', '静态'],
    accountMenu: ['profile', 'account', 'user menu', 'open profile', '個人資料', '个人资料', '帳戶', '账户'],
    signIn: ['sign in', 'signin', 'log in', 'login', 'connect', 'authorize', 'authenticate', '登入', '登录', '連接', '连接', '授權', '授权'],
    pluginActions: ['plugin actions', 'app actions', 'connector actions'],
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const canonicalAppIdentity = (value) => normalize(value).replace(/[^\p{L}\p{N}]+/gu, '');
  const sameAppIdentity = (left, right) => Boolean(canonicalAppIdentity(left) && canonicalAppIdentity(left) === canonicalAppIdentity(right));
  const containsAppIdentity = (text, appName) => {
    const wanted = canonicalAppIdentity(appName);
    return Boolean(wanted && canonicalAppIdentity(text).includes(wanted));
  };
  const visible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  // innerText and textContent carry the same visible label, so they must not be concatenated:
  // a plain <button>Create</button> would otherwise read as "create create" and never match exactly.
  function elementLabels(el) {
    if (!el) return [];
    const labels = [
      el.innerText ?? el.textContent,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('placeholder'),
      el.getAttribute?.('data-testid'),
    ].map(normalize).filter(Boolean);
    return [...new Set(labels)];
  }

  function elementText(el) {
    return elementLabels(el).join(' ');
  }

  function textMatches(el, values, exact = false) {
    const labels = elementLabels(el);
    return values.some((value) => {
      const wanted = normalize(value);
      if (!wanted) return false;
      return exact ? labels.includes(wanted) : labels.some((label) => label.includes(wanted));
    });
  }

  function allClickable(root = document) {
    return [...root.querySelectorAll('button, [role="button"], a, [role="menuitem"], [role="tab"]')].filter(visible);
  }

  function findClickable(values, root = document, exact = false) {
    const candidates = allClickable(root);
    return candidates.find((el) => textMatches(el, values, exact)) || null;
  }

  function findClickablePreferExact(values, root = document) {
    return findClickable(values, root, true) || findClickable(values, root, false);
  }

  async function waitFor(fn, timeoutMs = 9000, step = 200) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = fn();
      if (result) return result;

      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) break;
      const waitMs = Math.min(step, remaining);

      // Most ChatGPT page state arrives through DOM mutations. Wake immediately when that happens
      // instead of always paying the next polling interval; keep the timer as a safe fallback for
      // non-DOM state changes and pages where observation is unavailable.
      if (typeof MutationObserver === 'function' && document?.documentElement) {
        await new Promise((resolve) => {
          let settled = false;
          const observer = new MutationObserver(() => finish());
          let timerId = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            observer.disconnect();
            if (timerId !== null) clearTimeout(timerId);
            resolve();
          };
          try {
            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
            timerId = setTimeout(finish, waitMs);
          } catch {
            observer.disconnect();
            timerId = setTimeout(finish, waitMs);
          }
        });
      } else {
        await sleep(waitMs);
      }
    }
    return null;
  }

  function setInputValue(input, value) {
    if (!input) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }

  // Only fields a value can actually be typed into. Without this, findInput('url') could match the
  // dialog's hidden file input and setInputValue would silently write nowhere.
  const TEXTUAL_INPUT_TYPES = new Set(['', 'text', 'url', 'search', 'email', 'password', 'tel', 'number']);

  function inputs(root = document) {
    return [...root.querySelectorAll('input, textarea')].filter((el) => {
      if (!visible(el)) return false;
      if (el.tagName === 'TEXTAREA') return true;
      return TEXTUAL_INPUT_TYPES.has(normalize(el.getAttribute('type')));
    });
  }

  function associatedLabelText(input) {
    const id = input.id;
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const parentLabel = input.closest('label');
    let container = input.parentElement;
    const nearby = [];
    for (let i = 0; i < 4 && container; i += 1, container = container.parentElement) {
      nearby.push(container.querySelector?.('label')?.innerText || '');
      nearby.push(container.querySelector?.('[data-slot="label"]')?.innerText || '');
      nearby.push(container.getAttribute?.('aria-label') || '');
    }
    return normalize([
      byFor?.innerText,
      parentLabel?.innerText,
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.name,
      ...nearby,
    ].filter(Boolean).join(' '));
  }

  // ChatGPT's OAuth advanced panel names its fields with a plain element rendered ABOVE the input
  // ("Auth URL", "Authorization server base", "Resource") instead of a <label for>. Those fields
  // have no id, name, aria-label or useful placeholder, so the preceding text is the only name they
  // have. Kept as a separate, lower-priority pass so it cannot loosen the primary matching.
  function precedingLabelText(input) {
    const parts = [];
    const push = (el) => {
      if (!el) return;
      parts.push(String(el.innerText ?? el.textContent ?? '').slice(0, 80));
    };
    let sibling = input.previousElementSibling;
    for (let i = 0; i < 2 && sibling; i += 1, sibling = sibling.previousElementSibling) push(sibling);
    let block = input.parentElement;
    for (let i = 0; i < 3 && block; i += 1, block = block.parentElement) push(block.previousElementSibling);
    return normalize(parts.filter(Boolean).join(' '));
  }

  function inputKeys(kind) {
    switch (kind) {
      case 'name': return ['app name', 'plugin name', 'name', '名稱', '名称'];
      case 'description': return ['description', '描述'];
      case 'url': return ['mcp server url', 'mcp url', 'endpoint', 'server url', 'connector url', 'connector-url', 'connection url', 'connection', 'mcp', '連線', '连接', '端點', '端点'];
      case 'clientId': return ['oauth client id', 'client id', 'client_id', '用戶端 id', '客户端 id'];
      case 'clientSecret': return ['oauth client secret', 'client secret', 'client_secret', '用戶端密鑰', '客户端密钥', '客戶端密鑰'];
      case 'authorizeUrl': return ['authorization url', 'authorization endpoint', 'authorize url', 'auth url', '授權 url', '授权 url'];
      case 'tokenUrl': return ['token url', 'token endpoint', '權杖 url', '令牌 url'];
      case 'authServerBase': return ['authorization server base', 'authorization server', 'auth server base'];
      case 'resource': return ['resource'];
      case 'registrationUrl': return ['registration url', 'registration endpoint'];
      default: return [];
    }
  }

  function findInput(kind, root = document) {
    const keys = inputKeys(kind).map(normalize);
    const candidates = inputs(root);
    const byLabel = candidates.find((input) => {
      const label = associatedLabelText(input);
      return keys.some((key) => label.includes(key));
    });
    if (byLabel) return byLabel;

    if (kind === 'url') {
      // ChatGPT's create dialog gives the endpoint field no label and no aria-label — it is
      // identifiable only by its id/name (custom-connector-url) and its https:// placeholder.
      const byShape = candidates.find((input) => {
        const idName = normalize(`${input.id || ''} ${input.name || ''}`);
        if (/(^|[^a-z])url([^a-z]|$)/.test(idName)) return true;
        return /^https?:\/\//.test(normalize(input.getAttribute('placeholder')));
      });
      if (byShape) return byShape;
    }

    return candidates.find((input) => {
      const label = precedingLabelText(input);
      return keys.some((key) => label.includes(key));
    }) || null;
  }

  // Only real dialogs. A bare [data-state="open"] is NOT one: ChatGPT's sidebar, accordions and
  // other Radix parts carry it, so including it made activeSurface() return the open sidebar. Every
  // search scoped to the "active surface" — findExactAppNode above all — then looked inside the
  // sidebar, never found the app card, and concluded no app existed. That is what made sync skip
  // detection and go straight to creating.
  function visibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
  }

  function activeSurface() {
    const dialogs = visibleDialogs();
    return dialogs.at(-1) || document;
  }

  function directText(el) {
    if (!el) return '';
    return normalize([...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || '')
      .join(' '));
  }

  function findExactAppNode(appName) {
    const wanted = canonicalAppIdentity(appName);
    const surface = activeSurface();
    const scopes = surface === document ? [document.body] : [surface, document.body];
    const textHits = [];
    // Search the active surface first, then fall back to the whole page. Scoping alone is not
    // trustworthy: the app card lives outside any dialog, so a scoped-only search silently reports
    // "no such app" whenever some unrelated overlay is open.
    for (const scope of scopes) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (canonicalAppIdentity(textNode.nodeValue) !== wanted) continue;
        const parent = textNode.parentElement;
        if (parent && visible(parent) && !textHits.includes(parent)) textHits.push(parent);
      }
      if (textHits.length) break;
    }
    if (textHits.length) {
      return textHits.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0];
    }

    const candidates = scopes
      .flatMap((scope) => [...scope.querySelectorAll('h1,h2,h3,h4,p,span,div,a,button,[role="button"],[role="link"]')])
      .filter(visible);
    return candidates
      .filter((el) => {
        const labels = [directText(el), el.getAttribute?.('aria-label'), el.getAttribute?.('title')].filter(Boolean);
        return labels.some((value) => canonicalAppIdentity(value) === wanted);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0] || null;
  }

  const PERSONAL_PLUGINS_PATH = '/plugins';
  const PERSONAL_VIEW_LABELS = ['personal', 'created by you', 'my plugins', 'my apps', '個人', '个人', '我的'];

  function isChatGptHost(host) {
    const lower = String(host || '').toLowerCase();
    return /(^|\.)chatgpt\.com$/.test(lower) || lower === 'chat.openai.com';
  }

  // ChatGPT drops ?view=personal and lands on a bare /plugins whenever the personal list is empty.
  // That redirected page is still the page this sync drives, so it must not be treated as wrong_page.
  //
  // Only the "view" parameter is inspected. ChatGPT appends unrelated query parameters of its own,
  // and background.js used to demand that "view" be the ONLY parameter — so the worker rejected a
  // page the content script had accepted and kept opening fresh tabs. Both now apply this rule.
  function isPersonalPluginsUrl(urlString) {
    try {
      const current = new URL(urlString);
      if (!isChatGptHost(current.hostname)) return false;
      if (current.pathname.replace(/\/+$/, '') !== PERSONAL_PLUGINS_PATH) return false;
      const view = current.searchParams.get('view');
      return !view || view === 'personal';
    } catch {
      return false;
    }
  }

  // A ChatGPT app detail page (/plugins/<id>), which is NOT the list this sync drives.
  function isPluginDetailUrl(urlString) {
    try {
      const current = new URL(urlString);
      if (!isChatGptHost(current.hostname)) return false;
      return /^\/plugins\/[^/]+/.test(current.pathname);
    } catch {
      return false;
    }
  }

  /**
   * True when the URL looks like a ChatGPT plugins/apps/connectors manager, including renamed
   * settings-style routes. Conversation and plugin-detail URLs are excluded.
   */
  function isPotentialPluginsManagerUrl(urlString) {
    try {
      const current = new URL(urlString);
      if (!isChatGptHost(current.hostname) || isPluginDetailUrl(urlString)) return false;
      return /(^|\/)(plugins|connectors|apps)(\/|$)/i.test(current.pathname);
    } catch {
      return false;
    }
  }

  function pluginsManagerToolbarPresent() {
    const search = inputs(document).some((el) => {
      const labels = elementLabels(el);
      return labels.some((label) => /search\s+(plugins?|apps?|connectors?)/i.test(label));
    });
    if (!search) return false;
    return allClickable(document).some((el) => {
      const labels = elementLabels(el);
      return labels.some((label) => /^(create|add|new)(\s+new)?\s+(app|plugin|connector)$/i.test(label));
    });
  }

  function renderedPluginCardEvidence() {
    return pluginCardLinks().some((link) => {
      const openLabel = elementLabels(link)
        .map((label) => label.match(/^(?:open|manage|edit)\s+(.+)$/i)?.[1] || '')
        .find(Boolean);
      const wanted = canonicalAppIdentity(openLabel);

      let container = link.parentElement;
      for (let depth = 0; depth < 4 && container; depth += 1, container = container.parentElement) {
        const text = normalize(container.innerText || container.textContent);
        if (text.length > 1800) continue;

        // Real manager cards typically carry an action/menu button. This is strong structural
        // evidence even when ChatGPT renames the link label.
        if (container.querySelectorAll?.('button,[role="button"],[role="menuitem"]')?.length) return true;

        // When the link says "Open <app>", require the same app identity to also appear as a
        // separate label in the card. A pasted link inside conversation text has no such sibling.
        if (wanted) {
          const siblings = [...(container.querySelectorAll?.('span,div,h1,h2,h3,h4,p') || [])];
          if (siblings.some((node) => node !== link && canonicalAppIdentity(directText(node)) === wanted)) return true;
        }
        if (container === document.body) break;
      }
      return false;
    });
  }

  /**
   * True when the current page is the personal plugins list.
   *
   * The URL is the primary signal but not the only one: ChatGPT has renamed this route before, and
   * a URL-only test then reports wrong_page for a list that is fully rendered in front of us. A
   * manager-like route actually serving plugin cards or the plugins toolbar is therefore accepted
   * too. Conversation pages and plugin detail pages are excluded — they carry plugin links of
   * their own and must never be treated as the list.
   */
  function isPersonalPluginsPage() {
    if (isPersonalPluginsUrl(location.href)) return true;
    if (isPluginDetailUrl(location.href)) return false;
    if (!isPotentialPluginsManagerUrl(location.href)) return false;
    return renderedPluginCardEvidence() || pluginsManagerToolbarPresent();
  }

  async function waitForPersonalPluginsPage(timeoutMs = 3000) {
    if (isPersonalPluginsPage()) return true;
    // Normal conversation routes should fail fast. The short grace period is only for manager-like
    // routes ChatGPT may rename while their client-side UI is still rendering.
    if (!isPotentialPluginsManagerUrl(location.href)) return false;
    return Boolean(await waitFor(() => (isPersonalPluginsPage() ? true : null), timeoutMs, 250));
  }

  // Best effort only, and deliberately limited to in-page tab controls: clicking a navigating
  // anchor here would tear down this content script mid-request. An empty personal list
  // legitimately has no Personal tab to select, so failing to find one is not an error.
  async function ensurePersonalView() {
    try {
      if (new URL(location.href).searchParams.get('view') === 'personal') return true;
    } catch {
      return false;
    }
    const tabs = [...document.querySelectorAll('[role="tab"], button')].filter(visible);
    const personal = tabs.find((el) => textMatches(el, PERSONAL_VIEW_LABELS, true));
    if (!personal) return false;
    personal.click();
    await sleep(400);
    return true;
  }

  function canonicalMcpEndpoint(rawValue) {
    let raw = String(rawValue || '').trim().replace(/[),.;]+$/, '');
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'https:') return '';
      parsed.hash = '';
      parsed.search = '';
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      if (!/\/mcp$/i.test(parsed.pathname)) return '';
      return `${parsed.origin.toLowerCase()}${parsed.pathname}`;
    } catch {
      return '';
    }
  }

  function collectMcpEndpoints(root) {
    if (!root) return [];
    const values = [];
    const push = (value) => {
      const canonical = canonicalMcpEndpoint(value);
      if (canonical && !values.includes(canonical)) values.push(canonical);
    };

    for (const input of root.querySelectorAll?.('input, textarea') || []) push(input.value);
    for (const anchor of root.querySelectorAll?.('a[href]') || []) push(anchor.href);
    for (const el of root.querySelectorAll?.('[data-url], [data-endpoint], [data-mcp-url]') || []) {
      push(el.getAttribute('data-url'));
      push(el.getAttribute('data-endpoint'));
      push(el.getAttribute('data-mcp-url'));
    }

    const text = String(root.textContent || '');
    for (const match of text.matchAll(/https:\/\/[^\s"'<>]+/gi)) push(match[0]);
    return values;
  }

  function appContainerFor(node, appName) {
    if (!node) return null;
    let current = node;
    let best = null;
    for (let i = 0; i < 8 && current && current !== document.body; i += 1, current = current.parentElement) {
      const text = String(current.textContent || '');
      if (!containsAppIdentity(text, appName)) continue;
      const controls = current.querySelectorAll?.('button,[role="button"],a,[role="link"],[role="menuitem"]')?.length || 0;
      if (controls > 0) best = current;
      if (menuButtonForAppCard(current) && normalize(text).length < 1800) return current;
    }
    return best || node.parentElement;
  }

  // Require the endpoint field specifically. A page-wide "mcp" text check used to be enough, which
  // is true on the plugins list itself and would report a form that is not open.
  function createFormPresent() {
    return Boolean(findInput('url') && findInput('name'));
  }

  function exactAppClickable(appNode) {
    if (!appNode || !visible(appNode)) return null;
    const clickable = appNode.matches?.('a[href],button,[role="button"],[role="link"]')
      ? appNode
      : appNode.closest('a[href],button,[role="button"],[role="link"]');
    if (clickable && visible(clickable)) {
      const text = String(clickable.textContent || clickable.getAttribute?.('aria-label') || '');
      const compact = normalize(clickable.innerText || clickable.textContent);
      if (containsAppIdentity(text, appNode.textContent) && !['+', '＋'].includes(compact)) return clickable;
    }

    // If ChatGPT renders the app name as plain text inside a JS-clickable row, click the exact
    // matched name node itself. HTMLElement.click() bubbles to the row handler without touching
    // the separate + action at the right side of the row.
    return appNode;
  }

  async function mainWorldEndpointsForApp(appName) {
    const requestId = `ctmcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return await new Promise((resolve) => {
      let settled = false;
      const cleanup = () => document.removeEventListener('coding-tools-mcp:inspect-result', onResult);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onResult = (event) => {
        let payload;
        try { payload = JSON.parse(String(event.detail || '{}')); } catch { return; }
        if (payload.requestId !== requestId) return;
        finish(Array.isArray(payload.endpoints) ? payload.endpoints.map(canonicalMcpEndpoint).filter(Boolean) : []);
      };
      document.addEventListener('coding-tools-mcp:inspect-result', onResult);
      document.dispatchEvent(new CustomEvent('coding-tools-mcp:inspect-request', {
        detail: JSON.stringify({ requestId, appName }),
      }));
      setTimeout(() => finish([]), 1400);
    });
  }

  function pointerActivate(target, coordinateSource = target) {
    if (!target) return;
    const rect = coordinateSource?.getBoundingClientRect?.() || target.getBoundingClientRect?.();
    const clientX = rect ? rect.left + Math.min(Math.max(rect.width * 0.35, 4), Math.max(rect.width - 4, 4)) : 0;
    const clientY = rect ? rect.top + rect.height / 2 : 0;
    const common = { bubbles: true, cancelable: true, composed: true, clientX, clientY, button: 0, buttons: 1 };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', common)); } catch {}
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 })); } catch { target.click?.(); }
  }

  async function openExactAppDetails(appNode, appName) {
    if (!appNode) return { opened: false, detailUrl: '', surface: null };
    const beforeUrl = location.href;
    const beforeDialogs = new Set(visibleDialogs());
    const candidates = [];
    const add = (el) => {
      if (!el || !visible(el) || candidates.includes(el)) return;
      const compact = normalize(el.innerText || el.textContent);
      if (['+', '＋'].includes(compact)) return;
      candidates.push(el);
    };
    add(appNode.matches?.('a[href],button,[role="button"],[role="link"]') ? appNode : null);
    add(appNode.closest?.('a[href],button,[role="button"],[role="link"]'));
    let current = appNode;
    for (let i = 0; i < 6 && current; i += 1, current = current.parentElement) {
      const cursor = getComputedStyle(current).cursor;
      if (cursor === 'pointer' || current.tabIndex >= 0 || current.getAttribute?.('data-state')) add(current);
    }
    add(appNode);

    for (const candidate of candidates) {
      const anchor = candidate.matches?.('a[href]') ? candidate : candidate.closest?.('a[href]');
      if (anchor?.href && anchor.href !== location.href) {
        return { opened: false, detailUrl: anchor.href, surface: null };
      }
      pointerActivate(candidate, appNode);
      const signal = await waitFor(() => {
        if (location.href !== beforeUrl) return { kind: 'url', value: location.href };
        const newDialog = visibleDialogs().find((dialog) => !beforeDialogs.has(dialog) && containsAppIdentity(dialog.textContent || '', appName));
        if (newDialog) return { kind: 'surface', value: newDialog };
        const surface = activeSurface();
        if (surface !== document && containsAppIdentity(surface.textContent || '', appName)) return { kind: 'surface', value: surface };
        if (findInput('url', surface)) return { kind: 'surface', value: surface };
        return null;
      }, 1600, 120);
      if (signal?.kind === 'url') return { opened: false, detailUrl: signal.value, surface: null };
      if (signal?.kind === 'surface') return { opened: true, detailUrl: '', surface: signal.value };
    }
    return { opened: false, detailUrl: '', surface: null };
  }

  function scriptEndpointForApp(appName) {
    const found = [];
    for (const script of document.scripts) {
      const text = String(script.textContent || '');
      if (!containsAppIdentity(text, appName)) continue;
      const decodedText = text.replaceAll('\\/', '/');
      for (const match of decodedText.matchAll(/https:\/\/[^\s"'<>]+/gi)) {
        const canonical = canonicalMcpEndpoint(match[0]);
        if (canonical && !found.includes(canonical)) found.push(canonical);
      }
    }
    return found.length === 1 ? found[0] : '';
  }

  // The app card's own "Open <app>" anchor, e.g. /plugins/plugin_asdk_app_<id>.
  function cardDetailUrl(card) {
    if (!card) return '';
    const anchor = [...card.querySelectorAll('a[href]')].find((el) => {
      const match = (el.getAttribute('href') || '').match(/^\/plugins\/([^?#/]+)/);
      return match && !['discover', 'store', 'featured', 'categories'].includes(match[1].toLowerCase());
    });
    return anchor?.href || '';
  }

  async function inspectExistingApp(appName) {
    await clearPluginSearch();
    const gridCard = await waitFor(() => findGridArticle(appName), 2200, 150);
    if (gridCard) {
      const cardEndpoints = collectMcpEndpoints(gridCard);
      return {
        found: true,
        endpoint: cardEndpoints.length === 1 ? cardEndpoints[0] : '',
        appNode: gridCard,
        card: gridCard,
        detailsOpened: false,
        source: 'grid',
      };
    }

    // A renamed manager route may paint the card outside the first <main>. Read the
    // painted identity without clicking sidebar/composer chrome.
    const appNode = findExactAppNode(appName);
    if (!appNode || isUnsafeChrome(appNode)) {
      return { found: false, endpoint: '', appNode: null, card: null, detailsOpened: false };
    }
    const card = appContainerFor(appNode, appName);
    const cardRect = card?.getBoundingClientRect?.();
    if (!card || isUnsafeChrome(card) || !(inPluginList(card) || isCardLikeRect(cardRect))) {
      return { found: false, endpoint: '', appNode: null, card: null, detailsOpened: false };
    }
    const cardEndpoints = collectMcpEndpoints(card);
    if (cardEndpoints.length === 1) {
      return { found: true, endpoint: cardEndpoints[0], appNode, card, detailsOpened: false, source: 'card' };
    }
    const linkedDetailUrl = cardDetailUrl(card);
    if (linkedDetailUrl) {
      return { found: true, endpoint: '', appNode, card, detailsOpened: false, detailUrl: linkedDetailUrl, source: 'card-link' };
    }
    return { found: true, endpoint: '', appNode, card, detailsOpened: false, source: 'name' };
  }

  function menuButtonForAppCard(card) {
    if (!card) return null;
    const candidates = [...card.querySelectorAll('button,[role="button"]')].filter(visible);
    const labelled = candidates.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      const aria = normalize(el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute('title'));
      const testid = normalize(el.getAttribute('data-testid'));
      return ['…', '...', '⋯'].includes(text)
        || /(^|\s)(actions|more|options|manage|menu)(\s|$)/.test(aria)
        || /(^|\s)(actions|more|options|manage|menu)(\s|$)/.test(title)
        || /(menu|more|options|manage|actions)/.test(testid);
    });
    if (labelled) return labelled;

    // ChatGPT only attaches aria-label="Actions for <app>" while the row is hovered; unhovered the
    // control is an icon-only button with no text and no label at all. It is still the sole
    // textless button in the card, which is enough to identify it without guessing.
    const iconOnly = candidates.filter((el) => !normalize(el.innerText || el.textContent));
    return iconOnly.length === 1 ? iconOnly[0] : null;
  }

  // Opening the Manage panel can leave the card's own menu mounted, so two menus are visible at
  // once and their items interleave. Read only the most recently opened menu.
  function menuItemsNow() {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    const newest = menus.at(-1);
    if (newest) {
      const scoped = [...newest.querySelectorAll('[role="menuitem"]')].filter(visible);
      if (scoped.length) return scoped;
    }
    return [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
  }

  function pluginActionsButtonIn(scope) {
    if (!scope) return null;
    return allClickable(scope).find((el) => textMatches(el, STRINGS.pluginActions, false)) || null;
  }

  function isUnsafeChrome(el) {
    return Boolean(el?.closest?.('nav, aside, [role="navigation"], [data-testid^="history"], [data-testid*="composer"], form'));
  }

  function pluginGridArticles() {
    const root = pluginListRoot();
    const roots = root ? [root] : [];
    const found = [];
    const add = (el) => {
      if (!el || found.includes(el) || !visible(el) || isUnsafeChrome(el)) return;
      const rect = el.getBoundingClientRect();
      // Sidebar rows are about 233x36. Real plugin cards are taller.
      if (rect.width < 180 || rect.height < 72 || rect.width > 760 || rect.height > 560) return;
      found.push(el);
    };
    for (const root of roots) {
      for (const el of root.querySelectorAll('article, [role="article"]')) add(el);
      for (const el of root.querySelectorAll('div, li, a, section')) {
        const display = getComputedStyle(el).display;
        if (display !== 'grid' && display !== 'inline-grid') continue;
        for (const child of el.children) add(child);
      }
    }
    return found;
  }

  function exactNameIn(article, appName) {
    const wanted = canonicalAppIdentity(appName);
    if (!wanted || !article) return false;
    const heading = article.querySelector('h1, h2, h3, h4');
    if (heading && canonicalAppIdentity(heading.innerText || heading.textContent) === wanted) return true;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (canonicalAppIdentity(node.nodeValue) === wanted) return true;
    }
    return false;
  }

  function otherAppTitleIn(article, appName) {
    const wanted = canonicalAppIdentity(appName);
    const titles = [...article.querySelectorAll('h1, h2, h3, h4')]
      .map((el) => canonicalAppIdentity(el.innerText || el.textContent))
      .filter(Boolean);
    return titles.some((title) => title !== wanted);
  }

  function pluginListRoot() {
    // The plugins search is right-aligned. Grid cards sit to its left, so the
    // list root is main, not the search field's column. ChatGPT settings SPA can
    // leave a loading <main> mounted and append a later list <main> — prefer the
    // one that already shows plugin-card evidence.
    const mains = [...document.querySelectorAll('main')];
    for (let i = mains.length - 1; i >= 0; i -= 1) {
      const main = mains[i];
      if (!visible(main) || isUnsafeChrome(main)) continue;
      const hasListEvidence = [...main.querySelectorAll('a[href], article, [role="article"]')].some((el) => {
        if (el.tagName === 'ARTICLE' || el.getAttribute('role') === 'article') return true;
        return /\/plugins\/[^/?#]+/i.test(el.getAttribute('href') || '');
      });
      if (hasListEvidence) return main;
    }
    const visibleMains = mains.filter((el) => visible(el) && !isUnsafeChrome(el));
    return visibleMains[visibleMains.length - 1] || document.body;
  }

  function isSidebarRow(el) {
    if (!el) return true;
    if (isUnsafeChrome(el)) return true;
    if (el.closest?.('input, textarea, [role="search"]')) return true;
    const rect = el.getBoundingClientRect();
    return rect.left < 220 && rect.width <= 280 && rect.height <= 56;
  }

  function isCardLikeRect(rect) {
    return Boolean(rect)
      && rect.width >= 160
      && rect.height >= 44
      && rect.height <= 640
      && rect.width <= 1400;
  }

  // Name labels inside a card are small and often left-aligned. They must not be discarded as
  // sidebar rows when an ancestor already has plugin-card dimensions.
  function hasCardLikeAncestor(el) {
    const root = pluginListRoot();
    let current = el;
    for (let i = 0; i < 12 && current && current !== root && current !== document.body; i += 1, current = current.parentElement) {
      if (isUnsafeChrome(current)) break;
      if (isCardLikeRect(current.getBoundingClientRect())) return true;
    }
    return false;
  }

  function inPluginList(el) {
    if (!el || isUnsafeChrome(el)) return false;
    const root = pluginListRoot();
    if (!root?.contains(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    if (isSidebarRow(el) && !hasCardLikeAncestor(el)) return false;
    return true;
  }

  function labelIsApp(value, appName) {
    const wanted = canonicalAppIdentity(appName);
    const got = canonicalAppIdentity(value);
    if (!wanted || !got) return false;
    if (got === wanted) return true;
    return got.includes(wanted) && got.length <= wanted.length + 24;
  }

  function pluginNameNodes(appName) {
    const wanted = canonicalAppIdentity(appName);
    const root = pluginListRoot();
    if (!wanted || !root) return [];
    const hits = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (canonicalAppIdentity(node.nodeValue) !== wanted) continue;
      const parent = node.parentElement;
      if (!parent || !visible(parent) || !inPluginList(parent)) continue;
      if (parent.closest('input, textarea')) continue;
      hits.push(parent);
    }
    if (hits.length) return hits;
    return [...root.querySelectorAll('h1, h2, h3, h4, a, button, [aria-label], [title], img')].filter((el) => {
      if (!visible(el) || !inPluginList(el)) return false;
      const own = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('alt'),
        el.innerText || el.textContent,
      ].join(' ');
      return labelIsApp(own, appName);
    });
  }

  function cardAroundName(nameEl, appName) {
    const root = pluginListRoot();
    let current = nameEl;
    let best = null;
    for (let i = 0; i < 12 && current && current !== root && current !== document.body; i += 1, current = current.parentElement) {
      if (isUnsafeChrome(current)) break;
      if (!inPluginList(current)) continue;
      const rect = current.getBoundingClientRect();
      if (!isCardLikeRect(rect)) continue;
      if (!exactNameIn(current, appName) || otherAppTitleIn(current, appName)) continue;
      best = current;
      if (dotsButtonIn(current, appName)) return current;
    }
    return best;
  }

  function findGridArticle(appName) {
    const tagged = pluginGridArticles().find((article) => exactNameIn(article, appName) && !otherAppTitleIn(article, appName) && inPluginList(article));
    if (tagged) return tagged;

    const hits = pluginNameNodes(appName);
    for (const nameEl of hits) {
      const card = cardAroundName(nameEl, appName);
      // Existence does not require the ⋯ control to have painted. Requiring it treated a
      // fully rendered nested card as absent and sent Sync down the create path.
      if (card && inPluginList(card)) return card;
    }
    return null;
  }

  function installedNameVisible(appName) {
    return pluginNameNodes(appName).length > 0;
  }

  async function clearPluginSearch() {
    const input = pluginSearchInput();
    if (!input || !input.value) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, '');
    else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
    return true;
  }

  async function filterPluginSearch(appName) {
    const input = pluginSearchInput();
    if (!input || !appName) return false;
    if (canonicalAppIdentity(input.value) === canonicalAppIdentity(appName)) return true;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    try { input.focus(); } catch {}
    if (setter) setter.call(input, appName);
    else input.value = appName;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(450);
    return true;
  }

  async function hoverCard(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    const rect = el.getBoundingClientRect();
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + Math.min(28, Math.max(8, rect.width / 3)),
      clientY: rect.top + Math.min(20, Math.max(8, rect.height / 2)),
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      try {
        const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, common));
      } catch {}
    }
    await sleep(200);
  }

  function isForbiddenDotsTarget(el) {
    if (!el) return true;
    if (isUnsafeChrome(el)) return true;
    const label = normalize([
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.innerText || el.textContent,
    ].filter(Boolean).join(' '));
    // Conversation / project / Pets / sidebar chrome must never receive the delete click.
    return /(history-item|conversation|pin |project|pets?|寵物|宠物|composer|sidebar|profile|account|new chat|organize)/.test(label)
      || Boolean(el.closest('[data-testid^="history"], [data-testid*="composer"], nav, aside'));
  }

  function dotsNearName(nameEl, scope = null) {
    if (!nameEl) return null;
    const root = scope || pluginListRoot();
    if (!root) return null;
    const nameRect = nameEl.getBoundingClientRect();
    const buttons = allClickable(root).filter((el) => {
      if (scope && !scope.contains(el)) return false;
      if (el.closest('[role="menu"], [role="menuitem"], [role="dialog"]')) return false;
      if (isForbiddenDotsTarget(el)) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 12 || rect.height < 12 || rect.width > 56 || rect.height > 56) return false;
      const sameRow = Math.abs((rect.top + rect.height / 2) - (nameRect.top + nameRect.height / 2)) < 40;
      // Stay on the card: only a short distance to the right of the name.
      return sameRow && rect.left >= nameRect.left - 4 && rect.left <= nameRect.right + 120;
    });
    if (!buttons.length) return null;
    const labelled = buttons.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      const aria = normalize(el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute('title'));
      return ['…', '...', '⋯', '⋮'].includes(text)
        || ['…', '...', '⋯', '⋮'].includes(aria)
        || DOT_LABEL.test(aria)
        || DOT_LABEL.test(title)
        || el.getAttribute('aria-haspopup') === 'menu';
    });
    if (labelled) return labelled;
    if (buttons.length !== 1) return null;
    return buttons[0];
  }

  async function dismissOpenMenus() {
    for (let i = 0; i < 3 && newestMenu(); i += 1) {
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      } catch {}
      await sleep(120);
    }
  }

  function pluginCardMenuLooksValid(menu) {
    if (!menu) return false;
    const items = allClickable(menu).map((el) => normalize(el.innerText || el.textContent || el.getAttribute('aria-label')));
    const joined = items.join(' | ');
    if (/(^|\|)(pets?|寵物|宠物|pin |unpin|share|archive|rename|delete chat|new chat)(\||$)/.test(joined)
      && !/(manage|管理|delete|刪除|删除)/.test(joined)) {
      return false;
    }
    return items.some((label) => ['manage', '管理'].includes(label) || label.includes('manage') || label.includes('管理'));
  }

  const DOT_LABEL = /(more|options|menu|actions|更多|選項|选项|操作|選單|菜单)/;

  function pointInside(el, box) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  }

  function dotsButtonIn(scope, appName = '') {
    if (!scope) return null;
    const box = scope.getBoundingClientRect();
    const wanted = canonicalAppIdentity(appName);
    const buttons = [...scope.querySelectorAll('button, [role="button"]')].filter((el) => {
      if (!visible(el)) return false;
      if (!scope.contains(el)) return false;
      if (el.closest('[role="menu"], [role="menuitem"]')) return false;
      if (isForbiddenDotsTarget(el)) return false;
      if (!pointInside(el, box)) return false;
      return true;
    });
    if (wanted) {
      const namedForApp = buttons.find((el) => {
        const aria = canonicalAppIdentity(el.getAttribute('aria-label'));
        const title = canonicalAppIdentity(el.getAttribute('title'));
        return (aria && aria.includes(wanted)) || (title && title.includes(wanted));
      });
      if (namedForApp) return namedForApp;
    }
    const labelled = buttons.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      const aria = normalize(el.getAttribute('aria-label'));
      const title = normalize(el.getAttribute('title'));
      return ['…', '...', '⋯', '⋮'].includes(text)
        || ['…', '...', '⋯', '⋮'].includes(aria)
        || DOT_LABEL.test(aria)
        || DOT_LABEL.test(title)
        || el.getAttribute('aria-haspopup') === 'menu';
    });
    if (labelled) return labelled;
    const iconOnly = buttons.filter((el) => {
      if (normalize(el.innerText || el.textContent)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width <= 56 && rect.height <= 56 && rect.width >= 12;
    });
    if (!iconOnly.length) return null;
    if (iconOnly.length === 1) return iconOnly[0];
    return iconOnly.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const aScore = (box.right - (ar.left + ar.width / 2)) + Math.max(0, ar.top - box.top);
      const bScore = (box.right - (br.left + br.width / 2)) + Math.max(0, br.top - box.top);
      return aScore - bScore;
    })[0];
  }

  function newestMenu() {
    return popoverRoots().at(-1) || null;
  }

  function popoverRoots() {
    return [...document.querySelectorAll('[role="menu"], [data-radix-popper-content-wrapper], [data-radix-menu-content]')]
      .filter(visible);
  }

  function menuItemNamed(values) {
    const menu = newestMenu();
    if (!menu) return null;
    return allClickable(menu).find((el) => textMatches(el, values, true))
      || allClickable(menu).find((el) => textMatches(el, values, false))
      || null;
  }

  function openedPanel(appName, beforeDialogs) {
    const wanted = canonicalAppIdentity(appName);
    return visibleDialogs().find((el) => {
      if (beforeDialogs.has(el)) return false;
      return canonicalAppIdentity(el.textContent || '').includes(wanted);
    }) || null;
  }

  /**
   * Only the coding-tools-mcp grid card. If that card is not unique, click nothing.
   */
  async function deleteViaManage(appName) {
    if (!isPersonalPluginsPage()) return { removed: false, reason: 'wrong_page' };
    await clearPluginSearch();
    let article = await waitFor(() => findGridArticle(appName), 2200, 150);
    if (!article) {
      await filterPluginSearch(appName);
      article = await waitFor(() => findGridArticle(appName), 1200, 150);
    }
    if (!article) return { removed: false, reason: 'grid_article_not_found' };

    // Fail closed: only click ⋯ that lives inside this exact card. Never hunt across the page —
    // that is how Pets / chat options / project menus get opened.
    if (!exactNameIn(article, appName) || otherAppTitleIn(article, appName)) {
      return { removed: false, reason: 'card_name_ambiguous' };
    }
    await hoverCard(article);
    const nameEl = pluginNameNodes(appName).find((el) => article.contains(el) || article === el) || null;
    let dots = dotsButtonIn(article, appName);
    if (!dots && nameEl) dots = dotsNearName(nameEl, article);
    if (!dots || !article.contains(dots) || isForbiddenDotsTarget(dots)) {
      return { removed: false, reason: 'app_menu_not_found' };
    }
    await dismissOpenMenus();
    await pointerActivateMenu(dots);

    const manage = await waitFor(() => {
      const menu = newestMenu();
      if (!pluginCardMenuLooksValid(menu)) return null;
      return menuItemNamed(['manage', '管理']);
    }, 4000, 150);
    if (!manage) {
      await dismissOpenMenus();
      return { removed: false, reason: 'manage_not_reachable' };
    }

    const beforeDialogs = new Set(visibleDialogs());
    await pointerActivateMenu(manage);

    const panel = await waitFor(() => openedPanel(appName, beforeDialogs), 12000, 250);
    if (!panel || !canonicalAppIdentity(panel.textContent || '').includes(canonicalAppIdentity(appName))) {
      return { removed: false, reason: 'manage_panel_not_open' };
    }

    const manageDots = await waitFor(() => {
      const current = openedPanel(appName, beforeDialogs);
      if (!current) return null;
      const button = dotsButtonIn(current, appName);
      return button && current.contains(button) && button !== dots ? button : null;
    }, 8000, 250);
    if (!manageDots) return { removed: false, reason: 'manage_menu_not_found' };
    await pointerActivateMenu(manageDots);

    const del = await waitFor(() => menuItemNamed(STRINGS.deleteApp), 6000, 200);
    if (!del) return { removed: false, reason: 'delete_item_not_found' };
    await pointerActivateMenu(del);

    const confirm = await waitFor(() => {
      for (const dialog of visibleDialogs()) {
        if (dialog === panel) continue;
        if (!containsAppIdentity(dialog.textContent, appName)) continue;
        const button = allClickable(dialog).find((el) => textMatches(el, STRINGS.confirmRemove, true) || textMatches(el, STRINGS.deleteApp, true));
        if (button && button !== del) return button;
      }
      return null;
    }, 4000, 200);
    if (confirm) await pointerActivateMenu(confirm);

    const gone = await waitFor(() => !findGridArticle(appName), 9000, 300);
    if (!gone) return { removed: false, reason: 'still_present_after_delete' };
    await dismissOpenMenus();
    for (let i = 0; i < 4 && visibleDialogs().length; i += 1) {
      if (!(await closeOpenDialog())) break;
    }
    await clearPluginSearch();
    // Always hand create back to the worker. Staying on this page leaves the Manage overlay
    // and leftover name text, which would look "still present" and skip recreate.
    return { removed: true, reason: 'deleted', returnToPlugins: true };
  }

  async function removeExistingStrict(appName, inspection = null) {
    const currentInspection = inspection?.found ? inspection : await inspectExistingApp(appName);
    const card = findGridArticle(appName);
    if (!card) {
      // Already deleted. Let Sync create instead of failing closed on a sidebar name match.
      return { removed: true, reason: 'already_absent', returnToPlugins: true };
    }
    if (!currentInspection.found) {
      return { removed: true, reason: 'already_absent', returnToPlugins: true };
    }

    // Fail closed. Never fall through to a page-wide click if the exact card is missing.
    const viaManage = await deleteViaManage(appName);
    return viaManage.removed ? viaManage : { removed: false, reason: viaManage.reason || 'delete_refused' };

    let remove = null;
    const surface = activeSurface();
    if (containsAppIdentity(surface.textContent, appName)) {
      remove = findClickablePreferExact(STRINGS.remove, surface);
    }

    if (!remove) {
      const appNode = findExactAppNode(appName);
      const card = appContainerFor(appNode, appName);
      const menu = menuButtonForAppCard(card);
      if (!menu) return { removed: false, reason: 'app_menu_not_found' };
      // Radix dropdown: a bare .click() opens and instantly re-closes it, so the menu was never
      // actually readable here.
      await pointerActivateMenu(menu);
      remove = await waitFor(() => {
        const popup = [...document.querySelectorAll('[role="menu"]')].filter(visible).at(-1);
        if (popup) {
          const item = allClickable(popup).find((el) => textMatches(el, STRINGS.remove, true));
          if (item) return item;
        }
        return findClickablePreferExact(STRINGS.remove, activeSurface());
      }, 4000, 200);
    }

    if (!remove) return { removed: false, reason: 'remove_not_available' };
    await pointerActivateMenu(remove);
    await sleep(400);

    const confirm = await waitFor(() => {
      const dialogs = visibleDialogs();
      for (const dialog of dialogs) {
        if (!containsAppIdentity(dialog.textContent, appName) && !normalize(dialog.textContent).includes('remove') && !normalize(dialog.textContent).includes('delete')) continue;
        const button = findClickablePreferExact(STRINGS.confirmRemove, dialog);
        if (button && button !== remove) return button;
      }
      return null;
    }, 3500);
    if (confirm) confirm.click();

    const gone = await waitFor(() => !findExactAppNode(appName), 7000, 250);
    return gone ? { removed: true, reason: 'removed' } : { removed: false, reason: 'still_present' };
  }

  const SEARCH_TERMS = ['search plugins', 'search apps', 'search connectors', '搜尋外掛程式', '搜索插件', '搜尋插件', '搜索应用', '搜尋應用'];

  function pluginSearchInput() {
    return [...document.querySelectorAll('input')].filter(visible).find((input) => {
      const label = normalize([input.placeholder, input.getAttribute('aria-label')].filter(Boolean).join(' '));
      return SEARCH_TERMS.some((term) => label.includes(normalize(term)));
    }) || null;
  }

  function isBarePlus(el) {
    return ['+', '＋'].includes(normalize(el.innerText ?? el.textContent));
  }

  function barePlusCandidates() {
    const appNode = findExactAppNode('coding-tools-mcp');
    const appCard = appContainerFor(appNode, 'coding-tools-mcp');
    return allClickable(document).filter((el) => {
      if (!isBarePlus(el)) return false;
      if (el.closest('[role="dialog"]')) return false;
      // The + inside the existing app row adds that app to a chat; it must never be used to create.
      if (appCard?.contains(el)) return false;
      return true;
    });
  }

  function searchAssociatedPlus() {
    const search = pluginSearchInput();
    if (!search) return null;
    const searchRect = search.getBoundingClientRect();
    return barePlusCandidates()
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => Math.abs((rect.top + rect.height / 2) - (searchRect.top + searchRect.height / 2)) < 70
        && rect.left >= searchRect.right - 20)
      .sort((a, b) => Math.abs(a.rect.left - searchRect.right) - Math.abs(b.rect.left - searchRect.right))[0]?.el || null;
  }

  // Toolbar row holding the plugin search field and the create control. ChatGPT renders the create
  // control as an icon-only button, so anchoring on the row and taking its single button survives
  // an aria-label change. Verified 2026-08-16: this class set matches exactly one node, containing
  // the "Search plugins" input and one button ("Create app").
  const CREATE_ROW_CLASSES = ['flex', 'w-full', 'min-w-0', 'flex-nowrap', 'items-center', 'gap-3', 'md:ms-auto', 'md:w-auto'];

  function createRowButton() {
    const rows = [...document.querySelectorAll('div')]
      .filter((el) => CREATE_ROW_CLASSES.every((cls) => el.classList?.contains(cls)));
    const soleButton = (row) => {
      const buttons = [...row.querySelectorAll('button, [role="button"]')].filter(visible);
      return buttons.length === 1 ? buttons[0] : null;
    };
    // A row that also holds the search field is the toolbar for certain; prefer it.
    for (const row of rows) {
      if (!row.querySelector('input')) continue;
      const button = soleButton(row);
      if (button) return button;
    }
    for (const row of rows) {
      const button = soleButton(row);
      if (button) return button;
    }
    return null;
  }

  const EXACT_CREATE_LABELS = [
    'create', 'create app', 'create plugin', 'create connector', 'create new app', 'create new plugin',
    'new app', 'new plugin', 'new connector', 'add app', 'add plugin', 'add connector', '+ create',
    '建立', '創建', '创建', '新增應用', '新增应用', '新增插件', '新增', '添加应用', '新增連接器', '新增连接器',
  ];
  const CREATE_VERB = /(^|\s)(create|new|add|connect)(\s|$)/;
  const CREATE_NOUN = /(^|\s)(app|apps|plugin|plugins|connector|connectors|mcp|server)(\s|$)/;

  /**
   * Returns the control that opens the create-app form, or null when nothing can be identified
   * safely. Never returns the + inside an existing app row, and never guesses between ambiguous
   * bare + controls.
   */
  function createControl() {
    if (!isPersonalPluginsPage() && !isPotentialPluginsManagerUrl(location.href)) return null;
    const outsideDialogs = allClickable(document).filter((el) => !el.closest('[role="dialog"], form, [data-testid*="composer"]'));

    const exact = outsideDialogs.find((el) => textMatches(el, EXACT_CREATE_LABELS, true));
    if (exact) return exact;

    // "Create new app", "Add MCP server", "Create custom connector" — a create verb plus an app noun.
    const phrase = outsideDialogs.find((el) => elementLabels(el)
      .some((label) => label.length <= 40 && CREATE_VERB.test(label) && CREATE_NOUN.test(label)));
    if (phrase) return phrase;

    const labelledPlus = outsideDialogs.find((el) => {
      if (!isBarePlus(el)) return false;
      const meta = `${normalize(el.getAttribute('aria-label'))} ${normalize(el.getAttribute('title'))}`;
      return CREATE_VERB.test(meta) && CREATE_NOUN.test(meta);
    });
    if (labelledPlus) return labelledPlus;

    if (!isPersonalPluginsPage()) return null;

    // Structural fallback for when ChatGPT renames the control's label.
    const rowButton = createRowButton();
    if (rowButton) return rowButton;

    // Personal-plugins UI with a list: the + sits directly beside the search field.
    const besideSearch = searchAssociatedPlus();
    if (besideSearch) return besideSearch;

    // Empty personal list: there is no search field at all. A single unambiguous + is the
    // create control; two or more means we cannot tell them apart, so nothing is clicked.
    const pluses = barePlusCandidates();
    return pluses.length === 1 ? pluses[0] : null;
  }

  // ChatGPT renders the plugins list asynchronously. Deciding "no existing app, go create one"
  // before the list paints would create a duplicate.
  //
  // The search field is NOT a sufficient signal: it paints well before the plugin cards and the
  // create control, and accepting it caused the comparison and the create lookup to run against a
  // page holding nothing but the nav shell. Wait for the app itself or the create control.
  // Any link into a specific plugin is a rendered card. The old test demanded the literal word
  // "plugin" inside the id (/plugins/plugin_asdk_app_x), which only holds for one of ChatGPT's id
  // shapes: a list of apps whose ids look different read as "nothing rendered", the job burned its
  // retries, and an existing app could then be treated as absent. The list's own routes are
  // excluded so a nav link cannot pass for a card.
  const NON_CARD_PLUGIN_SEGMENTS = new Set(['discover', 'store', 'browse', 'search', 'personal', 'installed', 'new', 'create']);

  function pluginCardLinks() {
    return [...document.querySelectorAll('a[href]')]
      .filter(visible)
      .filter((el) => !el.closest?.('nav,aside,[role="navigation"]'))
      .filter((el) => {
        const href = el.getAttribute('href') || '';
        const match = /\/plugins\/([^/?#]+)/i.exec(href);
        return Boolean(match) && !NON_CARD_PLUGIN_SEGMENTS.has(match[1].toLowerCase());
      });
  }

  const EMPTY_PLUGIN_LIST_LABELS = [
    'no apps yet', 'no plugins yet', 'no connectors yet',
    'no apps', 'no plugins', 'no connectors',
    '尚未建立應用', '尚未建立插件', '尚未建立連接器',
    '尚未创建应用', '尚未创建插件', '尚未创建连接器',
  ];

  function pluginsPageRenderState(appName) {
    // Readiness is about whether this app's identity has painted, not whether its ⋯ menu is
    // clickable yet. findGridArticle is the delete/create gate; using it here reported a
    // late-rendered name+link card as mere 'cards' and missed the mutation wakeup.
    if (findExactAppNode(appName) || findGridArticle(appName)) return 'app';
    if (pluginCardLinks().length) return 'cards';
    // Search alone is NOT readiness: it paints before the grid. Creating on search-only
    // skips delete when the existing card has not mounted yet.

    // Empty lists render no cards or search box in some ChatGPT builds. An explicit empty-state
    // message plus an exact create control is positive evidence that loading has completed.
    if (isPersonalPluginsPage()) {
      const pageText = normalize(document.body?.innerText || document.body?.textContent);
      const explicitEmpty = EMPTY_PLUGIN_LIST_LABELS.some((label) => pageText.includes(normalize(label)));
      if (explicitEmpty && createControl()) return 'empty';
    }
    return 'unknown';
  }

  /**
   * Resolves how much of the plugins list actually rendered.
   *
   * createControl() by itself is NOT an acceptable readiness signal: the create button shares a
   * toolbar row with the search field, and that row paints before any plugin card. An explicit
   * empty-state message plus that control is trusted. Returns:
   *   'app'     — this app is present
   *   'cards'   — the list rendered, this app is not in it
   *   'empty'   — an explicit rendered-empty state is present
   *   'unknown' — nothing trustworthy rendered; absence cannot be inferred
   */
  async function waitForPluginsPageReady(appName) {
    // Fail closed without the old 8s/12s stall. DOM-mutation wakeups make a real grid appear
    // well before this bound; an unrendered search-only shell should not block Sync that long.
    const listed = await waitFor(() => {
      if (!document.body || !normalize(document.body.textContent)) return null;
      const state = pluginsPageRenderState(appName);
      return state === 'unknown' ? null : state;
    }, 5000, 250);
    return listed || pluginsPageRenderState(appName);
  }

  async function closeOpenDialog() {
    const dialog = visibleDialogs().at(-1);
    if (!dialog) return false;
    const close = allClickable(dialog).find((el) => normalize(el.getAttribute('aria-label')) === 'close'
      || textMatches(el, ['close', 'cancel', '關閉', '关闭', '取消'], true));
    if (!close) return false;
    close.click();
    await sleep(400);
    return true;
  }

  async function openCreateFormStrict() {
    if (!isPersonalPluginsPage()) return false;
    if (createFormPresent()) return true;

    // Deleting an app leaves ChatGPT's Settings modal open over the plugins list. The create control
    // is still in the DOM and still passes visible(), so createControl() happily returns it — but it
    // sits under the modal: elementFromPoint at its centre returns the overlay, and a real click
    // never lands. Close any leftover modal before looking for it.
    await dismissOpenMenus();
    for (let i = 0; i < 5 && visibleDialogs().length && !createFormPresent(); i += 1) {
      if (!(await closeOpenDialog())) {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
        } catch {}
        await sleep(200);
        if (visibleDialogs().length) break;
      }
      await sleep(400);
    }
    if (createFormPresent()) return true;
    // The create control paints after the plugin list, later than the search field, so poll for it
    // rather than deciding from a single look at a page that is still building.
    const create = await waitFor(() => createControl(), 3000, 250);
    if (!create) return false;
    create.click();
    return Boolean(await waitFor(() => createFormPresent(), 7000));
  }

  // Recorded into lastSyncState when no create control can be identified, so the page's actual
  // controls can be inspected after the fact instead of guessed at.
  function pageInventory(limit = 60) {
    const describe = (el) => {
      const rect = el.getBoundingClientRect();
      return [
        el.tagName?.toLowerCase() || '?',
        JSON.stringify(normalize(el.innerText ?? el.textContent).slice(0, 40)),
        el.getAttribute?.('aria-label') || '-',
        el.getAttribute?.('data-testid') || '-',
        `${Math.round(rect.top)},${Math.round(rect.left)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      ].join(' | ');
    };
    return {
      url: location.href,
      clickables: allClickable(document).slice(0, limit).map(describe),
      inputs: inputs(document).slice(0, 15).map((el) => [
        el.getAttribute('placeholder') || '-',
        el.getAttribute('aria-label') || '-',
        el.name || '-',
      ].join(' | ')),
    };
  }

  async function chooseAuth(authType) {
    const normalized = normalize(authType);
    const labels = normalized === 'none' || normalized === 'noauth' ? STRINGS.noAuth : normalized === 'oauth' ? STRINGS.oauth : [];
    if (!labels.length) return { changed: false };

    const surface = activeSurface();

    // Try the native <select> first. ChatGPT renders auth as <select id="custom-connector-auth">,
    // and a loose text match would otherwise hit the "Advanced OAuth settings" disclosure button.
    const selects = [...surface.querySelectorAll('select')].filter(visible);
    for (const select of selects) {
      const option = [...select.options].find((item) => labels.some((label) => normalize(item.textContent).includes(normalize(label))));
      if (option) {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (setter) setter.call(select, option.value); else select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(250);
        return { changed: true };
      }
    }

    const direct = allClickable(surface).find((el) => textMatches(el, labels, true)
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (direct) {
      direct.click();
      await sleep(350);
      return { changed: true };
    }

    const radios = [...surface.querySelectorAll('input[type="radio"]')].filter(visible);
    for (const radio of radios) {
      const label = associatedLabelText(radio);
      if (labels.some((value) => label.includes(normalize(value)))) {
        radio.click();
        await sleep(250);
        return { changed: true };
      }
    }
    return { changed: false };
  }

  // The create dialog offers "Server URL" or "Tunnel" as the connection kind. A captured
  // trycloudflare /mcp endpoint is a plain server URL, so select that mode when it is offered.
  async function chooseServerUrlConnection() {
    const surface = activeSurface();
    const option = allClickable(surface).find((el) => textMatches(el, STRINGS.serverUrlMode, true));
    if (!option) return { changed: false };
    const selected = option.getAttribute('aria-checked') === 'true'
      || option.getAttribute('data-state') === 'checked'
      || option.getAttribute('aria-selected') === 'true';
    if (selected) return { changed: false };
    option.click();
    await sleep(250);
    return { changed: true };
  }

  const TRUST_PHRASES = ['i understand', 'understand and want to continue', 'i acknowledge', '我了解', '我明白', '我理解'];

  // ChatGPT gates Create behind an explicit "custom MCP servers introduce risk / I understand"
  // acknowledgement (input#trust-checkbox). Sync ticks it for the endpoint the user chose to
  // publish; leaving it unticked means the final Create button can never enable and the job
  // times out with nothing to show.
  async function acknowledgeCustomServerTrust() {
    const surface = activeSurface();
    const boxes = [...surface.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]')];
    const target = boxes.find((box) => {
      if (/trust|understand|acknowledge|consent/i.test(`${box.id || ''} ${box.getAttribute('name') || ''}`)) return true;
      let container = box.parentElement;
      for (let i = 0; i < 5 && container; i += 1, container = container.parentElement) {
        const text = normalize(container.innerText ?? container.textContent);
        if (TRUST_PHRASES.some((phrase) => text.includes(phrase))) return true;
      }
      return false;
    });
    if (!target) return { changed: false };
    const checked = target.checked === true
      || target.getAttribute('aria-checked') === 'true'
      || target.getAttribute('data-state') === 'checked';
    if (checked) return { changed: false };
    target.click();
    await sleep(250);
    return { changed: true };
  }

  // "Registration method" offers DCR / CIMD / a user-defined client. Only the user-defined option
  // accepts the client ID this workspace captured, and ChatGPT refuses to create without one
  // ("Enter a client ID to use a user-defined OAuth client").
  async function chooseUserDefinedOauthClient() {
    const surface = activeSurface();
    for (const select of [...surface.querySelectorAll('select')].filter(visible)) {
      const option = [...select.options].find((item) => /user-?defined|manual|client credentials/i.test(item.textContent || ''));
      if (!option) continue;
      if (select.value === option.value) return { changed: false };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(select, option.value); else select.value = option.value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(300);
      return { changed: true };
    }
    return { changed: false };
  }

  async function exposeManualOauthFields() {
    if (findInput('clientId') || findInput('clientSecret')) return;

    // The disclosure stays disabled until ChatGPT has fetched the MCP URL and discovered the
    // server's OAuth settings. Clicking it immediately after typing the URL does nothing, which
    // is why the client ID was never filled.
    const advanced = await waitFor(() => {
      const control = findClickable(STRINGS.advancedOauth, activeSurface());
      if (!control) return null;
      return (control.disabled || control.getAttribute('aria-disabled') === 'true') ? null : control;
    }, 15000, 300);
    if (advanced) {
      advanced.click();
      await sleep(600);
    }

    await chooseUserDefinedOauthClient();
    const manual = findClickable(STRINGS.manualOauth, activeSurface());
    if (manual && !manual.disabled) {
      manual.click();
      await sleep(300);
    }
    await waitFor(() => findInput('clientId'), 5000, 200);
  }

  function sameOrigin(left, right) {
    try {
      return new URL(left).origin.toLowerCase() === new URL(right).origin.toLowerCase();
    } catch {
      return false;
    }
  }

  // ChatGPT discovers Auth/Token/Authorization-server/Resource from the MCP server itself. When the
  // server still advertises a previous Quick Tunnel hostname, those discovered values point at a
  // dead tunnel and OAuth cannot complete. The locally captured values are authoritative for the
  // tunnel running right now, so replace any endpoint whose origin is not the current one.
  async function repairDiscoveredOauthEndpoints(endpoint, { oauthAuthorizeUrl, oauthTokenUrl }) {
    const repaired = [];
    let base = '';
    try { base = new URL(endpoint).origin; } catch { return repaired; }

    // Shapes follow the server's own advertised metadata:
    //   authorization_endpoint / token_endpoint  →  <origin>/oauth/{authorize,token}
    //   authorization_servers  (server base)     →  <origin>
    //   resource                                 →  <origin>, NOT the /mcp path
    // The /mcp path is the MCP transport endpoint and belongs only in the Server URL field.
    const targets = [
      ['authorizeUrl', oauthAuthorizeUrl || `${base}/oauth/authorize`],
      ['tokenUrl', oauthTokenUrl || `${base}/oauth/token`],
      ['authServerBase', base],
      ['resource', base],
    ];

    for (const [kind, value] of targets) {
      if (!value) continue;
      const field = findInput(kind);
      if (!field) continue;
      const current = String(field.value || '').trim();
      if (current === value) continue;
      // Leave anything already pointing at the live tunnel alone.
      if (current && sameOrigin(current, endpoint)) continue;
      setInputValue(field, value);
      repaired.push(kind);
    }
    return repaired;
  }

  async function fillOauth({ endpoint, oauthClientId, oauthClientSecret, oauthAuthorizeUrl, oauthTokenUrl }) {
    await exposeManualOauthFields();
    const warnings = [];

    const clientId = await waitFor(() => findInput('clientId'), 6000, 250);
    if (clientId && oauthClientId) setInputValue(clientId, oauthClientId);
    else if (oauthClientId) warnings.push('OAuth Client ID field not detected');

    const clientSecret = findInput('clientSecret');
    if (clientSecret && oauthClientSecret) setInputValue(clientSecret, oauthClientSecret);
    else if (oauthClientSecret) warnings.push('OAuth Client Secret field not detected');

    const repaired = await repairDiscoveredOauthEndpoints(endpoint, { oauthAuthorizeUrl, oauthTokenUrl });
    if (repaired.length) {
      warnings.push(`replaced stale discovered OAuth endpoints (${repaired.join(', ')}) with the current tunnel`);
    }

    return warnings;
  }

  async function fillAndStartScan({ appName, endpoint, authType, oauthClientId, oauthClientSecret, oauthAuthorizeUrl, oauthTokenUrl }) {
    const name = await waitFor(() => findInput('name'), 5000);
    const url = await waitFor(() => findInput('url'), 5000);
    if (!name || !url) return { ok: false, stage: 'form', message: 'Could not identify the current ChatGPT custom app name/endpoint fields.' };

    setInputValue(name, appName);
    const description = findInput('description');
    if (description) setInputValue(description, 'Local coding workspace provided by Coding Tools MCP.');
    await chooseServerUrlConnection();
    setInputValue(url, endpoint);
    await chooseAuth(authType);

    let warnings = [];
    if (normalize(authType) === 'oauth') {
      warnings = await fillOauth({ endpoint, oauthClientId, oauthClientSecret, oauthAuthorizeUrl, oauthTokenUrl });
    }

    await acknowledgeCustomServerTrust();

    const enabled = (el) => Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const scan = await waitFor(() => {
      const button = findClickablePreferExact(STRINGS.scan, activeSurface());
      return enabled(button) ? button : null;
    }, 7000);

    if (!scan) {
      // Not every ChatGPT build has a separate Scan/Test step; some validate the endpoint when the
      // final Create is pressed. Hand off to the finalizer instead of stopping the whole job.
      const createLater = allClickable(activeSurface()).find((el) => textMatches(el, STRINGS.createFinal));
      if (!createLater) {
        const disabledScan = findClickablePreferExact(STRINGS.scan, activeSurface());
        return {
          ok: false,
          stage: disabledScan ? 'scan_disabled' : 'scan',
          message: disabledScan
            ? `Scan Tools is still disabled after filling the form.${warnings.length ? ` ${warnings.join('; ')}.` : ''}`
            : `MCP and OAuth values were filled, but neither Scan Tools nor a Create action was found.${warnings.length ? ` ${warnings.join('; ')}.` : ''}`,
        };
      }
      return {
        ok: true,
        stage: 'awaiting_create',
        message: `Filled ${appName}, MCP URL and OAuth credentials. This ChatGPT build has no separate Scan Tools step, so Create is pressed once it becomes available.${warnings.length ? ` Review: ${warnings.join('; ')}.` : ''}`,
        warnings,
      };
    }
    scan.click();

    // Do NOT click Authorize here. ChatGPT mints the connector redirect_uri only after
    // Create (or Connect). Clicking Authorize during Scan uses a callback that is not
    // registered yet → "redirect_uri is not allowed".
    // Wait briefly for Scan Tools to settle, then let the finalizer Create → Connect.
    await sleep(1500);
    await waitFor(() => {
      const create = finalCreateButton(appName);
      if (create) return create;
      // Scan still running / tools list filling — keep waiting without clicking auth.
      const surface = normalize(activeSurface().textContent || '');
      if (/scan|tool|oauth|authoriz|驗證|扫描|掃描/.test(surface)) return null;
      return null;
    }, 20000, 400);

    return {
      ok: true,
      stage: 'scanning',
      message: `Filled ${appName}, MCP URL and OAuth credentials, then started Scan Tools. Waiting for Create before any OAuth click.${warnings.length ? ` Review: ${warnings.join('; ')}.` : ''}`,
      warnings,
    };
  }


  let finalizerState = null;

  function stopFinalizer() {
    if (!finalizerState) return;
    try { finalizerState.observer?.disconnect(); } catch {}
    if (finalizerState.intervalId) clearInterval(finalizerState.intervalId);
    finalizerState = null;
  }

  function finalCreateButton(appName) {
    const surface = activeSurface();
    const surfaceText = normalize(surface.textContent || '');
    if (!surfaceText.includes(normalize(appName)) && !surfaceText.includes('mcp')) return null;
    const candidates = allClickable(surface).filter((el) => textMatches(el, STRINGS.createFinal));
    return candidates.find((el) => {
      const text = normalize(el.innerText || el.textContent || el.getAttribute?.('aria-label'));
      const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
      if (disabled) return false;
      if (text.includes('scan') || text.includes('discover')) return false;
      return STRINGS.createFinal.some((label) => text === normalize(label) || text.startsWith(`${normalize(label)} `));
    }) || null;
  }

  /**
   * The Sign in / Connect control belonging to this app only.
   *
   * Deliberately scoped: once the create dialog closes, activeSurface() is the whole plugins page,
   * where every other connector also has a Connect control. Searching page-wide would sign in to
   * somebody else's app.
   */
  function signInControl(appName) {
    const scopes = [];
    const card = appContainerFor(findExactAppNode(appName), appName);
    if (card) scopes.push(card);
    const dialog = visibleDialogs().at(-1);
    if (dialog) scopes.push(dialog);

    for (const scope of scopes) {
      const button = allClickable(scope).find((el) => textMatches(el, STRINGS.signIn, true)
        && !el.disabled
        && el.getAttribute('aria-disabled') !== 'true');
      if (button) return button;
    }
    return null;
  }

  /**
   * The control that starts authorization, inside an already-scoped surface.
   *
   * ChatGPT's Manage panel renders it as ONE row button whose text is "Connection Connect" — a
   * "Connection" label beside a "Connect" value, with no inner button and no aria-label. Matching
   * the row's whole text is therefore the only way to reach it.
   */
  function connectControlIn(scope) {
    if (!scope) return null;
    const clickables = allClickable(scope)
      .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');

    const direct = clickables.find((el) => textMatches(el, STRINGS.signIn, true));
    if (direct) return direct;

    return clickables.find((el) => /^connection\s+(connect|sign in|log in|authorize|登入|登录|連接|连接)$/
      .test(normalize(el.innerText ?? el.textContent))) || null;
  }

  /**
   * Starts authorization for this app.
   *
   * The prompt shown immediately after creation is one-shot — it does not come back on reload. The
   * durable route is Plugin actions (⋯) → Manage → Connection → Connect, so fall back to that
   * rather than depending on catching the transient prompt.
   */
  /**
   * Radix dropdowns open on pointerdown and toggle shut on the following click. Firing the whole
   * sequence with no gap opens and immediately closes the menu — observed live: aria-expanded went
   * false → true only once a delay was inserted between pointerdown and pointerup.
   */
  async function pointerActivateMenu(target) {
    if (!target) return;
    const rect = target.getBoundingClientRect?.();
    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect ? rect.left + rect.width / 2 : 0,
      clientY: rect ? rect.top + rect.height / 2 : 0,
      button: 0,
      buttons: 1,
    };
    try { target.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mousedown', common)); } catch {}
    await sleep(140);
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 })); } catch {}
    try { target.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 })); } catch { target.click?.(); }
  }

  /**
   * The consent step between Connect and the provider: a dialog headed "Add <app> to ChatGPT"
   * whose action reads "Sign in with <app>" — not "Sign in", so an exact label match misses it.
   */
  function consentSignInControl(appName) {
    const dialog = visibleDialogs().at(-1);
    if (!dialog) return null;
    return allClickable(dialog).find((el) => {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const text = normalize(el.innerText ?? el.textContent);
      if (/^(sign in|log in|continue|authorize|allow)\b/.test(text)) return true;
      return containsAppIdentity(text, appName) && /(sign in|log in|connect|authorize)/.test(text);
    }) || null;
  }

  async function confirmConsentDialog(appName) {
    const button = await waitFor(() => consentSignInControl(appName), 9000, 300);
    if (!button) return { confirmed: false };
    await pointerActivateMenu(button);
    return { confirmed: true };
  }

  async function openConnectFlow(appName) {
    const scoped = visibleDialogs().at(-1)
      || appContainerFor(findExactAppNode(appName), appName)
      || null;
    const immediate = connectControlIn(scoped);
    if (immediate) {
      await pointerActivateMenu(immediate);
      const consent = await confirmConsentDialog(appName);
      return { opened: true, via: consent.confirmed ? 'direct+consent' : 'direct' };
    }

    // The app card only appears once ChatGPT has finished creating and re-rendered the list.
    await waitFor(() => findExactAppNode(appName), 12000, 300);
    const card = appContainerFor(findExactAppNode(appName), appName);
    const scope = card || document.querySelector('main') || document.body;
    // On the card the ⋯ carries aria-label="Actions for <app>" only while hovered; unhovered it is
    // an unlabelled icon button, so fall back to the card's sole textless control.
    const actions = pluginActionsButtonIn(scope) || menuButtonForAppCard(card);
    if (!actions) return { opened: false, reason: 'plugin_actions_not_found' };
    await pointerActivateMenu(actions);

    const manage = await waitFor(() => {
      const menu = [...document.querySelectorAll('[role="menu"]')].filter(visible).at(-1);
      return menu ? (allClickable(menu).find((el) => textMatches(el, STRINGS.manage, true)) || null) : null;
    }, 5000, 200);
    if (!manage) return { opened: false, reason: 'manage_not_found' };
    await pointerActivateMenu(manage);

    const connect = await waitFor(() => connectControlIn(visibleDialogs().at(-1)), 9000, 300);
    if (!connect) return { opened: false, reason: 'connect_not_found' };
    await pointerActivateMenu(connect);

    // Connect only opens a consent dialog; the provider redirect is behind "Sign in with <app>".
    const consent = await confirmConsentDialog(appName);
    if (!consent.confirmed) return { opened: false, reason: 'consent_sign_in_not_found' };
    return { opened: true, via: 'manage+consent' };
  }

  function pendingOauthButton() {
    const surface = activeSurface();
    const authSignals = ['authorize', 'authorization', 'connect', 'sign in', 'log in', '授權', '授权', '連線', '连接', '登入', '登录'];
    const button = findClickable(authSignals, surface);
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    return button;
  }

  function startFinalizer(appName, jobId = '', authType = '') {
    if (finalizerState?.jobId === jobId && finalizerState?.appName === appName) return;
    stopFinalizer();

    const state = {
      appName,
      jobId,
      authType,
      startedAt: Date.now(),
      authClickedAt: 0,
      busy: false,
      observer: null,
      intervalId: null,
    };
    finalizerState = state;

    const finish = async (result) => {
      if (finalizerState !== state) return;
      stopFinalizer();
      try {
        await chrome.runtime.sendMessage({ type: 'CHATGPT_SYNC_RESULT', result: { ...result, jobId } });
      } catch {}
    };

    const check = async () => {
      if (finalizerState !== state || state.busy) return;
      state.busy = true;
      try {
        if (Date.now() - state.startedAt > 180000) {
          await finish({ ok: false, stage: 'create_timeout', message: 'ChatGPT did not expose an enabled final Create button within 3 minutes. The draft is left open for review.' });
          return;
        }

        // Create before any OAuth click. Premature Authorize uses an unready redirect_uri.
        const create = finalCreateButton(appName);
        if (create) {
          create.click();
          await sleep(2000);

          // Wait for the new app card to appear so Connect targets the real connector.
          await waitFor(() => findGridArticle(appName), 15000, 400);

          if (normalize(state.authType) === 'oauth' && findGridArticle(appName)) {
            // Give ChatGPT a moment to attach the connector oauth callback id.
            await sleep(2000);
            const connected = await openConnectFlow(appName);
            if (connected.opened) {
              await finish({
                ok: true,
                stage: 'authorizing',
                awaitingOauth: true,
                message: `${appName} was created and its OAuth connection was started (${connected.via}). Waiting for authorization to finish.`,
              });
              return;
            }
            await finish({
              ok: true,
              stage: 'created_needs_signin',
              awaitingOauth: true,
              message: `${appName} was created, but its Connect control was not reachable (${connected.reason}). Open the app, choose Plugin actions → Manage → Connection → Connect; the captured authorization password will still be submitted automatically.`,
            });
            return;
          }

          await finish({ ok: true, stage: 'created', message: `${appName} was created after MCP scan.` });
          return;
        }

        // Only if Create is not available yet, do not click Authorize during the draft/scan form.
        // OAuth must start from post-create Connect / consent, not from a mid-scan Authorize button.

      } finally {
        state.busy = false;
      }
    };

    state.observer = new MutationObserver(() => { void check(); });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-state'] });
    state.intervalId = setInterval(() => { void check(); }, 700);
    void check();
  }

  let activePrepareJobId = '';

  async function prepareSync(payload) {
    if (payload?.jobId && activePrepareJobId === payload.jobId) {
      return {
        ok: true,
        complete: false,
        continue: 'wait',
        stage: 'comparison_in_progress',
        message: 'The exact existing-app comparison is still running; keep the current sync phase instead of advancing to OAuth.',
      };
    }
    if (payload?.jobId) activePrepareJobId = payload.jobId;

    if (!isPersonalPluginsUrl(location.href) && !isPotentialPluginsManagerUrl(location.href)) {
      activePrepareJobId = '';
      return {
        ok: false,
        stage: 'wrong_page',
        message: `Refusing to click on ${location.href}. Sync only acts on the plugins page.`,
      };
    }

    // A create dialog left open by a previous attempt must be closed, never filled. Filling it here
    // meant sync created a second app without ever looking at the list — detection has to happen
    // against the list, not against a half-open form.
    if (createFormPresent()) {
      await closeOpenDialog();
      await sleep(600);
    }

    if (!(await waitForPersonalPluginsPage())) {
      activePrepareJobId = '';
      return {
        ok: false,
        stage: 'wrong_page',
        message: `Sync expected the ChatGPT plugins page but found ${location.href}. A reused ChatGPT tab can restore its last conversation instead of opening /plugins; the worker will retry in a clean tab.`,
      };
    }

    await ensurePersonalView();
    const readiness = await waitForPluginsPageReady(payload.appName);

    // Fail closed. Search shell / nav alone is not proof the app is absent. Wait and retry
    // until real cards, this app, or an explicit empty state appear.
    if (readiness === 'unknown') {
      activePrepareJobId = '';
      return {
        ok: false,
        stage: 'list_not_rendered',
        message: `The plugins list did not finish loading at ${location.href}, so whether ${payload.appName} already exists could not be determined. Nothing was created; waiting and retrying.`,
        inventory: pageInventory(),
      };
    }

    await clearPluginSearch();
    // After clearing search, wait once more so filtered-away cards remount before we decide.
    await waitForPluginsPageReady(payload.appName);
    const inspection = await inspectExistingApp(payload.appName);
    // A real plugins-grid card counts. inspectExistingApp already refuses sidebar/composer chrome,
    // so a renamed-route card painted outside the first <main> still enters delete-first replace.
    const installed = Boolean(findGridArticle(payload.appName) || inspection.found);

    if (installed) {
      // Every sync is a clean replacement, even when the endpoint is unchanged.
      // Reading the old endpoint is NOT a precondition for removal: an app carrying this name is
      // replaced whether or not its /mcp URL can be read, because an unreadable app is exactly the
      // kind that is broken.
      if (payload.replaceExisting === false) {
        activePrepareJobId = '';
        return {
          ok: false,
          stage: 'url_mismatch',
          existingEndpoint: inspection.endpoint || '',
          message: `${payload.appName} exists but replacement is disabled, so it was left unchanged.`,
        };
      }

      const removal = await removeExistingStrict(payload.appName, inspection);
      if (!removal.removed) {
        activePrepareJobId = '';
        return {
          ok: false,
          stage: 'remove',
          existingEndpoint: inspection.endpoint || '',
          message: `Found an existing ${payload.appName}, but its Delete action was not reachable (${removal.reason}). Nothing else was clicked, and no duplicate was created.`,
          inventory: pageInventory(),
        };
      }

      // Only extra grid cards count. Sidebar chats named coding-tools-mcp are not apps.
      for (let extra = 0; extra < 3 && findGridArticle(payload.appName); extra += 1) {
        const again = await removeExistingStrict(payload.appName);
        if (!again.removed) break;
      }

      await sleep(400);
      await dismissOpenMenus();
      for (let i = 0; i < 4 && visibleDialogs().length; i += 1) {
        if (!(await closeOpenDialog())) break;
      }
      await clearPluginSearch();

      // Delete lands on the manage panel. Create only works on a clean plugins list.
      activePrepareJobId = '';
      return {
        ok: true,
        continue: 'return_to_plugins',
        removed: true,
        stage: 'removed_old_app',
        message: `Deleted ${payload.appName}. Going back to the plugins page to create the replacement.`,
      };
    }

    // Last line of defence: never create while a real grid card is still on the page.
    // Leftover name text in search/sidebar/toast is not a card and must not block recreate.
    if (findGridArticle(payload.appName)) {
      activePrepareJobId = '';
      return {
        ok: false,
        stage: 'remove',
        message: `${payload.appName} is still present, so creating now would skip delete and produce a duplicate. Nothing was created.`,
        inventory: pageInventory(),
      };
    }

    const opened = await openCreateFormStrict();
    if (!opened) {
      activePrepareJobId = '';
      return {
        ok: false,
        stage: 'open_create',
        message: 'The personal plugins page is open, but an exact Create/New App control was not detected. No unrelated + button was clicked.',
        inventory: pageInventory(),
      };
    }

    const started = await fillAndStartScan(payload);
    if (started?.ok) startFinalizer(payload.appName, payload.jobId || '', payload.authType || '');
    else activePrepareJobId = '';
    return started;
  }

  async function inspectDetailsAndMaybeRemove(payload) {
    let surface = activeSurface();
    if (!containsAppIdentity(surface.textContent || '', payload.appName)) {
      const appNode = findExactAppNode(payload.appName);
      if (!appNode) {
        return { ok: false, stage: 'details_app_not_found', message: `Opened the app detail page, but ${payload.appName} was not detected there.` };
      }
      surface = activeSurface();
    }

    let urlInput = findInput('url', surface);
    let endpoint = canonicalMcpEndpoint(urlInput?.value || '');
    let endpoints = collectMcpEndpoints(surface);
    if (!endpoint && endpoints.length === 1) endpoint = endpoints[0];

    if (!endpoint) {
      const manage = findClickablePreferExact(STRINGS.manage, surface);
      if (manage) {
        manage.click();
        await sleep(500);
        surface = activeSurface();
        urlInput = findInput('url', surface);
        endpoint = canonicalMcpEndpoint(urlInput?.value || '');
        endpoints = collectMcpEndpoints(surface);
        if (!endpoint && endpoints.length === 1) endpoint = endpoints[0];
      }
    }

    if (!endpoint) {
      return { ok: false, stage: 'existing_url_not_detected', message: `The exact ${payload.appName} detail page opened, but its current /mcp URL was not exposed safely.` };
    }

    if (payload.replaceExisting === false) {
      return { ok: false, stage: 'url_mismatch', existingEndpoint: endpoint, message: `${payload.appName} points to ${endpoint}, which differs from ${payload.endpoint}. Replacement is disabled.` };
    }

    const removal = await removeExistingStrict(payload.appName, { found: true, endpoint, detailsOpened: true, details: surface });
    if (!removal.removed) {
      return {
        ok: false,
        stage: 'remove',
        existingEndpoint: endpoint,
        message: `The existing ${payload.appName} uses ${endpoint}, which differs from ${payload.endpoint}, but its exact Remove action was not safely available (${removal.reason}).`,
      };
    }

    return {
      ok: true,
      complete: false,
      removed: true,
      stage: 'removed_old_app',
      existingEndpoint: endpoint,
      message: `Removed the old ${payload.appName} because ${endpoint} differs from ${payload.endpoint}. Returning to Personal plugins to create the replacement.`,
    };
  }

  async function createReplacement(payload) {
    if (!(await waitForPersonalPluginsPage())) {
      return { ok: false, stage: 'wrong_page', message: 'Replacement creation must start from a verified ChatGPT Plugins/Apps manager page.' };
    }
    await dismissOpenMenus();
    for (let i = 0; i < 4 && visibleDialogs().length; i += 1) {
      if (!(await closeOpenDialog())) break;
    }
    await clearPluginSearch();
    await sleep(350);
    const opened = await openCreateFormStrict();
    if (!opened) {
      return { ok: false, stage: 'open_create', message: 'Could not identify the Create control beside Search plugins. No app-row + button was clicked.', inventory: pageInventory() };
    }
    const started = await fillAndStartScan(payload);
    if (started?.ok) startFinalizer(payload.appName, payload.jobId || '', payload.authType || '');
    return started;
  }

  async function finalizeSync(appName) {
    const surface = activeSurface();
    const authSignals = ['authorize', 'authorization', 'sign in', 'log in', '授權', '授权', '登入', '登录'];
    const pendingAuth = findClickable(authSignals, surface);
    if (pendingAuth) {
      return { ok: false, stage: 'authorization_pending', message: 'ChatGPT still shows an OAuth authorization action. Complete it, then click Sync again to finish Create.' };
    }

    const createFinal = await waitFor(() => {
      const candidates = allClickable(activeSurface()).filter((el) => textMatches(el, STRINGS.createFinal));
      return candidates.find((el) => {
        const text = normalize(el.innerText || el.textContent);
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        return !disabled && !text.includes('scan tools') && !text.includes('scan');
      }) || null;
    }, 20000, 350);

    if (!createFinal) {
      return {
        ok: false,
        stage: 'create_pending',
        message: 'OAuth/Scan Tools did not expose an enabled final Create button yet. The form is preserved for review instead of guessing.',
      };
    }

    createFinal.click();
    await sleep(900);
    return { ok: true, stage: 'created', message: `${appName} was submitted after MCP/OAuth sync.` };
  }

  function observeAppConnection(appName) {
    const card = findGridArticle(appName);
    const scopes = card ? [card] : [];
    for (const dialog of visibleDialogs()) {
      const headings = [...dialog.querySelectorAll('h1,h2,h3,[role="heading"]')];
      if (headings.some((el) => sameAppIdentity(el.textContent, appName))) scopes.push(dialog);
    }
    for (const scope of scopes) {
      const controls = allClickable(scope).filter(visible);
      const pending = controls.some((el) => elementLabels(el).some((label) => /^(connect|sign in|log in|connection connect|連接|登入)$/.test(label)));
      if (pending) continue;
      const statuses = [...scope.querySelectorAll('[role="status"],[data-state="connected"],button,[role="button"]')].filter(visible);
      const positive = statuses.some((el) => elementLabels(el).some((label) => /^(connected|connection connected|disconnect|connection disconnect|已連線|已連接|已连接|中斷連線|斷開連接)$/.test(label)));
      if (positive) return {ok:true,stage:'connected',connectionObserved:true,
        message:`ChatGPT shows ${appName} as connected; actual tool execution is not verified.`};
    }
    return {ok:false,stage:'connection_verification_pending',connectionObserved:false,
      message:'Waiting for a Connected status on this exact app. No new authorization was started.'};
  }

  // Test seam. This lives in the extension's isolated world, so the page cannot reach it.
  globalThis.__codingToolsMcpInternals = {
    observeAppConnection,
    elementText,
    textMatches,
    findClickable,
    findClickablePreferExact,
    isPersonalPluginsPage,
    isPersonalPluginsUrl,
    isPluginDetailUrl,
    isPotentialPluginsManagerUrl,
    waitForPersonalPluginsPage,
    canonicalMcpEndpoint,
    prepareSync,
    createReplacement,
    findExactAppNode,
    createControl,
    openCreateFormStrict,
    findInput,
    createFormPresent,
    inputs,
    acknowledgeCustomServerTrust,
    repairDiscoveredOauthEndpoints,
    precedingLabelText,
    signInControl,
    connectControlIn,
    openConnectFlow,
    consentSignInControl,
    menuButtonForAppCard,
    deleteViaManage,
    findGridArticle,
    dotsButtonIn,
    waitForPluginsPageReady,
    pluginsPageRenderState,
    pluginCardLinks,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CODING_TOOLS_MCP_PING') {
      sendResponse({ ok: true, version: HELPER_VERSION });
      return false;
    }

    if (message?.type === 'SYNC_MCP_APP_INSPECT_DETAILS') {
      inspectDetailsAndMaybeRemove(message)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, stage: 'exception', message: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'SYNC_MCP_APP_CREATE_REPLACEMENT') {
      createReplacement(message)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, stage: 'exception', message: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'SYNC_MCP_APP_RESUME') {
      const appName = message.appName || 'coding-tools-mcp';
      if (message.oauthSubmitted) {
        stopFinalizer();
        sendResponse(observeAppConnection(appName));
        return false;
      }
      if (!isPersonalPluginsPage()) {
        sendResponse({ ok: true, stage: 'wrong_page' });
        return false;
      }
      startFinalizer(appName, message.jobId || '', message.authType || '');
      // The app can already exist and merely be unauthorized — e.g. creation succeeded but the
      // connect control was not reachable yet. Retry it here so a live job recovers on its own
      // instead of idling until the watchdog gives up.
      if (normalize(message.authType) === 'oauth' && isPersonalPluginsPage() && findGridArticle(appName)) {
        openConnectFlow(appName)
          .then((result) => sendResponse({ ok: true, stage: result.opened ? 'authorizing' : 'finalizer_resumed', connect: result }))
          .catch(() => sendResponse({ ok: true, stage: 'finalizer_resumed' }));
        return true;
      }
      sendResponse({ ok: true, stage: 'finalizer_resumed' });
      return false;
    }

    if (message?.type === 'OPEN_CHATGPT_APPS_SETTINGS') {
      sendResponse({ ok: isPersonalPluginsPage(), stage: isPersonalPluginsPage() ? 'personal_plugins_open' : 'wrong_page' });
      return false;
    }

    if (message?.type === 'SYNC_MCP_APP_PREPARE') {
      prepareSync(message)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, stage: 'exception', message: error?.message || String(error) }));
      return true;
    }

    if (message?.type === 'SYNC_MCP_APP_FINALIZE') {
      finalizeSync(message.appName)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, stage: 'exception', message: error?.message || String(error) }));
      return true;
    }
  });
})();
