/**
 * Settlement tracer — finds where an x402 payment actually landed on Base.
 *
 * Written because a fixture claimed a Base `txHash` that no Base RPC
 * recognises: both `eth_getTransactionByHash` and `eth_getTransactionReceipt`
 * return null for it, the payer's Base nonce is 1, and no USDC `Transfer` has
 * the payer as `from`. Yet the payer's balance demonstrably drops $0.01 per
 * call. Something settles; the recorded hash is not the thing that settles it.
 *
 * The payer holds 209 bytes of code, so it is a smart account and its spends
 * are submitted by a bundler or facilitator. That means:
 *   - tx.origin is NOT the payer, so sender-side tx scans find nothing;
 *   - the EOA nonce never increments, so nonce==1 proves nothing either;
 *   - but the USDC Transfer LOG still names the payer as `from`.
 *
 * So this scans the log, not the transaction. It reads NOTHING but public
 * chain state and spends no USDC.
 *
 * Usage
 *   npx tsx src/tracepay.ts                 # look back over the last ~6h
 *   npx tsx src/tracepay.ts --hours 60      # widen the window
 */

import "dotenv/config";
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { base } from "viem/chains";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const PAYER = (process.env.CIRCLE_WALLET_ADDRESS ??
    "0x6bce06e213373f9dff337e542a47377c79305775") as `0x${string}`;
const SELLER = "0xDd257723b86B4947483905cdAcBbBC70fACF2ec0" as const;

const TRANSFER = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// Public Base RPC caps eth_getLogs at 10k blocks per call, so walk in chunks.
const CHUNK = 9_000n;
const BLOCK_TIME_SECONDS = 2n;

async function main() {
    const hoursArg = process.argv.indexOf("--hours");
    const hours = hoursArg !== -1 ? BigInt(process.argv[hoursArg + 1]!) : 6n;

    const client = createPublicClient({ chain: base, transport: http() });
    const latest = await client.getBlockNumber();
    const span = (hours * 3600n) / BLOCK_TIME_SECONDS;
    const from = latest - span;

    console.log(`Base latest block ${latest}`);
    console.log(`Scanning last ${hours}h (~${span} blocks) from ${from}`);
    console.log(`payer  ${PAYER}`);
    console.log(`seller ${SELLER}\n`);

    const outgoing: Array<{ block: bigint; to: string; value: bigint; tx: string }> = [];
    const incoming: Array<{ block: bigint; from: string; value: bigint; tx: string }> = [];

    for (let start = from; start <= latest; start += CHUNK) {
        const end = start + CHUNK - 1n > latest ? latest : start + CHUNK - 1n;

        // Two filtered queries rather than one broad scan: USDC on Base is one
        // of the busiest contracts on any chain, and an unfiltered range would
        // return far more logs than the RPC will serve.
        const [out, inc] = await Promise.all([
            client.getLogs({ address: USDC, event: TRANSFER, args: { from: PAYER }, fromBlock: start, toBlock: end }),
            client.getLogs({ address: USDC, event: TRANSFER, args: { to: PAYER }, fromBlock: start, toBlock: end }),
        ]);

        for (const log of out) {
            outgoing.push({
                block: log.blockNumber!,
                to: log.args.to!,
                value: log.args.value!,
                tx: log.transactionHash!,
            });
        }
        for (const log of inc) {
            incoming.push({
                block: log.blockNumber!,
                from: log.args.from!,
                value: log.args.value!,
                tx: log.transactionHash!,
            });
        }
    }

    console.log(`OUTGOING USDC transfers (payer as from): ${outgoing.length}`);
    for (const t of outgoing) {
        const toSeller = t.to.toLowerCase() === SELLER.toLowerCase();
        console.log(
            `  block ${t.block}  ${formatUnits(t.value, 6).padStart(10)} USDC -> ${t.to}` +
                (toSeller ? "  <-- SELLER" : ""),
        );
        console.log(`    settled in tx ${t.tx}`);
    }

    console.log(`\nINCOMING USDC transfers (payer as to): ${incoming.length}`);
    for (const t of incoming) {
        console.log(`  block ${t.block}  ${formatUnits(t.value, 6).padStart(10)} USDC <- ${t.from}`);
        console.log(`    settled in tx ${t.tx}`);
    }

    // The decisive comparison: if an outgoing transfer exists, whoever
    // submitted it is the real settlement path, and its tx hash is the value
    // the fixture should have recorded.
    if (outgoing.length > 0) {
        const tx = await client.getTransaction({ hash: outgoing[0]!.tx as `0x${string}` });
        console.log(`\nSubmitter of the first outgoing transfer:`);
        console.log(`  tx.from = ${tx.from}`);
        console.log(`  tx.to   = ${tx.to}`);
        console.log(
            `  payer is ${tx.from.toLowerCase() === PAYER.toLowerCase() ? "THE SUBMITTER" : "NOT the submitter (bundler/facilitator path)"}`,
        );
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
