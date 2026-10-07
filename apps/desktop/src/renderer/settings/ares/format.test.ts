import type { SearchByMeaningStatus } from '@commander/domain';
import { describe, expect, it } from 'vitest';
import { formatLatency, formatTokens, formatUsd, meaningStatusLine } from './format';

describe('formatting usage', () => {
  it('shows dollars to the cent, and fractions of a cent to four places', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.75)).toBe('$1.75');
    expect(formatUsd(0.0005)).toBe('$0.0005');
    expect(formatUsd(0.00004)).toBe('<$0.0001');
    expect(formatUsd(null)).toBe('—');
  });

  it('shows latency in milliseconds, then seconds', () => {
    expect(formatLatency(840)).toBe('840 ms');
    expect(formatLatency(19_250)).toBe('19.3 s');
  });

  it('groups token counts', () => {
    expect(formatTokens(1_234_567)).toBe('1,234,567');
  });
});

describe('where search by meaning stands (#73)', () => {
  const status = (changes: Partial<SearchByMeaningStatus>): SearchByMeaningStatus => ({
    on: true,
    state: 'ready',
    model: { name: 'Granite Embedding 97M Multilingual R2', downloadBytes: 123_174_716 },
    receivedBytes: 0,
    totalBytes: 123_174_716,
    embedded: 1300,
    total: 1300,
    problem: null,
    ...changes,
  });

  it('says how far the download has got, in megabytes', () => {
    expect(meaningStatusLine(status({ state: 'downloading', receivedBytes: 45_000_000 }))).toBe(
      'Downloading the model: 45 MB of 123 MB',
    );
  });

  it('says how many Items, memories and Conversation turns are indexed, while indexing and once done', () => {
    expect(meaningStatusLine(status({ embedded: 412 }))).toBe(
      'Ready. Indexing in the background: 412 of 1,300',
    );
    expect(meaningStatusLine(status({}))).toBe(
      'Ready. All 1,300 Items, memories and Conversation turns are indexed',
    );
  });

  it('says what it is doing otherwise', () => {
    expect(meaningStatusLine(status({ state: 'off', on: false }))).toBe(
      'Off. Search finds things by their words.',
    );
    expect(meaningStatusLine(status({ state: 'waiting' }))).toBe('Starting…');
    expect(meaningStatusLine(status({ state: 'loading' }))).toBe('Loading the model…');
    expect(meaningStatusLine(status({ state: 'failed', problem: 'Couldn’t reach huggingface.co' }))).toBe(
      'Couldn’t get the model ready: Couldn’t reach huggingface.co. Commander tries again later.',
    );
  });
});
