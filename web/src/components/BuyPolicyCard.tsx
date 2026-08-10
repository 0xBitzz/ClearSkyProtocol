"use client";

import { useEffect, useMemo, useState } from "react";
import { maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { erc20Abi, flightRegistryAbi, insuranceAbi, vaultAbi } from "@/lib/abis";
import {
  ASSET_SYMBOL,
  CONTRACTS,
  DELAY_THRESHOLD_OPTIONS,
  PURCHASE_CUTOFF_SECONDS,
  explorerTx,
} from "@/lib/contracts";
import {
  errorMessage,
  formatAssetWithSymbol,
  formatRelative,
  formatTimestamp,
  parseAsset,
} from "@/lib/format";
import type { FlightInfo } from "@/lib/policy";
import { arcTestnet } from "@/lib/wagmi";

/** Debounce on the flight-number field so we don't hit the provider per keypress. */
const LOOKUP_DEBOUNCE_MS = 400;

export function BuyPolicyCard() {
  const { address, chainId } = useAccount();
  const { switchChain, isPending: switchPending } = useSwitchChain();

  // Reads silently return undefined on the wrong chain and writes go nowhere,
  // so without this check the form just sits inert with no explanation.
  const wrongChain = Boolean(address) && chainId !== arcTestnet.id;


  const [flightNumber, setFlightNumber] = useState("");
  const [premiumInput, setPremiumInput] = useState("");
  const [thresholdSeconds, setThresholdSeconds] = useState<number>(
    DELAY_THRESHOLD_OPTIONS[1].seconds,
  );

  const premium = parseAsset(premiumInput);
  const trimmedFlight = flightNumber.trim().toUpperCase();

  // --- Leg resolution ------------------------------------------------------
  // The traveller types a flight number, but cover is keyed by LEG
  // (`fa_flight_id`), because an airline reuses "BA208" every day. The provider
  // is the only thing that can say which leg today's BA208 is, so resolve it
  // here and treat the resolved legId as the identity of what's being insured.
  const [legId, setLegId] = useState<string | null>(null);
  const [legLoading, setLegLoading] = useState(false);
  const [legUnknown, setLegUnknown] = useState(false);

  useEffect(() => {
    if (!trimmedFlight) {
      setLegId(null);
      setLegUnknown(false);
      setLegLoading(false);
      return;
    }

    // A stale response must never overwrite a newer one — otherwise a fast
    // typist can end up buying cover for the leg they typed two edits ago.
    let active = true;
    const controller = new AbortController();

    setLegLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/flightaware/flights/${encodeURIComponent(trimmedFlight)}`,
          { signal: controller.signal, cache: "no-store" },
        );

        if (!active) return;

        if (!response.ok) {
          setLegId(null);
          setLegUnknown(true);
          return;
        }

        const body = (await response.json()) as {
          flights?: { fa_flight_id?: string }[];
        };
        const resolved = body.flights?.[0]?.fa_flight_id ?? null;

        if (!active) return;
        setLegId(resolved);
        setLegUnknown(!resolved);
      } catch {
        if (active) {
          setLegId(null);
          setLegUnknown(true);
        }
      } finally {
        if (active) setLegLoading(false);
      }
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmedFlight]);

  // --- Flight lookup -------------------------------------------------------
  // getFlight reverts with FlightNotFound rather than returning an empty
  // struct, so an error here is the "unknown flight" signal, not a failure.
  const {
    data: flight,
    isLoading: flightFetching,
    isError: flightUnregistered,
  } = useReadContract({
    address: CONTRACTS.flightRegistry,
    abi: flightRegistryAbi,
    functionName: "getFlight",
    args: legId ? [legId] : undefined,
    query: { enabled: Boolean(legId), retry: false },
  });

  const flightInfo = flight as FlightInfo | undefined;
  const flightLoading = legLoading || flightFetching;
  // Either the provider doesn't know the number, or the leg it resolved to has
  // never been registered on-chain. Both are "you can't insure this" to a user.
  const flightUnknown = legUnknown || flightUnregistered;

  // --- Protocol parameters -------------------------------------------------
  const { data: params } = useReadContracts({
    contracts: [
      {
        address: CONTRACTS.insurance,
        abi: insuranceAbi,
        functionName: "minPremium",
      },
      {
        address: CONTRACTS.insurance,
        abi: insuranceAbi,
        functionName: "maxPremium",
      },
      {
        address: CONTRACTS.insurance,
        abi: insuranceAbi,
        functionName: "payoutMultiplier",
      },
    ],
  });

  const minPremium = params?.[0]?.result as bigint | undefined;
  const maxPremium = params?.[1]?.result as bigint | undefined;
  const multiplier = params?.[2]?.result as bigint | undefined;

  const coverage = useMemo(
    () => (premium && multiplier ? premium * multiplier : undefined),
    [premium, multiplier],
  );

  // --- Solvency + allowance ------------------------------------------------
  // canUnderwrite tells us up front whether the vault can back this payout.
  // Without it the sale reverts inside lockCollateral after the user has
  // already paid gas and signed twice.
  const { data: canUnderwrite } = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: "canUnderwrite",
    args: coverage ? [coverage] : undefined,
    query: { enabled: Boolean(coverage) },
  });

  // Approval goes to the VAULT, not Insurance — the vault does the
  // transferFrom in depositPremium.
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, CONTRACTS.vault] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: balance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const needsApproval =
    premium !== undefined &&
    allowance !== undefined &&
    (allowance as bigint) < premium;

  // --- Writes --------------------------------------------------------------
  const {
    data: approveHash,
    writeContract: writeApprove,
    isPending: approvePending,
    error: approveError,
    reset: resetApprove,
  } = useWriteContract();

  const {
    isLoading: approveConfirming,
    isSuccess: approveConfirmed,
    error: approveReceiptError,
  } = useWaitForTransactionReceipt({ hash: approveHash });

  useEffect(() => {
    if (approveConfirmed) refetchAllowance();
  }, [approveConfirmed, refetchAllowance]);


  const {
    data: buyHash,
    writeContract: writeBuy,
    isPending: buyPending,
    error: buyError,
    reset: resetBuy,
  } = useWriteContract();

  const {
    isLoading: buyConfirming,
    isSuccess: buyConfirmed,
    error: buyReceiptError,
  } = useWaitForTransactionReceipt({ hash: buyHash });

  useEffect(() => {
    if (buyConfirmed) {
      setFlightNumber("");
      setPremiumInput("");
      setLegId(null);
    }
  }, [buyConfirmed]);

  /** Clears a stuck write so the form is usable again without a page reload. */
  function startOver() {
    resetApprove();
    resetBuy();
  }


  // --- Validation ----------------------------------------------------------
  // Mirrors the contract's checks purely so the user sees the problem before
  // spending gas. The contract remains the source of truth.
  const validationError = useMemo(() => {
    if (!trimmedFlight) return null;
    if (flightUnknown) return "That flight isn't registered yet.";
    if (!flightInfo) return null;

    const departsAt = Number(flightInfo.scheduledDeparture);
    const now = Math.floor(Date.now() / 1000);
    if (now + PURCHASE_CUTOFF_SECONDS > departsAt) {
      return "Too close to departure — cover must be bought at least 1 hour ahead.";
    }

    if (premium === undefined) return null;
    if (minPremium !== undefined && premium < minPremium) {
      return `Minimum premium is ${formatAssetWithSymbol(minPremium)}.`;
    }
    if (maxPremium !== undefined && premium > maxPremium) {
      return `Maximum premium is ${formatAssetWithSymbol(maxPremium)}.`;
    }
    if (balance !== undefined && premium > (balance as bigint)) {
      return `Not enough ${ASSET_SYMBOL}. You have ${formatAssetWithSymbol(balance as bigint)}.`;
    }
    if (canUnderwrite === false) {
      return "The vault can't back this payout right now. Try a smaller premium.";
    }
    return null;
  }, [
    trimmedFlight,
    flightUnknown,
    flightInfo,
    premium,
    minPremium,
    maxPremium,
    balance,
    canUnderwrite,
  ]);

  const readyToWrite =
    Boolean(address) &&
    Boolean(legId) &&
    premium !== undefined &&
    premium > 0n &&
    !validationError &&
    Boolean(flightInfo);

  const ready = readyToWrite && !wrongChain;

  const busy = approvePending || approveConfirming || buyPending || buyConfirming;

  // A write that produced a hash but never resolved leaves `busy` latched. Give
  // the user a way out rather than a permanently greyed button.
  const stuck = busy && Boolean(approveHash || buyHash);

  const pendingHash = approveConfirming
    ? approveHash
    : buyConfirming
      ? buyHash
      : undefined;

  const failure =
    approveError ?? buyError ?? approveReceiptError ?? buyReceiptError;

  return (
    <section className="card p-6">
      <p className="label">Policy details</p>

      <div className="mt-5 space-y-5">
        {wrongChain && (
          <div className="rounded-xl bg-warning-soft px-4 py-3.5">
            <p className="text-sm text-warning">
              Your wallet is on the wrong network. Contract reads return nothing
              and transactions won&apos;t land until you switch.
            </p>
            <button
              type="button"
              onClick={() => switchChain({ chainId: arcTestnet.id })}
              disabled={switchPending}
              className="btn-primary mt-3 w-full"
            >
              {switchPending ? "Switching…" : `Switch to ${arcTestnet.name}`}
            </button>
          </div>
        )}

        <div>
          <label
            htmlFor="flight-number"
            className="mb-1.5 block text-sm font-medium text-ink"
          >
            Flight number
          </label>
          <input
            id="flight-number"
            value={flightNumber}
            onChange={(e) => {
              setFlightNumber(e.target.value);
              resetBuy();
            }}
            placeholder="BA2490"
            className="field num uppercase placeholder:normal-case"
          />
          {flightLoading && trimmedFlight && (
            <p className="mt-1.5 text-sm text-ink-muted">Looking up flight…</p>
          )}
          {flightInfo && (
            <p className="mt-1.5 text-sm text-ink-muted">
              Departs {formatTimestamp(flightInfo.scheduledDeparture)} (
              {formatRelative(flightInfo.scheduledDeparture)})
            </p>
          )}
          {legId && (
            <p className="num mt-1 text-xs text-ink-muted">Leg {legId}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="premium"
            className="mb-1.5 block text-sm font-medium text-ink"
          >
            Premium ({ASSET_SYMBOL})
          </label>
          <input
            id="premium"
            value={premiumInput}
            onChange={(e) => {
              setPremiumInput(e.target.value);
              resetBuy();
            }}
            inputMode="decimal"
            placeholder="10.00"
            className="field num"
          />
          {minPremium !== undefined && maxPremium !== undefined && (
            <p className="mt-1.5 text-sm text-ink-muted">
              Between {formatAssetWithSymbol(minPremium)} and{" "}
              {formatAssetWithSymbol(maxPremium)}
            </p>
          )}
        </div>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink">
            Pay out if delayed by
          </span>
          <div className="grid grid-cols-5 gap-2">
            {DELAY_THRESHOLD_OPTIONS.map((option) => {
              const selected = thresholdSeconds === option.seconds;
              return (
                <button
                  key={option.seconds}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setThresholdSeconds(option.seconds)}
                  className={`num rounded-xl border px-2 py-2.5 text-sm font-medium transition-colors ${
                    selected
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-line text-ink-muted hover:border-ink-muted hover:text-ink"
                  }`}
                >
                  {option.label.replace(" hours", "h").replace(" hour", "h")}
                </button>
              );
            })}
          </div>
        </div>

        {coverage !== undefined && (
          <div className="flex items-center justify-between rounded-xl bg-signal-soft px-4 py-3.5">
            <div>
              <p className="label text-signal">Payout if delayed</p>
              <p className="num mt-1 text-xl font-semibold text-signal">
                {formatAssetWithSymbol(coverage)}
              </p>
            </div>
            {multiplier !== undefined && (
              <span className="num rounded-lg bg-signal px-2.5 py-1 text-xs font-medium text-white">
                {multiplier.toString()}x premium
              </span>
            )}
          </div>
        )}

        {validationError && (
          <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">
            {validationError}
          </p>
        )}

        {needsApproval ? (
          <button
            onClick={() =>
              writeApprove({
                address: CONTRACTS.usdc,
                abi: erc20Abi,
                functionName: "approve",
                // Approve unbounded rather than exactly `premium`. The exact
                // amount is captured at click time, so editing the premium
                // between approving and buying left an allowance too small for
                // the buy — which then reverted with no obvious cause.
                args: [CONTRACTS.vault, maxUint256],
              })
            }
            disabled={!ready || busy}
            className="btn-primary w-full"
          >
            {approvePending
              ? "Confirm in wallet…"
              : approveConfirming
                ? "Approving…"
                : `Approve ${ASSET_SYMBOL}`}
          </button>
        ) : (
          <button
            onClick={() =>
              premium &&
              legId &&
              writeBuy({
                address: CONTRACTS.insurance,
                abi: insuranceAbi,
                functionName: "buyPolicy",
                args: [legId, premium, BigInt(thresholdSeconds)],
              })
            }
            disabled={!ready || busy}
            className="btn-primary w-full"
          >
            {buyPending
              ? "Confirm in wallet…"
              : buyConfirming
                ? "Buying cover…"
                : "Buy cover"}
          </button>
        )}

        {pendingHash && (
          <p className="text-sm text-ink-muted">
            Waiting for confirmation —{" "}
            <a
              href={explorerTx(pendingHash)}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-ink"
            >
              view on explorer
            </a>
          </p>
        )}

        {stuck && (
          <button
            type="button"
            onClick={startOver}
            className="w-full text-sm text-ink-muted underline hover:text-ink"
          >
            Taking too long? Start over
          </button>
        )}

        {buyConfirmed && (
          <p className="rounded-xl bg-positive-soft px-3 py-2 text-sm text-positive">
            Cover is active. It&apos;ll appear under My policies.
          </p>
        )}

        {failure && (
          <p className="text-sm text-danger">{errorMessage(failure)}</p>
        )}
      </div>
    </section>
  );
}
