import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import Link from "next/link";
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
        <header className="border-b border-fog px-6 py-4">
          <div className="mx-auto flex max-w-5xl items-center gap-2">
            <Link href="/" className="flex items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/wordmark.svg" alt="bullet" className="h-7 w-auto" />
            </Link>
            <nav className="ml-auto flex items-center gap-3 text-sm">
              <Link
                href="/send"
                className="rounded-full border border-fog bg-white px-4 py-2 font-medium transition-colors hover:border-graphite"
              >
                Send money
              </Link>
              <Link
                href="/register"
                className="rounded-full bg-ink px-4 py-2 font-medium text-paper transition-colors hover:bg-ink/85"
              >
                Sign up
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-12">{children}</main>
      </body>
    </html>
  );
}
