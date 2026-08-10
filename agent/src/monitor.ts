/**
 * ClearSky monitoring agent.
 *
 * Polls flight data, posts material changes to the FlightRegistry through
 * FlightAgent, and sweeps settled-on-time policies so their collateral is
 * released back to the vault.
 *
 * Design notes
 *
 * - IDEMPOTENT BY COMPARISON. Every poll reads the on-chain record first and
 *   writes only when the observation differs. Gas is real money on any chain and
 *   a re-report of identical data is pure waste; more importantly it keeps the
 *   agent restartable at any moment without duplicating work.
 *
 * - EVIDENCE PER REPORT. `dataHash` is keccak256 over the exact API payload the
 *   decision was made from. The chain can't verify the hash matches reality, but
 *   it makes a false report falsifiable by anyone holding the original response.
 *
 * - ACTUAL, NOT ESTIMATED. Settlement only ever moves on `actual_out`. An
 *   estimate that is revised upward and then walked back would otherwise let a
 *   transient delay drain the vault.
 *
 * Usage
 *   npm run monitor           # poll forever
 *   npm run monitor:once      # single pass, useful in CI or a cron
 *   npm run sweep             # expire on-time policies only, no status writes
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    keccak256,
    toHex,
} from "viem";
import {
    account,
    arcTestnet,
    config,
    explorerTx,
    scenarioParamsFor,
} from "./config.js";

import {
    flightAgentAbi,
    flightRegistryAbi,
    insuranceAbi,
    PolicyStatus,
} from "./abis.js";
import {
    fetchFlight,
    FlightStatus,
    type FlightObservation,
} from "./flightdata.js";

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
});

const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(),
});

const AGENT_ROLE = keccak256(toHex("AGENT_ROLE"));

type OnChainFlight = {
    legId: string;
    flightNumber: string;
    scheduledDeparture: bigint;
    actualDeparture: bigint;
    status: number;
    exists: boolean;
    dataHash: `0x${string}`;
};

const log = (...parts: unknown[]) =>
    console.log(`[${new Date().toISOString()}]`, ...parts);

/**
 * Commitment to the payload a report was derived from.
 *
 * Hashing the serialised raw record rather than the normalised reading is
 * deliberate: the point is to commit to what the SOURCE said, so a dispute can
 * be settled against the original response and not against our interpretation
 * of it.
 */
function evidenceHash(observation: FlightObservation): `0x${string}` {
    return keccak256(toHex(JSON.stringify(observation.raw)));
}

/**
 * Read a leg from the registry.
 *
 * Keyed by `legId` (AeroAPI's `fa_flight_id`), which is why the provider is
 * queried BEFORE the chain in `pollFlights`: the config holds flight numbers a
 * human can type, and only the provider can say which leg one currently means.
 */
async function readFlight(legId: string): Promise<OnChainFlight | null> {
    try {
        const result = await publicClient.readContract({
            address: config.flightRegistry,
            abi: flightRegistryAbi,
            functionName: "getFlight",
            args: [legId],
        });
        return result as unknown as OnChainFlight;
    } catch {
        // getFlight reverts with FlightNotFound rather than returning an empty
        // struct, so a revert here means "not registered", not "call failed".
        return null;
    }
}

/**
 * Whether an observation says something the chain does not already know.
 *
 * Status alone is not enough: a flight can go Scheduled -> Delayed -> Departed
 * while `actualDeparture` stays 0, and the delay is what a policy settles on.
 */
function needsUpdate(
    onChain: OnChainFlight,
    observed: FlightObservation,
): boolean {
    // A recorded departure is terminal. Never report a flight back to
    // "not departed" once the chain has an actual departure time.
    //
    // This is a safety property, not an optimisation. `Insurance.claim` settles
    // on `flight.actualDeparture`, and a traveller has a 30-day claim window — so
    // zeroing that field would silently void a payout they had already earned,
    // and `expirePolicy` would then release the collateral as if the flight had
    // been fine. A provider serving a stale or rolled-forward record (the demo
    // mock rolls a fixture to tomorrow once its slot passes; real APIs drop
    // completed flights out of their live feed) must not be able to rewrite
    // settled history.
    if (onChain.actualDeparture > 0n && observed.actualDeparture === 0) {
        return false;
    }

    const actualChanged =
        BigInt(observed.actualDeparture) !== onChain.actualDeparture;
    const statusChanged = observed.status !== onChain.status;

    // Deliberately NOT comparing dataHash. Unrelated fields in the payload churn
    // between requests on the real API, so hashing the whole response would make
    // every poll look like a change and spend gas re-reporting identical facts.
    // Only the two fields settlement actually depends on trigger a write.
    return actualChanged || statusChanged;
}

