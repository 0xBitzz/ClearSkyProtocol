"use client";

import { useEffect } from "react";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { parseUnits } from "viem";
import { erc20Abi } from "@/lib/abis";
import { ASSET_DECIMALS, ASSET_SYMBOL, CONTRACTS } from "@/lib/contracts";
import { errorMessage, formatAssetWithSymbol } from "@/lib/format";
import { StatRow } from "@/components/Metric";

const FAUCET_AMOUNT = parseUnits("1000", ASSET_DECIMALS);

/**
 * Testnet convenience: MockUSDC has an unrestricted `mint`, so anyone can top
 * themselves up. Only rendered when NEXT_PUBLIC_ASSET_IS_MINTABLE is set, so
 * pointing the app at real USDC hides it automatically.
 */
export function FaucetCard() {
  const { address } = useAccount();

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  // Balance only changes once the mint is mined, not when it's submitted.
  useEffect(() => {
    if (isSuccess) refetchBalance();
  }, [isSuccess, refetchBalance]);

  const busy = isPending || isConfirming;

  return (
    <section className="card p-6">
      <p className="label">Faucet</p>
      <p className="mt-3 text-sm text-ink-muted">
        Mint mock {ASSET_SYMBOL} to try the app. Test tokens only — no value.
      </p>

      <div className="mt-4">
        <StatRow label="Your balance">
          {formatAssetWithSymbol(balance as bigint | undefined)}
        </StatRow>
      </div>

      <button
        onClick={() =>
          address &&
          writeContract({
            address: CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "mint",
            args: [address, FAUCET_AMOUNT],
          })
        }
        disabled={busy || !address}
        className="btn-primary mt-5 w-full"
      >
        {isPending
          ? "Confirm in wallet…"
          : isConfirming
            ? "Minting…"
            : `Mint 1,000 ${ASSET_SYMBOL}`}
      </button>

      {isSuccess && (
        <p className="mt-3 rounded-xl bg-positive-soft px-3 py-2 text-sm text-positive">
          Minted. You&apos;re ready to buy cover or supply liquidity.
        </p>
      )}

      {error && (
        <p className="mt-3 text-sm text-danger">{errorMessage(error)}</p>
      )}
    </section>
  );
}

