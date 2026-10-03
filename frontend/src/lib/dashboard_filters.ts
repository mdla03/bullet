/** Filters the dashboard transactions tab understands, straight off the query
 *  string. Kept out of the page so the sanitising below is testable. */
export interface TxFilters {
  type: string;
  token: string;
  from: string;
  to: string;
  q: string;
  page: number;
}

export const PAGE_SIZE = 100;

/** A Stellar public key (G…) or contract id (C…): 56 chars of base32. Decides
 *  whether a search term is looked up as a wallet rather than matched against
 *  the handle and tx hash columns. Also what makes interpolating the term into
 *  a filter string safe, since nothing outside [A-Z2-7] can pass. */
export function isStellarAddress(q: string): boolean {
  return /^[GC][A-Z2-7]{55}$/.test(q);
}

export function readFilters(
  sp: Record<string, string | string[] | undefined>
): TxFilters {
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) ?? "";
  const type = one("type");
  return {
    type: type === "send" || type === "claim" ? type : "",
    token: /^\d+$/.test(one("token")) ? one("token") : "",
    from: /^\d{4}-\d{2}-\d{2}$/.test(one("from")) ? one("from") : "",
    to: /^\d{4}-\d{2}-\d{2}$/.test(one("to")) ? one("to") : "",
    // The search term lands inside a PostgREST `or` filter string, where a
    // comma or a paren ends the current condition and starts another one, and
    // `%` and `*` are ilike wildcards. Keep only what a handle or a tx hash
    // can contain.
    q: one("q").slice(0, 80).replace(/[^A-Za-z0-9@._:/-]/g, ""),
    page: Math.max(0, Number.parseInt(one("page"), 10) || 0),
  };
}
