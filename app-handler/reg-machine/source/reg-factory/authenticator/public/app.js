'use strict';

const state = {
  setup: false,
  unlocked: false,
  refreshTimer: null,
  revealedCodes: new Set(),
  openDetails: new Set(),
  detailsCache: new Map(),
  detailsDrafts: new Map(),
  revealedRecovery: new Set()
};

const authPanel = document.querySelector('#auth-panel');
const vaultPanel = document.querySelector('#vault-panel');
const authTitle = document.querySelector('#auth-title');
const authHelp = document.querySelector('#auth-help');
const authButton = document.querySelector('#auth-button');
const authForm = document.querySelector('#auth-form');
const authMessage = document.querySelector('#auth-message');
const vaultMessage = document.querySelector('#vault-message');
const entriesEl = document.querySelector('#entries');
const entryForm = document.querySelector('#entry-form');
const logoutButton = document.querySelector('#logout-button');
const passwordForm = document.querySelector('#password-form');

async function api(path, options = {}) {
  const headers = {
    'x-requested-with': 'local-authenticator',
    ...(options.headers || {})
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(path, {
    ...options,
    headers
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || 'Request failed.');
  }
  return body;
}

function setMessage(target, message, isError = false) {
  target.textContent = message || '';
  target.style.color = isError ? '#9d3328' : '';
}

function renderMode() {
  authPanel.classList.toggle('hidden', state.unlocked);
  vaultPanel.classList.toggle('hidden', !state.unlocked);
  authTitle.textContent = state.setup ? 'Unlock vault' : 'Create vault';
  authHelp.textContent = state.setup
    ? 'Enter your username and password.'
    : 'First run: create the username and password that will encrypt this vault.';
  authButton.textContent = state.setup ? 'Unlock' : 'Create encrypted vault';

  if (state.unlocked) {
    startRefresh();
  } else {
    stopRefresh();
    state.revealedCodes.clear();
    state.openDetails.clear();
    state.detailsCache.clear();
    state.detailsDrafts.clear();
    state.revealedRecovery.clear();
  }
}

function stopRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startRefresh() {
  stopRefresh();
  loadEntries();
  state.refreshTimer = setInterval(loadEntries, 1000);
}

function entryName(entry) {
  return [entry.issuer, entry.label].filter(Boolean).join(' / ') || entry.label;
}

function renderEntries(entries) {
  if (!entries.length) {
    entriesEl.innerHTML = '<p class="message">No authenticator codes saved yet.</p>';
    return;
  }

  entriesEl.replaceChildren(...entries.map(entry => {
    const isCodeRevealed = state.revealedCodes.has(entry.id);
    const isDetailsOpen = state.openDetails.has(entry.id);
    const card = document.createElement('article');
    card.className = 'entry';

    const title = document.createElement('div');
    title.className = 'entry-title';
    title.textContent = entryName(entry);

    const code = document.createElement('div');
    code.className = `code ${isCodeRevealed ? '' : 'code-blurred'}`;
    code.tabIndex = 0;
    code.title = isCodeRevealed ? 'Click to hide token' : 'Click to reveal token';
    code.textContent = entry.code;
    code.addEventListener('click', () => toggleToken(entry.id));
    code.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggleToken(entry.id);
      }
    });

    const meta = document.createElement('p');
    meta.className = 'message';
    meta.textContent = `${entry.remaining}s remaining - ${entry.algorithm} - ${entry.digits} digits`;

    const hint = document.createElement('p');
    hint.className = 'message';
    hint.textContent = isCodeRevealed ? 'Click the token to hide it.' : 'Click the blurred token to reveal it.';

    const actions = document.createElement('div');
    actions.className = 'entry-actions';

    const copy = document.createElement('button');
    copy.className = 'secondary';
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(entry.code);
      setMessage(vaultMessage, 'Code copied.');
    });

    const details = document.createElement('button');
    details.className = 'secondary';
    details.type = 'button';
    details.textContent = isDetailsOpen ? 'Hide details' : 'Details';
    details.addEventListener('click', () => toggleDetails(entry.id));

    const del = document.createElement('button');
    del.className = 'secondary delete';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteEntry(entry.id));

    actions.append(copy, details, del);
    card.append(title, code, meta, hint, actions);

    if (isDetailsOpen) {
      card.append(renderDetailsPanel(entry));
    }

    return card;
  }));
}

