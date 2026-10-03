import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SignInError } from './sign-in-error';

// The browser half of the OAuth sign-in: a one-shot listener on the fixed, registered loopback
// port. Linear redirects the browser to http://localhost:<port>/callback?code=…&state=…; the first
// callback settles the sign-in and the listener closes, whatever the outcome.

export type RedirectListener = {
  redirectUri: string;
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

export async function listenForRedirect({
  port,
  state,
  timeoutMs = 5 * 60_000,
}: {
  port: number;
  state: string;
  timeoutMs?: number;
}): Promise<RedirectListener> {
  let settle!: { resolve: (value: { code: string }) => void; reject: (error: SignInError) => void };
  const result = new Promise<{ code: string }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers may close before attaching a handler; the rejection is still theirs to observe.
  result.catch(() => {});

  let done = false;
  const servers: Server[] = [];
  // Resolves once the port is free again.
  const stop = () => {
    clearTimeout(timer);
    return Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
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
    if (url.pathname !== '/callback' || done) {
      response.writeHead(404).end();
      return;
    }
    const reply = (status: number, heading: string, body: string) =>
      response
        .writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
        .end(page(heading, body));
    const params = url.searchParams;
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
      reply(200, 'Linear not connected', 'You can close this tab and return to Commander.');
      finish(
        error === 'access_denied'
          ? new SignInError('declined', 'You declined access in Linear, so no Account was connected.')
          : new SignInError('exchange-failed', `Linear refused the sign-in (${error}). Try again.`),
      );
      return;
    }
    const code = params.get('code');
    if (!code) {
      reply(400, 'Sign-in failed', 'Linear sent no authorization code. Try again from Commander.');
      finish(new SignInError('exchange-failed', 'Linear sent no authorization code. Try connecting again.'));
      return;
    }
    reply(200, 'Linear approved', 'You can close this tab and return to Commander.');
    finish({ code });
  };

  const timer = setTimeout(
    () => finish(new SignInError('timed-out', 'The sign-in timed out waiting for the browser. Try again.')),
    timeoutMs,
  );
  try {
    for (const host of HOSTS) {
      const server = createServer(handle);
      if (await listen(server, port, host)) servers.push(server);
    }
  } catch (error) {
    done = true;
    void stop();
    const code = (error as NodeJS.ErrnoException).code;
    throw code === 'EADDRINUSE'
      ? new SignInError(
          'port-in-use',
          `Commander couldn't listen for Linear's reply because port ${port} is in use by another program. Close it and try again.`,
        )
      : error;
  }

  return {
    redirectUri: `http://localhost:${port}/callback`,
    result,
    close: () => finish(new SignInError('cancelled', 'The sign-in was cancelled.')),
  };
}
