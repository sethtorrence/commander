import type { SearchByMeaningStatus } from '@commander/domain';

// How Settings → Ares and the Usage page show money, time and tokens, and where search by meaning
// stands.

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

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** One line on where search by meaning stands (#73). */
export function meaningStatusLine(status: SearchByMeaningStatus): string {
  switch (status.state) {
    case 'off':
      return 'Off. Search finds things by their words.';
    case 'waiting':
      return 'Starting…';
    case 'downloading':
      return `Downloading the model: ${megabytes(status.receivedBytes)} of ${megabytes(status.totalBytes)}`;
    case 'loading':
      return 'Loading the model…';
    case 'failed':
      return `Couldn’t get the model ready: ${status.problem ?? 'something went wrong'}. Commander tries again later.`;
    case 'ready':
      return status.embedded < status.total
        ? `Ready. Indexing in the background: ${formatTokens(status.embedded)} of ${formatTokens(status.total)}`
        : `Ready. All ${formatTokens(status.total)} Items and memories are indexed`;
  }
}
