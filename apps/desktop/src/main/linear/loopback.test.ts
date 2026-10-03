import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenForRedirect, type RedirectListener } from './loopback';
import { SignInError } from './sign-in-error';

// A free port, found by letting the OS pick one and releasing it.
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function isListening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/callback`);
    return true;
  } catch {
    return false;
  }
}

let listener: RedirectListener | undefined;
let blocker: Server | undefined;

afterEach(async () => {
  listener?.close();
  listener = undefined;
  if (blocker) await new Promise((resolve) => blocker?.close(resolve));
  blocker = undefined;
});

describe('the loopback redirect listener', () => {
  it('listens on the registered localhost callback URL', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });

    expect(listener.redirectUri).toBe(`http://localhost:${port}/callback`);
  });

  it('hands over the code when the browser comes back with the right state, then stops listening', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });

    const page = await fetch(`http://localhost:${port}/callback?code=the-code&state=state-1`);

    await expect(listener.result).resolves.toEqual({ code: 'the-code' });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/return to Commander/);
    expect(await isListening(port)).toBe(false);
  });

  it('refuses a redirect whose state does not match, and stops listening', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });
    const failure = expect(listener.result).rejects.toMatchObject({ reason: 'state-mismatch' });

    const page = await fetch(`http://localhost:${port}/callback?code=forged&state=someone-else`);

    await failure;
    expect(page.status).toBe(400);
    expect(await isListening(port)).toBe(false);
  });

  it('reports that the User declined when Linear redirects with access_denied', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });
    const failure = expect(listener.result).rejects.toMatchObject({ reason: 'declined' });

    await fetch(`http://localhost:${port}/callback?error=access_denied&state=state-1`);

    await failure;
    expect(await isListening(port)).toBe(false);
  });

  it('ignores requests for anything but the callback, and keeps waiting', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });

    const favicon = await fetch(`http://localhost:${port}/favicon.ico`);
    await fetch(`http://localhost:${port}/callback?code=the-code&state=state-1`);

    expect(favicon.status).toBe(404);
    await expect(listener.result).resolves.toEqual({ code: 'the-code' });
  });

  it('explains when the port is already taken', async () => {
    const port = await freePort();
    blocker = createServer();
    await new Promise<void>((resolve) => blocker?.listen(port, '127.0.0.1', resolve));

    const listening = listenForRedirect({ port, state: 'state-1' });

    await expect(listening).rejects.toBeInstanceOf(SignInError);
    await expect(listening).rejects.toMatchObject({ reason: 'port-in-use' });
    await expect(listening).rejects.toThrow(String(port));
  });

  it('gives up after the timeout and stops listening', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1', timeoutMs: 50 });

    await expect(listener.result).rejects.toMatchObject({ reason: 'timed-out' });
    expect(await isListening(port)).toBe(false);
  });

  it('stops listening when the sign-in is cancelled', async () => {
    const port = await freePort();
    listener = await listenForRedirect({ port, state: 'state-1' });
    const failure = expect(listener.result).rejects.toMatchObject({ reason: 'cancelled' });

    listener.close();

    await failure;
    expect(await isListening(port)).toBe(false);
  });
});
