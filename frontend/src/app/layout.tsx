import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bullet — fast, small, silent payments",
  description:
    "Send USDC privately to any X handle or email on Stellar. Zero-knowledge proofs keep sender and recipient unlinkable on-chain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <header className="border-b border-zinc-800/80 px-6 py-4">
          <div className="mx-auto flex max-w-lg items-baseline gap-3">
            <span className="text-lg font-bold tracking-tight">
              <span className="text-amber-400">●</span> Bullet
            </span>
            <span className="text-xs tracking-widest text-zinc-500">
              FAST · SMALL · SILENT
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-lg px-4 py-12">{children}</main>
      </body>
    </html>
  );
}
