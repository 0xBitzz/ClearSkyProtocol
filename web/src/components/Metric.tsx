/**
 * Shared metric primitives.
 *
 * The reference design repeats one shape everywhere: a titled tile with a short
 * description, a progress bar, and a mono readout aligned right. Centralising it
 * keeps the landing preview, the vault dashboard, and the policy list visually
 * identical instead of three near-misses.
 */

export function ProgressBar({ ratio }: { ratio: number }) {
  // Clamped so a value above its own target (paid-out vault, over-target
  // metric) renders as full rather than overflowing the track.
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;

  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function MetricTile({
  title,
  description,
  ratio,
  readout,
}: {
  title: string;
  description: string;
  ratio?: number;
  readout: string;
}) {
  return (
    <div className="tile">
      <p className="font-semibold text-ink">{title}</p>
      <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
      {ratio !== undefined && (
        <div className="mt-4">
          <ProgressBar ratio={ratio} />
        </div>
      )}
      <p className="num mt-2 text-right text-sm text-ink">{readout}</p>
    </div>
  );
}

/** Label/value row used inside cards, with a hairline rule between rows. */
export function StatRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-line py-3 last:border-0">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="num text-sm text-ink">{children}</span>
    </div>
  );
}
