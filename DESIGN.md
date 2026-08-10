# Design Notes

Answers to the four questions raised during review.

---

## 1. Why the OpenZeppelin imports showed errors

They were never real. `forge build` and `forge test` compile all 45 files
successfully — the failures came from the VS Code Solidity extension, which does
not read `foundry.toml` and therefore did not know what `@openzeppelin/` maps to.

Fixed by adding `.vscode/settings.json` with the same remappings. There are now
three places remappings live, which is unfortunate but standard for Foundry:

| File | Read by |
|---|---|
| `foundry.toml` | `forge build` / `forge test` |
| `remappings.txt` | some tooling, and `forge` as a fallback |
| `.vscode/settings.json` | the editor's language server |

If the squiggles persist, reload the window (`Cmd+Shift+P` → "Developer: Reload
Window"). The rule of thumb: **if `forge build` passes, the code is fine.**

---

## 2. Flight data and user manipulation

**This is already handled the way you wanted.** The traveller cannot set
`scheduledDeparture` — it is read out of the registry, not taken from calldata.

`Insurance.buyPolicy` accepts only three arguments:

```solidity
function buyPolicy(
    string calldata flightNumber,   // a lookup key, not data
    uint256 premium,                // bounded by minPremium/maxPremium
    uint256 delayThreshold          // bounded 1–12 hours
)
```

and then does:

```solidity
FlightInfo memory flight = flightRegistry.getFlight(flightNumber);
// reverts FlightNotFound if the agent never registered it
...
departureTime: flight.scheduledDeparture,  // ← from the registry
```

So the trust boundary is:

```
agent  ──writes──▶  scheduledDeparture, actualDeparture, status
user   ──writes──▶  which flight, how much, what threshold
```

A user cannot invent a flight, cannot claim it was scheduled for a different
time, and cannot alter the actual departure. The worst they can do is pick a
flight they aren't on (see limitation 4 in the README) or choose a low delay
threshold — and if you price by threshold later, that stops being free.

### The part that WAS a problem — now fixed

`registerFlight` reverts with `FlightAlreadyExists` on a second call, and
`updateFlightStatus` only touches `status` and `actualDeparture`. So an airline
re-timing a flight from 14:00 to 16:00 could not be recorded at all.

Worse, digging into it revealed a real bug. Settlement used to call
`flightRegistry.isFlightDelayed(...)`, which computes the delay from the
registry's **current** `scheduledDeparture`. So a reschedule would have
retroactively moved the baseline for policies that were already sold — a
traveller who bought cover against a 14:00 departure would silently have had it
re-measured against 16:00, quietly voiding cover they had paid for.

Both are fixed:

1. **`rescheduleFlight(flightNumber, newScheduledDeparture)`** — agent-only,
   on both `FlightRegistry` and `FlightAgent`. Rejects unknown flights, flights
   that have already departed, times in the past, and no-op writes. Emits
   `FlightRescheduled(flightNumber, old, new)`.
2. **Settlement now measures against the purchase-time snapshot.** A new
   internal `_isDelayed(policy, flight)` compares `flight.actualDeparture`
   against `policy.departureTime` — the schedule captured when the cover was
   sold — instead of the live registry value. Used by `claim`, `expirePolicy`,
   and `isClaimable`.

This matches how traditional insurers work: **the contract is fixed at the point
of sale.** A schedule change afterwards is the airline's problem, not the
policyholder's. A reschedule alone never triggers a payout — nobody has sat in
an airport yet — only a real departure, late against the purchased baseline,
does. New buyers are quoted against the updated schedule.

There's also a new `recordedDelay(policyId)` view so a frontend can show the
delay a policy would actually be settled on.

Still worth considering later: **lazy registration.** Let `buyPolicy` accept a
schedule signed by the agent (EIP-712), verify the signature, and register on
first use. The user supplies the bytes but cannot forge them, so the trust
boundary is unchanged and you drop the pre-registration requirement entirely.


---

## 3. Is this architecture right?

Broadly yes. The split you proposed maps cleanly onto the four things that
change for different reasons:

| Contract | Reason to change |
|---|---|
| `FlightRegistry` | how flight data is shaped |
| `FlightAgent` | where flight data comes from |
| `Insurance` | pricing and policy rules |
| `Vault` | how capital is managed |

That is the right decomposition. The important property it buys you: **the Vault
holds the money and knows nothing about flights.** When you later swap the agent
for a Chainlink oracle, or change the pricing model, the contract holding user
funds is untouched. That is worth a lot.

### Two things I would change

**a) `FlightAgent` is currently a thin pass-through.** It forwards to the
registry and records some stats. That is fine now, but it means the registry
must trust *two* role sets (it grants `AGENT_ROLE` to both the agent contract
and to EOAs). Consider making the registry accept writes *only* from the
`FlightAgent` contract. Then the agent becomes the single chokepoint where you
can later add multi-agent consensus or a dispute window without touching the
registry at all.

**b) The agent is a single trusted key.** This is the biggest real risk in the
system — a compromised agent key mints arbitrary delays and drains the vault.
The conventional progression is:

