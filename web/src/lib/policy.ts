import type { Address } from "viem";

/** Mirrors `IFlightData.PolicyStatus`. Order must match the Solidity enum. */
export enum PolicyStatus {
  Active = 0,
  Claimed = 1,
  Expired = 2,
}

/** Mirrors `IFlightData.FlightStatus`. Order must match the Solidity enum. */
export enum FlightStatus {
  Scheduled = 0,
  Delayed = 1,
  Departed = 2,
  Cancelled = 3,
}

/** Shape returned by `Insurance.getPolicy`. */
export type Policy = {
  policyholder: Address;
  /** The leg this cover is bound to — `fa_flight_id`, not the flight number. */
  legId: string;
  /** Airline flight number, carried for display only. */
  flightNumber: string;
  premium: bigint;
  coverageAmount: bigint;
  departureTime: bigint;
  delayThreshold: bigint;
  status: number;
  purchaseTime: bigint;
};

/** Shape returned by `FlightRegistry.getFlight`. */
export type FlightInfo = {
  legId: string;
  flightNumber: string;
  scheduledDeparture: bigint;
  actualDeparture: bigint;
  status: number;
  exists: boolean;
};

export const POLICY_STATUS_LABEL: Record<number, string> = {
  [PolicyStatus.Active]: "Active",
  [PolicyStatus.Claimed]: "Claimed",
  [PolicyStatus.Expired]: "Expired",
};

export const FLIGHT_STATUS_LABEL: Record<number, string> = {
  [FlightStatus.Scheduled]: "Scheduled",
  [FlightStatus.Delayed]: "Delayed",
  [FlightStatus.Departed]: "Departed",
  [FlightStatus.Cancelled]: "Cancelled",
};

/**
 * What the traveller should be told about a policy, and what action (if any)
 * they can take.
 *
 * `claimable` comes from the contract's own `isClaimable`, never recomputed
 * here — the two drifting apart would show a button that always reverts.
 */
export type PolicyView = {
  label: string;
  tone: "neutral" | "pending" | "good" | "bad";
  detail: string;
};

export function describePolicy(
  policy: Policy,
  flight: FlightInfo | undefined,
  claimable: boolean,
): PolicyView {
  if (policy.status === PolicyStatus.Claimed) {
    return {
      label: "Paid out",
      tone: "good",
      detail: "Payout has been transferred to your wallet.",
    };
  }

  if (policy.status === PolicyStatus.Expired) {
    return {
      label: "Closed",
      tone: "neutral",
      detail: "Flight was on time, or the claim window closed. No payout.",
    };
  }

  if (claimable) {
    return {
      label: "Claim ready",
      tone: "good",
      detail: "Your flight qualified. Claim your payout.",
    };
  }

  if (flight?.status === FlightStatus.Cancelled) {
    return {
      label: "Cancelled",
      tone: "good",
      detail: "Flight was cancelled — this policy pays out.",
    };
  }

  if (flight && flight.actualDeparture !== 0n) {
    return {
      label: "Departed on time",
      tone: "neutral",
      detail: "Delay did not reach your threshold. No payout due.",
    };
  }

  return {
    label: "Monitoring",
    tone: "pending",
    detail: "The agent is watching this flight. Nothing to do yet.",
  };
}
