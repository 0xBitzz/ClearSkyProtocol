# ClearSkyProtocol

Parametric flight-delay insurance on Arc.

A traveller pays a premium before departure. An agent monitors the flight. If it
departs later than the traveller's chosen delay threshold, they claim a multiple
of their premium. If it leaves on time, the premium stays in the protocol.

## Architecture

Four contracts, each with one job:

```
                  ┌──────────────────┐
   off-chain  ──▶ │   FlightAgent    │  the oracle: reports flight status
   aviation API   └────────┬─────────┘
                           │ AGENT_ROLE
                           ▼
                  ┌──────────────────┐
                  │  FlightRegistry  │  the facts: scheduled vs actual departure
                  └────────┬─────────┘
                           │ read
                           ▼
   traveller  ────▶ ┌──────────────────┐
                    │    Insurance     │  the rules: sell, price, settle policies
                    └────────┬─────────┘
                             │ INSURANCE_ROLE
                             ▼
   underwriter ───▶ ┌──────────────────┐
                    │      Vault       │  the money: premiums, liquidity, payouts
                    └──────────────────┘
```

**`FlightRegistry`** is the single source of truth for flight data. It stores the
scheduled and actual departure times and answers one question: was this flight
delayed by at least *N* seconds? Only `AGENT_ROLE` can write to it.

**`FlightAgent`** is the oracle boundary. It forwards status reports into the
registry and tracks per-agent activity so you can tell whether your 24/7 monitor
is actually alive. Swapping this for a Chainlink Functions consumer later means
touching only this contract. It is also where agent identity and evidence live —
see *The agent* below.


**`Vault`** custodies every token in the system and knows nothing about flights.
It is an ERC-4626 tokenised vault, so underwriters deposit USDC and receive
`csUW` shares. Its whole job is one invariant:

```
availableLiquidity = totalAssets - lockedCollateral
```

`maxWithdraw` is overridden to `min(your assets, availableLiquidity)`, so an
underwriter can never pull capital that is already backing a live policy.


**`Insurance`** holds the policy logic and never holds funds. It is an
authorisation layer over the Vault, which it drives through `INSURANCE_ROLE`.

## The design decision that matters

**Payouts are collateralised at purchase time, not at claim time.**

When a policy is sold, the Vault immediately locks `premium × payoutMultiplier`.
If there isn't enough liquidity to back the payout, `lockCollateral` reverts and
the sale simply doesn't happen.

This is what stops the protocol from becoming insolvent. The naive version —
collect premiums, pay claims from whatever is in the pot — works fine until a
single storm delays forty insured flights at once and the fortieth traveller
finds an empty vault. Here, the protocol refuses to sell cover it cannot honour.

Note this also means your `5x` multiplier requires the vault to hold 5x every
premium in reserve, so underwriting capital, not premium volume, is the real
constraint on growth.

## Policy lifecycle

| Step | Who | What happens |
|---|---|---|
| `registerFlight` | agent | Flight becomes insurable |
| `buyPolicy` | traveller | Premium collected, coverage locked. Must be ≥1h before departure |
| `rescheduleFlight` | agent | Airline re-times the flight. Affects new quotes only |
| `updateFlightStatus` | agent | Actual departure time recorded on-chain |
| `claim` | traveller | Delay ≥ threshold → payout. 30-day window |
| `expirePolicy` | anyone | On time, or window closed → collateral released, premium kept |


`expirePolicy` is permissionless because releasing collateral can only ever
improve solvency and can never move funds to the caller. It refuses to run on a
delayed flight while the traveller still has time to claim.

### Schedule changes

Airlines re-time flights, so `rescheduleFlight` records the new departure. The
important rule, and the one traditional insurers follow: **a policy is always
settled against the schedule published when it was bought.**

`buyPolicy` snapshots `flight.scheduledDeparture` onto the policy, and
settlement measures the actual departure against that snapshot rather than the
registry's current value. So a re-timing can never retroactively void cover
someone already paid for, and a reschedule on its own never triggers a payout —
only a real departure, late against the purchased baseline, does that. New
buyers are quoted against the updated schedule.


## Parameters

| Parameter | Value | Configurable |
|---|---|---|
| Payout multiplier | 5x | yes, capped at 20x |
| Purchase cutoff | 1 hour before departure | no |
| Claim window | 30 days after departure | no |
| Delay threshold | 1–12 hours, chosen by buyer | no |
| Premium band | set at deploy | yes |

Changing the multiplier only affects new policies; existing ones keep the
coverage they were sold at.

The multiplier is **flat across every route and every threshold** in this MVP: a
2-hour threshold on a reliable trunk route costs exactly what a 12-hour threshold
on a chronically-delayed regional hop costs. That is a deliberate simplification,
not an oversight — see *Roadmap* below.

## Vault economics

The Vault is ERC-4626. Underwriters `deposit(assets, receiver)` and receive
`csUW` shares; there is no separate `depositLiquidity` function any more.

Share price is `totalAssets / totalSupply`, so profit and loss accrue
automatically without anyone distributing anything:

