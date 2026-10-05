import { describe, expect, it } from 'vitest';
import { gate, MAILBOX_CONCURRENCY, mailboxGate } from './mailbox-gate';

// Outlook's limit of 4 requests at once per mailbox, shared by an Account's mail and calendar (#136).

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('the mailbox gate', () => {
  it('runs no more than 4 at once, a batch holding as many places as it carries', async () => {
    expect(MAILBOX_CONCURRENCY).toBe(4);
    const run = gate(MAILBOX_CONCURRENCY);
    let running = 0;
    let most = 0;
    const task = (weight: number) =>
      run(async () => {
        running += weight;
        most = Math.max(most, running);
        await tick();
        running -= weight;
      }, weight);
    await Promise.all([task(1), task(1), task(4), task(1), task(2), task(1), task(3)]);
    expect(most).toBe(4);
  });

  it('is one gate per Account, whichever Outlook Source asks', () => {
    expect(mailboxGate('outlook:t:a')).toBe(mailboxGate('outlook:t:a'));
    expect(mailboxGate('outlook:t:a')).not.toBe(mailboxGate('outlook:t:b'));
  });
});
