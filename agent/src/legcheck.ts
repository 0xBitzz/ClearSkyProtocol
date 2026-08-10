/**
 * Leg-selection check against real captured data.
 *
 * Runs `selectCurrentLeg` over the live StableTravel response saved in
 * agent/fixtures/stabletravel-live-UAL455.json — 15 real legs of UAL455 across
 * two routes and a week of dates. Costs nothing: the payment was made once and
 * the response committed to the repo.
 *
 * This exists because `flights[0]` was wrong on real data in a way no mock
 * would have caught. The mock returns one leg; the real API returns fifteen,
 * newest-scheduled first, so [0] was a flight two days in the future while the
 * aircraft the policy covered was already airborne.
 *
 *   npm run legcheck
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
    normaliseFlight,
    selectCurrentLeg,
    FlightStatus,
    type AeroApiFlight,
} from "./flightdata.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "stabletravel-live-UAL455.json");

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    flights: AeroApiFlight[];
};

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${label}`);
    } else {
        failed++;
        console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
}

const flights = fixture.flights;
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

console.log(`\nfixture: ${flights.length} legs of UAL455\n`);

// The bug this file exists to prevent.
console.log("leg selection");
{
    // 2026-08-08T16:00Z: UAL455 KPIT->KORD is airborne (pushed back 14:55Z),
    // and flights[0] is a KORD->KPHX leg two days out.
    const now = at("2026-08-08T16:00:00Z");
    const leg = selectCurrentLeg(flights, now);

    check(
        "picks the airborne leg, not flights[0]",
        leg?.fa_flight_id === "UAL455-1785974592-fa-1986p",
        `got ${leg?.fa_flight_id}`,
    );
    check(
        "flights[0] would have been the wrong leg",
        flights[0]!.fa_flight_id !== leg?.fa_flight_id,
        "fixture no longer exercises the bug",
    );
    check(
        "selected leg is the KPIT->KORD route",
        leg?.origin?.code === "KPIT" && leg?.destination?.code === "KORD",
        `got ${leg?.origin?.code}->${leg?.destination?.code}`,
    );
}

{
    // 06:00Z, nine hours before the day's first departure. Last night's leg
    // pushed back 11.6h ago and is still inside the 24h window.
    //
    // It wins, and that is correct: a policy on last night's flight can still be
    // claimed, and dropping it to look at a leg that has not boarded would stop
    // reporting on a flight that may owe a payout. "Next departure" only takes
    // over once the previous leg ages out of the window.
    const now = at("2026-08-08T06:00:00Z");
    const leg = selectCurrentLeg(flights, now);
    check(
        "an unexpired leg outranks tomorrow's schedule",
        leg?.fa_flight_id === "UAL455-1785888239-fa-2175p",
        `got ${leg?.fa_flight_id}`,
    );
}

{
    // Same instant, with every departure cleared — nothing has pushed back, so
    // no claim window is open behind us. The next scheduled leg is the target.
    //
    // Derived from the real schedule rather than a hand-written fixture, so the
    // "next departure" branch is exercised against the same 15 legs and the same
    // descending order the API actually returns.
    const now = at("2026-08-08T06:00:00Z");
    const noneDeparted = flights.map((f) => ({ ...f, actual_out: null }));
    const leg = selectCurrentLeg(noneDeparted, now);
    check(
        "with nothing claimable behind, picks the next departure",
        leg?.scheduled_out === "2026-08-08T14:54:00Z",
        `got ${leg?.scheduled_out}`,
    );
    check(
        "the next departure is the earliest still ahead, not the latest",
        leg?.fa_flight_id === "UAL455-1785974592-fa-1986p",
        `got ${leg?.fa_flight_id}`,
    );
}

{
    // Between the two daily legs: the earlier one has pushed back and is within
    // 24h, so it still owns the claim window.
    //
    // This case caught a real bug. The fixture carries `actual_out` values for
    // legs in the FUTURE — at this instant one is 21 hours ahead — so ranking
    // "has departed" by recency alone handed back tomorrow's flight while the
    // aircraft under policy was three hours into its trip.
    const now = at("2026-08-07T17:30:00Z");
    const leg = selectCurrentLeg(flights, now);
    check(
        "a leg that departed today keeps priority over tonight's",
        leg?.fa_flight_id === "UAL455-1785888193-fa-1486p",
        `got ${leg?.fa_flight_id}`,
    );
    check(
        "never selects a leg whose actual_out is in the future",
        at(leg!.actual_out!) <= now,
        `actual_out ${leg?.actual_out} > now`,
    );
}

// One ident, two routes — the ambiguity that makes flight numbers unsafe keys.
console.log("\nleg identity");
{
    const routes = new Set(
        flights.map((f) => `${f.origin?.code}->${f.destination?.code}`),
    );
    check(
        "one flight number spans multiple routes",
        routes.size > 1,
        [...routes].join(", "),
    );

    const ids = new Set(flights.map((f) => f.fa_flight_id));
    check("every leg id is unique", ids.size === flights.length);

    const idents = new Set(flights.map((f) => f.ident));
    check(
        "every leg shares one ident (so ident cannot be the key)",
        idents.size === 1,
        [...idents].join(", "),
    );
}

// Signed seconds: an early pushback must not become a delay.
console.log("\ndelay normalisation");
{
    const early = flights.find((f) => (f.departure_delay ?? 0) < 0);
    check("fixture contains a negative (early) departure_delay", !!early,
        "cannot verify the clamp");

    if (early) {
        const obs = normaliseFlight(early);
        check(
            "early departure clamps to zero delay",
            obs.delaySeconds === 0,
            `got ${obs.delaySeconds} from ${early.departure_delay}`,
        );
        check(
            "an early departure is still Departed, not Delayed",
            obs.status === FlightStatus.Departed,
            FlightStatus[obs.status],
        );
    }

    const late = flights.find((f) => (f.departure_delay ?? 0) > 0);
    if (late) {
        const obs = normaliseFlight(late);
        check(
            "a late pushback keeps its delay in seconds",
            obs.delaySeconds === late.departure_delay,
            `got ${obs.delaySeconds}, expected ${late.departure_delay}`,
        );
    }

    const scheduled = flights.find((f) => !f.actual_out && !f.cancelled);
    if (scheduled) {
        const obs = normaliseFlight(scheduled);
        check(
            "a leg that hasn't pushed back has actualDeparture 0",
            obs.actualDeparture === 0,
        );
    }
}

// The web copy is a hand-kept mirror (web/src/lib/flightaware.ts). Nothing in
// the type system links the two, so drift is silent — and a divergence here is
// exactly the kind that shows a claim button which reverts, or hides one that
// would have paid. Replaying the same fixture through both is what catches it.
console.log("\nagent/web parity");
{
    const webModule = join(
        here,
        "..",
        "..",
        "web",
        "src",
        "lib",
        "flightaware.ts",
    );

    if (!existsSync(webModule)) {
        check("web copy is present", false, `not found at ${webModule}`);
    } else {
        const web = (await import(pathToFileURL(webModule).href)) as {
            selectCurrentLeg: typeof selectCurrentLeg;
            normaliseFlight: typeof normaliseFlight;
        };

        // Same instants the agent cases above use, including the one that
        // caught the future-actual_out bug.
        for (const iso of [
            "2026-08-08T16:00:00Z",
            "2026-08-08T06:00:00Z",
            "2026-08-07T17:30:00Z",
        ]) {
            const now = at(iso);
            const mine = selectCurrentLeg(flights, now);
            const theirs = web.selectCurrentLeg(flights, now);
            check(
                `both copies pick the same leg at ${iso}`,
                mine?.fa_flight_id === theirs?.fa_flight_id,
                `agent ${mine?.fa_flight_id} vs web ${theirs?.fa_flight_id}`,
            );
        }

        // Delay normalisation has to agree too: the UI decides whether to offer
        // a claim from the same number the agent writes on-chain.
        const mismatch = flights.find(
            (f) =>
                normaliseFlight(f).delaySeconds !==
                    web.normaliseFlight(f).delaySeconds ||
                normaliseFlight(f).status !== web.normaliseFlight(f).status,
        );
        check(
            "both copies normalise every leg identically",
            !mismatch,
            mismatch
                ? `${mismatch.fa_flight_id}: agent ${normaliseFlight(mismatch).delaySeconds}s/${
                      FlightStatus[normaliseFlight(mismatch).status]
                  } vs web ${web.normaliseFlight(mismatch).delaySeconds}s/${
                      FlightStatus[web.normaliseFlight(mismatch).status]
                  }`
                : "",
        );
    }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
