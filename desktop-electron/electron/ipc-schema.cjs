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

function normalizedJsonKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[-.\s]+/g, "_");
}

function jsonKeyIsDisallowed(key, rejectSensitiveKeys) {
  return DISALLOWED_JSON_KEYS.has(key)
    || (rejectSensitiveKeys && SENSITIVE_RESPONSE_KEYS.has(normalizedJsonKey(key)));
}

function snapshotJsonValue(
  value,
  code,
  path = "$",
  ancestors = new Set(),
  depth = 0,
  rejectSensitiveKeys = false,
) {
  if (depth > MAX_JSON_DEPTH) throw codedError(code, `${path} exceeds the maximum JSON depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw codedError(code, `${path} must be a JSON value`);
  }
  if (ancestors.has(value)) throw codedError(code, `${path} contains a cyclic reference`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = value.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_JSON_ARRAY_ITEMS) {
        throw codedError(code, `${path} has an invalid or excessive array length`);
      }
      const keys = Object.keys(value);
      if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
        throw codedError(code, `${path} must be a dense JSON array without extra properties`);
      }
      const snapshot = new Array(length);
      for (let index = 0; index < length; index += 1) {
        snapshot[index] = snapshotJsonValue(
          value[index],
          code,
          `${path}[${index}]`,
          ancestors,
          depth + 1,
          rejectSensitiveKeys,
        );
      }
      return Object.freeze(snapshot);
    }

    const keys = Object.keys(value);
    if (keys.length > MAX_JSON_OBJECT_ENTRIES) {
      throw codedError(code, `${path} has too many object entries`);
    }
    const snapshot = {};
    for (const key of keys) {
      if (jsonKeyIsDisallowed(key, rejectSensitiveKeys)) {
        throw codedError(code, `${path}.${key} is not allowed`);
      }
      Object.defineProperty(snapshot, key, {
        value: snapshotJsonValue(
          value[key],
          code,
          `${path}.${key}`,
          ancestors,
          depth + 1,
          rejectSensitiveKeys,
        ),
        enumerable: true,
        configurable: false,
        writable: false,
      });
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

function assertSerializedSize(value, limit, sizeCode, valueCode) {
  assertJsonValue(value, valueCode);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw codedError(valueCode, error instanceof Error ? error.message : String(error));
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limit) throw codedError(sizeCode, `${bytes} bytes exceeds ${limit}`);
}

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
        } else {
          assertJsonValue(item, code, `${path}.${key}`);
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

const workspaceSummary = Object.freeze({
  type: "object",
  required: Object.freeze(["id", "name", "path", "mcpState", "policyRevision"]),
  properties: Object.freeze({
    id: Object.freeze({ type: "string", minLength: 1, maxLength: 128 }),
    name: Object.freeze({ type: "string", minLength: 1, maxLength: 240 }),
    path: Object.freeze({ type: "string", minLength: 1, maxLength: 4096 }),
    mcpState: Object.freeze({
      type: "string",
      enum: Object.freeze(["stopped", "starting", "running", "stopping", "error"]),
    }),
    policyRevision: Object.freeze({ type: "integer", minimum: 0 }),
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

const appsCallRequest = Object.freeze({
  type: "object",
  required: Object.freeze(["moduleId", "operation"]),
  properties: Object.freeze({
    moduleId: Object.freeze({
      type: "string",
      enum: Object.freeze(["cpa", "codex-router", "commandcode-proxy", "paseo", "anneal"]),
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
    request: emptyObject,
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

async function invokeContract(ipcRenderer, name, payload = {}) {
  const contract = CONTRACTS[name];
  if (!contract) throw codedError("IPC_CONTRACT_UNKNOWN", name);

  const requestSnapshot = snapshotJsonPayload(payload, "IPC_REQUEST_SCHEMA_INVALID");
  assertSerializedSize(
    requestSnapshot,
    MAX_REQUEST_BYTES,
    "IPC_REQUEST_TOO_LARGE",
    "IPC_REQUEST_SCHEMA_INVALID",
  );
  assertSchema(requestSnapshot, contract.request, "IPC_REQUEST_SCHEMA_INVALID");

  let response;
  try {
    response = await ipcRenderer.invoke(contract.channel, requestSnapshot);
  } catch {
    throw codedError("IPC_TRANSPORT_FAILED", `${name} failed`);
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
