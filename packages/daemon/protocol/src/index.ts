/**
 * The daemon protocol: JSON-RPC 2.0 between a tnega runtime (the side that
 * runs the agent) and a daemon (the side that owns files and commands). One
 * connection per daemon; the daemon dials out and sends `initialize` first.
 *
 * Plain JSON only: bytes travel as base64 with a size cap, long output as
 * notifications, cancellation as `$/cancel` with the request id. Method
 * namespaces mirror the seams (`fs/*`, `process/*`, `http/*`).
 *
 * See docs/plans/v2-plan.md ("Daemon protocol") and v2-package-changes.md (P4).
 */

export * from './methods.js'
export * from './peer.js'
export * from './transport.js'
export * from './link.js'

export const name = '@tnega/daemon-protocol'
