# Arc Testnet deployment (mock USDC)

Chain ID `5042002` · RPC `https://rpc.testnet.arc.io` · Explorer
[testnet.arcscan.app](https://testnet.arcscan.app)

Deployed with `script/DeployMock.s.sol`, so the asset is a mintable stand-in
rather than Arc's real USDC. Use this deployment to exercise protocol logic at
volume; use `script/Deploy.s.sol` to validate real token semantics.

Admin / deployer: `0x74cE6B0402B66C7F3F7eaD989140D518dc1bc08c`
Agent operator: `0x2158D895A8e41249770713296314ad47DD8900ED`

| Contract               | Address                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Insurance`            | [`0x5F10f4694055d64DBe8B4C5E2E03BE7A0986E8eb`](https://testnet.arcscan.app/address/0x5F10f4694055d64DBe8B4C5E2E03BE7A0986E8eb) |
| `Vault`                | [`0x27FAF75ef7378240fD8963662c6f3d3EBE5f013c`](https://testnet.arcscan.app/address/0x27FAF75ef7378240fD8963662c6f3d3EBE5f013c) |
| `FlightAgent`          | [`0x5000D5Ee64Ba44F76047Fc60e0ef5Df1d3203CAC`](https://testnet.arcscan.app/address/0x5000D5Ee64Ba44F76047Fc60e0ef5Df1d3203CAC) |
| `FlightRegistry`       | [`0x0C6572C440cA1d1eba938640326358FAE08992Ae`](https://testnet.arcscan.app/address/0x0C6572C440cA1d1eba938640326358FAE08992Ae) |
| `MockUSDC`             | [`0xc00E27A30f5b644342a5C0556024892305fC730b`](https://testnet.arcscan.app/address/0xc00E27A30f5b644342a5C0556024892305fC730b) |

cast send <FLIGHT_AGENT_ADDRESS> "registerFlight(...)" <ARGS> --rpc-url $RPC_URL --private-key $PRIVATE_KEY

cast send $FLIGHT_AGENT_CONTRACT_ADDRESS "registerFlight(string,string,uint256)" \
  "CS1006-1786357775" "CS1006" 1786367775 \
  --rpc-url $RPC_URL --private-key $AGENT_PRIVATE_KEY

`FlightAgent` binds against Arc's real ERC-8004 registry at
[`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e).
`MockIdentityRegistry` is no longer deployed or referenced.

## Who's who: three "agents", two chains

The naming invites confusion. Two of these are keys, one is a contract, and they
do not live on the same chain.

| Name                   | What it is                | Where             | What it can do                                                              |
| ---------------------- | ------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `FlightAgent`          | Contract (`0x5000D5Ee…`)  | Arc Testnet       | The registry's only writer. Gates who may report. Holds no funds.           |
| Agent operator         | EOA (`0x2158D895…`)       | Arc Testnet       | Signs flight reports. Bound to ERC-8004 agentId `865730`. Cannot move money. |
| Circle Agent Wallet    | Wallet (`CIRCLE_WALLET_ADDRESS`) | Base mainnet | Spends real USDC to buy flight data over x402. Never touches Arc.       |

**`FlightAgent`** is the protocol's single oracle chokepoint. It holds the only
`AGENT_ROLE` on `FlightRegistry`, so every registration, status report, and
reschedule funnels through one contract. Its `onlyIdentifiedAgent` modifier
refuses a write unless the caller holds `AGENT_ROLE` *on FlightAgent* **and** has
an ERC-8004 identity bound — which is why the admin's own `updateFlightStatus`
reverts `AgentIdentityRequired`. Holding the admin key is not an identity.

**The agent operator** is the key the monitoring process signs with
(`AGENT_PRIVATE_KEY`). `registerAgent` bound it to agentId `865730` only after
checking `identityRegistry.ownerOf(agentId) == operator`, so an operator cannot
borrow someone else's reputation by naming their id. Identities are per-operator
rather than one for the contract, so each operator accrues its own attributable
history; a contract-level identity would blur every operator's record into one.