function renderDetailsPanel(entry) {
  const cached = state.detailsCache.get(entry.id);
  const revealed = state.revealedRecovery.has(entry.id);
  const draft = state.detailsDrafts.get(entry.id);
  const wrapper = document.createElement('div');
  wrapper.className = 'details-panel';

  if (!cached) {
    const loading = document.createElement('p');
    loading.className = 'message';
    loading.textContent = 'Loading saved details...';
    wrapper.append(loading);
    return wrapper;
  }

  const field = document.createElement('label');
  field.className = 'details-field';
  field.textContent = 'Recovery codes (optional)';

  const textarea = document.createElement('textarea');
  textarea.rows = Math.max(4, Math.min(10, cached.recoveryCodes.length || 4));
  textarea.value = draft !== undefined ? draft : cached.recoveryCodes.join('\n');
  textarea.className = revealed ? 'recovery-textarea' : 'recovery-textarea recovery-blurred';
  textarea.spellcheck = false;
  textarea.readOnly = !revealed;
  textarea.placeholder = 'One backup code per line';
  textarea.addEventListener('input', () => {
    state.detailsDrafts.set(entry.id, textarea.value);
  });
  field.append(textarea);

  const hint = document.createElement('p');
  hint.className = 'message';
  hint.textContent = revealed
    ? 'Recovery codes are revealed. Save after editing.'
    : 'Open details and reveal to view or edit recovery codes.';

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const reveal = document.createElement('button');
  reveal.className = 'secondary';
  reveal.type = 'button';
  reveal.textContent = revealed ? 'Hide recovery' : 'Reveal recovery';
  reveal.addEventListener('click', () => toggleRecovery(entry.id));

  const save = document.createElement('button');
  save.className = 'secondary';
  save.type = 'button';
  save.textContent = 'Save recovery';
  save.addEventListener('click', () => saveRecovery(entry.id, textarea.value));

  const copy = document.createElement('button');
  copy.className = 'secondary';
  copy.type = 'button';
  copy.textContent = 'Copy recovery';
  copy.disabled = !cached.recoveryCodes.length;
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(cached.recoveryCodes.join('\n'));
    setMessage(vaultMessage, 'Recovery codes copied.');
  });

  const download = document.createElement('button');
  download.className = 'secondary';
  download.type = 'button';
  download.textContent = 'Save file';
  download.disabled = !cached.recoveryCodes.length;
  download.addEventListener('click', () => downloadRecoveryCodes(entry, cached.recoveryCodes));

  actions.append(reveal, save, copy, download);
  wrapper.append(field, hint, actions);
  return wrapper;
}

function toggleToken(id) {
  if (state.revealedCodes.has(id)) {
    state.revealedCodes.delete(id);
  } else {
    state.revealedCodes.add(id);
  }
  loadEntries();
}

async function toggleDetails(id) {
  if (state.openDetails.has(id)) {
    state.openDetails.delete(id);
    loadEntries();
    return;
  }

  state.openDetails.add(id);
  if (!state.detailsCache.has(id)) {
    try {
      const details = await api(`/api/entries/${encodeURIComponent(id)}/details`, { method: 'GET' });
      state.detailsCache.set(id, details);
      if (!state.detailsDrafts.has(id)) {
        state.detailsDrafts.set(id, (details.recoveryCodes || []).join('\n'));
      }
    } catch (error) {
      state.openDetails.delete(id);
      setMessage(vaultMessage, error.message, true);
    }
  }
  await loadEntries();
}

function toggleRecovery(id) {
  if (state.revealedRecovery.has(id)) {
    state.revealedRecovery.delete(id);
  } else {
    state.revealedRecovery.add(id);
  }
  loadEntries();
}

async function saveRecovery(id, value) {
  try {
    const details = await api(`/api/entries/${encodeURIComponent(id)}/details`, {
      method: 'PATCH',
      body: JSON.stringify({ recoveryCodes: value })
    });
    state.detailsCache.set(id, details);
    state.detailsDrafts.set(id, (details.recoveryCodes || []).join('\n'));
    setMessage(vaultMessage, 'Recovery codes saved.');
    await loadEntries();
  } catch (error) {
    setMessage(vaultMessage, error.message, true);
  }
}

function downloadRecoveryCodes(entry, codes) {
  const name = entryName(entry).replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'authenticator';
  const blob = new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-recovery-codes.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadStatus() {
  const body = await api('/api/status', { method: 'GET' });
  state.setup = body.setup;
  state.unlocked = body.unlocked;
  renderMode();
}

async function loadEntries() {
  if (!state.unlocked) return;
  try {
    const body = await api('/api/entries', { method: 'GET' });
    renderEntries(body.entries);
  } catch (error) {
    state.unlocked = false;
    setMessage(authMessage, error.message, true);
    renderMode();
  }
}

async function deleteEntry(id) {
  try {
    await api(`/api/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.revealedCodes.delete(id);
    state.openDetails.delete(id);
    state.detailsCache.delete(id);
    state.detailsDrafts.delete(id);
    state.revealedRecovery.delete(id);
    setMessage(vaultMessage, 'Entry deleted.');
    await loadEntries();
  } catch (error) {
    setMessage(vaultMessage, error.message, true);
  }
}

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(authMessage, '');
  const body = {
    username: document.querySelector('#username').value,
    password: document.querySelector('#password').value
  };
  try {
    await api(state.setup ? '/api/login' : '/api/register', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    state.setup = true;
    state.unlocked = true;
    authForm.reset();
    renderMode();
  } catch (error) {
    setMessage(authMessage, error.message, true);
  }
});

entryForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(vaultMessage, '');
  const body = {
    issuer: document.querySelector('#issuer').value,
    label: document.querySelector('#label').value,
    secret: document.querySelector('#secret').value
  };
  try {
    await api('/api/entries', { method: 'POST', body: JSON.stringify(body) });
    entryForm.reset();
    setMessage(vaultMessage, 'Entry encrypted and saved.');
    await loadEntries();
  } catch (error) {
    setMessage(vaultMessage, error.message, true);
  }
});

logoutButton.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.unlocked = false;
  renderMode();
});

passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(vaultMessage, '');
  const body = {
    currentUsername: document.querySelector('#current-username').value,
    currentPassword: document.querySelector('#current-password').value,
    username: document.querySelector('#new-username').value,
    password: document.querySelector('#new-password').value
  };
  try {
    await api('/api/change-password', { method: 'POST', body: JSON.stringify(body) });
    passwordForm.reset();
    setMessage(vaultMessage, 'Vault re-encrypted with the new login.');
  } catch (error) {
    setMessage(vaultMessage, error.message, true);
  }
});

loadStatus().catch(error => setMessage(authMessage, error.message, true));
