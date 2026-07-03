import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import IslandNav from "@/components/IslandNav";
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
      </body>
    </html>
  );
}
