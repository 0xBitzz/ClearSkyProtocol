/**
 * Live leg picker.
 *
 * Buys one airport-departures page from StableTravel and prints the legs that
 * are still ahead of us, soonest first, so a demo can be pinned to a real
 * flight that is about to push back.
 *
 * Why this exists as its own script rather than a flag on the monitor: the
 * monitor is keyed by leg, and you cannot know which leg to watch until you
 * have looked at what is departing. This is the discovery step that produces
 * the `fa_flight_id` everything downstream uses.
 *
 * EVERY RUN SPENDS USDC. One call, ~$0.01, capped by X402_MAX_AMOUNT_USDC.
 *
 * Usage
 *   npx tsx src/pickleg.ts KJFK            # what's leaving JFK soon
 *   npx tsx src/pickleg.ts KORD --save     # also write a demo fixture
 *   npx tsx src/pickleg.ts --sweep A,B,C   # rank next leg across idents
 *
 * On --sweep: the departures feed turned out to be REAR-facing. Two airports
 * sampled (KJFK, RJTT) both returned only legs that had already pushed back,
 * so it cannot answer "what leaves next". /flights/{ident} does carry future
 * legs, so sweep asks several idents and ranks their soonest undeparted leg.
 * Cost is one paid call per ident — the list is deliberately caller-supplied
 * rather than a hardcoded default.
 */


// Loads agent/.env. Imported for side effects only, and FIRST: x402.ts reads
// CIRCLE_WALLET_ADDRESS off process.env, so the file has to be parsed before
// any other import touches it.
import "dotenv/config";

import { writeFileSync } from "node:fs";
import { payAndFetch } from "./x402.js";
import type { AeroApiFlight } from "./flightdata.js";


const BASE_URL =
    process.env.FLIGHTAWARE_BASE_URL ?? "https://stabletravel.dev/api/flightaware";

const toUnix = (value: string | null | undefined): number =>
    value ? Math.floor(new Date(value).getTime() / 1000) : 0;

const mins = (seconds: number) => Math.round(seconds / 60);

/** Soonest leg for one ident that has NOT pushed back yet. */
async function soonestLeg(ident: string, now: number) {
    const url = `${BASE_URL.replace(/\/$/, "")}/flights/${encodeURIComponent(ident)}`;
    const { body } = await payAndFetch<{ flights?: AeroApiFlight[] }>({
        url,
        method: "GET",
    });

    // Guard on actual_out as well as the clock. FlightAware publishes
    // actual_out for legs up to a day ahead of the current one, so "scheduled
    // in the future" alone would happily return an already-departed leg.
    const future = (body.flights ?? [])
        .filter((f) => !f.cancelled && !f.actual_out && toUnix(f.scheduled_out) > now)
        .sort((a, b) => toUnix(a.scheduled_out) - toUnix(b.scheduled_out));

    return future[0] ?? null;
}

async function sweep(idents: string[]) {
    const now = Math.floor(Date.now() / 1000);
    console.log(
        `Sweeping ${idents.length} idents — this spends ~$${(idents.length * 0.01).toFixed(2)} USDC.\n`,
    );

    const found: Array<{ ident: string; leg: AeroApiFlight; eta: number }> = [];

    for (const ident of idents) {
        try {
            const leg = await soonestLeg(ident, now);
            if (!leg) {
                console.log(`  ${ident.padEnd(9)} no undeparted leg in window`);
                continue;
            }
            const eta = toUnix(leg.scheduled_out) - now;
            found.push({ ident, leg, eta });
            console.log(
                `  ${ident.padEnd(9)} next in ${String(mins(eta)).padStart(5)}min  ${leg.fa_flight_id}`,
            );
        } catch (error) {
            // One bad ident must not abandon a sweep that has already been
            // paid for; report and keep going.
            console.log(
                `  ${ident.padEnd(9)} FAILED: ${error instanceof Error ? error.message : error}`,
            );
        }
    }

    found.sort((a, b) => a.eta - b.eta);

    console.log(`\n=== Ranked by time to departure ===`);
    for (const { ident, leg, eta } of found) {
        const drift = toUnix(leg.estimated_out) - toUnix(leg.scheduled_out);
        console.log(
            `  ${String(mins(eta)).padStart(5)}min  ${ident.padEnd(9)} ${leg.fa_flight_id.padEnd(32)}` +
                ` ${leg.origin?.code ?? "?"}->${leg.destination?.code ?? "?"}` +
                (drift > 0 ? `  [est +${mins(drift)}min late]` : ""),
        );
    }

    if (found.length > 0) {
        const best = found[0]!;
        console.log(
            `\nSoonest overall: ${best.leg.fa_flight_id} in ${mins(best.eta)}min ` +
                `(${new Date(toUnix(best.leg.scheduled_out) * 1000).toISOString()})`,
        );
    }
}

