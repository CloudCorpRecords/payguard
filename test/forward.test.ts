import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  OMITTED_TOOL_NAMES,
  parseRpcBody,
  PayguardClient,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { createServer, handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real AgentProof endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/kushbitx-agentproof-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Ruling 1 (extended fleet-wide, Rene 2026-11-15): the registration
 * comparison strips `description` fields recursively on both sides, so
 * truthful parameter descriptions added under the ruling do not break
 * the deep-equal against the captured fixture; everything else is
 * compared exactly as before.
 */
function stripDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDescriptions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "description") continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return value;
}

/**
 * Publish-survival guard (Wave 29 P1 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const EVALUATE = "spendguard_evaluate";
const OMITTED = ["quick_check", "token_risk", "preflight", "verify_payment"];

const RECIPIENT = "0x1111111111111111111111111111111111111111";

const SAMPLE_ARGS = {
  agentId: "agent-1",
  requestId: "req-1",
  chain: "base",
  asset: "USDC",
  recipient: RECIPIENT,
  amount: "25.00",
  policy: {
    maxPerTransaction: "50.00",
    remainingDailyBudget: "100.00",
    requireHumanAbove: "40.00",
    maxRepeats: 3,
    allowedRecipients: [RECIPIENT],
    blockUnknownRecipients: true,
  },
};

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"decision\":\"APPROVE\",\"findings\":[]}" }],
  structuredContent: { decision: "APPROVE", findings: [] },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-abc" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "agentproof", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new PayguardClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

function defOf(name: string): ToolDef {
  const def = TOOL_DEFS.find((t) => t.name === name);
  assert.ok(def !== undefined, `missing tool def ${name}`);
  return def;
}

/* CLI helpers. */

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    cwd: CLI_ROOT,
    encoding: "utf8",
    timeout: 30000,
  });
}

/* MCP client over an in-memory transport, for tools/list and
 * tools/call assertions at the MCP layer itself. */
