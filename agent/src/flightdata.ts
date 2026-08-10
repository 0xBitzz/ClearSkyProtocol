/**
 * FlightAware client + normaliser — agent copy.
 *
 * This is a mirror of web/src/lib/flightaware.ts, kept in sync by hand. The web
 * copy typechecks against a DOM lib (Next), the agent against Node types
 * (@types/node), and the differences between them are deliberate:
 *
 *  - Node's fetch has no HTTP cache to bypass, so the `cache: "no-store"` hint
 *    is dropped here (`cache` is not part of undici's RequestInit type).
 *  - Only the agent can pay. Reaching StableTravel costs USDC per call, and the
 *    spending wallet lives with the agent, so the x402 path exists here and not
 *    in the browser bundle. The web copy stays on the free mock.
 *
 * When a third consumer appears, extract the shared parts to a package and
 * delete both copies. Until then, treat a change to one as a change to the other.
 *
 * One parser, one interpretation: the agent is the only writer of flight status
 * on-chain, so if it read a response differently from the UI, the two would
 * disagree about whether a policy is payable. The UI would show a claim button
 * that reverts, or hide one that would have paid.
 */

import { payAndFetch } from "./x402.js";

/** Mirrors IFlightData.FlightStatus — order matters, it's an on-chain enum. */
export enum FlightStatus {
  Scheduled = 0,
  Departed = 1,
  Delayed = 2,
  Cancelled = 3,
}

export type AeroApiFlight = {
  ident: string;
  fa_flight_id: string;
  origin: { code: string } | null;
  destination: { code: string } | null;
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  departure_delay: number | null;
  cancelled: boolean;
  diverted: boolean;
  status: string;
};

export type FlightObservation = {
  /**
   * FlightAware's `fa_flight_id` — unique per LEG, not per flight number. This
   * is the protocol's flight key, because `ident` is reused every day and would
   * collapse Monday's and Tuesday's BA208 onto one on-chain record.
   */
  legId: string;
  /** Airline flight number (FlightAware `ident`). Display only. */
  flightNumber: string;
  origin: string | null;
  destination: string | null;
  /** Unix seconds. */
  scheduledDeparture: number;
  /** Unix seconds, or 0 when the aircraft hasn't left the gate. */
  actualDeparture: number;
  /** Seconds of delay as published by the airline. Advisory until departure. */
  delaySeconds: number;
  status: FlightStatus;
  /**
   * Commitment to the exact payload this reading came from. FlightRegistry
   * rejects a zero hash, so the agent has to stake its claim on specific data
   * rather than posting an unfalsifiable assertion.
   */
  raw: AeroApiFlight;
};

const toUnix = (value: string | null): number =>
  value ? Math.floor(new Date(value).getTime() / 1000) : 0;

/**
 * Collapses a FlightAware flight record into a single reading.
 *
 * `actual_out` is the only field trusted for settlement. `estimated_out` moves
 * around while a flight is boarding, and paying out on an estimate would let a
 * revised-then-reverted delay drain the vault.
 */
export function normaliseFlight(flight: AeroApiFlight): FlightObservation {
  const scheduledDeparture = toUnix(flight.scheduled_out);
  const actualDeparture = toUnix(flight.actual_out);

  // FlightAware publishes departure_delay as SIGNED seconds — negative means
  // the aircraft pushed back early. Clamping at 0 keeps "delay" meaning what
  // the policy means by it; an early departure is not a negative delay, it is
  // no delay. Without the clamp a -420 would read as a large negative number
  // and the on-chain uint would underflow on cast.
  const publishedDelay = flight.departure_delay ?? null;
  const delaySeconds =
    publishedDelay !== null
      ? Math.max(0, publishedDelay)
      : actualDeparture && scheduledDeparture
        ? Math.max(0, actualDeparture - scheduledDeparture)
        : 0;

  let status: FlightStatus;
  if (flight.cancelled) {
    status = FlightStatus.Cancelled;
  } else if (actualDeparture > 0) {
    status = FlightStatus.Departed;
  } else if (delaySeconds > 0) {
    status = FlightStatus.Delayed;
  } else {
    status = FlightStatus.Scheduled;
  }

  return {
    legId: flight.fa_flight_id,
    flightNumber: flight.ident,
    origin: flight.origin?.code ?? null,
    destination: flight.destination?.code ?? null,
    scheduledDeparture,
    actualDeparture,
    delaySeconds,
    status,
    raw: flight,
  };
}

/**
 * Picks the leg a policy bought "today" refers to.
 *
 * A live call for UAL455 returns 15 legs spanning a week, sorted DESCENDING by
 * schedule — so `flights[0]` is the furthest-FUTURE leg, days away. Taking [0]
 * would monitor a flight that has not boarded and never report a departure.
 *
 * Worse, one ident can cover two different routes on the same day: UAL455 flies
 * KPIT->KORD at 14:54Z and KORD->KPHX at 18:30Z. Flight number alone does not
 * identify a leg.
 *
 * The leg we want is the one whose departure is nearest to now — already
 * airborne, or the next to push back. Preferring a leg that has actually
 * departed matters because settlement only ever moves on `actual_out`: once a
 * flight is in the air its record is the one that can pay a claim, and a
 * just-scheduled later leg must not displace it.
 */
