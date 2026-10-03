// How Settings → Ares and the Usage page show money, time and tokens.

export function formatUsd(usd: number | null): string {
  if (usd === null) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}