| Event | Effect on `totalAssets` | Effect on share price |
|---|---|---|
| Premium collected | +premium | up |
| Flight on time, policy expires | unchanged (premium already counted) | unchanged |
| Claim paid | −coverage (5× premium) | down |

Underwriters are the counterparty to every policy. They earn the premiums from
on-time flights and absorb the 4× net loss on every payout.

Two things behave differently from a textbook ERC-4626, both deliberately:

- **`maxWithdraw` is clamped by `availableLiquidity`.** It returns
  `min(your assets, unlocked liquidity)`, so collateral backing a live policy is
  not withdrawable even by the underwriter who supplied it. `_withdraw` re-checks
  the same bound as a backstop. An integrator assuming vanilla semantics may be
  surprised by a withdrawal capped for reasons unrelated to their own balance.
- **Deposits are permissioned** behind `UNDERWRITER_ROLE`. Shares are ordinary
  transferable ERC-20s once minted, and revoking the role blocks new deposits
  without trapping capital already in the vault.

### The vesting gap (MVP tradeoff)

**Premiums are recognised immediately.** A premium counts toward `totalAssets`
the moment it is collected, so the share price steps up in a single block, before
anyone knows whether that policy will pay out.

The consequence: with meaningful TVL and mempool visibility, someone could
deposit immediately before a batch of premiums lands, then redeem straight after,
capturing yield they carried no risk for and diluting the underwriters who did.
It is a value-extraction problem, not an insolvency one — the vault stays
collateralised throughout, and the coverage lock means no policyholder is ever
short-changed by it.

We accepted this for the hackathon MVP because the attack needs real TVL and
active mempool watching to be worth anything. **Before mainnet** this becomes an
`unearnedPremium` bucket excluded from `totalAssets` and dripped in linearly over
a vesting window, so the share price only reflects risk that has actually been
carried.


## A note on approvals

The **Vault** performs `transferFrom`, not the Insurance contract. Travellers
must approve the Vault address:

```solidity
usdc.approve(address(vault), premium);
insurance.buyPolicy("BA208", premium, 2 hours);
```

## Usage

```bash
forge build
forge test
forge test -vvv --match-test test_Claim   # verbose traces
```

## Deploying on Arc

**Use the deploy script, not `forge create`.** Four contracts is the easy part;
the risk is the wiring that follows — `setInsurance`, `addAgent`, and the
deployer's own `removeAgent`. Done by hand that means pasting four addresses
between six commands with a live key, and one transposed character leaves the
Vault trusting the wrong Insurance contract. The script does all of it in one
broadcast.

Arc uses **USDC as its native gas token**, so fund the deployer from the
[Circle Faucet](https://faucet.circle.com/) first.

```bash
export PRIVATE_KEY=0x...
export ARC_TESTNET_RPC_URL="https://rpc.testnet.arc.io"

forge script script/Deploy.s.sol:Deploy \
  --rpc-url arc_testnet \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://testnet.arcscan.app/api/
```

`arc_testnet` is defined in `foundry.toml` under `[rpc_endpoints]`. Drop the
`--verify` block if you just want the deploy; Blockscout verification can be run
after the fact with `forge verify-contract`.

Configuration is read from the environment, so no source edits are needed:

| Variable            | Default                                      | Notes                                     |
| ------------------- | -------------------------------------------- | ----------------------------------------- |
| `USDC_ADDRESS`      | `0x3600000000000000000000000000000000000000` | Arc's ERC-20 interface over native USDC   |
| `IDENTITY_REGISTRY` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | ERC-8004; `address(0)` disables binding   |
| `MIN_PREMIUM`       | `10e6`                                       | 6 decimals                                |
| `MAX_PREMIUM`       | `1000e6`                                     | 6 decimals                                |

Note the decimals trap: Arc's **native** USDC balance uses 18 decimals, while the
**ERC-20 interface** at `0x3600…` uses 6. ClearSky talks to the ERC-20 interface
throughout, so every premium figure in this repo is 6-decimal.

The script deploys all four contracts, wires the roles, and then **revokes the
deployer's own `AGENT_ROLE` on the registry**, leaving the `FlightAgent` contract
as the only address that can write flight data. Operators are granted
`AGENT_ROLE` on the agent instead, so every oracle update passes through one
chokepoint — which is where multi-agent consensus or a dispute window will go.

### Real USDC vs. mock USDC

Two deployments are supported because they test different things:

```bash
# 1. Real USDC — validates token semantics on Arc
forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast

# 2. Mock USDC — validates protocol logic at volume
forge script script/DeployMock.s.sol:DeployMock --rpc-url arc_testnet --broadcast
```

The mock exists for a practical reason. The vault locks 5× every premium as
collateral, so one 10 USDC policy already needs 50 USDC of backing — more than a
faucet comfortably provides, and nowhere near enough to exercise multi-underwriter
share accounting. The mock is for protocol logic; it deliberately does **not**
reproduce Arc's USDC semantics (blocklist enforcement, dual decimals,
native/ERC-20 equivalence), so run the real-USDC deployment for those.

### After deploying

The script cannot do these for you — they need capital and an agent operator:

