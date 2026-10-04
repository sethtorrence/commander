import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitiseInWorker } from './sanitiser';
import { TooComplex } from './sanitize';

// The sanitiser off the Core's thread, with a hard time limit. These stand-in workers answer as the
// real one does, or never.
const ANSWERS = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (job) => {
  if (job.html === 'hang') for (;;) {}
  if (job.html === 'complex') return parentPort.postMessage({ id: job.id, ok: false, tooComplex: true, error: 'nested' });
  parentPort.postMessage({ id: job.id, ok: true, result: { html: '<p>' + job.html + '</p>', remoteImages: [], heldImages: 0, hasQuote: false } });
});`;

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function sanitiser(timeoutMs = 300) {
  let started = 0;
  const made = sanitiseInWorker(
    () => {
      started += 1;
      return new Worker(ANSWERS, { eval: true }) as never;
    },
    { timeoutMs },
  );
  stops.push(made.stop);
  return { ...made, started: () => started };
}

const request = (html: string) => ({ html, images: 'held' as const, quotes: false, token: 'a'.repeat(32) });

describe('sanitising off the Core’s thread', () => {
  it('answers each message, one thread for many', async () => {
    const { sanitise, started } = sanitiser();
    expect((await sanitise(request('one'))).html).toBe('<p>one</p>');
    expect((await sanitise(request('two'))).html).toBe('<p>two</p>');
    expect(started()).toBe(1);
  });

  it('passes on a message too complex to show', async () => {
    const { sanitise } = sanitiser();
    await expect(sanitise(request('complex'))).rejects.toBeInstanceOf(TooComplex);
  });

  it('gives up on a message that takes too long, stops its thread, and carries on with a fresh one', async () => {
    const { sanitise, started } = sanitiser(300);
    const began = Date.now();
    await expect(sanitise(request('hang'))).rejects.toBeInstanceOf(TooComplex);
    expect(Date.now() - began).toBeLessThan(2000);
    expect((await sanitise(request('after'))).html).toBe('<p>after</p>');
    expect(started()).toBe(2);
  });

  it('keeps messages in order behind a slow one', async () => {
    const { sanitise } = sanitiser(300);
    const results = await Promise.allSettled([sanitise(request('hang')), sanitise(request('next'))]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: expect.objectContaining({ html: '<p>next</p>' }),
    });
  });
});