**The Circle Agent Wallet** pays for data. StableTravel's endpoints are
x402-priced — there is no API key, the USDC payment *is* the auth. Its key lives
inside the Circle CLI and is never exported into the agent process, so
`agent/.env` holds no spending key at all. It is on Base because the data seller
is Base-native; Arc is where the protocol settles.

One poll, end to end:

```
Circle wallet (Base)      pays USDC  ->  StableTravel returns the flight reading
agent process             keccak256(exact payload)  ->  dataHash
agent operator (Arc)      signs  ->  FlightAgent.updateFlightStatus(legId, …, dataHash)
FlightAgent (Arc)         writes ->  FlightRegistry
```

Spending, identity, and settlement are three separate keys across two chains.
That split is the point: a leak of any one of them does not hand over the others.


### Why this address set replaced the previous one

Flights used to be keyed by flight number. That gave the protocol one storage
slot per route rather than one per flight: the second day's `registerFlight`
reverted as a duplicate, and a departure reported for Tuesday would settle cover
bought for Monday. Rekeying to the provider's per-leg id (`legId`) changed the
`FlightRegistry` storage layout and the `IFlightData` ABI, so the old contracts
could not be upgraded in place — the whole stack was redeployed.

Worth recording because it cost hours: the first redeploy silently shipped the
*old* bytecode. `forge script --broadcast` reused a stale `out/` artifact, so the
new address answered `getFlight(string)` with the flight-number layout and every
agent write reverted against a contract that looked correct in the source tree.
`forge clean` before deploying is not optional when a struct or selector changes.

### FlightAgent history

`FlightAgent.identityRegistry` is immutable, so repointing it means redeploying.
`script/RewireFlightAgent.s.sol` does that in one shot: deploys the new agent,
grants it `AGENT_ROLE` on the registry, revokes the old one, and binds the
operator's ERC-8004 identity — leaving flight data in `FlightRegistry` untouched.

| Address       | Status  | Why replaced                                                                                              |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `0x29C7F45e…` | retired | Bound to `MockIdentityRegistry`, so `registerAgent` reverted `NonexistentAgent` against real ERC-8004 ids |
| `0xe5E930Cd…` | retired | Correct registry, but the write path still accepted `AGENT_ROLE` without a bound identity                 |
| `0xE2cfB5A9…` | retired | Pointed at the flight-number `FlightRegistry`, orphaned by the `legId` rekey                              |
| `0x5000D5Ee…` | live    | —                                                                                                         |

## Verified wiring

Checked on-chain after deployment, not assumed from the script:

