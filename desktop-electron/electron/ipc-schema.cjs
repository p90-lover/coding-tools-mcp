const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_ITEMS = 10_000;
const MAX_JSON_OBJECT_ENTRIES = 10_000;
const DISALLOWED_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_RESPONSE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "client_secret",
  "clientsecret",
  "api_key",
  "apikey",
  "runtime_key",
  "runtimekey",
  "private_key",
  "privatekey",
  "session_cookie",
  "sessioncookie",
  "authorization",
  "cookie",
  "set_cookie",
  "id_token",
  "auth_token",
  "oauth_token",
  "bearer_token",
  "csrf_token",
  "xsrf_token",
  "secret_key",
  "credential",
  "password",
  "secret",
  "token",
  "bearer",
]);
const VALIDATION_ERROR_MARKER = Symbol("coding-tools-ipc-validation-error");

function codedError(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  Object.defineProperty(error, VALIDATION_ERROR_MARKER, { value: true });
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Every key of every response is normalized (three regular expressions) to look for credentials,
// and the same few dozen names ("id", "kind", "status"…) repeat throughout. A project's runs and
// chat timelines held the window for 0.8 s in this checking alone, so a key's form is remembered.
const NORMALIZED_KEYS = new Map();
const NORMALIZED_KEYS_MAX = 4096;
function normalizedJsonKey(key) {
  let normalized = NORMALIZED_KEYS.get(key);
  if (normalized !== undefined) return normalized;
  normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.\s]+/g, "_");
  if (NORMALIZED_KEYS.size >= NORMALIZED_KEYS_MAX) NORMALIZED_KEYS.clear();
  NORMALIZED_KEYS.set(key, normalized);
  return normalized;
}

function jsonKeyIsDisallowed(key, rejectSensitiveKeys) {
  return DISALLOWED_JSON_KEYS.has(key)
    || (rejectSensitiveKeys && SENSITIVE_RESPONSE_KEYS.has(normalizedJsonKey(key)));
}

// `path` names where a value sits, for an error message. It may be a function that builds it:
// building a path string for every value of a large response cost more than checking the value,
// so a path is only spelled out when something fails.
const pathText = (path) => (typeof path === "function" ? path() : path);

