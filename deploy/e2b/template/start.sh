#!/bin/sh
# Starts the daemon in a tnega box. Not the template's start command: E2B runs
# that once at build time and snapshots it, so it would never see a box's own
# token. The Machine Provider runs this script as root through E2B's command API
# on each start (unless the daemon already runs), with these in its environment:
#   TNEGA_SERVER        where the daemon dials (wss://)
#   TNEGA_DAEMON_TOKEN  the box's one-time daemon token
#   TNEGA_WORKSPACE     the workspace inside the box
#   HTTPS_PROXY ...     the egress proxy with the box's proxy token (egress boxes)
#   TNEGA_EGRESS_CA     the CA the egress proxy signs key-carrying hosts with
#   TNEGA_HOSTS         "address name" lines for the server: the box firewall
#                       allows addresses only and no DNS, so its name is mapped here
#                       (gVisor boxes get a ready /etc/hosts from the host instead)
# The CA goes to a file every tool trusts, then leaves the environment, so no
# command the agent runs sees it twice. The daemon removes its own token from
# its environment before it runs anything.
#
# A gVisor box runs as the owner of the folder it mounts, not root: then the
# certificates go to a folder of the box's own and HOME is created on /tmp.
set -eu

if [ "$(id -u)" = 0 ]; then
  certs=/etc/ssl/certs
else
  mkdir -p "${HOME:-/tmp/home}"
  certs=/tmp/tnega-certs
  mkdir -p "$certs"
fi

: "${TNEGA_SERVER:?TNEGA_SERVER is not set}"
: "${TNEGA_DAEMON_TOKEN:?TNEGA_DAEMON_TOKEN is not set}"
workspace="${TNEGA_WORKSPACE:-/workspace}"
mkdir -p "$workspace"

if [ -n "${TNEGA_HOSTS:-}" ]; then
  printf '%s\n' "$TNEGA_HOSTS" >> /etc/hosts
  unset TNEGA_HOSTS
fi

if [ -n "${TNEGA_EGRESS_CA:-}" ]; then
  ca="$certs/tnega-egress.pem"
  printf '%s\n' "$TNEGA_EGRESS_CA" > "$ca"
  # One bundle with the system roots and the egress CA, for tools that take a single file.
  bundle="$certs/tnega-bundle.pem"
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
