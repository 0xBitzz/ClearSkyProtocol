/**
 * AeroAPI client + normaliser.
 *
 * One place converts FlightAware's payload into the shape the contracts speak
 * (unix seconds, FlightStatus enum). The agent imports the same module, so the
 * UI and the thing that actually writes on-chain can never disagree about how a
 * response was read.
 *
 * MIRRORED FILE. agent/src/flightdata.ts is a hand-kept copy of this logic —
 * the agent typechecks against Node types and can pay for data over x402, which
 * does not belong in a browser bundle. Treat a change to one as a change to
 * both: if the UI read a response differently from the agent that writes status
 * on-chain, the two would disagree about whether a policy is payable, and the UI
 * would offer a claim that reverts or hide one that would have paid.
 * `agent/npm run legcheck` pins the shared behaviour against real captured data.
 *
 * Point FLIGHTAWARE_BASE_URL at https://aeroapi.flightaware.com/aeroapi and set
 * FLIGHTAWARE_API_KEY to switch from the mock to the real service.
 */

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
   * AeroAPI's `fa_flight_id` — unique per LEG, not per flight number. This is
   * the protocol's flight key, because `ident` is reused every day and would
   * collapse Monday's and Tuesday's BA208 onto one on-chain record.
   */
  legId: string;
  /** Airline flight number (AeroAPI `ident`). Display only. */
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
 * Collapses an AeroAPI flight record into a single reading.
 *
 * `actual_out` is the only field trusted for settlement. `estimated_out` moves
 * around while a flight is boarding, and paying out on an estimate would let a
 * revised-then-reverted delay drain the vault.
 */
export function normaliseFlight(flight: AeroApiFlight): FlightObservation {
  const scheduledDeparture = toUnix(flight.scheduled_out);
  const actualDeparture = toUnix(flight.actual_out);

  // AeroAPI publishes departure_delay as SIGNED seconds — negative means the
  // aircraft pushed back early. Clamping at 0 keeps "delay" meaning what the
  // policy means by it; an early departure is not a negative delay, it is no
  // delay. Without the clamp a -420 renders as a negative delay in the UI and
  // underflows on cast to the on-chain uint.
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
 * Kept identical to the agent's copy in agent/src/flightdata.ts. If the UI and
 * the agent disagreed about which leg a flight number means, the UI would show a
 * claim button that reverts, or hide one that would have paid.
 *
 * A live call for UAL455 returns 15 legs spanning a week, sorted DESCENDING by
 * schedule — so `flights[0]` is the furthest-FUTURE leg, days away. Worse, one
 * ident can cover two routes on the same day: UAL455 flies KPIT->KORD at 14:54Z
 * and KORD->KPHX at 18:30Z. Flight number alone does not identify a leg.
 *
 * The leg we want is the one whose departure is nearest to now — already
 * airborne, or the next to push back.
 */
export function selectCurrentLeg(
  flights: AeroApiFlight[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AeroApiFlight | null {
  if (flights.length === 0) return null;

  // Legs that have ALREADY left the gate, most recent first. The `<= nowSeconds`
  // bound matters: FlightAware publishes `actual_out` for legs in the future, so
  // without it tomorrow's departure outranks the flight that is airborne now.
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
  apiKey?: string;
  /**
   * How the ident is interpreted by the provider. `fa_flight_id` pins the query
   * to ONE leg; `designator` is the flight-number lookup that returns every leg
   * the number has flown this week.
   */
  identType?: "fa_flight_id" | "designator" | "registration";
  /** Forwarded to the mock for demos; ignored by the real AeroAPI. */
  searchParams?: Record<string, string>;
};

/**
 * Fetches the operative flight record for an ident.
 *
 * AeroAPI returns a `flights` array covering roughly a week, so which entry to
 * read is a decision, not an index — see `selectCurrentLeg`.
 */
export async function fetchFlight(
  ident: string,
  options: FetchOptions = {},
): Promise<FlightObservation | null> {
  // Next falls forward to 3001 when 3000 is taken, so the default matches the
  // port the dev server is actually on here. Override with FLIGHTAWARE_BASE_URL
  // rather than editing this — that's also the switch to real AeroAPI.
  const baseUrl =
    options.baseUrl ??
    process.env.FLIGHTAWARE_BASE_URL ??
    "http://localhost:3000/api/flightaware";

  const apiKey = options.apiKey ?? process.env.FLIGHTAWARE_API_KEY;

  const url = new URL(
    `${baseUrl.replace(/\/$/, "")}/flights/${encodeURIComponent(ident)}`,
  );
  if (options.identType) {
    url.searchParams.set("ident_type", options.identType);
  }
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: apiKey ? { "x-apikey": apiKey } : undefined,
    // Flight status is the definition of stale-sensitive data.
    cache: "no-store",
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `AeroAPI ${response.status} for ${ident}: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { flights?: AeroApiFlight[] };
  const flight = selectCurrentLeg(body.flights ?? []);
  return flight ? normaliseFlight(flight) : null;
}
