import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignInError } from './sign-in-error';

// The browser half of an OAuth sign-in: a one-shot listener on a loopback port. The Source
// redirects the browser to http://localhost:<port><path>?code=…&state=…; the first reply settles the
// sign-in and the listener closes, whatever the outcome. The port is either fixed (registered with
// the Source, as Linear needs) or 0 for any free one (Microsoft ignores the port of http://localhost;
// Google takes any port on http://127.0.0.1).

export type RedirectListener = {
  redirectUri: string;
  // The port listened on (the one the system picked, when asked for 0).
  port: number;
  // Resolves with the authorization code, or rejects with a SignInError.
  result: Promise<{ code: string }>;
  // Cancels the sign-in (if still waiting) and stops listening.
  close(): void;
};

// Browsers may resolve "localhost" to either loopback address, so listen on both. Never on a
// public interface.
const HOSTS = ['127.0.0.1', '::1'];
// IPv6 may be switched off; then the IPv4 listener is enough.
const IGNORABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
// A port the system picked for IPv4 may already be taken on IPv6: pick again, this many times.
const PICK_ATTEMPTS = 5;

const page = (heading: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Commander</title>` +
  `<body style="font:16px system-ui,sans-serif;margin:15vh auto;max-width:34em;padding:0 1em">` +
  `<h1 style="font-size:1.4em">${heading}</h1><p>${body}</p></body>`;

function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (IGNORABLE.has(error.code ?? '')) resolve(false);
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

const closeAll = (servers: Server[]) =>
  Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );

// Listens on every loopback address on one port; for port 0, on one the system picks.
async function listenOnLoopback(port: number, handle: Parameters<typeof createServer>[1]) {
  for (let attempt = 1; ; attempt++) {
    const servers: Server[] = [];
    let chosen = port;
    try {
      for (const host of HOSTS) {
        const server = createServer(handle);
        if (!(await listen(server, chosen, host))) continue;
        servers.push(server);
        chosen = (server.address() as AddressInfo).port;
      }
      return { servers, port: chosen };
    } catch (error) {
      await closeAll(servers);
      const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!(port === 0 && inUse && attempt < PICK_ATTEMPTS)) throw error;
    }
  }
}

export async function listenForRedirect({
  port,
  path = '/callback',
  host = 'localhost',
  state,
  sourceName,
  timeoutMs = 5 * 60_000,
}: {
  // The registered port, or 0 for any free one.
  port: number;
  // The redirect's path: '/callback' for Linear, '/' for a bare http://localhost:<port>.
  path?: string;
  // The redirect's host. Listening is on both loopback addresses either way.
  host?: 'localhost' | '127.0.0.1';
  state: string;
  // The Source, as the browser page and the messages name it ("Linear", "Microsoft").
  sourceName: string;
  timeoutMs?: number;
}): Promise<RedirectListener> {
  let settle!: { resolve: (value: { code: string }) => void; reject: (error: SignInError) => void };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers may close before attaching a handler; the rejection is still theirs to observe.
  result.catch(() => {});

  let done = false;
  let servers: Server[] = [];
  // Resolves once the port is free again.
  const stop = () => {
    clearTimeout(timer);
    return closeAll(servers);
  };
  // Settles only after the listener has closed, so the port is free for the next sign-in.
  const finish = (outcome: { code: string } | SignInError) => {
    if (done) return;
    done = true;
    // Let the browser's response go out before the sockets close.
    setImmediate(async () => {
      await stop();
      if (outcome instanceof SignInError) settle.reject(outcome);
      else settle.resolve(outcome);
    });
  };

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const params = url.searchParams;
    // Anything but a reply to the sign-in (a favicon, a bare visit) is ignored.
    const isReply = ['state', 'code', 'error'].some((name) => params.has(name));
    if (url.pathname !== path || !isReply || done) {
      response.writeHead(404).end();
      return;
    }
    const reply = (status: number, heading: string, body: string) =>
      response
        .writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
        .end(page(heading, body));
    if (params.get('state') !== state) {
      reply(400, 'Sign-in refused', 'This sign-in didn’t start in Commander, so it was refused. Try again.');
      finish(
        new SignInError(
          'state-mismatch',
          'The sign-in was refused because the browser’s reply did not match the request Commander made. Try connecting again.',
        ),
      );
      return;
    }
    const error = params.get('error');
    if (error) {
      reply(200, `${sourceName} not connected`, 'You can close this tab and return to Commander.');
      const sourceError = { code: error, description: params.get('error_description') ?? '' };
      finish(
        error === 'access_denied'
          ? new SignInError(
              'declined',
              `You declined access in ${sourceName}, so no Account was connected.`,
              {
                sourceError,
              },
            )
          : new SignInError('exchange-failed', `${sourceName} refused the sign-in (${error}). Try again.`, {
              sourceError,
            }),
      );
      return;
    }
    const code = params.get('code');
    if (!code) {
      reply(400, 'Sign-in failed', `${sourceName} sent no authorization code. Try again from Commander.`);
      finish(
        new SignInError('exchange-failed', `${sourceName} sent no authorization code. Try connecting again.`),
      );
      return;
    }
    reply(200, `${sourceName} approved`, 'You can close this tab and return to Commander.');
    finish({ code });
  };

  const timer = setTimeout(
    () => finish(new SignInError('timed-out', 'The sign-in timed out waiting for the browser. Try again.')),
    timeoutMs,
  );
  let listening: { servers: Server[]; port: number };
  try {
    listening = await listenOnLoopback(port, handle);
  } catch (error) {
    done = true;
    clearTimeout(timer);
    const code = (error as NodeJS.ErrnoException).code;
    throw code === 'EADDRINUSE'
      ? new SignInError(
          'port-in-use',
          `Commander couldn't listen for ${sourceName}'s reply because port ${port} is in use by another program. Close it and try again.`,
        )
      : error;
  }
  servers = listening.servers;

  return {
    // A bare http://localhost:<port> carries no path: Entra matches the registered one exactly.
    redirectUri: `http://${host}:${listening.port}${path === '/' ? '' : path}`,
    port: listening.port,
    result,
    close: () => finish(new SignInError('cancelled', 'The sign-in was cancelled.')),
  };
}
