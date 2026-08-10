/**
 * Title block used at the top of every app page: eyebrow label, heading,
 * one-line subtitle, and an optional status chip pinned right.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  aside,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="label">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>
      </div>
      {aside && <div className="shrink-0">{aside}</div>}
    </div>
  );
}
