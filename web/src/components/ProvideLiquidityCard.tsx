"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, vaultAbi } from "@/lib/abis";
import { ASSET_SYMBOL, CONTRACTS } from "@/lib/contracts";
import {
  errorMessage,
  formatAsset,
  formatAssetWithSymbol,
  parseAsset,
} from "@/lib/format";
import { MetricTile, ProgressBar, StatRow } from "@/components/Metric";

/**
 * Underwriter (liquidity provider) dashboard.
 *
 * Underwriters are the counterparty to every policy: their capital is what
 * `lockCollateral` reserves against, they keep the premiums on flights that
 * land on time, and they absorb the loss when a claim pays out. The vault is an
 * ERC-4626, so that P&L shows up as share price drift rather than as a separate
 * rewards balance.
 */

// keccak256("UNDERWRITER_ROLE"), matching Vault.UNDERWRITER_ROLE. Read from the
// contract rather than hardcoded so a rename can't silently desync.
export function ProvideLiquidityCard() {
  const { address } = useAccount();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amountInput, setAmountInput] = useState("");

  const amount = parseAsset(amountInput);

  const { data: underwriterRole } = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: "UNDERWRITER_ROLE",
  });

  const { data: vault, refetch: refetchVault } = useReadContracts({
    contracts: [
      { address: CONTRACTS.vault, abi: vaultAbi, functionName: "totalAssets" },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "lockedCollateral",
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "availableLiquidity",
      },
      { address: CONTRACTS.vault, abi: vaultAbi, functionName: "sharePrice" },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "totalPremiumsCollected",
      },
      {
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "totalClaimsPaid",
      },
    ],
  });

  const totalAssets = (vault?.[0]?.result as bigint | undefined) ?? 0n;
  const locked = (vault?.[1]?.result as bigint | undefined) ?? 0n;
  const available = (vault?.[2]?.result as bigint | undefined) ?? 0n;
  const sharePrice = vault?.[3]?.result as bigint | undefined;
  const premiums = (vault?.[4]?.result as bigint | undefined) ?? 0n;
  const claims = (vault?.[5]?.result as bigint | undefined) ?? 0n;

  const { data: position, refetch: refetchPosition } = useReadContracts({
    contracts: address
      ? [
          {
            address: CONTRACTS.vault,
            abi: vaultAbi,
            functionName: "balanceOf" as const,
            args: [address] as const,
          },
          {
            address: CONTRACTS.vault,
            abi: vaultAbi,
            functionName: "maxWithdraw" as const,
            args: [address] as const,
          },
          {
            address: CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address] as const,
          },
          {
            address: CONTRACTS.usdc,
            abi: erc20Abi,
            functionName: "allowance" as const,
            args: [address, CONTRACTS.vault] as const,
          },
        ]
      : [],
    query: { enabled: Boolean(address) },
  });

  const shares = (position?.[0]?.result as bigint | undefined) ?? 0n;
  const withdrawable = (position?.[1]?.result as bigint | undefined) ?? 0n;
  const walletBalance = (position?.[2]?.result as bigint | undefined) ?? 0n;
  const allowance = (position?.[3]?.result as bigint | undefined) ?? 0n;

  // Share value in asset terms. maxWithdraw is separately clamped to unlocked
  // liquidity, so these two intentionally disagree while policies are live.
  const { data: positionValue } = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: "convertToAssets",
    args: [shares],
    query: { enabled: shares > 0n },
  });

  const { data: hasRole } = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: "hasRole",
    args: address && underwriterRole ? [underwriterRole, address] : undefined,
    query: { enabled: Boolean(address && underwriterRole) },
  });

  const needsApproval =
    mode === "deposit" && amount !== undefined && allowance < amount;

  const {
    data: approveHash,
    writeContract: writeApprove,
    isPending: approvePending,
    error: approveError,
  } = useWriteContract();

  const { isLoading: approveConfirming, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash });

  const {
    data: actionHash,
    writeContract: writeAction,
    isPending: actionPending,
    error: actionError,
  } = useWriteContract();

  const { isLoading: actionConfirming, isSuccess: actionConfirmed } =
    useWaitForTransactionReceipt({ hash: actionHash });

  useEffect(() => {
    if (approveConfirmed) refetchPosition();
  }, [approveConfirmed, refetchPosition]);

  useEffect(() => {
    if (actionConfirmed) {
      setAmountInput("");
      refetchVault();
      refetchPosition();
    }
  }, [actionConfirmed, refetchVault, refetchPosition]);

  const utilization =
    totalAssets > 0n ? Number(locked) / Number(totalAssets) : 0;

  const validationError = useMemo(() => {
    if (amount === undefined) return null;
    if (amount === 0n) return "Enter an amount above zero.";

    if (mode === "deposit") {
      if (hasRole === false) return null; // handled by the role notice below
      if (amount > walletBalance) {
        return `You only have ${formatAssetWithSymbol(walletBalance)}.`;
      }
      return null;
    }

    if (amount > withdrawable) {
      return `Only ${formatAssetWithSymbol(withdrawable)} can be withdrawn right now.`;
    }
    return null;
  }, [amount, mode, hasRole, walletBalance, withdrawable]);

  const busy =
    approvePending || approveConfirming || actionPending || actionConfirming;

  const canSubmit =
    Boolean(address) &&
    amount !== undefined &&
    amount > 0n &&
    !validationError &&
    !busy &&
    (mode === "withdraw" || hasRole !== false);

  const maxForMode = mode === "deposit" ? walletBalance : withdrawable;

  return (
    <div className="space-y-6">
      {/* Vault health ------------------------------------------------- */}
      <section className="card p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="label">Vault utilization</p>
            <p className="num mt-2 text-4xl font-semibold tracking-tight text-ink">
              {(utilization * 100).toFixed(1)}
              <span className="text-2xl text-ink-muted">%</span>
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              {formatAsset(locked)} of {formatAssetWithSymbol(totalAssets)}{" "}
              reserved against live policies.
            </p>
          </div>
          <span className={utilization > 0.9 ? "chip-bad" : "chip-active"}>
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                utilization > 0.9 ? "bg-danger" : "bg-positive"
              }`}
            />
            {utilization > 0.9 ? "Near capacity" : "Healthy"}
          </span>
        </div>

        <div className="mt-5">
          <ProgressBar ratio={utilization} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <MetricTile
            title="Premiums earned"
            description="Lifetime, kept by underwriters."
            readout={formatAsset(premiums)}
          />
          <MetricTile
            title="Claims paid"
            description="Lifetime, borne by underwriters."
            readout={formatAsset(claims)}
          />
        </div>
      </section>

      {/* Your position ------------------------------------------------ */}
      <section className="card p-6">
        <p className="label">Your position</p>

        <div className="mt-3">
          <StatRow label="Shares held">
            {formatAsset(shares)} csUW
          </StatRow>
          <StatRow label="Position value">
            {formatAssetWithSymbol(positionValue as bigint | undefined)}
          </StatRow>
          <StatRow label="Withdrawable now">
            {formatAssetWithSymbol(withdrawable)}
          </StatRow>
          <StatRow label="Share price">
            {sharePrice ? `${formatAsset(sharePrice, 4)} ${ASSET_SYMBOL}` : "—"}
          </StatRow>
        </div>

        {/* Explains the gap between position value and withdrawable, which
            otherwise looks like a bug rather than the collateral guard. */}
        {shares > 0n &&
          positionValue !== undefined &&
          withdrawable < (positionValue as bigint) && (
            <p className="mt-4 rounded-xl border border-line bg-sunken px-4 py-3 text-sm text-ink-muted">
              Part of your position is backing live policies and can&apos;t be
              withdrawn until those flights resolve. It unlocks as policies
              expire or pay out.
            </p>
          )}
      </section>

      {/* Deposit / withdraw ------------------------------------------- */}
      <section className="card p-6">
        <div className="mb-5 inline-flex rounded-xl bg-sunken p-1">
          {(["deposit", "withdraw"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setAmountInput("");
              }}
              className={`rounded-lg px-4 py-2 text-sm font-medium capitalize transition-colors ${
                mode === m
                  ? "bg-raised text-ink shadow-card"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === "deposit" && hasRole === false ? (
          <div className="rounded-xl border border-line bg-sunken px-4 py-4">
            <p className="font-medium text-ink">
              This address isn&apos;t an approved underwriter
            </p>
            <p className="mt-1.5 text-sm text-ink-muted">
              Deposits are permissioned in this release. An admin has to grant
              your address <span className="num">UNDERWRITER_ROLE</span> on the
              vault before you can supply liquidity. Withdrawals are never
              gated, so any shares you already hold stay redeemable.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <label
                htmlFor="lp-amount"
                className="text-sm font-medium text-ink"
              >
                Amount ({ASSET_SYMBOL})
              </label>
              <button
                onClick={() => setAmountInput(formatAsset(maxForMode))}
                className="text-sm text-accent transition-opacity hover:opacity-70"
              >
                Max {formatAsset(maxForMode)}
              </button>
            </div>

            <input
              id="lp-amount"
              value={amountInput}
              onChange={(e) => setAmountInput(e.target.value)}
              inputMode="decimal"
              placeholder="1000.00"
              className="field mt-2"
            />

            {validationError && (
              <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">
                {validationError}
              </p>
            )}

            {needsApproval ? (
              <button
                onClick={() =>
                  amount &&
                  writeApprove({
                    address: CONTRACTS.usdc,
                    abi: erc20Abi,
                    functionName: "approve",
                    args: [CONTRACTS.vault, amount],
                  })
                }
                disabled={!canSubmit}
                className="btn-primary mt-5 w-full"
              >
                {approvePending
                  ? "Confirm in wallet…"
                  : approveConfirming
                    ? "Approving…"
                    : `Approve ${ASSET_SYMBOL}`}
              </button>
            ) : (
              <button
                onClick={() => {
                  if (!amount || !address) return;
                  // withdraw(assets) rather than redeem(shares): the input is
                  // denominated in USDC, and maxWithdraw is what we validated.
                  writeAction(
                    mode === "deposit"
                      ? {
                          address: CONTRACTS.vault,
                          abi: vaultAbi,
                          functionName: "deposit",
                          args: [amount, address],
                        }
                      : {
                          address: CONTRACTS.vault,
                          abi: vaultAbi,
                          functionName: "withdraw",
                          args: [amount, address, address],
                        },
                  );
                }}
                disabled={!canSubmit}
                className="btn-primary mt-5 w-full"
              >
                {actionPending
                  ? "Confirm in wallet…"
                  : actionConfirming
                    ? mode === "deposit"
                      ? "Depositing…"
                      : "Withdrawing…"
                    : mode === "deposit"
                      ? "Supply liquidity"
                      : "Withdraw"}
              </button>
            )}

            {actionConfirmed && (
              <p className="mt-3 rounded-xl bg-positive-soft px-3 py-2 text-sm text-positive">
                {mode === "deposit"
                  ? "Liquidity supplied. Your shares are earning premiums."
                  : "Withdrawal complete."}
              </p>
            )}

            {(approveError || actionError) && (
              <p className="mt-3 text-sm text-danger">
                {errorMessage(approveError ?? actionError)}
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
