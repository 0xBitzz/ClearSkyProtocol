/**
 * Mint the agent's ERC-8004 identity on Arc and report the id to bind.
 *
 * Why this exists
 *
 *   `FlightAgent.registerAgent(operator, agentId)` refuses to grant AGENT_ROLE
 *   unless `IdentityRegistry.ownerOf(agentId)` is the operator. So the identity
 *   has to exist, and it has to be minted BY the monitoring key — not by the
 *   admin on the agent's behalf — or the ownership check fails.
 *
 * Two properties worth noting
 *
 * - IDEMPOTENT. `register` is callable repeatedly and would happily mint a
 *   second identity for the same wallet, quietly splitting the agent's history
 *   across two ids. So this checks `balanceOf` first and refuses to mint again
 *   unless asked with --force.
 *
 * - THE ID IS NOT RETURNED. `register(string)` returns nothing, so the token id
 *   is recovered from the ERC-721 `Transfer` log in the mint receipt. Reading it
 *   from the receipt rather than scanning history means we get the id from the
 *   transaction we just sent, with no block-range window to get wrong.
 *
 * Usage
 *   npm run register-identity
 *   npm run register-identity -- --force        # mint even if one is owned
 *   METADATA_URI=ipfs://... npm run register-identity
 */

import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbiItem,
    parseEventLogs,
} from "viem";
import { account, arcTestnet, config, explorerTx } from "./config.js";
import { flightAgentAbi, identityRegistryAbi } from "./abis.js";

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(),
});

const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: http(),
});

const log = (...parts: unknown[]) => console.log(...parts);

/** Identities already held by this wallet, newest last. */
async function findOwnedIdentities(): Promise<bigint[]> {
    // eth_getLogs is capped near 10k blocks on Arc's public RPC.
    const latest = await publicClient.getBlockNumber();
    const range = 10_000n;
    const fromBlock = latest > range ? latest - range : 0n;

    const logs = await publicClient.getLogs({
        address: config.identityRegistry,
        event: parseAbiItem(
            "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
        ),
        args: { to: account.address },
        fromBlock,
        toBlock: latest,
    });

    // Confirm current ownership: a Transfer to us in the window does not mean we
    // still hold the token.
    const owned: bigint[] = [];
    for (const entry of logs) {
        const tokenId = entry.args.tokenId;
        if (tokenId === undefined) continue;
        try {
            const owner = await publicClient.readContract({
                address: config.identityRegistry,
                abi: identityRegistryAbi,
                functionName: "ownerOf",
                args: [tokenId],
            });
            if (owner.toLowerCase() === account.address.toLowerCase()) {
                owned.push(tokenId);
            }
        } catch {
            // Burned or otherwise gone.
        }
    }
    return owned;
}

async function mintIdentity(metadataURI: string): Promise<bigint> {
    log(`  minting with metadataURI ${metadataURI}`);

    const hash = await walletClient.writeContract({
        address: config.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "register",
        args: [metadataURI],
    });

    log(`  submitted ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== "success") {
        throw new Error(`registration reverted — ${explorerTx(hash)}`);
    }
    log(`  ${receipt.status} — ${explorerTx(hash)}`);

    // Pull the id straight out of the mint we just made.
    const events = parseEventLogs({
        abi: identityRegistryAbi,
        eventName: "Transfer",
        logs: receipt.logs,
    });

    const minted = events.find(
        (e) => e.args.to.toLowerCase() === account.address.toLowerCase(),
    );

    if (!minted) {
        throw new Error(
            `no Transfer to ${account.address} in the receipt — cannot determine agentId`,
        );
    }

    return minted.args.tokenId;
}

async function main(): Promise<void> {
    const force = process.argv.includes("--force");
    const metadataURI =
        process.env.METADATA_URI ??
        "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

    log(`agent   ${account.address}`);
    log(`chain   ${arcTestnet.name} (${arcTestnet.id})`);
    log(`registry ${config.identityRegistry}`);

    const balance = await publicClient.getBalance({ address: account.address });
    log(`balance ${balance} wei native USDC`);
    if (balance === 0n) {
        throw new Error(
            "agent wallet holds no native USDC — it cannot pay gas on Arc. Fund it first.",
        );
    }

    let agentId: bigint;
    const owned = await findOwnedIdentities();

    if (owned.length > 0 && !force) {
        agentId = owned[owned.length - 1]!;
        log(`\nalready owns identity ${agentId} — not minting again`);
        log(`  pass --force to mint an additional one (usually not what you want)`);
    } else {
        log("");
        agentId = await mintIdentity(metadataURI);
        log(`\nminted identity ${agentId}`);
    }

    const owner = await publicClient.readContract({
        address: config.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
    });
    const tokenURI = await publicClient.readContract({
        address: config.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
    });

    log(`  owner    ${owner}`);
    log(`  metadata ${tokenURI}`);

    // Is it already bound on FlightAgent?
    const bound = await publicClient.readContract({
        address: config.flightAgent,
        abi: flightAgentAbi,
        functionName: "agentIds",
        args: [account.address],
    });

    log("");
    if (bound === agentId) {
        log(`already bound on FlightAgent — nothing left to do`);
        return;
    }

    if (bound !== 0n) {
        log(`WARNING: FlightAgent has this operator bound to ${bound}, not ${agentId}`);
    }

    // registerAgent is admin-only, and the admin key is not this process's key.
    log(`next step — have the admin bind it:\n`);
    log(
        `  cast send ${config.flightAgent} \\\n` +
            `    "registerAgent(address,uint256)" ${account.address} ${agentId} \\\n` +
            `    --private-key $PRIVATE_KEY --rpc-url ${arcTestnet.rpcUrls.default.http[0]}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
