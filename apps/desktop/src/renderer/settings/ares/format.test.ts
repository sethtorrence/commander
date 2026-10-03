import { describe, expect, it } from 'vitest';
import { formatLatency, formatTokens, formatUsd } from './format';

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
