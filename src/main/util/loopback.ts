// Every service WL2GO spawns is started by us, on this machine, and consumed
// only by us -- so every one of them binds to loopback and nothing else.
//
// This is not hygiene. Left at their defaults all three listen on every network
// interface, and each carries a real consequence:
//
//   rigctld  an open port lets anyone on the network key the transmitter
//   ardopcf  its host port is a TNC control interface, same concern in session
//   pat      its HTTP API is unauthenticated remote control of the station --
//            read the mailbox, compose and send, connect, PUT config
//
// There is deliberately no configuration option to widen this. Anything that
// needs to reach these services runs inside this app.
//
// Loopback keeps the NETWORK out, not this machine. Any web page open in the
// operator's browser can send requests to 127.0.0.1, and an HTTP API answers a
// cross-origin <img> or form post as readily as it answers us. Pat, the one
// HTTP service here, is therefore also patched to demand a per-launch token
// and an exact Host header (vendor/pat/patches/0001), on a port chosen fresh
// each launch.
//
// OPEN: rigctld and ardopcf are line protocols on fixed ports with no
// authentication. A page's no-cors POST still delivers a body it controls,
// after HTTP header lines these daemons may simply reject and read past, so a
// cross-protocol request is not ruled out. Not yet verified either way.

export const LOOPBACK_HOST = "127.0.0.1";

/** A listen address for services that take a single host:port string. */
export function loopbackAddr(port: number): string {
  return `${LOOPBACK_HOST}:${port}`;
}
