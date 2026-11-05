# The tnega box: E2B builds this into a Firecracker template (docs/adr/0018-microvm-box-layer.md).
# Build from the repository root with E2B's template build v2, see README.md:
#   E2B_API_KEY=... pnpm try:boxes template
# No start command: the Machine Provider starts the daemon in each box.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl procps python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# tnega from the packed tarball, so the box runs exactly the build being deployed.
COPY tnega-*.tgz /tmp/
RUN npm install -g /tmp/tnega-*.tgz && rm /tmp/tnega-*.tgz

COPY start.sh /usr/local/bin/tnega-box-start
RUN chmod 0755 /usr/local/bin/tnega-box-start && mkdir -p /workspace

WORKDIR /workspace
