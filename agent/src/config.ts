import "dotenv/config";
import { defineChain, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Agent configuration, read once at startup so a missing value fails loudly on
 * boot rather than midway through a monitoring loop.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy agent/.env.example to agent/.env.`);
  return value;
}

function requiredAddress(name: string): Address {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${name} is not a valid address: ${value}`);
  }
  return value as Address;
}

export const arcTestnet = defineChain({
  id: Number(process.env.CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  // Gas on Arc is paid in USDC, not ETH.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL ?? "https://rpc.testnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
  testnet: true,
});

export const account = privateKeyToAccount(required("AGENT_PRIVATE_KEY") as Hex);

export const config = {
  flightAgent: requiredAddress("FLIGHT_AGENT_ADDRESS"),
  flightRegistry: requiredAddress("FLIGHT_REGISTRY_ADDRESS"),
  insurance: requiredAddress("INSURANCE_ADDRESS"),

  /**
   * ERC-8004 IdentityRegistry. Defaults to the canonical Arc Testnet
   * deployment, which is also what FlightAgent was constructed with.
   */
  identityRegistry: (process.env.IDENTITY_REGISTRY_ADDRESS ??
    "0x8004A818BFB912233c491871b3d84c89A494BD9e") as Address,


  /**
   * What to watch. Entries are either a flight number (`UAL455`) or a
   * FlightAware leg id (`UAL455-1785974592-fa-1986p`).
   *
   * Prefer leg ids. A flight number is ambiguous — UAL455 is two different
   * routes on the same day (KPIT->KORD at 14:54Z, KORD->KPHX at 18:30Z) — so
   * monitoring by number means the agent has to guess which leg the traveller
   * bought. A leg id resolves to exactly one flight and one query.
   */
  flights: (process.env.MONITORED_FLIGHTS ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean),

  /** Live flight data. Point at StableTravel to leave the mock behind. */
  flightBaseUrl:
    process.env.FLIGHTAWARE_BASE_URL ?? "http://localhost:3000/api/flightaware",

  /**
   * Circle Agent Wallet that pays for flight data over x402.
   *
   * Separate from AGENT_PRIVATE_KEY on purpose: this wallet spends real USDC on
   * Base mainnet to buy data, while the Arc key writes the results on-chain. The
   * CLI holds this wallet's key — there is no private key here to leak.
   */
  circleWallet: process.env.CIRCLE_WALLET_ADDRESS,
  circlePayChain: process.env.CIRCLE_PAY_CHAIN ?? "BASE",
  maxSpendPerCallUsdc: process.env.X402_MAX_AMOUNT_USDC ?? "0.02",

  pollIntervalMs: Number(process.env.POLL_INTERVAL_SECONDS ?? 30) * 1000,

  /**
   * Flights the demo wants to see depart right now.
   *
   * Scoped to a list rather than a global on/off switch, because a flight that
   * has been reported as departed cannot be un-departed — the registry has no
   * rewind, by design. A blanket `FORCE_DEPARTED=1` therefore settles every
   * monitored flight permanently, which burns the whole fixture set in one pass.
   *
   * `FORCE_DEPARTED=CS1005` forces one. `FORCE_DEPARTED=1` or `=all` still
   * forces everything, for when that is genuinely what you want.
   */
  forcedDepartures: (() => {
    const raw = (process.env.FORCE_DEPARTED ?? "").trim();
    if (!raw) return new Set<string>();
    if (raw === "1" || raw.toLowerCase() === "all") return "all" as const;
    return new Set(
      raw
        .split(",")
        .map((f) => f.trim().toUpperCase())
        .filter(Boolean),
    );
  })(),

  /** Forwarded to the mock for demos; ignored by the real AeroAPI. */
  forcedScenario: process.env.FORCE_SCENARIO,
} as const;

/** Query params to send to the flight provider for a specific flight. */
export function scenarioParamsFor(flightNumber: string): Record<string, string> {
  const params: Record<string, string> = {};

  const forced = config.forcedDepartures;
  if (forced === "all" || forced.has(flightNumber.toUpperCase())) {
    params.departed = "1";
  }
  if (config.forcedScenario) params.scenario = config.forcedScenario;

  return params;
}


export function explorerTx(hash: string) {
  return `${arcTestnet.blockExplorers.default.url}/tx/${hash}`;
}
