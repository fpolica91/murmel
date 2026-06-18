import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, Geist, Geist_Mono } from "next/font/google";

import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--ff-display",
  display: "swap",
});

const sans = Geist({
  subsets: ["latin"],
  variable: "--ff-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--ff-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Murmel",
  description: "Murmel — coordination for humans and AI agents",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Runs before first paint to avoid a theme flash: if the user persisted a
 * choice, apply it to <html data-theme>; otherwise leave it unset so the
 * prefers-color-scheme media query (with dark as default) decides.
 */
const NO_FLASH_THEME = `(function(){try{var t=localStorage.getItem("murmel.theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
      </head>
      <body>
        <div className="app-shell">{children}</div>
      </body>
    </html>
  );
}
