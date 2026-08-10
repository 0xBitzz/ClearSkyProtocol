"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Wordmark } from "@/components/Wordmark";
import { ThemeToggle } from "@/components/providers/ThemeProvider";
import { ASSET_IS_MINTABLE } from "@/lib/contracts";
import { shortenAddress } from "@/lib/format";

/**
 * App shell: brand sidebar rail, page-coloured content area, and a fake browser
 * chrome bar above the page body. The chrome is decorative but it is the detail
 * that frames the content as a product rather than a form on a page.
 */

const NAV = [
  { href: "/app", label: "Insure a flight", icon: PlaneIcon },
  { href: "/app/policies", label: "My policies", icon: ShieldIcon },
  { href: "/app/provide", label: "Provide liquidity", icon: LayersIcon },
  ...(ASSET_IS_MINTABLE
    ? [{ href: "/app/faucet", label: "Test USDC", icon: DropIcon }]
    : []),
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  return (
    <div className="flex min-h-screen bg-surface">
      {/* Sidebar ------------------------------------------------------- */}
      <aside className="hidden w-64 shrink-0 flex-col bg-brand px-4 py-6 lg:flex">
        <Link href="/" className="px-2" aria-label="ClearSky home">
          <Wordmark tone="light" />
        </Link>

        <nav className="mt-10 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            // Exact match for /app so it doesn't stay lit on child routes.
            const active =
              href === "/app" ? pathname === "/app" : pathname.startsWith(href);

            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "bg-on-brand/10 font-medium text-on-brand"
                    : "text-on-brand/55 hover:bg-on-brand/5 hover:text-on-brand"
                }`}
              >
                {/* Boarding-gate tick: a short accent bar on the active row
                    instead of a filled pill, so the rail stays quiet. */}
                {active && (
                  <span
                    className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
                <Icon />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto rounded-xl border border-on-brand/15 p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-on-brand/40">
            Network
          </p>
          <p className="mt-1 text-sm text-on-brand/80">Arc Testnet</p>
        </div>
      </aside>

      {/* Main --------------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line px-6 py-4">
          <Link href="/" className="lg:hidden" aria-label="ClearSky home">
            <Wordmark />
          </Link>

          <div className="ml-auto flex items-center gap-3">
            {isConnected ? (
              <>
                <span className="chip-active">
                  <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                  {shortenAddress(address!)}
                </span>
                <button
                  onClick={() => disconnect()}
                  className="text-sm text-ink-muted transition-colors hover:text-ink"
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button
                onClick={() => connect({ connector: connectors[0] })}
                disabled={isPending}
                className="btn-primary py-2.5 text-sm"
              >
                {isPending ? "Connecting…" : "Connect wallet"}
              </button>
            )}
            <ThemeToggle />
          </div>
        </header>

        {/* Mobile nav: the sidebar is hidden below lg, so the routes need a
            reachable alternative rather than disappearing entirely. */}
        <nav className="flex gap-2 overflow-x-auto border-b border-line px-6 py-3 lg:hidden">
          {NAV.map(({ href, label }) => {
            const active =
              href === "/app" ? pathname === "/app" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-brand font-medium text-on-brand"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
          <div className="mx-auto max-w-5xl">
            <div className="overflow-hidden rounded-card border border-line bg-raised shadow-card">
              {/* Browser chrome */}
              <div className="flex items-center gap-3 border-b border-line px-4 py-3">
                <div className="flex gap-1.5" aria-hidden>
                  <span className="h-2.5 w-2.5 rounded-full bg-line" />
                  <span className="h-2.5 w-2.5 rounded-full bg-line" />
                  <span className="h-2.5 w-2.5 rounded-full bg-line" />
                </div>
                <div className="mx-auto rounded-lg bg-sunken px-4 py-1.5">
                  <span className="num text-xs text-ink-muted">
                    clearsky.app{pathname}
                  </span>
                </div>
              </div>

              <div className="p-5 sm:p-8">
                {isConnected ? (
                  children
                ) : (
                  <ConnectPrompt
                    onConnect={() => connect({ connector: connectors[0] })}
                    isPending={isPending}
                  />
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function ConnectPrompt({
  onConnect,
  isPending,
}: {
  onConnect: () => void;
  isPending: boolean;
}) {
  return (
    <div className="py-16 text-center">
      <p className="label">Wallet required</p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
        Connect to continue
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
        Your policies and liquidity position are tied to your address, so there
        is nothing to show until a wallet is connected.
      </p>
      <button
        onClick={onConnect}
        disabled={isPending}
        className="btn-primary mt-8"
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    </div>
  );
}

/* Icons: inline so the shell has no icon-library dependency. */

function PlaneIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M2 11.5 21.2 3 12.7 22.2l-2.4-7.9-8.3-2.8Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M12 2 4 5v7c0 5 3.4 9.1 8 10 4.6-.9 8-5 8-10V5l-8-3Z" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M12 2 2 7l10 5 10-5-10-5Zm0 9.8L4.2 8 2 9.1l10 5 10-5L19.8 8 12 11.8Zm0 5L4.2 13 2 14.1l10 5 10-5-2.2-1.1L12 16.8Z" />
    </svg>
  );
}

function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="currentColor" aria-hidden>
      <path d="M12 2S5 10 5 14.5A7 7 0 0 0 19 14.5C19 10 12 2 12 2Z" />
    </svg>
  );
}
