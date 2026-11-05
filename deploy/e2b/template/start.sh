#!/bin/sh
# Start command of the tnega box. The Machine Provider sets, through E2B:
#   TNEGA_SERVER        where the daemon dials (wss://)
#   TNEGA_DAEMON_TOKEN  the box's one-time daemon token
#   TNEGA_WORKSPACE     the workspace inside the box
#   HTTPS_PROXY ...     the egress proxy with the box's proxy token (egress boxes)
#   TNEGA_EGRESS_CA     the CA the egress proxy signs key-carrying hosts with
# The CA goes to a file every tool trusts, then leaves the environment, so no
# command the agent runs sees it twice. The daemon removes its own token from
# its environment before it runs anything.
set -eu

: "${TNEGA_SERVER:?TNEGA_SERVER is not set}"
: "${TNEGA_DAEMON_TOKEN:?TNEGA_DAEMON_TOKEN is not set}"
workspace="${TNEGA_WORKSPACE:-/workspace}"
mkdir -p "$workspace"

if [ -n "${TNEGA_EGRESS_CA:-}" ]; then
  ca=/etc/ssl/certs/tnega-egress.pem
  printf '%s\n' "$TNEGA_EGRESS_CA" > "$ca"
  # One bundle with the system roots and the egress CA, for tools that take a single file.
  bundle=/etc/ssl/certs/tnega-bundle.pem
  cat /etc/ssl/certs/ca-certificates.crt "$ca" > "$bundle"
  export NODE_EXTRA_CA_CERTS="$ca"
  export SSL_CERT_FILE="$bundle"
  export REQUESTS_CA_BUNDLE="$bundle"
  export CURL_CA_BUNDLE="$bundle"
  export GIT_SSL_CAINFO="$bundle"
  export PIP_CERT="$bundle"
  export npm_config_cafile="$bundle"
  unset TNEGA_EGRESS_CA
fi

exec tnega daemon --server "$TNEGA_SERVER" --workspace "$workspace"
