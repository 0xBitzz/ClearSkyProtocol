"use client";

import { useEffect } from "react";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { flightRegistryAbi, insuranceAbi } from "@/lib/abis";
import { CONTRACTS } from "@/lib/contracts";
import {
  errorMessage,
  formatAssetWithSymbol,
  formatDuration,
  formatTimestamp,
} from "@/lib/format";

import {
  describePolicy,
  PolicyStatus,
  type FlightInfo,
  type Policy,
} from "@/lib/policy";

// Status renders as a rotated passport-style stamp rather than a pill — it is
// the detail that makes each row read as a ticket stub instead of a table row.
const TONE_CLASSES: Record<string, string> = {
  neutral: "stamp-neutral",
  pending: "stamp-pending",
  good: "stamp-good",
  bad: "stamp-bad",
};

export function MyPoliciesCard() {
  const { address } = useAccount();

  // The contract enumerates a holder's policies itself, so no indexer is
  // needed to render this list.
  const { data: policyIds, refetch: refetchIds } = useReadContract({
    address: CONTRACTS.insurance,
    abi: insuranceAbi,
    functionName: "getPoliciesOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const ids = (policyIds as bigint[] | undefined) ?? [];

  const { data: policyResults, refetch: refetchPolicies } = useReadContracts({
    contracts: ids.map((id) => ({
      address: CONTRACTS.insurance,
      abi: insuranceAbi,
      functionName: "getPolicy" as const,
      args: [id] as const,
    })),
    query: { enabled: ids.length > 0 },
  });

  const policies = (policyResults ?? []).map(
    (r) => r.result as Policy | undefined,
  );

  // isClaimable is the contract's own dry run of claim(), so the button is
  // never shown for a call that would revert.
  const { data: claimableResults, refetch: refetchClaimable } = useReadContracts(
    {
      contracts: ids.map((id) => ({
        address: CONTRACTS.insurance,
        abi: insuranceAbi,
        functionName: "isClaimable" as const,
        args: [id] as const,
      })),
      query: { enabled: ids.length > 0 },
    },
  );

  // Looked up by legId, not flight number — the policy is bound to one specific
  // leg, and the flight number alone would match every date the airline flies it.
  //
  // getFlight reverts for unknown flights, so allowFailure keeps one bad entry
  // from blanking the whole list.
  const { data: flightResults } = useReadContracts({
    allowFailure: true,
    contracts: policies
      .filter((p): p is Policy => Boolean(p))
      .map((p) => ({
        address: CONTRACTS.flightRegistry,
        abi: flightRegistryAbi,
        functionName: "getFlight" as const,
        args: [p.legId] as const,
      })),
    query: { enabled: policies.some(Boolean) },
  });

  const { data: hash, writeContract, isPending, error } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  useEffect(() => {
    if (isSuccess) {
      refetchIds();
      refetchPolicies();
      refetchClaimable();
    }
  }, [isSuccess, refetchIds, refetchPolicies, refetchClaimable]);

  if (!address) return null;

  return (
    <section className="card p-6">
      <p className="label">
        {ids.length} {ids.length === 1 ? "policy" : "policies"}
      </p>

      {ids.length === 0 ? (
        <div className="py-12 text-center">
          <p className="font-medium text-ink">Nothing insured yet</p>
          <p className="mt-1.5 text-sm text-ink-muted">
            Buy cover on a flight and it&apos;ll show up here.
          </p>
        </div>
      ) : (
        <ul className="mt-4 space-y-3">
          {ids.map((id, index) => {
            const policy = policies[index];
            if (!policy) return null;

            const flight = flightResults?.[index]?.result as
              | FlightInfo
              | undefined;
            const claimable = Boolean(claimableResults?.[index]?.result);
            const view = describePolicy(policy, flight, claimable);

            return (
              <li key={id.toString()} className="ticket">
                {/* Upper stub: flight identity and the status stamp. */}
                <div className="flex items-start justify-between gap-3 p-5">
                  <div className="min-w-0">
                    <p className="label">Flight</p>
                    <p className="num mt-1 text-2xl font-semibold tracking-tight text-ink">
                      {policy.flightNumber}
                    </p>

                    {/* Dotted route line: scheduled on the left, the delay
                        threshold that triggers a payout on the right. */}
                    <div className="mt-3 flex items-center gap-3">
                      <span className="num shrink-0 text-xs text-ink-muted">
                        {formatTimestamp(policy.departureTime)}
                      </span>
                      <span className="route-line" aria-hidden />
                      <span
                        className="shrink-0 text-ink-muted"
                        aria-hidden
                      >
                        <svg
                          viewBox="0 0 24 24"
                          className="h-3.5 w-3.5"
                          fill="currentColor"
                        >
                          <path d="M2 11.5 21.2 3 12.7 22.2l-2.4-7.9-8.3-2.8Z" />
                        </svg>
                      </span>
                      <span className="num shrink-0 text-xs text-ink-muted">
                        {formatDuration(policy.delayThreshold)}+
                      </span>
                    </div>
                  </div>

                  <span className={`${TONE_CLASSES[view.tone]} mt-1 shrink-0`}>
                    {view.label}
                  </span>
                </div>

                {/* Perforation, with a notch punched through each edge. */}
                <div className="relative">
                  <span
                    className="ticket-notch -left-2 -top-2"
                    aria-hidden
                  />
                  <span
                    className="ticket-notch -right-2 -top-2"
                    aria-hidden
                  />
                  <div className="ticket-perf" />
                </div>

                {/* Lower stub: the money. */}
                <div className="p-5">
                  <dl className="grid grid-cols-2 gap-4">
                    <div>
                      <dt className="label">Premium paid</dt>
                      <dd className="num mt-1 text-sm text-ink">
                        {formatAssetWithSymbol(policy.premium)}
                      </dd>
                    </div>
                    <div className="text-right">
                      <dt className="label">Payout</dt>
                      <dd className="num mt-1 text-sm font-semibold text-ink">
                        {formatAssetWithSymbol(policy.coverageAmount)}
                      </dd>
                    </div>

                    {flight && flight.actualDeparture !== 0n && (
                      <div className="col-span-2 border-t border-line pt-3">
                        <dt className="label">Actually departed</dt>
                        <dd className="num mt-1 text-sm text-ink">
                          {formatTimestamp(flight.actualDeparture)}
                        </dd>
                      </div>
                    )}
                  </dl>

                  <p className="mt-4 text-sm text-ink-muted">{view.detail}</p>

                  {claimable && policy.status === PolicyStatus.Active && (
                    <button
                      onClick={() =>
                        writeContract({
                          address: CONTRACTS.insurance,
                          abi: insuranceAbi,
                          functionName: "claim",
                          args: [id],
                        })
                      }
                      disabled={isPending || isConfirming}
                      className="btn-signal mt-4 w-full"
                    >
                      {isPending
                        ? "Confirm in wallet…"
                        : isConfirming
                          ? "Claiming…"
                          : `Claim ${formatAssetWithSymbol(policy.coverageAmount)}`}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="mt-3 text-sm text-danger">{errorMessage(error)}</p>}
    </section>
  );
}