async function reportStatus(observed: FlightObservation): Promise<void> {
    const hash = await walletClient.writeContract({
        address: config.flightAgent,
        abi: flightAgentAbi,
        functionName: "updateFlightStatus",
        args: [
            observed.legId,
            observed.status,
            BigInt(observed.actualDeparture),
            evidenceHash(observed),
        ],
    });

    log(`  submitted ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    log(`  ${receipt.status} — ${explorerTx(hash)}`);
}

/**
 * A FlightAware leg id looks like `UAL455-1785974592-fa-1986p` — ident, epoch,
 * `fa`, suffix. A bare flight number never matches.
 *
 * Distinguishing them matters because a leg id can be queried with
 * `ident_type=fa_flight_id`, which returns exactly one flight and removes the
 * daily ambiguity of a flight number entirely.
 */
const LEG_ID = /^[A-Z0-9]+-\d+-fa-\w+$/i;

/** One monitoring pass over every configured flight or leg. */
async function pollFlights(): Promise<void> {
    for (const entry of config.flights) {
        try {
            const isLegId = LEG_ID.test(entry);

            // A leg id pins the query to exactly one flight. A flight number
            // returns every leg the ident has flown this week, and
            // selectCurrentLeg inside fetchFlight picks the operative one.
            const observed = await fetchFlight(entry, {
                identType: isLegId ? "fa_flight_id" : "designator",
                searchParams: scenarioParamsFor(entry),
            });

            if (!observed) {
                log(`${entry}: no data from provider, skipping`);
                continue;
            }

            const label = isLegId
                ? `${observed.flightNumber} (${observed.legId})`
                : `${entry} -> ${observed.legId} ${observed.origin}->${observed.destination}`;

            const onChain = await readFlight(observed.legId);

            if (!onChain?.exists) {
                log(
                    `${label}: not registered on-chain — register it before monitoring`,
                );
                continue;
            }

            if (!needsUpdate(onChain, observed)) {
                log(
                    `${label}: unchanged (status ${FlightStatus[observed.status]}, actual ${observed.actualDeparture})`,
                );
                continue;
            }

            log(
                `${label}: ${FlightStatus[onChain.status]} -> ${FlightStatus[observed.status]}, actual ${onChain.actualDeparture} -> ${observed.actualDeparture}`,
            );
            await reportStatus(observed);
        } catch (error) {
            // One bad flight must not take the loop down; the next pass retries.
            log(`${entry}: ${(error as Error).message}`);
        }
    }
}

/**
 * Release collateral behind policies that can no longer pay out.
 *
 * `expirePolicy` is permissionless and reverts with ClaimTooEarly whenever the
 * outcome is still open, so the safe strategy is to attempt it and treat a
 * revert as "not yet". Simulating first keeps failed attempts off-chain and free.
 */
async function sweepExpiredPolicies(): Promise<void> {
    const nextId = await publicClient.readContract({
        address: config.insurance,
        abi: insuranceAbi,
        functionName: "nextPolicyId",
    });

    for (let id = 1n; id < (nextId as bigint); id++) {
        try {
            const policy = (await publicClient.readContract({
                address: config.insurance,
                abi: insuranceAbi,
                functionName: "getPolicy",
                args: [id],
            })) as unknown as {
                status: number;
                legId: string;
                flightNumber: string;
            };

            if (policy.status !== PolicyStatus.Active) continue;

            // Dry-run: a revert here means the policy isn't settleable yet.
            await publicClient.simulateContract({
                address: config.insurance,
                abi: insuranceAbi,
                functionName: "expirePolicy",
                args: [id],
                account,
            });

            const hash = await walletClient.writeContract({
                address: config.insurance,
                abi: insuranceAbi,
                functionName: "expirePolicy",
                args: [id],
            });

            await publicClient.waitForTransactionReceipt({ hash });
            log(
                `policy ${id} (${policy.flightNumber} / ${policy.legId}) expired — ${explorerTx(hash)}`,
            );
        } catch {
            // Still active and unresolved, or already settled. Nothing to do.
        }
    }
}

async function assertAuthorised(): Promise<void> {
    const authorised = await publicClient.readContract({
        address: config.flightAgent,
        abi: flightAgentAbi,
        functionName: "hasRole",
        args: [AGENT_ROLE, account.address],
    });

    if (!authorised) {
        throw new Error(
            `${account.address} does not hold AGENT_ROLE on ${config.flightAgent}. ` +
                `Have the admin call addAgent(address) or registerAgent(address,uint256).`,
        );
    }
}

async function main(): Promise<void> {
    const once = process.argv.includes("--once");
    const sweepOnly = process.argv.includes("--sweep-only");

    log(`agent ${account.address} on ${arcTestnet.name} (${arcTestnet.id})`);
    log(
        `watching ${config.flights.join(", ") || "(nothing — set MONITORED_FLIGHTS)"}`,
    );

    await assertAuthorised();

    do {
        if (!sweepOnly) await pollFlights();
        await sweepExpiredPolicies();

        if (once || sweepOnly) break;

        await new Promise((resolve) =>
            setTimeout(resolve, config.pollIntervalMs),
        );
    } while (true);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