async function withMcpClient<T>(
  upstream: { fetchFn: FetchFn },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer({ fetchFn: upstream.fetchFn, env: {} });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "payguard-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/* ------------------------------------------------------------------ */

describe("registration integrity (labelled subset: 1 of 5 captured tools)", () => {
  it("serves exactly the fixture's 1 tool, deep-equal", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 1);
    assert.deepEqual(stripDescriptions(TOOL_DEFS), stripDescriptions(fixture.tools));
  });

  it("serves exactly the one kept tool name", () => {
    assert.deepEqual(TOOL_NAMES, [EVALUATE]);
  });

  it("carries exactly the fixture's keys on the kept tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's title verbatim", () => {
    assert.equal(defOf(EVALUATE).title, "SpendGuard policy check");
  });

  it("carries the fixture's description verbatim", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(defOf(EVALUATE).description, fixture.tools[0].description);
    assert.match(defOf(EVALUATE).description, /^Free\. Check a proposed Base USDC payment/);
    assert.match(defOf(EVALUATE).description, /APPROVE, HUMAN_APPROVAL or BLOCK/);
    assert.match(defOf(EVALUATE).description, /never signs, holds keys or moves funds/);
  });

  it("carries the required array exactly as captured", () => {
    assert.deepEqual(schemaOf(defOf(EVALUATE)).required, [
      "agentId",
      "requestId",
      "chain",
      "asset",
      "recipient",
      "amount",
      "policy",
    ]);
  });

  it("carries every fixture property, in order", () => {
    assert.deepEqual(Object.keys(schemaOf(defOf(EVALUATE)).properties), [
      "agentId",
      "requestId",
      "chain",
      "asset",
      "recipient",
      "amount",
      "policy",
      "context",
    ]);
  });

  it("the top-level schema is an object with additionalProperties false and no $schema key", () => {
    const schema = schemaOf(defOf(EVALUATE));
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.equal("$schema" in schema, false);
  });

  it("agentId, requestId and amount are plain strings", () => {
    const props = schemaOf(defOf(EVALUATE)).properties;
    assert.deepEqual(props.agentId, { type: "string", description: "Identifier of the agent requesting the payment" });
    assert.deepEqual(props.requestId, { type: "string", description: "Unique identifier of this payment request" });
    assert.deepEqual(props.amount, { type: "string", description: "Payment amount, as a string" });
  });

  it("chain is the single-value enum [base] and asset is [USDC]", () => {
    const props = schemaOf(defOf(EVALUATE)).properties;
    assert.deepEqual(props.chain, { type: "string", enum: ["base"], description: "Blockchain network for the payment (base)" });
    assert.deepEqual(props.asset, { type: "string", enum: ["USDC"], description: "Asset to pay in (USDC)" });
  });

  it("recipient is a string with the captured EVM address pattern", () => {
    const recipient = schemaOf(defOf(EVALUATE)).properties.recipient;
    assert.deepEqual(recipient, {
      type: "string",
      pattern: "^0x[a-fA-F0-9]{40}$",
      description: "Recipient address of the payment",
    });
  });

  it("policy is a closed object with the captured required fields, in order", () => {
    const policy = schemaOf(defOf(EVALUATE)).properties.policy;
    assert.equal(policy.type, "object");
    assert.equal(policy.additionalProperties, false);
    assert.deepEqual(policy.required, [
      "maxPerTransaction",
      "remainingDailyBudget",
      "requireHumanAbove",
      "maxRepeats",
      "allowedRecipients",
      "blockUnknownRecipients",
    ]);
    assert.deepEqual(Object.keys(policy.properties), [
      "maxPerTransaction",
      "remainingDailyBudget",
      "requireHumanAbove",
      "maxRepeats",
      "allowedRecipients",
      "blockUnknownRecipients",
    ]);
  });

  it("policy money limits are strings and maxRepeats an integer of at least 1", () => {
    const props = schemaOf(defOf(EVALUATE)).properties.policy.properties;
    assert.deepEqual(props.maxPerTransaction, { type: "string" });
    assert.deepEqual(props.remainingDailyBudget, { type: "string" });
    assert.deepEqual(props.requireHumanAbove, { type: "string" });
    assert.deepEqual(props.maxRepeats, { type: "integer", minimum: 1 });
    assert.deepEqual(props.blockUnknownRecipients, { type: "boolean" });
  });

  it("policy allowedRecipients is an array of EVM-pattern strings", () => {
    const allowed = schemaOf(defOf(EVALUATE)).properties.policy.properties
      .allowedRecipients;
    assert.deepEqual(allowed, {
      type: "array",
      items: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
    });
  });

  it("context is an optional closed object with repeatCount and the decision enum", () => {
    const context = schemaOf(defOf(EVALUATE)).properties.context;
    assert.equal(context.type, "object");
    assert.equal(context.additionalProperties, false);
    assert.equal("required" in context, false);
    assert.deepEqual(Object.keys(context.properties), [
      "repeatCount",
      "agentProofDecision",
    ]);
    assert.deepEqual(context.properties.repeatCount, {
      type: "integer",
      minimum: 0,
    });
    assert.deepEqual(context.properties.agentProofDecision, {
      type: "string",
      enum: ["ALLOW", "WARN", "BLOCK", "INCOMPLETE", "UNKNOWN"],
    });
  });

  it("context itself is optional (not in the required array)", () => {
    assert.equal(schemaOf(defOf(EVALUATE)).required.includes("context"), false);
  });

  it("isKnownTool recognises the kept tool and rejects others", () => {
    assert.equal(isKnownTool(EVALUATE), true);
    assert.equal(isKnownTool("spendguard"), false);
    assert.equal(isKnownTool("evaluate"), false);
    assert.equal(isKnownTool(""), false);
  });

  it("the MCP tools/list response carries exactly the fixture's 1 tool", async (t) => {
    if (skipWithoutFixture(t)) return;
    const upstream = makeUpstream();
    const listed = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools;
    });
    assert.deepEqual(
      listed.map((t) => t.name),
      [EVALUATE],
    );
    assert.deepEqual(stripDescriptions(listed), stripDescriptions(fixture.tools));
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("omitted x402 tools are absent at every layer", () => {
  it("the omission list names exactly the four priced tools", () => {
    assert.deepEqual([...OMITTED_TOOL_NAMES], OMITTED);
  });

  it("registry level: none of the omitted names is registered", () => {
    for (const name of OMITTED) {
      assert.equal(TOOL_NAMES.includes(name), false, name);
      assert.equal(
        TOOL_DEFS.some((t) => t.name === name),
        false,
        name,
      );
      assert.equal(isKnownTool(name), false, name);
    }
  });

  it("MCP layer: handleCallTool rejects each omitted tool with MethodNotFound and no network hop", async () => {
    for (const name of OMITTED) {
      const upstream = makeUpstream();
      const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
      await assert.rejects(
        () => handleCallTool(c, name, {}),
        (err: unknown) =>
          err instanceof McpError && err.code === ErrorCode.MethodNotFound,
      );
      assert.equal(upstream.calls.length, 0, name);
    }
  });

  it("MCP layer: a live tools/call for each omitted tool is rejected and never reaches the upstream", async () => {
    for (const name of OMITTED) {
      const upstream = makeUpstream();
      await withMcpClient(upstream, async (client) => {
        await assert.rejects(() => client.callTool({ name, arguments: {} }));
      });
      assert.equal(upstream.calls.length, 0, name);
    }
  });

  it("MCP layer: tools/list contains none of the omitted names", async () => {
    const upstream = makeUpstream();
    const names = await withMcpClient(upstream, async (client) => {
      const res = await client.listTools();
      return res.tools.map((t) => t.name);
    });
    for (const name of OMITTED) assert.equal(names.includes(name), false, name);
  });

  it("CLI level: each omitted name is a usage error (exit 2)", () => {
    for (const name of OMITTED) {
      const res = runCli([name, "{}"]);
      assert.equal(res.status, 2, name);
      assert.match(res.stderr, /Usage:/);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://kushbitx.com/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-abc");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-abc");
  });

  it("sends clientInfo name payguard and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "payguard", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-abc");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the KUSHBITX_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new PayguardClient({
      fetchFn: upstream.fetchFn,
      env: { KUSHBITX_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { KUSHBITX_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new PayguardClient({
      fetchFn: upstream.fetchFn,
      env: { KUSHBITX_MCP_URL: "   " },
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("no auth header and no payment header is ever sent", () => {
  it("sends no Authorization header when the environment is empty", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header even when API-key style env vars are present", async () => {
    const upstream = makeUpstream();
    const c = new PayguardClient({
      fetchFn: upstream.fetchFn,
      env: {
        KUSHBITX_API_KEY: "some-key-42",
        AUTHORIZATION: "Bearer x",
        API_KEY: "y",
        KUSHBITX_TOKEN: "z",
      },
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
    assert.ok(upstream.calls.every((call) => call.headers["X-API-Key"] === undefined));
  });

  it("sends no X-PAYMENT header on any request", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.headers["X-PAYMENT"], undefined);
      assert.equal(call.headers["X-Payment"], undefined);
      assert.equal(call.headers["x-payment"], undefined);
    }
  });

  it("sends no payment header of any name, even with payment-flavoured env vars present", async () => {
    const upstream = makeUpstream();
    const c = new PayguardClient({
      fetchFn: upstream.fetchFn,
      env: {
        X402_TOKEN: "tok",
        PAYMENT_HEADER: "hdr",
        X_PAYMENT: "p",
      },
    });
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    for (const call of upstream.calls) {
      for (const key of Object.keys(call.headers)) {
        assert.equal(/payment|x402/i.test(key), false, `header ${key}`);
      }
      assert.equal(/payment|x402/i.test(JSON.stringify(call.body)), false);
    }
  });

  it("sends only Content-Type, Accept and (when issued) Mcp-Session-Id headers", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.deepEqual(Object.keys(calls[0].headers).sort(), [
      "Accept",
      "Content-Type",
    ]);
    assert.deepEqual(Object.keys(calls[2].headers).sort(), [
      "Accept",
      "Content-Type",
      "Mcp-Session-Id",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a spendguard_evaluate call verbatim with its full argument object", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(EVALUATE, SAMPLE_ARGS);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EVALUATE);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("forwards the optional context object verbatim when supplied", async () => {
    const args = {
      ...SAMPLE_ARGS,
      context: { repeatCount: 2, agentProofDecision: "WARN" },
    };
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await c.callTool(EVALUATE, args);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EVALUATE);
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "policy rejected upstream" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(EVALUATE, SAMPLE_ARGS, {
      fetchFn: upstream.fetchFn,
      env: {},
    });
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, EVALUATE);
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as payguard error text", () => {
  it("maps a JSON-RPC error to `payguard error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "evaluation failed upstream" },
    });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: evaluation failed upstream");
  });

  it("maps an initialize JSON-RPC error to payguard error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: malformed response");
  });

  it("maps a non-2xx upstream status to payguard error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: HTTP 500");
  });

  it("maps a throwing fetch to payguard error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^payguard error: /);
  });

  it("maps a throwing initialize fetch to payguard error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "payguard error: socket hang up");
  });

  it("maps a timed-out call to payguard error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(EVALUATE, SAMPLE_ARGS);
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^payguard error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, EVALUATE, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, EVALUATE, "amount=25"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid spendguard_evaluate call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, EVALUATE, SAMPLE_ARGS);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, SAMPLE_ARGS);
  });

  it("an MCP tools/call for an unknown tool is rejected and never reaches the upstream", async () => {
    const upstream = makeUpstream();
    await withMcpClient(upstream, async (client) => {
      await assert.rejects(() =>
        client.callTool({ name: "spendguard_delete", arguments: {} }),
      );
    });
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.match(res.stderr, /spendguard_evaluate/);
  });

  it("the usage text names only the kept tool, never an omitted one", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    for (const name of OMITTED) {
      assert.equal(res.stderr.includes(name), false, name);
    }
  });

  it("no command at all prints usage on stderr and exits 2", () => {
    const res = runCli([]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([EVALUATE, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([EVALUATE, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after a tool exit 2", () => {
    const res = runCli([EVALUATE, "{}", "extra"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
