# AGENTS.md

Parametric flight-delay insurance on Arc. Three independent parts, three toolchains — there is no root package manager; `web/` and `agent/` each own their `package.json`/`node_modules`.

## Layout

- **Contracts (root)** — Foundry. `src/`: `FlightRegistry` (facts, single source of truth for flight data), `FlightAgent` (oracle chokepoint, the registry's only writer), `Insurance` (policy rules, holds no funds), `Vault` (ERC-4626, holds every token; `INSURANCE_ROLE` drives it). Interfaces/errors in `src/interfaces/IFlightData.sol`.
- **`web/`** — Next.js 14 traveller frontend. Also serves the mock flight-data API at `api/flightaware`, which is the agent's default data source.
- **`agent/`** — TS (viem) monitoring agent. Polls flights, posts status to `FlightRegistry` via `FlightAgent`, sweeps settled policies.
- **`script/`** — deploy scripts. **`deployments/arc-testnet.md`** — live addresses, wiring checks, replay instructions. `DESIGN.md` — architecture rationale.

## Commands

Contracts:
```bash
forge build
forge test                              # 55 tests, all in test/ClearSky.t.sol
forge test -vvv --match-test test_Claim  # single test w/ traces
```
No Solidity linter. CI (`forge build --sizes && forge test -vvv`) runs only via manual `workflow_dispatch`.

Web (`cd web`): `npm run dev` and `npm run build` auto-run `npm run abis` (regenerates `src/lib/abis/` from `out/` — the folder is gitignored by design). Requires `forge build` at repo root first. Lint: `npm run lint`.

Agent (`cd agent`): `npm run typecheck` (tsc), `npm run monitor` / `monitor:once` / `sweep`, `npm run legcheck` + `mockpass` (the offline test suites — there is no test framework), `npm run register-identity` (mint ERC-8004 id).

## Gotchas (hard-earned)

- **`agent/src/flightdata.ts` is a hand-kept mirror of `web/src/lib/flightaware.ts`.** Change one, change both. `npm run legcheck` (in `agent/`) pins the shared leg-selection behaviour against captured real data.
- **Flights are keyed by `legId` (the provider's `fa_flight_id`), never flight number** — a flight number is reused daily. `flightNumber` is display-only.
- **6-decimal USDC everywhere** (Arc's ERC-20 USDC interface; the native balance is 18d — don't mix). In the web app use `src/lib/format.ts`, not viem's `formatEther`.
- **Approvals go to the Vault, not Insurance** — `Vault` calls `transferFrom`. Approving Insurance fails with `ERC20InsufficientAllowance`.
- **`buyPolicy` return values are invisible in receipts**; read `PolicyCreated` or re-read `getPoliciesOf`. `getFlight`/`getPolicy` revert on missing entries — batched reads need `allowFailure: true`.
- **`forge clean` before deploying** after any struct/selector change. A stale `out/` artifact made `forge script --broadcast` silently deploy old bytecode (see `deployments/arc-testnet.md`).
- **`evm_version = "cancun"` is pinned in `foundry.toml`.** Reverting to paris breaks simulation of Arc's ERC-8004 IdentityRegistry proxy (`EvmError: NotActivated`).
- **Deploy via `script/Deploy.s.sol` / `DeployMock.s.sol`, not `forge create`** — the script wires roles and revokes the deployer's `AGENT_ROLE`. Env-configured, no source edits; `arc_testnet` RPC is defined in `foundry.toml`.
- **Arc agent writes need an ERC-8004 identity**: `AGENT_ROLE` alone reverts with `AgentIdentityRequired`. Bind via `FlightAgent.registerAgent(operator, agentId)`; `npm run register-identity` mints the id.
- **Agent is idempotent**: it reads the on-chain record and writes only on change. It settles on `actual_out` (never `estimated_out`), and `dataHash` must be non-zero but deliberately isn't part of the change comparison.
- **`maxWithdraw` is clamped by `availableLiquidity`** — collateral backing a live policy is not withdrawable. This is deliberate, non-vanilla ERC-4626.
- **Secrets**: `.env` (root, deployer key), `agent/.env`, `web/.env.local` are gitignored — never commit or print them. Live deployment addresses live in the `.env.example` files and `deployments/arc-testnet.md`.
- **Mock flights are terminal once departed** — a registry entry can't be un-departed. To replay demos you need fresh flight numbers, not new dates. `FORCE_DEPARTED=CS1005 npm run monitor:once` forces one fixture flight.

`.clinerules/` exists but is an empty stub (`SKILL.md` empty, `skills/` empty) — nothing to follow there yet.
