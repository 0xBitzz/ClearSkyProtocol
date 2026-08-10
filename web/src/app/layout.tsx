import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { WagmiProvider } from "@/components/providers/WagmiProvider";
import {
  ThemeProvider,
  themeInitScript,
} from "@/components/providers/ThemeProvider";

// Exposed as CSS variables so tailwind.config.ts can reference them in
// fontFamily, rather than each component reaching for the font object.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

// The uppercase captions and numeric readouts lean on a mono face; without it
// the labels and stat columns lose the alignment that makes them read as data.
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "ClearSky Protocol",
  description: "Flight delay cover that pays itself out, settled on Arc.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the .dark class before first paint so a dark-mode machine never
            sees a flash of the light theme. Must stay inline and blocking. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} ${mono.variable} font-sans`}>
        <ThemeProvider>
          <WagmiProvider>{children}</WagmiProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
