import * as net from "node:net";

export interface TcpWaitOptions {
  host?: string;
  intervalMs?: number;
  /** Called between attempts; return a reason to abort early (e.g. the process died). */
  shouldAbort?: () => string | null;
  /** Included in the timeout message so the caller knows which subprocess failed. */
  label?: string;
}

/** Resolves once the port accepts a connection, or rejects on timeout. */
export function waitForTcpPort(port: number, timeoutMs: number, options: TcpWaitOptions = {}): Promise<void> {
  const { host = "127.0.0.1", intervalMs = 100, shouldAbort, label = "subprocess" } = options;
  const deadline = Date.now() + timeoutMs;

  const tryOnce = (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(Math.min(1000, timeoutMs));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });

  return (async () => {
    while (Date.now() < deadline) {
      const abortReason = shouldAbort?.();
      if (abortReason) throw new Error(abortReason);
      if (await tryOnce()) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`${label} did not open its port ${port} within ${timeoutMs}ms`);
  })();
}

/**
 * Finds a free port with its successor also free, on loopback.
 *
 * ardopcf claims hostPort AND hostPort+1 (the data port is always one higher),
 * so a single ephemeral port is not enough. Used by the device test, which must
 * not collide with a modem already running on a profile's configured port.
 */
export async function findFreePortPair(startAt = 18600, attempts = 50): Promise<number> {
  for (let port = startAt; port < startAt + attempts; port++) {
    if ((await isPortFree(port)) && (await isPortFree(port + 1))) return port;
  }
  throw new Error(`No free port pair found between ${startAt} and ${startAt + attempts}`);
}

/**
 * Whether nothing is listening on a loopback port.
 *
 * Exported because the modem has to ask BEFORE it spawns. waitForTcpPort
 * cannot answer this: an orphaned ardopcf holding the port makes the readiness
 * poll succeed instantly, so a new modem that failed to start would still be
 * reported running -- and Pat would then dial through a process holding the
 * wrong audio devices.
 */
/**
 * A loopback port the OS reports free right now, chosen by the OS.
 *
 * There is a window between this closing and the caller binding it, but the
 * caller binds within milliseconds and fails loudly if it lost the race.
 */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}
