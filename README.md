# payguard

Before an agent sends money, someone should check the payment against the rules it was given. payguard is a small forwarding client for the free SpendGuard tool on the hosted AgentProof MCP service: you describe a proposed Base USDC payment and the spending policy it must satisfy, and the service answers APPROVE, HUMAN_APPROVAL or BLOCK with findings — before anything moves. The check is advisory only; neither the service nor this client signs anything, holds keys, or moves funds.

The upstream service exposes five tools, but four of them (`quick_check`, `token_risk`, `preflight`, `verify_payment`) charge per call in USDC via x402. payguard never originates a payment, so those four are omitted outright — they do not appear in the tool list, the MCP surface, or the CLI — and no payment header is ever constructed or sent. What remains is the one free tool, exposed in full: the tool list is answered from your own machine using the captured definition, and each call travels upstream, with the service's answer handed back exactly as it arrived.

## The tool

- **`spendguard_evaluate`** — Check a proposed payment against a policy you supply. Required inputs: `agentId` and `requestId` (your own identifiers for the agent and the request), `chain` (only `base`) and `asset` (only `USDC`), the `recipient` address, the `amount` as a string, and a `policy` object with `maxPerTransaction`, `remainingDailyBudget`, `requireHumanAbove`, `maxRepeats`, `allowedRecipients` and `blockUnknownRecipients`. An optional `context` object can carry a `repeatCount` and a prior `agentProofDecision` (`ALLOW`, `WARN`, `BLOCK`, `INCOMPLETE` or `UNKNOWN`). Returns APPROVE, HUMAN_APPROVAL or BLOCK with findings.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/payguard mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "payguard": {
      "command": "npx",
      "args": ["-y", "@reneturcios/payguard", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/payguard
docker run --rm ghcr.io/cloudcorprecords/payguard spendguard_evaluate '{"agentId":"agent-1","requestId":"req-1","chain":"base","asset":"USDC","recipient":"0x1111111111111111111111111111111111111111","amount":"25.00","policy":{"maxPerTransaction":"50.00","remainingDailyBudget":"100.00","requireHumanAbove":"40.00","maxRepeats":3,"allowedRecipients":["0x1111111111111111111111111111111111111111"],"blockUnknownRecipients":true}}'
```

## CLI

A single binary covers both the command line and the MCP server. The kept tool is a subcommand whose one argument is a JSON string of that tool's inputs:

```bash
payguard spendguard_evaluate '{"agentId":"agent-1","requestId":"req-1","chain":"base","asset":"USDC","recipient":"0x1111111111111111111111111111111111111111","amount":"25.00","policy":{"maxPerTransaction":"50.00","remainingDailyBudget":"100.00","requireHumanAbove":"40.00","maxRepeats":3,"allowedRecipients":["0x1111111111111111111111111111111111111111"],"blockUnknownRecipients":true}}'
payguard --version
```

The omitted tools are not subcommands: `payguard quick_check '{}'` is a usage error, exactly like any other unknown command. Exit codes: `0` for a successful forwarded call, `1` when the result that comes back is an error, and `2` for usage mistakes like an unknown subcommand or a JSON argument that does not parse.

## Configuration

- `KUSHBITX_MCP_URL` — Replaces the upstream endpoint. Defaults to the pinned hosted endpoint, `https://kushbitx.com/mcp`. (This override variable is a reconstruction introduced by this rebuild.)

The AgentProof registry record lists no headers for its remote, so payguard never attaches an authentication header — every call goes upstream keyless. It likewise never attaches an x402 or other payment header: the one tool it forwards is free, and the priced tools are not part of this build at all.

When the upstream cannot answer — it returns a JSON-RPC error, answers with a non-2xx status, sends a body that cannot be read, or the request itself fails — the caller receives an error result whose text begins with `payguard error:`.

## How forwarding works

The first call of a process opens a session against the upstream: an `initialize` request (protocol version `2025-03-26`), a `notifications/initialized` notification, and then the `tools/call`. If the service issues an `Mcp-Session-Id` header during initialize, payguard repeats it on subsequent requests and keeps reusing that one session until the process ends. Replies are understood in both plain JSON and server-sent-events framing. Successful results are passed through untouched, `isError` flag and any extra fields included.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The suite compares the served tool list against the captured kept tool, proves the four omitted x402 tools are absent from the registry, the MCP layer and the CLI, proves no `Authorization` header and no payment header of any kind is sent under any environment, walks the session handshake and its reuse, and confirms that arguments travel upstream unchanged and results return unchanged.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
