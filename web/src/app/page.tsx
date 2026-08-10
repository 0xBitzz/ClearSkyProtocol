import Image from "next/image";
import Link from "next/link";
import { VaultPreview } from "@/components/VaultPreview";
import { Wordmark } from "@/components/Wordmark";
import { ThemeToggle } from "@/components/providers/ThemeProvider";

/**
 * Landing page.
 *
 * The hero is a full-bleed photo with a dark scrim, and the vault card is
 * intentionally allowed to run past the bottom of the viewport — the crop is
 * what makes it read as a peek into the app rather than a screenshot pasted
 * onto a page.
 */
export default function Landing() {
  return (
    <div className="min-h-screen bg-brand">
      {/* Hero ---------------------------------------------------------- */}
      <section className="relative isolate overflow-hidden">
        <Image
          src="/airplanes.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-10 object-cover"
        />
        {/* Scrim: the photo alone doesn't give white text enough contrast at
            the top, and a flat overlay would flatten the image. */}
        <div
          className="absolute inset-0 -z-10 bg-gradient-to-b from-brand/95 via-brand/70 to-brand/95"
          aria-hidden
        />

        <header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-6">
          <Link href="/" aria-label="ClearSky home">
            <Wordmark tone="light" />
          </Link>

          <nav className="hidden items-center gap-8 md:flex">
            <a
              href="#how-it-works"
              className="text-sm text-on-brand/70 transition-colors hover:text-on-brand"
            >
              How it works
            </a>
            <a
              href="#faq"
              className="text-sm text-on-brand/70 transition-colors hover:text-on-brand"
            >
              FAQ
            </a>
          </nav>

          <div className="flex items-center gap-3">
            <ThemeToggle className="border-on-brand/25 text-on-brand/70 hover:text-on-brand" />
            <Link
              href="/app"
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white transition-all hover:brightness-110"
            >
              Launch app →
            </Link>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-6 pb-0 pt-16 text-center sm:pt-24">
          {/* Departure-board strip: mono, ruled, and deliberately terse — the
              one piece of chrome that fixes the page as an airline artifact. */}
          <div className="mx-auto mb-8 inline-flex items-center gap-3 rounded-full border border-on-brand/20 px-4 py-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-on-brand/70">
              Delay cover · Settled on Arc
            </span>
          </div>

          <h1 className="mx-auto max-w-4xl text-5xl font-semibold leading-[1.05] tracking-tight text-on-brand sm:text-6xl lg:text-7xl">
            Your flight is late. You&apos;re already paid.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-on-brand/70">
            Delay cover with no claims desk and no paperwork. An agent watches
            your flight and the payout settles itself, on Arc.
          </p>

          <div className="mt-10 flex justify-center">
            <Link
              href="/app"
              className="rounded-xl bg-on-brand px-6 py-3.5 font-medium text-brand transition-opacity hover:opacity-90"
            >
              Insure a flight →
            </Link>
          </div>

          {/* Cropped on purpose — see the note at the top of the file. */}
          <div className="mt-16 flex justify-center px-0 sm:mt-20">
            <div className="w-full max-w-3xl translate-y-8">
              <VaultPreview />
            </div>
          </div>
        </div>
      </section>

      {/* How it works -------------------------------------------------- */}
      <section
        id="how-it-works"
        className="bg-surface px-6 pb-24 pt-28 sm:pt-32"
      >
        <div className="mx-auto max-w-5xl text-center">
          <p className="label">How it works</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Buy. Fly. Get paid.
          </h2>
        </div>

        <ol className="mx-auto mt-12 grid max-w-5xl gap-5 sm:grid-cols-3">
          {[
            {
              step: "01",
              title: "Pick your flight",
              body: "Enter your flight number, choose a premium, and set how long a delay has to run before it pays.",
            },
            {
              step: "02",
              title: "An agent watches it",
              body: "A verified agent tracks the flight and writes the actual departure time on-chain. Nobody has to file anything.",
            },
            {
              step: "03",
              title: "Claim, or don't",
              body: "Late past your threshold, your payout is waiting. On time, your premium stays with the underwriters who carried the risk.",
            },
          ].map(({ step, title, body }) => (
            <li key={step} className="card p-6">
              <p className="label">{step}</p>
              <p className="mt-4 text-lg font-semibold text-ink">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                {body}
              </p>
            </li>
          ))}
        </ol>

        <div className="mx-auto mt-8 max-w-5xl">
          <div className="card flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
            <div>
              <p className="font-semibold text-ink">
                Want to earn the premiums instead?
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                Underwriters supply the liquidity that backs every policy, and
                keep the premiums on flights that land on time.
              </p>
            </div>
            <Link
              href="/app/provide"
              className="btn-primary shrink-0 text-sm"
            >
              Provide liquidity →
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ ----------------------------------------------------------- */}
      <section id="faq" className="bg-surface px-6 pb-28">
        <div className="mx-auto max-w-3xl">
          <p className="label text-center">FAQ</p>
          <h2 className="mt-3 text-center text-3xl font-semibold tracking-tight text-ink">
            The short answers
          </h2>

          <dl className="mt-10 space-y-3">
            {[
              {
                q: "When can I buy cover?",
                a: "Up to an hour before scheduled departure. After that the flight is too close to price fairly.",
              },
              {
                q: "How much do I get back?",
                a: "A fixed multiple of your premium, shown before you buy. The vault checks it can cover the full payout before your policy goes live.",
              },
              {
                q: "Who decides if my flight was late?",
                a: "A registered agent posts the actual departure time on-chain. The contract compares it to the schedule — no human adjudicates your claim.",
              },
              {
                q: "What if I don't claim?",
                a: "Anyone can expire an on-time policy to release its collateral. Your payout, if you're owed one, stays claimable.",
              },
            ].map(({ q, a }) => (
              <div key={q} className="card p-5">
                <dt className="font-medium text-ink">{q}</dt>
                <dd className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                  {a}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <footer className="bg-brand px-6 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 sm:flex-row">
          <Wordmark tone="light" />
          <p className="font-mono text-xs uppercase tracking-widest text-on-brand/40">
            Settled on Arc · Testnet
          </p>
        </div>
      </footer>
    </div>
  );
}
