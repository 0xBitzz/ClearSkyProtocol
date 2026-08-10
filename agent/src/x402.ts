/**
 * x402 paid-fetch transport — Circle Agent Wallet.
 *
 * StableTravel's FlightAware endpoints are x402-priced: there is no API key to
 * hold, the USDC payment IS the auth. This module is the agent's only way to
 * reach a paid endpoint.
 *
 * Why shell out to the Circle CLI instead of signing in-process
 *
 * The CLI owns the Circle Agent Wallet's key material — it is never exported to
 * this process, so there is no private key in `agent/.env` for the paying wallet
 * and nothing for a leaked env file to give away. Signing x402 payments
 * in-process would mean holding a spending key in the same env as everything
 * else. The CLI also handles the parts of the protocol we would otherwise have
 * to reimplement and keep current: reading `accepts[]`, picking Gateway vs
 * vanilla, and the one-time smart-account deployment on first pay.
 *
 * The cost is a subprocess per call (~2s vanilla settlement on Base). At a
 * 30-second poll interval that is not the bottleneck.
 *
 * PAYMENT CHAIN vs SETTLEMENT CHAIN. The wallet paying for data lives on Base
 * mainnet and spends real USDC. That is a different wallet on a different chain
 * from the Arc key that writes flight status on-chain. Deliberate: the data
 * seller is a Base-native x402 service, and Arc is where the protocol settles.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Buffer for the largest StableTravel response we've seen (~43KB). */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type X402PayOptions = {
    /** Full resource URL, query string included. */
    url: string;
    /**
     * HTTP method the seller expects. Passed explicitly because the CLI
     * defaults to POST, and a method mismatch is rejected AFTER the payment
     * settles on-chain — burning USDC for zero data.
     */
    method?: string;
    /** Paying wallet. Defaults to CIRCLE_WALLET_ADDRESS. */
    address?: string;
    /** Circle chain name for the payment. Defaults to CIRCLE_PAY_CHAIN / BASE. */
    chain?: string;
    /**
     * Per-call spend ceiling in USDC. A price change on the seller's side
     * cannot silently drain the wallet: the CLI refuses to pay above this.
     */
    maxAmount?: string;
    timeoutMs?: number;
};

export type X402Receipt = {
    amount?: string;
    chain?: string;
    scheme?: string;
    seller?: string;
    receipt?: string;
};

export type X402Response<T> = {
    body: T;
    payment: X402Receipt | null;
};

export class X402Error extends Error {
    constructor(
        message: string,
        readonly code?: string,
        readonly hint?: string,
    ) {
        super(message);
        this.name = "X402Error";
    }
}

/**
 * Pays for a resource and returns its body.
 *
 * Every call spends USDC. Callers are responsible for not polling a paid
 * endpoint more often than the data actually changes.
 */
export async function payAndFetch<T>(
    options: X402PayOptions,
): Promise<X402Response<T>> {
    const address = options.address ?? process.env.CIRCLE_WALLET_ADDRESS;
    if (!address) {
        throw new X402Error(
            "Missing CIRCLE_WALLET_ADDRESS. Run `circle wallet list --chain BASE --type agent` " +
                "and set it in agent/.env.",
        );
    }

    const chain = options.chain ?? process.env.CIRCLE_PAY_CHAIN ?? "BASE";
    const maxAmount =
        options.maxAmount ?? process.env.X402_MAX_AMOUNT_USDC ?? "0.02";
    const method = (options.method ?? "GET").toUpperCase();

    // execFile, not exec: arguments are passed as an array so a flight ident or
    // URL can never be interpreted as shell syntax.
    const args = [
        "services",
        "pay",
        options.url,
        "-X",
        method,
        "--address",
        address,
        "--chain",
        chain,
        "--max-amount",
        maxAmount,
        "--output",
        "json",
    ];

    let stdout: string;
    try {
        const result = await execFileAsync("circle", args, {
            maxBuffer: MAX_OUTPUT_BYTES,
            timeout: options.timeoutMs ?? 120_000,
        });
        stdout = result.stdout;
    } catch (error) {
        // The CLI exits non-zero on payment failure but still prints a JSON
        // error body, which carries the actionable detail.
        const err = error as { stdout?: string; stderr?: string; message: string };
        const parsed = err.stdout ? tryParse(err.stdout) : null;
        const cliError = parsed?.error;
        if (cliError) {
            throw new X402Error(cliError.message, cliError.code, cliError.hint);
        }
        throw new X402Error(
            `circle services pay failed: ${err.stderr?.trim() || err.message}`,
        );
    }

    const parsed = tryParse(stdout);
    if (!parsed) {
        throw new X402Error(
            `Could not parse circle CLI output for ${options.url}`,
        );
    }
    if (parsed.error) {
        throw new X402Error(
            parsed.error.message,
            parsed.error.code,
            parsed.error.hint,
        );
    }

    const data: Record<string, unknown> = parsed.data ?? parsed;
    if (data.response === undefined) {
        throw new X402Error(
            `Payment for ${options.url} returned no response body — USDC may have been spent for nothing.`,
        );
    }

    return {
        body: data.response as T,
        payment: (data.payment as X402Receipt) ?? null,
    };
}

/**
 * Parses CLI stdout, tolerating Node deprecation warnings printed before the
 * JSON. Extracting from the first `{` is more robust than filtering known
 * warning strings, which would break on the next warning Node adds.
 */
type CliEnvelope = {
    data?: Record<string, unknown>;
    error?: { message: string; code?: string; hint?: string };
    [key: string]: unknown;
};

function tryParse(raw: string): CliEnvelope | null {
    const start = raw.indexOf("{");
    if (start === -1) return null;
    try {
        return JSON.parse(raw.slice(start));
    } catch {
        return null;
    }
}
