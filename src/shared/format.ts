/** Thousands separators for a count in server copy: "500,000". */
export const formatCount = (n: number) => n.toLocaleString("en-US");

/**
 * US dollars for provider costs far below a cent: "$2.00", "$0.0123",
 * "$0.00084". At least two decimals, at most six.
 */
export function formatUsd(usd: number): string {
  const [whole, decimals = ""] = usd.toFixed(6).split(".");
  return `$${whole}.${decimals.replace(/0+$/, "").padEnd(2, "0")}`;
}
