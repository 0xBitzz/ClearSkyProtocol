import type { Address } from "viem";

/**
 * Deployment addresses, read from the environment so the same build can point
 * at a mock-USDC stack or a real-USDC stack without a code change.
 */

function requireAddress(name: string, value: string | undefined): Address {
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy web/.env.local.example to web/.env.local.`,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return value as Address;
}

export const CONTRACTS = {
  insurance: requireAddress(
    "NEXT_PUBLIC_INSURANCE_ADDRESS",
    process.env.NEXT_PUBLIC_INSURANCE_ADDRESS,
  ),
  vault: requireAddress(
    "NEXT_PUBLIC_VAULT_ADDRESS",
    process.env.NEXT_PUBLIC_VAULT_ADDRESS,
  ),
  flightRegistry: requireAddress(
    "NEXT_PUBLIC_FLIGHT_REGISTRY_ADDRESS",
    process.env.NEXT_PUBLIC_FLIGHT_REGISTRY_ADDRESS,
  ),
  flightAgent: requireAddress(
    "NEXT_PUBLIC_FLIGHT_AGENT_ADDRESS",
    process.env.NEXT_PUBLIC_FLIGHT_AGENT_ADDRESS,
  ),
  usdc: requireAddress(
    "NEXT_PUBLIC_USDC_ADDRESS",
    process.env.NEXT_PUBLIC_USDC_ADDRESS,
  ),
} as const;

/** Whether the asset has an open `mint`, i.e. we can show a faucet. */
export const ASSET_IS_MINTABLE =
  process.env.NEXT_PUBLIC_ASSET_IS_MINTABLE === "true";

/** The vault's asset is USDC-like: 6 decimals, not 18. */
export const ASSET_DECIMALS = 6;
export const ASSET_SYMBOL = "USDC";

/**
 * Mirrors `Insurance.PURCHASE_CUTOFF` / `MIN_DELAY_THRESHOLD` /
 * `MAX_DELAY_THRESHOLD`. Duplicated here only to validate input before the user
 * spends gas — the contract remains the authority.
 */
export const PURCHASE_CUTOFF_SECONDS = 60 * 60; // 1 hour
export const MIN_DELAY_THRESHOLD_SECONDS = 60 * 60; // 1 hour
export const MAX_DELAY_THRESHOLD_SECONDS = 12 * 60 * 60; // 12 hours

/** Selectable delay thresholds, within the contract's 1–12h bounds. */
export const DELAY_THRESHOLD_OPTIONS = [
  { label: "1 hour", seconds: 1 * 60 * 60 },
  { label: "2 hours", seconds: 2 * 60 * 60 },
  { label: "3 hours", seconds: 3 * 60 * 60 },
  { label: "6 hours", seconds: 6 * 60 * 60 },
  { label: "12 hours", seconds: 12 * 60 * 60 },
] as const;

export const EXPLORER_URL = "https://testnet.arcscan.app";

export function explorerTx(hash: string) {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerAddress(address: string) {
  return `${EXPLORER_URL}/address/${address}`;
}
