/**
 * ClearSky mark: a paper-plane glyph in a rounded square, plus the wordmark.
 * `tone` flips it for the dark hero versus the app chrome.
 */
export function Wordmark({
  tone = "dark",
  className = "",
}: {
  tone?: "dark" | "light";
  className?: string;
}) {
  const text = tone === "light" ? "text-on-brand" : "text-ink";
  const chipBg = tone === "light" ? "bg-on-brand" : "bg-brand";
  const chipFg = tone === "light" ? "text-brand" : "text-on-brand";

  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-lg ${chipBg} ${chipFg}`}
        aria-hidden
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
          <path d="M2 11.5 21.2 3 12.7 22.2l-2.4-7.9-8.3-2.8Z" />
        </svg>
      </span>
      <span className={`text-lg font-semibold tracking-tight ${text}`}>
        ClearSky
      </span>
    </span>
  );
}
