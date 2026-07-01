import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ZeekPay — Private payments on Stellar",
  description: "Send USDC privately to any X handle or email using zero-knowledge proofs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        <header className="border-b border-gray-800 px-6 py-4">
          <span className="text-lg font-semibold tracking-tight text-purple-400">ZeekPay</span>
          <span className="ml-2 text-xs text-gray-500">private payments on Stellar</span>
        </header>
        <main className="mx-auto max-w-lg px-4 py-12">{children}</main>
      </body>
    </html>
  );
}