async function main() {
    const args = process.argv.slice(2);
    const sweepIdx = args.indexOf("--sweep");
    if (sweepIdx !== -1) {
        const list = (args[sweepIdx + 1] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (list.length === 0) {
            throw new Error("--sweep needs a comma-separated ident list, e.g. --sweep ANA965,JAL115");
        }
        return sweep(list);
    }

    const airport = args.find((a) => !a.startsWith("--")) ?? "KJFK";
    const save = args.includes("--save");


    const url = `${BASE_URL.replace(/\/$/, "")}/airports/${encodeURIComponent(airport)}/flights/departures`;

    console.log(`Paying for ${url}`);
    const { body, payment } = await payAndFetch<{
        // The CLI wraps the seller's response; unwrap defensively because the
        // envelope shape is the seller's choice, not ours.
        response?: { departures?: AeroApiFlight[] };
        departures?: AeroApiFlight[];
    }>({ url, method: "GET" });

    if (payment) {
        console.log(
            `Paid ${payment.amount ?? "?"} on ${payment.chain ?? "?"} to ${payment.seller ?? "?"}`,
        );
    }

    const departures = body.response?.departures ?? body.departures ?? [];
    const now = Math.floor(Date.now() / 1000);

    console.log(`\n${departures.length} departures returned.`);

    // A leg is usable for a live demo only if it has not left yet: settlement
    // moves on actual_out, so once that is populated the outcome is already
    // fixed and there is nothing left to monitor.
    const upcoming = departures
        .filter((f) => !f.cancelled && !f.actual_out && toUnix(f.scheduled_out) > now)
        .sort((a, b) => toUnix(a.scheduled_out) - toUnix(b.scheduled_out));

    if (upcoming.length === 0) {
        console.log(
            "\nNo legs still ahead of us in this page. The feed covers a fixed " +
                "window around now; try a hub in a timezone that is mid-morning.",
        );
    } else {
        console.log(`\n${upcoming.length} legs still to depart:\n`);
        for (const f of upcoming.slice(0, 12)) {
            const sched = toUnix(f.scheduled_out);
            const est = toUnix(f.estimated_out);
            // A published estimate later than schedule is the earliest warning
            // of a delay — advisory only, but it tells you which leg is worth
            // insuring for a demo that needs a payout.
            const drift = est && sched ? est - sched : 0;
            console.log(
                `  ${f.ident.padEnd(9)} ${f.fa_flight_id.padEnd(30)} ` +
                    `-> ${(f.destination?.code ?? "?").padEnd(5)} ` +
                    `in ${String(mins(sched - now)).padStart(4)}min` +
                    (drift > 0 ? `  [est +${mins(drift)}min late]` : ""),
            );
        }
    }

    if (save) {
        const path = `fixtures/stabletravel-departures-${airport}.json`;
        writeFileSync(
            path,
            JSON.stringify(
                {
                    _provenance: {
                        source: "StableTravel (FlightAware) via Circle x402",
                        resource: url,
                        method: "GET",
                        price: payment?.amount ?? "$0.01 USDC",
                        // Recorded from the CLI's own settlement report rather
                        // than assumed: an earlier fixture asserted a Base tx
                        // hash that does not exist on Base.
                        chain: payment?.chain ?? "unverified",
                        seller: payment?.seller ?? null,
                        payer: process.env.CIRCLE_WALLET_ADDRESS ?? null,
                        receipt: payment?.receipt ?? null,
                        capturedAt: new Date().toISOString(),
                    },
                    ...body,
                },
                null,
                2,
            ),
        );
        console.log(`\nSaved ${path}`);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
