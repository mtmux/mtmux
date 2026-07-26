// Single entry-point used by apps/cli to embed the relay alongside Next.js.
// The CLI bundle inlines this and the workspace packages it transitively
// depends on (@repo/logger, @repo/protocol). External npm deps stay external.

export { createWsServerNoBind, attachUpgrade } from "./ws-server.js";
export { wireConnections } from "./wire-connections.js";
export { handleRelayRequest, PAIR_LOCAL_PATH } from "./server.js";
export { issuePairingNonce, onPairingRedeemed } from "./pairing-local.js";
