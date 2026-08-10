# ClearSky Web

Traveller-facing frontend for the ClearSky flight-delay insurance protocol.

## Running locally

The app reads ABIs straight out of Foundry's `out/`, so the contracts must be
compiled first:

```bash
# from the repo root
forge build

cd web
npm install
cp .env.local.example .env.local
npm run dev
```

`npm run dev` and `npm run build` both run `npm run abis` first, which
regenerates `src/lib/abis/` from `out/`. Those files are gitignored on purpose:
a committed ABI eventually drifts from the contract it describes, and the
failure shows up as an opaque revert at runtime instead of a type error at
build time.

## Pointing at a different deployment

Everything environment-specific lives in `.env.local`. To target a different
chain or a stack backed by real USDC rather than `MockUSDC`, change the
addresses there and set `NEXT_PUBLIC_ASSET_IS_MINTABLE=false`, which hides the
faucet. No code change is needed.

## Notes for anyone extending this

A few contract behaviours shape the UI and are easy to trip over:

- **Approvals go to the Vault, not to Insurance.** `Insurance.buyPolicy` never
  moves tokens itself; `Vault.depositPremium` does the `transferFrom`. Approving
  the Insurance address produces a confusing `ERC20InsufficientAllowance`.

- **`buyPolicy` returns a `policyId`, but a transaction receipt cannot see
  return values.** Read the id from the `PolicyCreated` event instead. This
  frontend sidesteps it entirely by re-reading `getPoliciesOf` after the
  receipt lands.

- **`getFlight` and `getPolicy` revert on missing entries** rather than
  returning a zeroed struct. Batched reads therefore use `allowFailure: true`,
  or one unknown flight blanks the whole list.

- **Claimability is never recomputed client-side.** `Insurance.isClaimable` is
  the contract's own dry run of `claim`, so the button is only shown when the
  call would actually succeed.

- **Amounts are 6-decimal USDC, not 18-decimal ether.** Use the helpers in
  `src/lib/format.ts` rather than viem's `formatEther`/`parseEther`.
