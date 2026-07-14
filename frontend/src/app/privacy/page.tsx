import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · bullet",
  description: "What Bullet hides on-chain, and what it does not.",
};

export default function Privacy() {
  return (
    <div className="mx-auto max-w-2xl py-12 text-left">
      <h1 className="text-4xl font-bold tracking-tight">Privacy</h1>
      <p className="mt-4 text-lg text-graphite">
        What Bullet hides, and what it does not. Stated plainly, because
        privacy claims you can not check are worthless.
      </p>

      <h2 className="mt-12 text-2xl font-bold tracking-tight">
        What stays private
      </h2>
      <ul className="mt-4 space-y-4 text-graphite">
        <li>
          <span className="font-semibold text-ink">
            No on-chain link between deposit and claim.
          </span>{" "}
          The recipient claims with a zero-knowledge proof that shows a note is
          theirs without saying which one. Nothing in the claim transaction
          points back to your deposit.
        </li>
        <li>
          <span className="font-semibold text-ink">
            Payments to the same person do not link to each other.
          </span>{" "}
          Each payment lands at its own one-time commitment derived from the
          recipient&apos;s published key, not in a shared per-handle wallet.
          Ten payments are ten unrelated notes.
        </li>
        <li>
          <span className="font-semibold text-ink">
            Amounts carry no signal.
          </span>{" "}
          Every note is exactly 1, 10, 50 or 100 USDC, so an amount can not be
          used to match a deposit to a claim.
        </li>
      </ul>

      <h2 className="mt-12 text-2xl font-bold tracking-tight">
        What does not
      </h2>
      <ul className="mt-4 space-y-4 text-graphite">
        <li>
          <span className="font-semibold text-ink">
            Amounts are standardized, not encrypted.
          </span>{" "}
          A 50 USDC note is a visible 50 USDC transfer. The privacy comes from
          everyone using the same sizes, so no single payment stands out.
        </li>
        <li>
          <span className="font-semibold text-ink">
            The resolver sees lookups.
          </span>{" "}
          Resolving a handle to keys happens off-chain, so our server knows who
          looked up whom. It does not learn which on-chain note resulted.
        </li>
        <li>
          <span className="font-semibold text-ink">
            Email delivery shows the provider your claim link.
          </span>{" "}
          If a claim link travels by email, the email provider can see it. Copy
          the link and deliver it yourself to skip that.
        </li>
        <li>
          <span className="font-semibold text-ink">
            The crowd is still small.
          </span>{" "}
          Unlinkability hides you among all deposits in the contract pool.
          While volume is low, that crowd is thin, and it strengthens as usage
          grows.
        </li>
      </ul>
    </div>
  );
}