export function selectCurrentLeg(
  flights: AeroApiFlight[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AeroApiFlight | null {
  if (flights.length === 0) return null;

  // Legs that have ALREADY left the gate, most recent first.
  //
  // The `<= nowSeconds` bound is the subtle part. FlightAware publishes
  // `actual_out` for legs in the future — a real response at 2026-08-07T17:30Z
  // carried an actual_out of 2026-08-08T14:55Z, 21 hours ahead. Filtering only
  // on "has an actual_out" would let tomorrow's departure outrank the flight
  // that pushed back three hours ago, and the agent would report a departure
  // for a policy whose aircraft is still at the gate.
  const departed = flights
    .filter((f) => {
      const out = toUnix(f.actual_out);
      return out > 0 && out <= nowSeconds;
    })
    .sort((a, b) => toUnix(b.actual_out) - toUnix(a.actual_out));

  // A leg that departed within the last 24h is still the operative one — a
  // claim window is open on it and its record is what settles.
  const recentlyDeparted = departed.find(
    (f) => nowSeconds - toUnix(f.actual_out) < 24 * 60 * 60,
  );
  if (recentlyDeparted) return recentlyDeparted;

  // Otherwise the next leg due to depart.
  const upcoming = flights
    .filter((f) => toUnix(f.scheduled_out) >= nowSeconds)
    .sort((a, b) => toUnix(a.scheduled_out) - toUnix(b.scheduled_out));
  if (upcoming.length > 0) return upcoming[0]!;

  // Everything is in the past and nothing recorded a departure (cancellations,
  // or a stale feed). Fall back to the most recently scheduled leg.
  return [...flights].sort(
    (a, b) => toUnix(b.scheduled_out) - toUnix(a.scheduled_out),
  )[0]!;
}

export type FetchOptions = {
  baseUrl?: string;
  /**
   * How the ident is interpreted by the provider. `fa_flight_id` pins the query
   * to ONE leg and is what the monitor uses once a policy has been bound to a
   * specific flight; `designator` is the flight-number lookup used to discover
   * that leg in the first place.
   */
  identType?: "fa_flight_id" | "designator" | "registration";
  /** Forwarded to the mock for demos; ignored by the real provider. */
  searchParams?: Record<string, string>;
  /**
   * Pay for the request via x402. Defaults to on whenever the base URL is not
   * localhost, so a misconfigured base URL fails loudly rather than silently
   * spending USDC — or silently not spending it and getting a 402 back.
   */
  paid?: boolean;
  /** Overrides for the paying wallet; see x402.ts. */
  payment?: { address?: string; chain?: string; maxAmount?: string };
};

const isLocal = (url: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);

/**
 * Fetches the operative flight record for an ident.
 *
 * When `identType` is `fa_flight_id` the provider returns exactly one leg and
 * `selectCurrentLeg` is a no-op — which is the point: after a policy is bound
 * to a leg, every subsequent poll is unambiguous.
 */
export async function fetchFlight(
  ident: string,
  options: FetchOptions = {},
): Promise<FlightObservation | null> {
  // Defaults to the local mock. Point FLIGHTAWARE_BASE_URL at StableTravel to
  // go live: https://stabletravel.dev/api/flightaware
  const baseUrl =
    options.baseUrl ??
    process.env.FLIGHTAWARE_BASE_URL ??
    "http://localhost:3000/api/flightaware";

  const url = new URL(
    `${baseUrl.replace(/\/$/, "")}/flights/${encodeURIComponent(ident)}`,
  );
  if (options.identType) {
    url.searchParams.set("ident_type", options.identType);
  }
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const paid = options.paid ?? !isLocal(baseUrl);

  let body: { flights?: AeroApiFlight[] };

  if (paid) {
    // Costs USDC. `payAndFetch` throws rather than returning null on failure —
    // a payment that settles without returning data must be loud, not silent.
    const result = await payAndFetch<{ flights?: AeroApiFlight[] }>({
      url: url.toString(),
      method: "GET",
      ...options.payment,
    });
    body = result.body;
  } else {
    const response = await fetch(url, {
      // Note: no `cache: "no-store"` here — Node's fetch has no HTTP cache to
      // bypass, unlike a browser. See the file header.
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `Flight provider ${response.status} for ${ident}: ${await response.text()}`,
      );
    }

    body = (await response.json()) as { flights?: AeroApiFlight[] };
  }

  const flight = selectCurrentLeg(body.flights ?? []);
  return flight ? normaliseFlight(flight) : null;
}
