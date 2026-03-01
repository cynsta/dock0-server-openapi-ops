#!/usr/bin/env node

import crypto from "node:crypto";

const SERVER_INFO = { name: "server-openapi-ops", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-11-25";
const REQUEST_TIMEOUT_MS = 15_000;

// One-shot process model means in-memory store is per request process.
// This is acceptable for v0 scaffolding; production should persist specs in DB/cache.
const specStore = new Map();

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function initializeResult(request) {
  const requestedVersion = request?.params?.protocolVersion;
  return {
    protocolVersion: typeof requestedVersion === "string" ? requestedVersion : DEFAULT_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO
  };
}

function listToolsResult() {
  return {
    tools: [
      {
        name: "register_spec",
        description: "Fetch and register an OpenAPI JSON spec URL.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            spec_url: { type: "string" },
            auth_mode: { type: "string", enum: ["none", "bearer", "api_key_header"], default: "none" },
            auth_secret_name: { type: "string" }
          },
          required: ["spec_url"]
        }
      },
      {
        name: "list_operations",
        description: "List operations from a registered OpenAPI spec.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            spec_id: { type: "string" },
            spec_url: { type: "string" },
            tag: { type: "string" }
          },
          required: []
        }
      },
      {
        name: "call_operation",
        description: "Invoke an operation by operationId.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            spec_id: { type: "string" },
            spec_url: { type: "string" },
            operation_id: { type: "string" },
            path_params: { type: "object" },
            query: { type: "object" },
            body: { type: "object" }
          },
          required: ["operation_id"]
        }
      }
    ]
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("invalid_input: spec_url must be https");

    const res = await fetch(parsed, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "dock0-openapi-ops/0.1" }
    });

    if (!res.ok) throw new Error(`upstream_error: HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("timeout: request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function collectOperations(spec) {
  const out = [];
  const paths = spec?.paths ?? {};

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!op || typeof op !== "object") continue;
      const operationId = op.operationId ?? `${method.toUpperCase()} ${path}`;
      out.push({
        operation_id: operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? null,
        tags: Array.isArray(op.tags) ? op.tags : [],
        required_params: Array.isArray(op.parameters)
          ? op.parameters
              .filter((p) => p?.required)
              .map((p) => ({
                name: p?.name,
                in: p?.in
              }))
          : []
      });
    }
  }

  return out;
}

function findOperation(spec, operationId) {
  const paths = spec?.paths ?? {};
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!op || typeof op !== "object") continue;
      const currentId = op.operationId ?? `${method.toUpperCase()} ${path}`;
      if (currentId === operationId) {
        return { method: method.toUpperCase(), path, operation: op };
      }
    }
  }
  return null;
}

function buildUrl(baseUrl, pathTemplate, pathParams = {}, query = {}) {
  let path = pathTemplate;
  for (const [k, v] of Object.entries(pathParams ?? {})) {
    path = path.replaceAll(`{${k}}`, encodeURIComponent(String(v)));
  }

  const u = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u;
}

async function invokeOperation(specRecord, opMatch, args) {
  const url = buildUrl(specRecord.base_url, opMatch.path, args?.path_params ?? {}, args?.query ?? {});

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const init = {
      method: opMatch.method,
      signal: controller.signal,
      headers: {
        "user-agent": "dock0-openapi-ops/0.1",
        accept: "application/json, text/plain;q=0.8"
      }
    };

    if (!["GET", "HEAD"].includes(opMatch.method) && args?.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(args.body);
    }

    const res = await fetch(url, init);
    const contentType = res.headers.get("content-type") ?? "";

    let json = null;
    let text = null;
    if (contentType.includes("application/json")) {
      json = await res.json().catch(() => null);
    } else {
      text = await res.text();
    }

    return {
      status: res.status,
      headers_subset: {
        content_type: res.headers.get("content-type"),
        cache_control: res.headers.get("cache-control")
      },
      json,
      text
    };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("timeout: upstream call timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleRegisterSpec(args) {
  if (typeof args?.spec_url !== "string") throw new Error("invalid_input: spec_url is required");
  const spec = await fetchJson(args.spec_url);

  const servers = Array.isArray(spec?.servers) ? spec.servers : [];
  const baseUrl = servers[0]?.url;
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error("invalid_input: spec missing servers[0].url");
  }

  const specId = crypto.createHash("sha1").update(args.spec_url).digest("hex").slice(0, 12);
  const operations = collectOperations(spec);

  specStore.set(specId, {
    spec,
    base_url: baseUrl,
    auth_mode: args?.auth_mode ?? "none",
    auth_secret_name: args?.auth_secret_name ?? null,
    operations
  });

  return {
    spec_id: specId,
    title: spec?.info?.title ?? "unknown",
    version: spec?.info?.version ?? "unknown",
    operations_count: operations.length
  };
}

async function resolveSpecRecord(args) {
  const specId = typeof args?.spec_id === "string" ? args.spec_id : null;
  const specUrl = typeof args?.spec_url === "string" ? args.spec_url : null;

  if (specId) {
    const record = specStore.get(specId);
    if (record) {
      return { specId, record };
    }
    if (!specUrl) {
      throw new Error("invalid_input: unknown spec_id (provide spec_url for stateless mode)");
    }
  } else if (!specUrl) {
    throw new Error("invalid_input: either spec_id or spec_url is required");
  }

  const spec = await fetchJson(specUrl);
  const servers = Array.isArray(spec?.servers) ? spec.servers : [];
  const baseUrl = servers[0]?.url;
  if (!baseUrl || typeof baseUrl !== "string") {
    throw new Error("invalid_input: spec missing servers[0].url");
  }

  const derivedSpecId = crypto.createHash("sha1").update(specUrl).digest("hex").slice(0, 12);
  const record = {
    spec,
    base_url: baseUrl,
    auth_mode: "none",
    auth_secret_name: null,
    operations: collectOperations(spec)
  };
  specStore.set(derivedSpecId, record);
  return { specId: derivedSpecId, record };
}

async function handleListOperations(args) {
  const { specId, record } = await resolveSpecRecord(args);

  const tag = typeof args?.tag === "string" ? args.tag : null;
  const operations = tag
    ? record.operations.filter((op) => Array.isArray(op.tags) && op.tags.includes(tag))
    : record.operations;

  return { spec_id: specId, total: operations.length, operations };
}

async function handleCallOperation(args) {
  if (typeof args?.operation_id !== "string") throw new Error("invalid_input: operation_id is required");
  const { specId, record } = await resolveSpecRecord(args);

  const match = findOperation(record.spec, args.operation_id);
  if (!match) throw new Error("invalid_input: operation_id not found in spec");

  const response = await invokeOperation(record, match, args);
  return {
    spec_id: specId,
    operation_id: args.operation_id,
    method: match.method,
    path: match.path,
    response
  };
}

async function callToolResult(params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "register_spec") return handleRegisterSpec(args);
  if (name === "list_operations") return await handleListOperations(args);
  if (name === "call_operation") return handleCallOperation(args);
  throw new Error(`invalid_input: unknown tool '${String(name ?? "")}'`);
}

async function handleRequest(request) {
  const id = request?.id ?? null;
  const method = request?.method;

  if (method === "initialize") return jsonRpcResult(id, initializeResult(request));
  if (method === "notifications/initialized") return jsonRpcResult(id, {});
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, listToolsResult());

  if (method === "tools/call") {
    try {
      const structured = await callToolResult(request?.params);
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return jsonRpcError(id, -32602, message);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${String(method ?? "")}`);
}

async function main() {
  process.stdin.setEncoding("utf8");

  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
        continue;
      }

      const response = await handleRequest(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const request = JSON.parse(tail);
      const response = await handleRequest(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "internal_error";
  process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32000, message))}\n`);
  process.exitCode = 1;
});
