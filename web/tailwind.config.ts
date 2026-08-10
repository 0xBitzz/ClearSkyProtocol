import type { Config } from "tailwindcss";

/**
 * Colours resolve to CSS variables defined in globals.css, so `dark:` variants
 * are unnecessary — flipping the `.dark` class on <html> reassigns every token
 * at once. The `<alpha-value>` placeholder keeps opacity modifiers working
 * (e.g. `bg-accent/20`).
 */
const withAlpha = (variable: string) => `rgb(var(${variable}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: withAlpha("--surface"),
        raised: withAlpha("--surface-raised"),
        sunken: withAlpha("--surface-sunken"),
        line: withAlpha("--line"),

        ink: {
          DEFAULT: withAlpha("--ink"),
          soft: withAlpha("--ink-soft"),
          muted: withAlpha("--ink-muted"),
        },

        brand: {
          DEFAULT: withAlpha("--brand"),
          hover: withAlpha("--brand-hover"),
        },
        "on-brand": withAlpha("--on-brand"),

        accent: {
          DEFAULT: withAlpha("--accent"),
          soft: withAlpha("--accent-soft"),
        },
        signal: {
          DEFAULT: withAlpha("--signal"),
          soft: withAlpha("--signal-soft"),
        },
        positive: {
          DEFAULT: withAlpha("--positive"),
          soft: withAlpha("--positive-soft"),
        },
        warning: {
          DEFAULT: withAlpha("--warning"),
          soft: withAlpha("--warning-soft"),
        },
        danger: {
          DEFAULT: withAlpha("--danger"),
          soft: withAlpha("--danger-soft"),
        },
      },

      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },

      borderRadius: {
        card: "1.25rem",
      },

      boxShadow: {
        card: "0 1px 2px rgb(15 23 42 / 0.04), 0 8px 24px -12px rgb(15 23 42 / 0.12)",
        lift: "0 2px 4px rgb(15 23 42 / 0.06), 0 24px 48px -20px rgb(15 23 42 / 0.28)",
      },
    },
  },
  plugins: [],
};

export default config;
