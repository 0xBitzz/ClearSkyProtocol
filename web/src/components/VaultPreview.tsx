"use client";

import { useReadContracts } from "wagmi";
import { insuranceAbi, vaultAbi } from "@/lib/abis";
import { CONTRACTS } from "@/lib/contracts";
import { formatAsset } from "@/lib/format";
import { MetricTile } from "@/components/Metric";

/**
 * The card that floats over the hero image.
 *
 * Deliberately reads live vault state rather than being a static mock: the
 * landing page then doubles as proof the deployment is up, and there is no
 * second set of numbers to drift out of sync with the app.
 */
export function VaultPreview() {
  const { data } = useReadContracts({
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
      {
        address: CONTRACTS.insurance,
        abi: insuranceAbi,
        functionName: "payoutMultiplier",
      },
    ],
  });

  const totalAssets = (data?.[0]?.result as bigint | undefined) ?? 0n;
  const locked = (data?.[1]?.result as bigint | undefined) ?? 0n;
  const available = (data?.[2]?.result as bigint | undefined) ?? 0n;
  const premiums = (data?.[3]?.result as bigint | undefined) ?? 0n;
  const claims = (data?.[4]?.result as bigint | undefined) ?? 0n;
  const multiplier = data?.[5]?.result as bigint | undefined;

  const utilization = totalAssets > 0n ? Number(locked) / Number(totalAssets) : 0;

  return (
    <div className="card w-full max-w-3xl p-6 shadow-lift sm:p-8">
      <p className="label">Vault status</p>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 flex-col items-center justify-center rounded-xl bg-brand text-on-brand">
            <span className="font-mono text-[9px] uppercase tracking-widest">
              Pays
            </span>
            <span className="num text-lg font-semibold leading-none">
              {multiplier ? `${multiplier}x` : "—"}
            </span>
          </div>
          <div>
            <p className="font-semibold text-ink">Backed by underwriters</p>
            <span className="chip-active mt-1">
              <span className="h-1.5 w-1.5 rounded-full bg-positive" />
              Accepting cover
            </span>
          </div>
        </div>

        <div className="hidden text-right sm:block">
          <p className="label">Capacity used</p>
          <p className="num mt-1 text-sm text-ink">
            {(utilization * 100).toFixed(0)}%
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MetricTile
          title="Available to cover"
          description="Unlocked liquidity."
          ratio={totalAssets > 0n ? Number(available) / Number(totalAssets) : 0}
          readout={`${formatAsset(available)} / ${formatAsset(totalAssets)}`}
        />
        <MetricTile
          title="Reserved"
          description="Backing live policies."
          ratio={utilization}
          readout={`${formatAsset(locked)} / ${formatAsset(totalAssets)}`}
        />
        <MetricTile
          title="Premiums taken"
          description="Lifetime, all policies."
          readout={formatAsset(premiums)}
        />
        <MetricTile
          title="Claims paid"
          description="Lifetime, to travellers."
          readout={formatAsset(claims)}
        />
      </div>
    </div>
  );
}