```
single EOA  →  m-of-n agents + dispute window  →  Chainlink Functions / API3
```

You do not need step three for a hackathon or v1, but the architecture should
not fight it. It currently doesn't, which is good.

### An architecture I would *not* recommend

A "contract per flight" factory pattern. It reads naturally ("one contract for
the flight") but each new flight costs a full deployment, capital gets
fragmented across contracts so you cannot pool underwriting risk, and querying
"all my policies" requires indexing every deployed instance. Your current
mapping-based registry is strictly better.

---

## 4. ERC-4626, LP shares, and yield accrual

### What the vault does today

Underwriters deposit and get a bookkeeping entry:

```solidity
mapping(address => uint256) public underwriterDeposits;
```

Deposit 1,000 USDC, and you may withdraw exactly 1,000 USDC. If the protocol
earns 50,000 USDC in premiums from on-time flights, that money sits in the vault
and **no underwriter can ever withdraw it.** It is stranded. There is no reason
for anyone to supply capital.

That is the actual problem — ERC-4626 is just the standard way to solve it.

### What share tokens change

Instead of recording a balance, the vault mints *shares*:

```
shares_minted = assets_deposited × totalShares / totalAssets
assets_owed   = shares_held      × totalAssets / totalShares
```

Deposits and withdrawals are priced by the ratio, so profits and losses accrue
to shareholders automatically:

| Event | totalAssets | totalShares | Value of 1 share |
|---|---|---|---|
| Alice deposits 1,000 | 1,000 | 1,000 | 1.00 |
| Bob deposits 1,000 | 2,000 | 2,000 | 1.00 |
| 200 in premiums kept | 2,200 | 2,000 | **1.10** |
| Alice withdraws all | 1,100 | 1,000 | 1.10 |

Alice takes out 1,100 for her 1,000. Nobody wrote any distribution logic — it
falls out of the arithmetic. Conversely, if claims exceed premiums the share
price drops below 1.00 and underwriters eat the loss, which is exactly what
underwriting means.

Making those shares an ERC-20 also means they are transferable and composable —
an underwriter can exit by selling shares rather than waiting for collateral to
unlock, and the position can be used elsewhere in DeFi.

### Why the *standard* specifically

ERC-4626 fixes the function signatures (`deposit`, `mint`, `withdraw`, `redeem`,
`convertToShares`, `previewDeposit`, `maxWithdraw`…) so that aggregators,
frontends, and other protocols can integrate without custom code. OZ ships
`ERC4626.sol` with the share maths and the inflation-attack mitigation already
handled — you would mostly be overriding two hooks.

### The two traps you must handle

**Trap 1 — `maxWithdraw` must respect locked collateral.**

Vanilla ERC-4626 assumes every asset is withdrawable. Yours are not; collateral
backing live policies must stay put. You override:

```solidity
function maxWithdraw(address owner) public view override returns (uint256) {
    uint256 ownerAssets = convertToAssets(balanceOf(owner));
    uint256 free = availableLiquidity();          // totalAssets - lockedCollateral
    return ownerAssets < free ? ownerAssets : free;
}
```

Without this override, an underwriter drains collateral out from under an active
policy. This is the single most important line in an insurance ERC-4626 vault.

**Trap 2 — instant premium recognition is front-runnable.**

If a premium counts toward `totalAssets` the moment a policy expires, the share
price *jumps* in one block. Anyone can watch the mempool, deposit right before a
large batch of policies expires, and redeem immediately after — capturing yield
they took no risk for, diluting the underwriters who actually carried it.

The standard fix is to not recognise premiums instantly. Hold them in a separate
`unearnedPremium` bucket excluded from `totalAssets`, and drip them in linearly
over a vesting window (Yearn and Morpho both do a version of this):

```solidity
function totalAssets() public view override returns (uint256) {
    return asset.balanceOf(address(this)) - lockedUnearnedPremium();
}
```

Now the share price rises smoothly and there is no single block worth
front-running.

### My recommendation

Ship what you have. The current vault is correct — it just doesn't pay
underwriters, which is a v2 economic feature, not a v1 safety bug. When you do
migrate:

1. Inherit OZ's `ERC4626`.
2. Override `maxWithdraw` / `maxRedeem` for `lockedCollateral`. **Non-negotiable.**
3. Add linear premium vesting before you have meaningful TVL.
4. Keep `lockCollateral` / `releaseCollateral` / `payClaim` exactly as they are —
   they are orthogonal to the share accounting and already correct.

Step 2 is the one that turns a nice yield feature into a safe one.

---

## Summary of recommended next steps

| Priority | Item | Status |
|---|---|---|
| High | Multi-agent consensus or dispute window — the agent key is the main attack surface | open |
| High | `rescheduleFlight`, so airline schedule changes don't break the delay baseline | **done** |
| Medium | Restrict `FlightRegistry` writes to the `FlightAgent` contract only | open |
| Medium | Per-route risk pricing instead of a flat 5× | open |
| Low | ERC-4626 vault with locked-collateral overrides and premium vesting | open |

