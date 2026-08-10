import { formatUnits, parseUnits } from "viem";
import { ASSET_DECIMALS, ASSET_SYMBOL } from "./contracts";

/** Format a 6-decimal USDC amount for display, e.g. 12500000n -> "12.50". */
export function formatAsset(amount: bigint | undefined, dp = 2): string {
  if (amount === undefined) return "—";
  const asNumber = Number(formatUnits(amount, ASSET_DECIMALS));
  return asNumber.toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

export function formatAssetWithSymbol(
  amount: bigint | undefined,
  dp = 2,
): string {
  if (amount === undefined) return "—";
  return `${formatAsset(amount, dp)} ${ASSET_SYMBOL}`;
}

/** Parse user input into 6-decimal base units. Returns undefined if invalid. */
export function parseAsset(input: string): bigint | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (!/^\d*\.?\d*$/.test(trimmed)) return undefined;
  try {
    return parseUnits(trimmed, ASSET_DECIMALS);
  } catch {
    return undefined;
  }
}

/** "3h 20m" from a second count. */
export function formatDuration(seconds: bigint | number): string {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return "0m";

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/** Unix seconds -> local datetime string. */
export function formatTimestamp(unixSeconds: bigint | number): string {
  const asNumber = Number(unixSeconds);
  if (asNumber === 0) return "—";
  return new Date(asNumber * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Relative time, e.g. "in 4h 10m" / "2h 5m ago". */
export function formatRelative(unixSeconds: bigint | number): string {
  const target = Number(unixSeconds);
  if (target === 0) return "—";

  const deltaSeconds = target - Math.floor(Date.now() / 1000);
  const magnitude = formatDuration(Math.abs(deltaSeconds));

  return deltaSeconds >= 0 ? `in ${magnitude}` : `${magnitude} ago`;
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Pull a human-readable reason out of a viem/wagmi error.
 *
 * Wallet and RPC errors nest the useful line several levels down; surfacing the
 * raw object gives the user a wall of JSON, so walk the known fields instead.
 */
export function errorMessage(error: unknown): string {
  if (!error) return "";

  const candidate = error as {
    shortMessage?: string;
    details?: string;
    message?: string;
    cause?: unknown;
  };

  if (candidate.shortMessage) return candidate.shortMessage;
  if (candidate.details) return candidate.details;
  if (candidate.cause) {
    const fromCause = errorMessage(candidate.cause);
    if (fromCause) return fromCause;
  }
  if (candidate.message) return candidate.message.split("\n")[0];

  return "Transaction failed.";
}
