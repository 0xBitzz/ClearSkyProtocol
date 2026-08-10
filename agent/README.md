# ClearSky monitoring agent

The off-chain half of the oracle. Polls flight data, posts material changes to
`FlightRegistry` through `FlightAgent`, and releases collateral behind policies
that can no longer pay out.

## Setup

```bash
cd agent
npm install
cp .env.example .env   # then fill in AGENT_PRIVATE_KEY
```

`AGENT_PRIVATE_KEY` must hold `AGENT_ROLE` on the deployed `FlightAgent`. The
agent checks this on boot and refuses to start otherwise, so a misconfigured key
fails immediately rather than silently no-op'ing through a monitoring run.

Where an ERC-8004 `IdentityRegistry` is configured — as it is on Arc Testnet —
the role is necessary but not sufficient. The write path also requires the signer
to be bound to an identity it provably owns, so reports are attributable rather
than anonymous. Grant with:

```
FlightAgent.registerAgent(operator, agentId)
```

`addAgent(address)` grants the role without binding an identity. Where a registry
is configured, that leaves an operator holding `AGENT_ROLE` but unable to write:
its reports revert with `AgentIdentityRequired`. It exists for chains without
ERC-8004, where there is no identity to require.

Mint the identity first with `npm run register-identity`, which registers the
signer against the registry and prints the `agentId` to pass above.

## Running

```bash
npm run monitor        # poll forever at POLL_INTERVAL_SECONDS
npm run monitor:once   # single pass — good for cron or CI
npm run sweep          # expire settled policies only, no status writes
```

The flight data source defaults to the Next mock at
`http://localhost:3000/api/flightaware`, so `web` needs to be running.

## Real flight data (paid)

Point `FLIGHTAWARE_BASE_URL` at `https://stabletravel.dev/api/flightaware` for
live FlightAware data. There is no API key — the endpoint is x402-priced, so it
answers an unpaid request with `402 Payment Required` and a quote. The agent
pays $0.01 USDC per call from a Circle Agent Wallet on Base and retries with the
receipt attached; the payment *is* the authentication.

Paid mode switches on automatically for any non-localhost base URL, so a
mistyped URL fails loudly instead of silently spending or silently 402-ing.

Two wallets, deliberately separate: the Circle wallet spends USDC on Base to buy
data, `AGENT_PRIVATE_KEY` writes results on Arc. The spending key never enters
this process — payments are signed by the Circle CLI — so there is no hot key
here holding real funds. `X402_MAX_AMOUNT_USDC` caps each call, so a price
change at the seller cannot quietly drain the wallet.

Real data is messier than the mock, and four of its quirks are load-bearing:


- **One flight number is not one flight.** A lookup for `UAL455` returns 15 legs
  across a week and two different routes — KPIT→KORD and KORD→KPHX on the same
  day. The array is sorted newest-scheduled-first, so `flights[0]` is a flight
  days in the future. `selectCurrentLeg` picks the operative leg instead, and
  `fa_flight_id` (not the flight number) is the on-chain key. Set
  `MONITORED_FLIGHTS` to leg ids in production to skip the guesswork entirely.
- **`actual_out` can be in the future.** FlightAware publishes it ahead of
  departure, so "has departed" has to mean `actual_out <= now`, not just
  "present".
- **The airport departures feed looks backward.** `/airports/{id}/flights/
  departures` returned only already-pushed-back legs at both airports sampled
  (KJFK, RJTT), so it cannot answer "what leaves next". `/flights/{ident}` does
  carry future legs; `npm run pickleg -- --sweep IDENT,IDENT` ranks them.
- **`fa_flight_id` has more than one shape.** Alongside `-fa-` ids, the feed
  returns `-schedule-` and `-airline-` ids for legs further out — a leg
  scheduled but not yet tracked. Treat the id as an opaque string; do not
  pattern-match on the middle segment.


The first two are locked down by `npm run legcheck`, which replays a captured
live response through the selection and normalisation logic. It reads a
committed fixture, so it costs nothing to run.

### Verifying what a call actually paid

`npm run tracepay` reconstructs settlement from Base itself. It reads only
public chain state and spends nothing.

Reach for it because the obvious checks mislead here. The Circle wallet is a
smart account, so its spends are submitted by a bundler: the wallet never
appears as `tx.from`, and its EOA nonce stays at 1 no matter how many payments
clear. Scan USDC `Transfer` **logs** filtered on `from = wallet` instead — the
log names the payer even when the transaction does not.

This was written after the committed fixture turned out to carry a `txHash`
that no Base RPC would resolve. It was a transcription error: correct length,
correct prefix for 43 characters, then one digit inserted and another dropped.
Nothing short of asking the chain would have caught it, which is the point.


## Demo helpers

The mock keeps every fixture in the future, so nothing has departed yet. Force
one flight to depart:

```bash
FORCE_DEPARTED=CS1005 npm run monitor:once
```

Name the flights you want, comma-separated. `FORCE_DEPARTED=1` still forces
every monitored flight, but reach for it deliberately: a departure is terminal,
so a blanket force settles the entire fixture set in a single pass and there is
no way to walk it back. Use the scoped form for demos.

Fixture outcomes: CS1001 and CS1005 are on time, CS1002 is 90 minutes late,
CS1003 is 4 hours late, CS1004 is cancelled. CS1002 clears a 1-hour threshold
and makes a policy claimable; CS1005 is the one to use for the on-time path,
where the sweep releases collateral instead.

## How it decides to write

Each pass reads the on-chain record first and writes only when `actualDeparture`
or `status` differs from what was observed. `dataHash` deliberately does not
participate in that comparison: unrelated payload fields churn on every request,
so including it would spend gas re-reporting identical facts. The hash is still
committed with every write, over the raw provider response rather than the
normalised reading, so a disputed payout can be audited against what the source
actually said.

Settlement moves on `actual_out` only. `estimated_out` drifts while a flight
boards, and paying out on an estimate that later reverts would drain the vault.