function snapshotJsonValue(
  value,
  code,
  path = "$",
  ancestors = new Set(),
  depth = 0,
  rejectSensitiveKeys = false,
) {
  if (depth > MAX_JSON_DEPTH) throw codedError(code, `${pathText(path)} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw codedError(code, `${pathText(path)} must be a JSON value`);
  }
  if (ancestors.has(value)) throw codedError(code, `${pathText(path)} contains a cyclic reference`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_ARRAY_ITEMS) {
        throw codedError(code, `${pathText(path)} has an invalid or excessive array length`);
      }
      // Dense, with nothing but its indexes: as many own keys as items, and every index present.
      if (Object.keys(value).length !== length) {
        throw codedError(code, `${pathText(path)} must be a dense JSON array without extra properties`);
      }
      const snapshot = new Array(length);
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw codedError(code, `${pathText(path)} must be a dense JSON array without extra properties`);
        }
        snapshot[index] = snapshotJsonValue(
          value[index],
          code,
          () => `${pathText(path)}[${index}]`,
          ancestors,
          depth + 1,
          rejectSensitiveKeys,
        );
      }
      return Object.freeze(snapshot);
    }

    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_OBJECT_ENTRIES) {
      throw codedError(code, `${pathText(path)} has too many object entries`);
    }
    const snapshot = {};
    for (const key of keys) {
      // __proto__, prototype and constructor are refused here, so assigning below always makes an
      // own property; freezing the object then makes each one read-only, as defining them did.
      if (jsonKeyIsDisallowed(key, rejectSensitiveKeys)) {
        throw codedError(code, `${pathText(path)}.${key} is not allowed`);
      }
      snapshot[key] = snapshotJsonValue(
        value[key],
        code,
        () => `${pathText(path)}.${key}`,
        ancestors,
        depth + 1,
        rejectSensitiveKeys,
      );
    }
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotJsonPayload(value, code, { rejectSensitiveKeys = false } = {}) {
  try {
    return snapshotJsonValue(value, code, "$", new Set(), 0, rejectSensitiveKeys);
  } catch (error) {
    if (error instanceof Error
      && error[VALIDATION_ERROR_MARKER] === true
      && error.code === code) {
      throw error;
    }
    throw codedError(code, "payload could not be read safely");
  }
}

function assertJsonValue(value, code, path = "$", ancestors = new Set(), depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw codedError(code, `${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw codedError(code, `${path} must be a JSON value`);
  }
  if (ancestors.has(value)) throw codedError(code, `${path} contains a cyclic reference`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonValue(item, code, `${path}[${index}]`, ancestors, depth + 1));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, code, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The UTF-8 length of `text`, as Buffer.byteLength counts it (a lone surrogate is 3 bytes). In the
 * sandboxed preload Buffer is a JavaScript polyfill that first builds an array of every byte, which
 * cost hundreds of milliseconds per large response; this only counts. Where the native TextEncoder
 * exists (the renderer, Node) it counts instead: the counting loop still cost ~110 ms per 30 s of a
 * busy chat. Its count equals the loop's for JSON.stringify output, which has no lone surrogates.
 */
const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;
function utf8Length(text) {
  if (textEncoder) return textEncoder.encode(text).length;
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
      && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Throws when `value` serializes to more than `limit` bytes. `validated` says it is a snapshot
 * snapshotJsonValue already checked (plain JSON, acyclic, within depth), which need not be walked again.
 */
function assertSerializedSize(value, limit, sizeCode, valueCode, { validated = false } = {}) {
  if (!validated) assertJsonValue(value, valueCode);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw codedError(valueCode, error instanceof Error ? error.message : String(error));
  }
  // At most 3 bytes per UTF-16 unit (4 per surrogate pair), and at least 1: only a text between
  // limit/3 and limit units long needs counting.
  if (serialized.length * 3 <= limit) return;
  if (serialized.length > limit) {
    throw codedError(sizeCode, `at least ${serialized.length} bytes exceeds ${limit}`);
  }
  const bytes = utf8Length(serialized);
  if (bytes > limit) throw codedError(sizeCode, `${bytes} bytes exceeds ${limit}`);
}

/**
 * Checks a snapshot against its contract. `value` is always a snapshotJsonValue snapshot, already
 * checked as plain JSON within the depth and size caps, so fields the schema leaves free are not
 * walked again: that second walk of every response cost ~150 ms per 30 s of a busy chat (profiled
 * on 0.8.34).
 */
function assertSchema(value, schema, code, path = "$") {
  if (schema.nullable === true && value === null) return;
  if (schema.enum && !schema.enum.includes(value)) {
    throw codedError(code, `${path} must be one of ${schema.enum.join(", ")}`);
  }

  switch (schema.type) {
    case "object": {
      if (!isPlainObject(value)) throw codedError(code, `${path} must be an object`);
      const properties = schema.properties || {};
      for (const key of schema.required || []) {
        if (!Object.hasOwn(value, key)) throw codedError(code, `${path}.${key} is required`);
      }
      for (const [key, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          assertSchema(item, properties[key], code, `${path}.${key}`);
        } else if (schema.additionalProperties === false) {
          throw codedError(code, `${path}.${key} is not allowed`);
        }
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) throw codedError(code, `${path} must be an array`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw codedError(code, `${path} has too many items`);
      }
      value.forEach((item, index) => assertSchema(item, schema.items, code, `${path}[${index}]`));
      return;
    case "string":
      if (typeof value !== "string") throw codedError(code, `${path} must be a string`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw codedError(code, `${path} is too short`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw codedError(code, `${path} is too long`);
      }
      if (schema.pattern && !schema.pattern.test(value)) {
        throw codedError(code, `${path} has an invalid format`);
      }
      return;
    case "integer":
      if (!Number.isSafeInteger(value)) throw codedError(code, `${path} must be a safe integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw codedError(code, `${path} is below the minimum`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw codedError(code, `${path} exceeds the maximum`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") throw codedError(code, `${path} must be a boolean`);
      return;
    default:
      throw codedError(code, `${path} uses an unsupported schema type`);
  }
}

const emptyObject = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});

const pageProperties = Object.freeze({
  cursor: Object.freeze({ type: "integer", minimum: 0 }),
  limit: Object.freeze({ type: "integer", minimum: 1, maximum: 100 }),
});

const pageRequest = Object.freeze({
  type: "object",
  properties: pageProperties,
  additionalProperties: false,
});

const genericObject = Object.freeze({
  type: "object",
  additionalProperties: true,
});

const linkedProjectSummary = Object.freeze({
  type: "object",
  required: Object.freeze(["alias", "name", "path", "mode"]),
  properties: Object.freeze({
    alias: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    mode: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
  }),
  additionalProperties: false,
});

const workspaceSummary = Object.freeze({
  type: "object",
  required: Object.freeze(["id", "name", "path", "mcpState", "policyRevision", "linkedProjects", "permissionMode", "approvalMode", "toolProfile", "mcpAuthType", "actionsAuthType", "mcpLocalPort", "actionsLocalPort", "screenCaptureEnabled", "mcpOAuthClientId", "mcpOAuthRedirectUris", "mcpUseSharedSecrets", "actionsOAuthClientId", "actionsOAuthRedirectUris", "actionsOAuthScopes", "actionsUseSharedSecrets"]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    linkedProjects: Object.freeze({ type: "array", items: linkedProjectSummary, maxItems: 100 }),
    mcpState: Object.freeze({
      type: "string",
      enum: Object.freeze(["stopped", "starting", "running", "stopping", "error"]),
    }),
    policyRevision: Object.freeze({ type: "integer", minimum: 0 }),
    permissionMode: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    approvalMode: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    toolProfile: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    mcpAuthType: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    actionsAuthType: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    mcpLocalPort: Object.freeze({ type: "integer", minimum: 1, maximum: 65535, nullable: true }),
    actionsLocalPort: Object.freeze({ type: "integer", minimum: 1, maximum: 65535, nullable: true }),
    screenCaptureEnabled: Object.freeze({ type: "boolean", nullable: true }),
    mcpOAuthClientId: Object.freeze({ type: "string", maxLength: 256 }),
    mcpOAuthRedirectUris: Object.freeze({ type: "array", items: Object.freeze({ type: "string", maxLength: 2048 }), maxItems: 32 }),
    mcpUseSharedSecrets: Object.freeze({ type: "boolean", nullable: true }),
    actionsOAuthClientId: Object.freeze({ type: "string", maxLength: 256 }),
    actionsOAuthRedirectUris: Object.freeze({ type: "array", items: Object.freeze({ type: "string", maxLength: 2048 }), maxItems: 32 }),
    actionsOAuthScopes: Object.freeze({ type: "string", maxLength: 1024 }),
    actionsUseSharedSecrets: Object.freeze({ type: "boolean", nullable: true }),
  }),
  additionalProperties: false,
});

const pagedWorkspaceResponse = Object.freeze({
  type: "object",
  required: Object.freeze(["items", "nextCursor"]),
  properties: Object.freeze({
    items: Object.freeze({ type: "array", items: workspaceSummary, maxItems: 100 }),
    nextCursor: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
  }),
  additionalProperties: false,
});

const workspaceRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
  }),
  additionalProperties: false,
});

const workspacePolicyUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "permissionMode", "approvalMode", "toolProfile", "screenCaptureEnabled"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    permissionMode: Object.freeze({ type: "string", enum: Object.freeze(["read-only", "workspace-write"]) }),
    approvalMode: Object.freeze({ type: "string", enum: Object.freeze(["ask", "on-request", "never"]) }),
    toolProfile: Object.freeze({ type: "string", enum: Object.freeze(["read-only", "core", "advanced", "compat-readonly-all"]) }),
    screenCaptureEnabled: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

// The Edit project dialog: a name, the primary folder and the extra source folders.
const workspaceUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "name", "path", "linkedPaths", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    linkedPaths: Object.freeze({ type: "array", items: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }), maxItems: 32 }),
    confirm: Object.freeze({ type: "boolean", enum: Object.freeze([true]) }),
  }),
  additionalProperties: false,
});

// Removes the project from the app's list only; no file is deleted.
const workspaceRemoveRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    confirm: Object.freeze({ type: "boolean", enum: Object.freeze([true]) }),
  }),
  additionalProperties: false,
});

const workspaceCreateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["path", "confirm"]),
  properties: Object.freeze({
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    confirm: Object.freeze({ type: "boolean", enum: Object.freeze([true]) }),
  }),
  additionalProperties: false,
});

const workspaceCreatedResponse = Object.freeze({
  type: "object",
  required: Object.freeze(["id", "name", "path", "cancelled"]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096, nullable: true }),
    cancelled: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const nativeCodexStatusRequest = Object.freeze({
  type: "object",
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
  }),
  additionalProperties: false,
});

const nativeCodexConnectRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "executable", "codexHome", "model", "allowModelUsage", "allowCommandExecution", "permissionProfile", "requestLimit", "lifetimeSeconds"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    executable: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    codexHome: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    model: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    allowModelUsage: Object.freeze({ type: "boolean" }),
    allowCommandExecution: Object.freeze({ type: "boolean" }),
    permissionProfile: Object.freeze({ type: "string", enum: Object.freeze([":read-only", ":workspace"]) }),
    requestLimit: Object.freeze({ type: "integer", minimum: 0, maximum: 20 }),
    lifetimeSeconds: Object.freeze({ type: "integer", minimum: 0, maximum: 900 }),
  }),
  additionalProperties: false,
});

const workspaceAuthUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "service", "authType", "oauthClientId", "oauthRedirectUris", "oauthScopes", "useSharedSecrets"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    service: Object.freeze({ type: "string", enum: Object.freeze(["mcp", "actions"]) }),
    authType: Object.freeze({ type: "string", enum: Object.freeze(["oauth", "bearer", "noauth", "api_key", "none"]) }),
    oauthClientId: Object.freeze({ type: "string", maxLength: 256 }),
    oauthRedirectUris: Object.freeze({ type: "array", items: Object.freeze({ type: "string", maxLength: 2048 }), maxItems: 32 }),
    oauthScopes: Object.freeze({ type: "string", maxLength: 1024 }),
    useSharedSecrets: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const workspaceServiceRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "service", "operation"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    service: Object.freeze({ type: "string", enum: Object.freeze(["mcp", "actions"]) }),
    operation: Object.freeze({ type: "string", enum: Object.freeze(["status", "start", "stop", "restart"]) }),
  }),
  additionalProperties: false,
});

const workspaceSecretRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "key"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    key: Object.freeze({ type: "string", enum: Object.freeze(["bearer_token", "oauth_password", "actions_api_key", "actions_oauth_client_secret", "actions_oauth_password"]) }),
  }),
  additionalProperties: false,
});

const toolsCallRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "tool"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    tool: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    requestId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    arguments: genericObject,
  }),
  additionalProperties: false,
});

const RETIRED_APP_MODULE_IDS = Object.freeze(["paseo", "codex-router", "commandcode-proxy", "anneal"]);

const appsCallRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["moduleId", "operation"]),
  properties: Object.freeze({
    moduleId: Object.freeze({
      type: "string",
      enum: Object.freeze(["cpa", "agent-orchestrator", "antigravity-cli", ...RETIRED_APP_MODULE_IDS]),
    }),
    operation: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
    requestId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    arguments: genericObject,
  }),
  additionalProperties: false,
});

const taskListRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId"]),
  properties: Object.freeze({
    ...pageProperties,
    cursor: Object.freeze({ type: "integer", minimum: 0, maximum: 256 }),
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
  }),
  additionalProperties: false,
});

const taskSummary = Object.freeze({
  type: "object",
  required: Object.freeze(["id", "title", "description", "state"]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    title: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
    description: Object.freeze({ type: "string", maxLength: 8192 }),
    state: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
  }),
  additionalProperties: false,
});

const taskListResponse = Object.freeze({
  type: "object",
  required: Object.freeze(["items", "nextCursor", "revision"]),
  properties: Object.freeze({
    items: Object.freeze({ type: "array", items: taskSummary, maxItems: 100 }),
    nextCursor: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
    revision: Object.freeze({ type: "integer", minimum: 0 }),
  }),
  additionalProperties: false,
});

const historySearchRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceRoot", "query"]),
  properties: Object.freeze({
    workspaceRoot: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    query: Object.freeze({ type: "string", minLength: 1 }),
    cursor: Object.freeze({ type: "integer", minimum: 0 }),
    limit: Object.freeze({ type: "integer", minimum: 1, maximum: 50 }),
  }),
  additionalProperties: false,
});

const historySearchResponse = Object.freeze({
  type: "object",
  required: Object.freeze(["items", "nextCursor"]),
  properties: Object.freeze({
    items: Object.freeze({ type: "array", items: genericObject, maxItems: 50 }),
    nextCursor: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
  }),
  additionalProperties: false,
});

const genericListResponse = Object.freeze({
  type: "object",
  required: Object.freeze(["items", "nextCursor"]),
  properties: Object.freeze({
    items: Object.freeze({ type: "array", items: genericObject, maxItems: 100 }),
    nextCursor: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
  }),
  additionalProperties: false,
});


const executionReadRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    missionId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    refreshSource: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionSettings = Object.freeze({
  type: "object",
  required: Object.freeze([
    "engine",
    "endpoint",
    "provider",
    "model",
    "mode",
    "maxDurationMin",
    "allowCodex",
    "confirmExternalExecution",
  ]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    engine: Object.freeze({ type: "string", enum: Object.freeze(["paseo", "anneal"]) }),
    endpoint: Object.freeze({ type: "string", minLength: 1, maxLength: 2048 }),
    provider: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    model: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    mode: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    projectId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    repoId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    assigneeId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    maxDurationMin: Object.freeze({ type: "integer", minimum: 1, maximum: 1440 }),
    allowCodex: Object.freeze({ type: "boolean" }),
    confirmExternalExecution: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionProviderRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "operation", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    operation: Object.freeze({
      type: "string",
      enum: Object.freeze(["configure", "connect", "disable"]),
    }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0, nullable: true }),
    bindingId: Object.freeze({ type: "string", minLength: 1, maxLength: 128, nullable: true }),
    settings: Object.freeze({ ...executionSettings, nullable: true }),
    providerAccountId: Object.freeze({ type: "string", minLength: 1, maxLength: 160, nullable: true }),
    allowProviderFallback: Object.freeze({ type: "boolean" }),
    controlCredential: Object.freeze({ type: "string", maxLength: 8192 }),
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const executionUpdateRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["workspaceId", "expectedRevision", "change", "confirm"]),
  properties: Object.freeze({
    workspaceId: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    expectedRevision: Object.freeze({ type: "integer", minimum: 0 }),
    change: genericObject,
    confirm: Object.freeze({ type: "boolean" }),
  }),
  additionalProperties: false,
});

const CONTRACTS = Object.freeze({
  "runtime.status": Object.freeze({
    channel: "coding-tools:runtime:status",
    request: emptyObject,
    response: genericObject,
  }),
  "workspaces.list": Object.freeze({
    channel: "coding-tools:workspaces:list",
    request: pageRequest,
    response: pagedWorkspaceResponse,
  }),
  "workspaces.updatePolicy": Object.freeze({
    channel: "coding-tools:workspaces:policy-update",
    request: workspacePolicyUpdateRequest,
    response: genericObject,
  }),
  "workspaces.update": Object.freeze({
    channel: "coding-tools:workspaces:update",
    request: workspaceUpdateRequest,
    response: genericObject,
  }),
  "workspaces.remove": Object.freeze({
    channel: "coding-tools:workspaces:remove",
    request: workspaceRemoveRequest,
    response: genericObject,
  }),
  "workspaces.create": Object.freeze({
    channel: "coding-tools:workspaces:create",
    request: workspaceCreateRequest,
    response: workspaceCreatedResponse,
  }),
  "workspaces.updateAuth": Object.freeze({
    channel: "coding-tools:workspaces:auth-update",
    request: workspaceAuthUpdateRequest,
    response: genericObject,
  }),
  "workspaces.service": Object.freeze({
    channel: "coding-tools:workspaces:service",
    request: workspaceServiceRequest,
    response: genericObject,
  }),
  "workspaces.copySecret": Object.freeze({
    channel: "coding-tools:workspaces:copy-secret",
    request: workspaceSecretRequest,
    response: genericObject,
  }),
  "permissions.snapshot": Object.freeze({
    channel: "coding-tools:permissions:snapshot",
    request: workspaceRequest,
    response: genericObject,
  }),
  "computer.status": Object.freeze({
    channel: "coding-tools:computer:status",
    request: emptyObject,
    response: genericObject,
  }),
  "computer.requests": Object.freeze({
    channel: "coding-tools:computer:requests",
    request: emptyObject,
    response: genericObject,
  }),
  "computer.answer": Object.freeze({
    channel: "coding-tools:computer:answer",
    request: Object.freeze({
      type: "object",
      required: Object.freeze(["id"]),
      properties: Object.freeze({
        id: Object.freeze({ type: "string", minLength: 1, maxLength: 64 }),
        cancel: Object.freeze({ type: "boolean" }),
        window: Object.freeze({ type: "integer", minimum: 0, maximum: 10_000 }),
        duration: Object.freeze({ type: "string", minLength: 1, maxLength: 16 }),
        capture: Object.freeze({ type: "boolean" }),
      }),
      additionalProperties: false,
    }),
    response: genericObject,
  }),
  "tasks.list": Object.freeze({
    channel: "coding-tools:tasks:list",
    request: taskListRequest,
    response: taskListResponse,
  }),
  "history.search": Object.freeze({
    channel: "coding-tools:history:search",
    request: historySearchRequest,
    response: historySearchResponse,
  }),
  "nativeCodex.status": Object.freeze({
    channel: "coding-tools:native-codex:status",
    request: nativeCodexStatusRequest,
    response: genericObject,
  }),
  "nativeCodex.connect": Object.freeze({
    channel: "coding-tools:native-codex:connect",
    request: nativeCodexConnectRequest,
    response: genericObject,
  }),
  "nativeCodex.disconnect": Object.freeze({
    channel: "coding-tools:native-codex:disconnect",
    request: workspaceRequest,
    response: genericObject,
  }),
  "integrations.snapshot": Object.freeze({
    channel: "coding-tools:integrations:snapshot",
    request: emptyObject,
    response: genericObject,
  }),
  "execution.read": Object.freeze({
    channel: "coding-tools:execution:read",
    request: executionReadRequest,
    response: genericObject,
  }),
  "execution.provider": Object.freeze({
    channel: "coding-tools:execution:provider",
    request: executionProviderRequest,
    response: genericObject,
  }),
  "execution.update": Object.freeze({
    channel: "coding-tools:execution:update",
    request: executionUpdateRequest,
    response: genericObject,
  }),
  "updates.status": Object.freeze({
    channel: "coding-tools:updates:status",
    request: emptyObject,
    response: genericObject,
  }),
  "diagnostics.snapshot": Object.freeze({
    channel: "coding-tools:diagnostics:snapshot",
    request: emptyObject,
    response: genericObject,
  }),
  "tools.catalog": Object.freeze({
    channel: "coding-tools:tools:catalog",
    request: workspaceRequest,
    response: genericObject,
  }),
  "tools.call": Object.freeze({
    channel: "coding-tools:tools:call",
    request: toolsCallRequest,
    response: genericObject,
  }),
  "apps.list": Object.freeze({
    channel: "coding-tools:apps:list",
    request: emptyObject,
    response: genericObject,
  }),
  "apps.catalog": Object.freeze({
    channel: "coding-tools:apps:catalog",
    request: emptyObject,
    response: genericObject,
  }),
  "apps.call": Object.freeze({
    channel: "coding-tools:apps:call",
    request: appsCallRequest,
    response: genericObject,
  }),
});

// Anything that could carry a credential keeps the main process's error to itself.
const CREDENTIAL_TEXT = /authori[sz]ation|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|cookie|\bsk-[A-Za-z0-9]|\beyJ[A-Za-z0-9_-]{8,}/i;
/**
 * The main process's own error message, without Electron's "Error invoking remote method 'x':
 * Error:" wrapper. "apps.call failed" alone left a failed Stop (and every other refused action)
 * with no reason; a message that could carry a credential is still dropped.
 */
function transportReason(error) {
  const text = String(error?.message || "")
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || CREDENTIAL_TEXT.test(text)) return "";
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

async function invokeContract(ipcRenderer, name, payload = {}) {
  const contract = CONTRACTS[name];
  if (!contract) throw codedError("IPC_CONTRACT_UNKNOWN", name);

  const requestSnapshot = snapshotJsonPayload(payload, "IPC_REQUEST_SCHEMA_INVALID");
  assertSerializedSize(
    requestSnapshot,
    MAX_REQUEST_BYTES,
    "IPC_REQUEST_TOO_LARGE",
    "IPC_REQUEST_SCHEMA_INVALID",
    { validated: true },
  );
  assertSchema(requestSnapshot, contract.request, "IPC_REQUEST_SCHEMA_INVALID");
  if (name === "apps.call" && RETIRED_APP_MODULE_IDS.includes(requestSnapshot.moduleId)) {
    throw codedError("APP_MODULE_RETIRED", `Retired Coding Tools module: ${requestSnapshot.moduleId}`);
  }

  let response;
  try {
    response = await ipcRenderer.invoke(contract.channel, requestSnapshot);
  } catch (error) {
    const reason = transportReason(error);
    throw codedError("IPC_TRANSPORT_FAILED", reason ? `${name} failed: ${reason}` : `${name} failed`);
  }
  const responseSnapshot = snapshotJsonPayload(
    response,
    "IPC_RESPONSE_SCHEMA_INVALID",
    { rejectSensitiveKeys: true },
  );
  assertSerializedSize(
    responseSnapshot,
    MAX_RESPONSE_BYTES,
    "IPC_RESPONSE_TOO_LARGE",
    "IPC_RESPONSE_SCHEMA_INVALID",
    { validated: true },
  );
  assertSchema(responseSnapshot, contract.response, "IPC_RESPONSE_SCHEMA_INVALID");
  return responseSnapshot;
}

module.exports = Object.freeze({
  CONTRACTS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_JSON_DEPTH,
  MAX_JSON_ARRAY_ITEMS,
  MAX_JSON_OBJECT_ENTRIES,
  SENSITIVE_RESPONSE_KEYS,
  invokeContract,
});
