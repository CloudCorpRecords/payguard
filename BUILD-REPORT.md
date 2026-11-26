# BUILD REPORT — payguard

Clean-room rebuild of `com.kushbitx/agentproof` v1.0.0
(remote-only MCP server at `https://kushbitx.com/mcp`),
built 2026-10-28 as a forwarding client. Package: `@reneturcios/payguard`
0.1.0, registry name `io.github.CloudCorpRecords/payguard`.

## Surface built

**LABELLED SUBSET: 1 of 5 captured tools built.**

| Tool | Required fields as served |
|------|---------------------------|
| `spendguard_evaluate` | `agentId`, `requestId`, `chain`, `asset`, `recipient`, `amount`, `policy` |

OMITTED (absent from the fixture and from this rebuild):
`quick_check`, `token_risk`, `preflight`, `verify_payment` —
every one is priced per call in USDC via x402 in its own
captured description (0.001–0.00288 USDC per call, Base,
exact scheme). This rebuild never originates payment, so
the x402 tools are omitted individually beside the free
core. Tests assert their absence at registry level
(`TOOL_DEFS` / `TOOL_NAMES` / `isKnownTool`), at the MCP
layer (`handleCallTool` rejects each with MethodNotFound
before any network hop, a live in-memory-transport
`tools/call` for each is rejected with zero upstream
calls, and `tools/list` contains none of them), and at
the CLI level (each omitted name exits 2 as a usage
error, and the usage text never names one).

The kept tool carries exactly the keys `name`, `title`,
`description`, `inputSchema`, served verbatim from the
capture — including the nested `policy` object (closed,
six required fields, `maxRepeats` integer ≥ 1,
`allowedRecipients` an array of EVM-pattern strings) and
the optional `context` object (`repeatCount` integer
≥ 0, `agentProofDecision` enum ALLOW / WARN / BLOCK /
INCOMPLETE / UNKNOWN). The served `inputSchema` carries
no `$schema` key — none was captured, none was invented.
The tool literal was generated programmatically from
`harness/fixtures/kushbitx-agentproof-tools-original.json`
by the script at `/tmp/laneb8-payguard-scratch/gen.py`
(parse + re-serialise, spliced into `src/forward.ts`
between the TOOL_DEFS_GENERATED markers) — never
retyped — and the generator's round-trip check confirmed
the spliced block parses back deep-equal to the fixture's
1 tool object. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

The kept surface is a compute-only advisory over the
caller's own proposed payment and the caller's own
policy: it executes no payment and screens no third
party.

## Fixture conflicts

**None.** The spec and the fixture agree on the kept
tool's name, title, description, the `required` array
(`agentId`, `requestId`, `chain`, `asset`, `recipient`,
`amount`, `policy`), and every property shape, including
the nested `policy` and `context` objects.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://kushbitx.com/mcp`.
- Env override `KUSHBITX_MCP_URL` — labelled reconstruction.
- The registry record declares NO headers on the remote: no
  auth header is ever sent, under any environment. Tests
  assert that no `Authorization` header (and no `X-API-Key`
  header) is sent with an empty environment and with
  API-key / token style variables present.
- No x402/payment header: tests assert no `X-PAYMENT`
  header (any casing) is sent on any request, that no
  header name on any request matches /payment|x402/i even
  with payment-flavoured env vars present, that no request
  body contains a payment/x402 marker, and that the only
  headers ever sent are Content-Type, Accept and (when
  issued) Mcp-Session-Id.
- Error rendering `payguard error:` text for upstream
  failures — labelled reconstruction.
- Upstream results pass through verbatim, including `isError`
  and extra fields. tools/call is forwarded as streamable-HTTP
  JSON-RPC: initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE replies
  are both parsed. The forwarding core takes an injectable
  fetch; tests stub the upstream — no live network calls in
  tests, and no live call is claimed beyond the coordinator's
  tools/list capture.

## Deviations

**None.** No write-guard workaround was needed in this
session: the lockfile, `npm ci`, `tsc` build and test
suite all ran through the normal routes (tests and the
type check were invoked through the direct
`node_modules/.bin/` binaries, which is the fleet's
standard local route), and `dist/` is the direct output
of `tsc` on the validated sources.

## Lockfile

Generated clean from birth (Route 3, clean dir, no
`node_modules`, no pre-existing lockfile):
`npm install --package-lock-only --ignore-scripts --offline`
→ success. Parses as JSON; `name` == `@reneturcios/payguard`;
exactly **128** package entries; sha256
`791e8c0a3e792402092f6b748950d0f76ee93888265a8c78bcb52522d9df3b23`.
`npm ci --ignore-scripts --offline` then succeeded and the
lockfile sha256 was re-verified **unchanged** afterwards.

## server.json

- Description exactly: "Free SpendGuard: check a proposed Base USDC payment against your own spending policy first." — **91 characters** (measured).
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/payguard:0.1.0`) carries **no**
  `version` field. Both entries carry packageArguments
  `[{type: positional, value: mcp}]` and transport stdio. Dockerfile
  (node:20-alpine, both stages) carries the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/payguard"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/payguard`
  and its smoke test asserts the server name `payguard`.

## Verification (run 2026-10-28, builder session)

1. `npm install --package-lock-only --ignore-scripts --offline`
   → success; lockfile parses, name `@reneturcios/payguard`,
   128 package entries (see Lockfile).
2. `npm ci --ignore-scripts --offline` → success; lockfile
   sha256 unchanged.
3. `tsc --noEmit` (direct `node_modules/.bin/tsc`) → exit 0.
4. `tsc` build → exit 0; `node dist/cli.js --version` → `0.1.0`.
5. Full suite (`tsx --test test/*.test.ts`, direct
   `node_modules/.bin/tsx`) → **70 tests, 70 pass, 0 fail**
   (registration-integrity suite deep-equals the served
   tools/list against the fixture's 1 tool at both the
   registry level and through an in-memory-transport MCP
   `tools/list`; per-field schema detail assertions for the
   nested policy/context objects; omission assertions for
   all four x402 tools at registry, MCP-layer and CLI
   level; no-Authorization-header and no-payment-header
   assertions under every environment; session
   handling/reuse; env override; verbatim argument
   forwarding and result pass-through including upstream
   isError; SSE parsing; error rendering; MCP-layer
   validation; CLI behaviour).
6. Parity (harness, tools-file mode):
   `python3 /home/hatch/workspace/mcp-rebuild-100/harness/parity.py --original /home/hatch/workspace/mcp-rebuild-100/harness/fixtures/kushbitx-agentproof-tools-original.json --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/payguard/dist/cli.js mcp" --out /home/hatch/workspace/mcp-rebuild-100/builds/payguard/parity-out/`
   → **verdict PASS, parity 100.0** (1/1 identical, 0 missing,
   0 extra, no schema diffs). Output in `parity-out/`.
