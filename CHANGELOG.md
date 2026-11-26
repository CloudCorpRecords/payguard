# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted AgentProof MCP server's free SpendGuard tool. The upstream server exposes five tools; this rebuild carries exactly one — `spendguard_evaluate` — and omits the four per-call-priced x402 tools (`quick_check`, `token_risk`, `preflight`, `verify_payment`), which are absent from the tool registry, the MCP surface and the CLI.
- `spendguard_evaluate` checks a proposed Base USDC payment against a spending policy the caller supplies (per-transaction limit, daily budget, human-approval threshold, allowed recipients) and returns APPROVE, HUMAN_APPROVAL or BLOCK with findings. Advisory only: it never signs, holds keys or moves funds, and this client never constructs or sends any payment header.
- tools/list is answered locally from the captured definition; every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one). Upstream results pass through verbatim, including the isError flag; upstream failures surface as `payguard error:` text results.
- One bin serves the CLI (one subcommand for the kept tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `KUSHBITX_MCP_URL`. The registry record declares no headers on the remote, so no auth header is ever sent.