```bash
# 1. Authorise and fund an underwriter. No cover can be sold until the vault
#    holds capital, because coverage is collateralised at purchase time.
cast send $VAULT "addUnderwriter(address)" $UNDERWRITER --rpc-url arc_testnet --private-key $PRIVATE_KEY
cast send $USDC  "approve(address,uint256)" $VAULT 100000000000 --rpc-url arc_testnet --private-key $PRIVATE_KEY
cast send $VAULT "deposit(uint256,address)" 100000000000 $UNDERWRITER --rpc-url arc_testnet --private-key $PRIVATE_KEY

# 2. Bind the monitoring agent to its ERC-8004 identity. `agentId` comes from
#    calling register(metadataURI) on the IdentityRegistry.
cast send $AGENT "registerAgent(address,uint256)" $OPERATOR $AGENT_ID --rpc-url arc_testnet --private-key $PRIVATE_KEY
```

**Circle Developer Console is not an alternative here.** That path deploys
Circle's pre-audited templates — ERC-20, ERC-721, ERC-1155, Airdrop — and cannot
take custom Solidity. Foundry is the only route for this protocol.


## The agent

The agent is an **oracle, not an adjudicator**. It watches the flight and writes
one fact on-chain — the actual departure time:

```
FlightAgent.updateFlightStatus(flightNumber, status, actualDeparture, dataHash)
```

It does **not** decide who gets paid. That happens in `Insurance.claim()`, which
the traveller calls themselves, and which applies a rule to the agent's data:

```
delay = actualDeparture − policy.departureTime    // baseline snapshotted at purchase
delay ≥ policy.delayThreshold  →  payout = premium × multiplier
```

So the agent reports; the contract decides. It cannot pay one holder and refuse
another, change the multiplier, or touch the vault directly. Its real power is
narrower but still serious: a fabricated `actualDeparture` makes a fabricated
delay indistinguishable from a genuine one.

It is also **not a counterparty**. It never buys a policy, is never paid by the
protocol, and holds no stake — yet one status report can release 5× a premium
from the vault. No skin in the game, full authority over the input. Two
mechanisms narrow that gap:


**Identity (ERC-8004).** `registerAgent(operator, agentId)` checks the
IdentityRegistry that the operator actually owns the identity it claims before
granting it `AGENT_ROLE`, so nobody can borrow another agent's reputation by
naming its id. Identities are bound per-operator rather than one for the whole
contract: each monitor then accrues its own attributable history, which is what
makes reputation scoring meaningful later. A single contract-level identity would
blur every operator's record into one.

**Evidence.** Every status report must carry a `dataHash` — typically
`keccak256` of the raw aviation-API response the agent acted on. A zero hash is
rejected, so no payout can rest on an uncommitted report. The chain cannot verify
the hash reflects reality, but anyone holding the original response can recompute
it and show whether the agent reported what its source actually said.

Neither stops a compromised key from lying. Together they mean a lie is signed
and attributable rather than anonymous and deniable — and they leave the
groundwork for reputation-weighted, multi-agent consensus, which is the real fix.

ERC-8004 is optional: pass `address(0)` as the registry and the protocol deploys
unchanged on chains without one. Operators added via `addAgent` then report with
`agentId` 0, so unidentified agents stay visibly distinct from registered ones.

## Test coverage

47 tests covering the happy paths, every revert condition, the vault solvency
invariant, ERC-4626 share accounting, role enforcement, reschedule semantics,
agent identity binding and evidence commitments, and two fuzz properties: payout
always equals `premium × multiplier`, and a delay under the threshold never pays.


See `DESIGN.md` for the reasoning behind the architecture and the trust boundary
around flight data.


## Known limitations

Worth understanding before this goes near real money:

1. **The agent is trusted.** A compromised `AGENT_ROLE` key can fabricate delays
   and drain the vault. The registry now has a single writer, which narrows the
   surface, but production needs either a decentralised oracle or an m-of-n
   multi-agent scheme with a dispute window.
2. **No risk-based pricing.** A flat 5× multiplier for every route and every
   delay threshold. A chronically-delayed regional hop is a guaranteed loss for
   underwriters; real actuarial pricing needs per-route historical data.
3. **No premium vesting.** The share price recognises premiums immediately. See
   *The vesting gap* above for the value-extraction window this leaves open.
4. **No proof of boarding.** Anyone can insure any flight without being on it,
   which makes this closer to a delay prediction market than travel insurance.

## Roadmap

Deliberately out of scope for the MVP, in the order they should be tackled:

1. **Premium vesting** — an `unearnedPremium` bucket that drips into
   `totalAssets` linearly, so the share price tracks risk actually carried.
2. **Per-route risk pricing** — replace the flat multiplier with a rate derived
   from the route's historical on-time performance. The route should be recorded
   by the agent at registration, never supplied by the buyer, since anything the
   buyer controls can be gamed.
3. **Threshold-based pricing** — a 1-hour threshold is far likelier to trigger
   than a 12-hour one and should not cost the same.
4. **Multi-agent consensus** — m-of-n agreement plus a dispute window before a
   delay is treated as final.
5. **Proof of boarding** — bind a policy to a booking reference so this insures
   travel rather than speculation.

