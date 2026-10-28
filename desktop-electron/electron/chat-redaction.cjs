"use strict";

// Hiding secrets the user pasted into a chat (redact_message, chat-agent-tools.cjs). A chat's
// messages are its board task's description (chat-edits.cjs), so the agent's call replaces each
// secret there with a marker, "[hidden: <label>]", which the chat shows blurred. The stored text is
// changed, not masked on screen only: a later turn, chat_read and a fresh session read the marker,
// never the secret. What the agent's own session already received is out of the app's reach.
//
// The user chooses in Settings whether agents may do this and lists what counts as sensitive; the
// list is the tool's description, so the agent hides only those kinds of text.

// The same follow-up marker chat-edits.cjs and ao-chat.ts (chatMessagesFromDescription) read.
const FOLLOW_UP = /(\n\nFollow-up \([^)]+ UTC\):\n)/;
// What a hidden secret becomes; ao-chat.ts (hiddenSecretParts) draws it blurred.
const HIDDEN = /\[hidden: [^\]\n]{1,40}\]/;

const MAX_LIST_ITEMS = 30;
const MAX_LIST_ITEM = 200;
const MAX_SECRETS = 20;
const MAX_SECRET = 4096;

// What agents hide when the user has not edited the list.
const DEFAULT_REDACT_LIST = Object.freeze([
  "API keys and access tokens (sk-…, ghp_…, AKIA…, xox…, Bearer …)",
  "Passwords and passphrases",
  "Private keys (PEM, SSH, PGP) and certificates' private parts",
  "Connection strings and URLs with a password or token in them",
  "Session cookies, OAuth client secrets and refresh tokens",
  "Payment card and bank account numbers",
]);

/** The user's list as saved: trimmed lines, no blanks or repeats, capped; anything else is the default. */
function redactList(value) {
  if (!Array.isArray(value)) return [...DEFAULT_REDACT_LIST];
  const lines = value.filter((line) => typeof line === "string").map((line) => line.trim().slice(0, MAX_LIST_ITEM)).filter(Boolean);
  return [...new Set(lines)].slice(0, MAX_LIST_ITEMS);
}

/** The marker a secret becomes: its label kept to one short line without brackets. */
function hiddenMarker(label) {
  const word = String(label ?? "").replace(/[\]\[\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return `[hidden: ${word || "secret"}]`;
}

/**
 * Whether `secret` may be hidden: text the agent quotes from the user's message. The agent picks
 * it, so a careless or misled call must not blank out ordinary words of the conversation, nor the
 * chat's own structure (the follow-up and steer markers, earlier hidden markers).
 */
function acceptableSecret(secret) {
  if (typeof secret !== "string" || secret.length < 6 || secret.length > MAX_SECRET) return false;
  // Exactly as quoted, with no padding around it. It may span lines (a PEM, SSH or PGP private key
  // block, Codex review of #653): only one message's text is searched, never a follow-up header, and
  // a secret naming the chat's own markers is refused below.
  if (secret !== secret.trim()) return false;
  if (HIDDEN.test(secret) || /Follow-up|↳ Steer|\bUTC\b/.test(secret)) return false;
  // A key or password has a digit or a symbol, or is a long passphrase; one plain word ("please") never is.
  return /[\d\W_]/.test(secret) || secret.length >= 20;
}

/**
 * The description with every exact occurrence of each secret replaced by `label`'s marker, in the
 * user's messages only: the follow-up headers between them are never touched. Longer secrets go
 * first, so one that contains another is hidden whole. `hidden` counts the replacements; secrets
 * that are not acceptable are listed in `refused` and left as they are.
 */
function chatDescriptionRedacted(description, secrets, label) {
  const given = Array.isArray(secrets) ? secrets.slice(0, MAX_SECRETS) : [];
  const refused = given.filter((secret) => !acceptableSecret(secret));
  const wanted = [...new Set(given.filter(acceptableSecret))].sort((a, b) => b.length - a.length);
  const marker = hiddenMarker(label);
  let hidden = 0;
  // split with a capturing group keeps the headers at odd indexes.
  const parts = String(description ?? "").split(FOLLOW_UP).map((part, index) => {
    if (index % 2 === 1) return part;
    let text = part;
    for (const secret of wanted) {
      // A key pasted on Windows may be saved with CRLF while the agent quotes it with LF, or back.
      const forms = /\n/.test(secret)
        ? [...new Set([secret, secret.replace(/\r\n/g, "\n"), secret.replace(/\r?\n/g, "\r\n")])]
        : [secret];
      for (const form of forms) {
        const pieces = text.split(form);
        hidden += pieces.length - 1;
        text = pieces.join(marker);
      }
    }
    return text;
  });
  return { description: parts.join(""), hidden, refused: refused.length };
}

module.exports = {
  DEFAULT_REDACT_LIST, HIDDEN, MAX_SECRET, MAX_SECRETS,
  acceptableSecret, chatDescriptionRedacted, hiddenMarker, redactList,
};
