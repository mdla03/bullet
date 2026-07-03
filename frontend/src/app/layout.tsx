import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import Link from "next/link";
import IslandNav from "@/components/IslandNav";
import { XBrandIcon } from "@/components/icons";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "bullet · payments without a trace",
  description:
    "Send USDC privately to any X handle or email on Stellar. Zero-knowledge proofs keep sender and recipient unlinkable on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${geistMono.variable} min-h-screen bg-paper font-sans text-ink antialiased`}
      >
        <IslandNav />
        <main className="mx-auto max-w-5xl px-4 pb-12 pt-28">{children}</main>
        <footer className="border-t border-fog">
          <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row">
            <Link href="/" className="flex items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/wordmark.svg" alt="bullet" className="h-5 w-auto" />
            </Link>
            <nav className="flex items-center gap-6 text-sm text-graphite">
              <Link
                href="/privacy"
                className="transition-colors hover:text-ink"
              >
                Privacy
              </Link>
              <a
                href="https://x.com/BulletPayFi"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Bullet on X"
                className="transition-colors hover:text-ink"
              >
                <XBrandIcon className="h-4 w-4" />
              </a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
