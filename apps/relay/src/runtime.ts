// Single entry-point used by apps/cli to embed the relay alongside Next.js.
// The CLI bundle inlines this and the workspace packages it transitively
// depends on (@repo/logger, @repo/protocol). External npm deps stay external.

export { createWsServerNoBind, attachUpgrade } from "./ws-server.js";
export { wireConnections } from "./wire-connections.js";
export {
  handleRelayRequest,
  PAIR_LOCAL_PATH,
  PAIR_SESSION_PATH,
} from "./server.js";
export {
  issuePairingNonce,
  onPairingRedeemed,
  onSessionTokenUsed,
  registerSessionToken,
  revokeSessionToken,
} from "./pairing-local.js";
export {
  connectionSummary,
  onConnectionsChanged,
  type ConnectedDevice,
} from "./connection-manager.js";

/**
 * Recording, for `mtmux record`'s loopback control endpoint.
 *
 * Namespaced rather than re-exported one function at a time: `list` and
 * `remove` come from the index and `start`/`stop` from the recorder, and
 * flattening those into the runtime's top level would put four very
 * generic names beside `wireConnections`.
 */
export * as recorder from "./recorder.js";
export * as recordings from "./recordings-index.js";