| Check                                     | Result                                         |
| ----------------------------------------- | ---------------------------------------------- |
| `vault.asset()`                           | `0xc00E…730b` (MockUSDC)                       |
| `insurance.payoutMultiplier()`            | `5`                                            |
| `vault.hasRole(INSURANCE_ROLE, ins)`      | `true`                                         |
| `registry.hasRole(AGENT_ROLE, agent)`     | `true`                                         |
| `registry.hasRole(AGENT_ROLE, deployer)`  | `false` — deployer's direct write revoked      |
| `registry.hasRole(AGENT_ROLE, oldAgents)` | `false` — every retired agent demoted          |
| `agent.identityRegistry()`                | `0x8004A818…` (Arc's ERC-8004 registry)        |
| `agent.agentIds(operator)`                | `865730` — monitoring key bound to identity    |
| `agent.agentIds(deployer)`                | `0` — admin holds no identity                  |
| admin calling `updateFlightStatus`        | reverts `AgentIdentityRequired` (`0x22754373`) |

Two rows carry the weight. `registry.hasRole(AGENT_ROLE, agent)` being the only
`true` means the `FlightAgent` contract is the registry's sole writer, so every
flight-data update passes through one chokepoint. And the admin's own report
reverting is the tighter half: `AGENT_ROLE` alone no longer moves money, because
on a chain with ERC-8004 the write path also demands a bound identity. Holding
the admin key is not an identity.

## Proven end to end

One leg driven through the full lifecycle on this deployment, against the mock
data source:

| Step                                    | Result                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `registerFlight("CS1003-1786222800", …)` | [`0x89bbd555…`](https://testnet.arcscan.app/tx/0x89bbd5529cf8c6fc0a911da322c6c7d34771a1140318323bf0c859f651436426) |
| agent posts `Scheduled -> Delayed`      | [`0x6b77908b…`](https://testnet.arcscan.app/tx/0x6b77908b0cd70aae48ade5cbe55185949b8aa426108abc0f071fdf2bcf23c185) |
| second pass, nothing changed            | `unchanged (status Delayed, actual 0)` — no transaction, no gas                                                          |
| agent posts `Delayed -> Departed` (+4h) | [`0x08149560…`](https://testnet.arcscan.app/tx/0x0814956009f386eeb4cd78a31d977ffa799f411422136dc42562f48753f59644) |
| `isFlightDelayed(leg, 2h / 4h / 5h)`    | `true` / `true` / `false`                                                                                                |

The idempotent pass is the one to notice: the agent reads the on-chain record
before writing and stays silent when the observation matches, so a crash-restart
loop costs nothing and cannot double-report. The threshold row confirms
settlement reads `actualDeparture`, not an estimate — `isFlightDelayed` returned
`false` at every threshold while the flight sat at the gate marked `Delayed`, and
only became `true` once the aircraft actually pushed back.

Offline suites: `npm run mockpass` 13/13, `npm run legcheck` 20/20 (the latter
replays 15 real legs of UAL455 through both the agent's and the web app's copy of
the leg selector to catch drift).

## Policies sold and settled (2026-08-09)

Both outcomes exercised on this deployment: a paid claim and a kept premium.
Vault funded with 100,000 mUSDC by the admin, who already holds
`UNDERWRITER_ROLE` from the constructor — no `addUnderwriter` call was needed.
100,000 csUW minted at parity.

| Step                                     | Leg                  | Tx                                                                                                                 |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Approve vault                            | —                    | [`0xdf36e7d5…`](https://testnet.arcscan.app/tx/0xdf36e7d537407524352c71605e6ff0500e2646bcfb3567afc262f9e4d4683d46) |
| Deposit 100,000 mUSDC                    | —                    | [`0x669bdde4…`](https://testnet.arcscan.app/tx/0x669bdde44142f1735fb51063af4dbbdd3c2a02fa4ef6ccce686bb1f4c58ba48d) |
| Register leg                             | `CS1002-1786305600`  | [`0x5a9391e5…`](https://testnet.arcscan.app/tx/0x5a9391e5200291d13e510239580732b770a61bd1432da9150f8b46928deda79d) |
| Register leg                             | `CS1005-1786316400`  | [`0x8648a5f0…`](https://testnet.arcscan.app/tx/0x8648a5f0d7bd86ff8c68bbdbbe332b07ad676e29a36e8701da5f7541562f4d85) |
| Buy policy #1 — 100 mUSDC, 1h threshold  | `CS1002-1786305600`  | [`0x36fb938c…`](https://testnet.arcscan.app/tx/0x36fb938c9669dea288f41ccc561a1ef509ed58d1f9ec0dfb67245a35ff1c0d56) |
| Agent posts departure, 90m late          | `CS1002-1786305600`  | [`0x38297f0d…`](https://testnet.arcscan.app/tx/0x38297f0d2abf7a209449a59759b1acf6bd68de306ddff3cb47e9b90b3cc20e32) |
| Claim 500 mUSDC                          | policy #1            | [`0x66e3e4ba…`](https://testnet.arcscan.app/tx/0x66e3e4ba59cde7257ab90deacd2f3f048b4e505c858d8f0e4cabce7b3c61fe0f) |
| Buy policy #2 — 100 mUSDC, 1h threshold  | `CS1005-1786316400`  | [`0x5cdbd766…`](https://testnet.arcscan.app/tx/0x5cdbd7665ca6acebbf65a148b1c8b9b5117b46e8139fb02f192dda986263b30f) |
| Agent posts on-time departure            | `CS1005-1786316400`  | [`0xaa5b3a7f…`](https://testnet.arcscan.app/tx/0xaa5b3a7f75d78d93b9cadc8b138cc7ba82ce64bb9e6d80bd08ad3a6f06dfe9af) |
| Monitor expires the policy               | policy #2            | [`0xb3c2b421…`](https://testnet.arcscan.app/tx/0xb3c2b4211a29b34585f306f6e3bdb0888f24f4fd46405aa99996b700285733e0) |

### Share price through the run

All figures mUSDC, 6 decimals.

| Point                    | totalAssets | locked | sharePrice |
| ------------------------ | ----------- | ------ | ---------- |
| After deposit            | 100,000.00  | 0      | 1.000000   |
| After policy #1 sold     | 100,100.00  | 500.00 | 1.000999   |
| After 500 claim paid     | 99,600.00   | 0      | 0.996000   |
| After policy #2 sold     | 99,700.00   | 500.00 | 0.996999   |
| After policy #2 expired  | 99,700.00   | 0      | 0.997000   |

Lifetime: 200 mUSDC premiums collected, 500 mUSDC claims paid. Net −300 to
underwriters, which is the expected shape at a 5x multiplier with a 50% loss
rate — one claim needs five clean premiums to break even.

### What this confirms

| Property                        | Evidence                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Collateral is real, not nominal | With policy #1 live, `maxWithdraw` returned `99,600` against a `100,100` position — the 500 was unwithdrawable |
| Underwriters absorb losses      | `sharePrice` fell to `0.996000` on payout, recovered only to `0.997000` on the next premium                 |
| Settlement is parametric        | `recordedDelay(1)` read exactly `5400`s against the purchased baseline                                      |
| Nothing settles pre-departure   | `isClaimable(1)` was `false` until the agent posted `actualDeparture`                                       |
| Double-claiming is blocked      | A second `claim(1)` reverts `PolicyNotActive()` (`0x8966b51f`)                                              |
| On-time policies self-close     | Policy #2 expired in the same monitor pass that recorded departure, no manual call                          |

The `maxWithdraw` row is the one that matters. The clamp is what stops an
underwriter redeeming capital that is still backing someone's live cover, and it
held with a real policy in flight rather than only in tests.

### Notes for the next run

`CS1001`–`CS1005` have now all been reported as departed on-chain. A registry
entry cannot be un-departed, so replaying these paths needs **fresh flight
numbers** in the mock — new dates on the existing ones will not help.

The mock API and the agent's `FLIGHTAWARE_BASE_URL` must agree on a port. Next
hops to 3001/3002 when 3000 is occupied, and the agent will quietly read a stale
server if pointed at the wrong one; the symptom is legs reported "not registered
on-chain" that plainly are. Check the dev server banner before monitoring.

## Reproducing from a fresh deployment


```bash
source .env
RPC=https://rpc.testnet.arc.io
USDC=0xc00E27A30f5b644342a5C0556024892305fC730b
VAULT=0x27FAF75ef7378240fD8963662c6f3d3EBE5f013c
AGENT=0x5000D5Ee64Ba44F76047Fc60e0ef5Df1d3203CAC
ME=0x74cE6B0402B66C7F3F7eaD989140D518dc1bc08c

# 1. Mint mock USDC (6 decimals) — 100,000 units
cast send $USDC "mint(address,uint256)" $ME 100000000000 \
  --rpc-url $RPC --private-key $PRIVATE_KEY

# 2. Authorise yourself as an underwriter and fund the vault
cast send $VAULT "addUnderwriter(address)" $ME --rpc-url $RPC --private-key $PRIVATE_KEY
cast send $USDC  "approve(address,uint256)" $VAULT 100000000000 --rpc-url $RPC --private-key $PRIVATE_KEY
cast send $VAULT "deposit(uint256,address)" 100000000000 $ME --rpc-url $RPC --private-key $PRIVATE_KEY

# 3. Register a leg so there is something to insure.
#    legId comes from the provider (fa_flight_id); scheduled departure is a unix
#    timestamp and must be in the future.
cast send $AGENT "registerFlight(string,string,uint256)" \
  "CS1001-1786294800" "CS1001" 1786294800 \
  --rpc-url $RPC --private-key $AGENT_PRIVATE_KEY
```

Note the signer on step 3: registration goes through the **agent operator** key,
not the admin. The admin can grant roles but cannot write flight data.

Travellers approve the **Vault**, not the Insurance contract, since the Vault is
what calls `transferFrom`.
