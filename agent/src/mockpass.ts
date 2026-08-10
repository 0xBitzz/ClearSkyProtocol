/**
 * Mock-pass harness.
 *
 * Drives the real `fetchFlight` + `normaliseFlight` against the Next mock and
 * prints the reading the agent would act on, so the fixture and the normaliser
 * can be checked without spending gas or paying an x402 provider.
 *
 * Two things are verified, and the second matters as much as the first:
 *
 *   1. Each fixture maps onto the FlightStatus the agent would report.
 *   2. `legId` behaves like a key. Flights are stored per leg on-chain, so a
 *      legId that churned between polls would send the agent looking up a leg
 *      the registry has never seen — and it would quietly stop reporting rather
 *      than fail loudly. Cheap to assert here, expensive to discover in prod.
 *
 * Run: npm run mockpass
 */

import { fetchFlight, FlightStatus } from "./flightdata.js";

const BASE_URL =
    process.env.FLIGHTAWARE_BASE_URL ?? "http://localhost:3000/api/flightaware";

type Case = {
    ident: string;
    searchParams?: Record<string, string>;
    label: string;
    expect: FlightStatus | "null";
};

const CASES: Case[] = [
    { ident: "CS1001", label: "on time, pre-departure", expect: FlightStatus.Scheduled },
    { ident: "CS1002", label: "90m delay, at gate", expect: FlightStatus.Delayed },
    { ident: "CS1003", label: "4h delay, at gate", expect: FlightStatus.Delayed },
    { ident: "CS1004", label: "cancelled", expect: FlightStatus.Cancelled },
    {
        ident: "CS1002",
        searchParams: { departed: "1" },
        label: "90m delay, pushed back",
        expect: FlightStatus.Departed,
    },
    {
        ident: "CS1001",
        searchParams: { departed: "1" },
        label: "on time, pushed back",
        expect: FlightStatus.Departed,
    },
    {
        ident: "CS1004",
        searchParams: { departed: "1" },
        label: "cancelled stays cancelled under ?departed=1",
        expect: FlightStatus.Cancelled,
    },
    { ident: "ZZ9999", label: "unknown ident -> 404 -> null", expect: "null" },
];

const hhmm = (unix: number) =>
    unix === 0 ? "—" : new Date(unix * 1000).toISOString().slice(11, 16);

let checks = 0;
let failures = 0;

function check(ok: boolean, name: string, detail: string): void {
    checks++;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${detail}`);
}

/** Each fixture resolves to the status the agent would post on-chain. */
async function statusCases(): Promise<void> {
    console.log("status mapping\n");

    for (const testCase of CASES) {
        const suffix = testCase.searchParams
            ? `?${new URLSearchParams(testCase.searchParams)}`
            : "";
        const name = `${testCase.ident}${suffix}`;

        try {
            const observed = await fetchFlight(testCase.ident, {
                baseUrl: BASE_URL,
                searchParams: testCase.searchParams,
            });

            const actual = observed === null ? "null" : observed.status;
            const expectedLabel =
                testCase.expect === "null" ? "null" : FlightStatus[testCase.expect];
            const actualLabel =
                observed === null ? "null" : FlightStatus[observed.status];

            check(
                actual === testCase.expect,
                name,
                `${testCase.label} | expected ${expectedLabel}, got ${actualLabel}` +
                    (observed
                        ? ` | leg ${observed.legId} sched ${hhmm(
                              observed.scheduledDeparture,
                          )} actual ${hhmm(observed.actualDeparture)} delay ${
                              observed.delaySeconds
                          }s (${Math.round(observed.delaySeconds / 60)}m)`
                        : ""),
            );
        } catch (error) {
            check(false, name, `threw: ${(error as Error).message}`);
        }
    }
}

/**
 * legId is the on-chain key, so it has to behave like one: present, stable
 * across polls, unchanged when the flight's status moves, and distinct between
 * legs. Anything else and the agent and the registry drift apart.
 */
async function legInvariants(): Promise<void> {
    console.log("\nleg identity\n");

    const [first, second, departed, other] = await Promise.all([
        fetchFlight("CS1002", { baseUrl: BASE_URL }),
        fetchFlight("CS1002", { baseUrl: BASE_URL }),
        fetchFlight("CS1002", {
            baseUrl: BASE_URL,
            searchParams: { departed: "1" },
        }),
        fetchFlight("CS1001", { baseUrl: BASE_URL }),
    ]);

    if (!first || !second || !departed || !other) {
        check(false, "leg fixtures resolve", "a lookup returned null");
        return;
    }

    check(
        first.legId.length > 0,
        "legId non-empty",
        `registerFlight rejects an empty key | got "${first.legId}"`,
    );

    check(
        first.legId === second.legId,
        "legId stable across polls",
        `${first.legId} === ${second.legId}`,
    );

    check(
        first.legId === departed.legId,
        "legId survives departure",
        `pre ${first.legId} === post ${departed.legId}`,
    );

    check(
        first.legId !== other.legId,
        "legId distinct per leg",
        `CS1002 ${first.legId} !== CS1001 ${other.legId}`,
    );

    check(
        first.flightNumber === "CS1002",
        "flightNumber kept for display",
        `got ${first.flightNumber}`,
    );
}

async function main(): Promise<void> {
    console.log(`mock pass against ${BASE_URL}\n`);

    await statusCases();
    await legInvariants();

    console.log(
        `\n${checks - failures}/${checks} passed${failures ? ` — ${failures} FAILED` : ""}`,
    );
    process.exit(failures ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
