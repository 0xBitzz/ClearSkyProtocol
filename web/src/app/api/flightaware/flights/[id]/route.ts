import { NextResponse } from "next/server";

/**
 * Mock FlightAware AeroAPI endpoint.
 *
 * Shaped to match AeroAPI's `GET /flights/{ident}` response so the agent can be
 * pointed at the real service later by changing a base URL and adding an
 * `x-apikey` header — no parsing changes. Only the fields ClearSky actually
 * consumes are populated; the rest of AeroAPI's payload is irrelevant here and
 * omitting it keeps the fixture readable.
 *
 * Scenarios are keyed off the flight number so a demo is reproducible, and can
 * be overridden per-request with `?scenario=` for the cases that are awkward to
 * wait for in real time.
 */

type Scenario = "on_time" | "delayed_90m" | "delayed_4h" | "cancelled";

const SCENARIOS: Record<string, Scenario> = {
  CS1001: "on_time",
  CS1002: "delayed_90m",
  CS1003: "delayed_4h",
  CS1004: "cancelled",
  CS1005: "on_time",
};


// Departure is anchored to a fixed UTC hour rather than an offset from "now".
// The agent registers a flight on-chain once and then re-reads this endpoint on
// every poll; if the answer drifted between calls it would compute delays
// against a baseline that no longer matches what was written to the registry.
const DEPARTURE_HOUR_UTC: Record<string, number> = {
  CS1001: 17,
  CS1002: 20,
  CS1003: 21,
  CS1004: 22,
  // Late anchor so the on-time walkthrough stays buyable through an evening
  // session. CS1001–CS1004 have all been reported as departed on-chain and a
  // registry entry can't be un-departed, so a fresh number is the only way to
  // exercise the on-time path again.
  CS1005: 23,
};


/**
 * Today's anchor hour, or tomorrow's once that hour has passed.
 *
 * `registerFlight` rejects a departure in the past and policies must be bought
 * at least an hour ahead, so a fixture that has already "left" is dead weight —
 * rolling forward keeps all four demo flights permanently buyable without
 * anyone editing dates.
 */
function anchoredDeparture(hourUtc: number): Date {
  const now = new Date();
  const departure = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );

  // Two hours of headroom: one for the contract's purchase cutoff, one so a
  // flight doesn't roll over mid-demo.
  if (departure.getTime() - now.getTime() < 2 * 60 * 60 * 1000) {
    departure.setUTCDate(departure.getUTCDate() + 1);
  }

  return departure;
}

const DELAY_MINUTES: Record<Scenario, number> = {
  on_time: 0,
  delayed_90m: 90,
  delayed_4h: 240,
  cancelled: 0,
};

const ROUTES: Record<string, { origin: string; destination: string }> = {
  CS1001: { origin: "LOS", destination: "LHR" },
  CS1002: { origin: "LHR", destination: "JFK" },
  CS1003: { origin: "JFK", destination: "SFO" },
  CS1004: { origin: "ABV", destination: "CDG" },
  CS1005: { origin: "LOS", destination: "DXB" },
};


const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  const ident = params.id.trim().toUpperCase();
  const url = new URL(request.url);

  const override = url.searchParams.get("scenario") as Scenario | null;
  const scenario = override ?? SCENARIOS[ident];

  if (!scenario) {
    // AeroAPI returns 404 with a `title`/`detail` body for unknown idents.
    return NextResponse.json(
      { title: "Not Found", detail: `No flight found for ident ${ident}` },
      { status: 404 },
    );
  }

  const route = ROUTES[ident] ?? { origin: "LOS", destination: "LHR" };
  const scheduledOut = anchoredDeparture(DEPARTURE_HOUR_UTC[ident] ?? 18);

  const delayMinutes = DELAY_MINUTES[scenario];
  const cancelled = scenario === "cancelled";

  // `estimated_out` is what AeroAPI publishes before pushback; `actual_out`
  // only appears once the aircraft has actually left the gate. The agent must
  // treat estimated as advisory and only settle on actual — mirroring that
  // distinction here is the whole point of the fixture.
  const estimatedOut = new Date(scheduledOut.getTime() + delayMinutes * 60_000);

  // Fixtures are always in the future, so nothing has departed yet. A demo
  // forces departure with `?departed=1`.
  const departed = url.searchParams.get("departed") === "1";
  const actualOut = departed && !cancelled ? estimatedOut : null;

  return NextResponse.json({
    ident,
    flights: [
      {
        ident,
        fa_flight_id: `${ident}-${Math.floor(scheduledOut.getTime() / 1000)}`,
        origin: { code: route.origin },
        destination: { code: route.destination },
        scheduled_out: iso(scheduledOut),
        estimated_out: iso(estimatedOut),
        actual_out: actualOut ? iso(actualOut) : null,
        departure_delay: delayMinutes * 60, // AeroAPI reports delay in seconds
        cancelled,
        diverted: false,
        status: cancelled
          ? "Cancelled"
          : actualOut
            ? "Departed"
            : delayMinutes > 0
              ? "Delayed"
              : "Scheduled",
      },
    ],
    links: null,
    num_pages: 1,
  });
}
