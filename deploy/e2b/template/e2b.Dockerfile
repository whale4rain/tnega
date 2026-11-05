# The tnega box: E2B builds this into a Firecracker template (docs/adr/0018-microvm-box-layer.md).
# Build from the repository root, see README.md:
#   pnpm build && pnpm pack --pack-destination deploy/e2b/template
#   e2b template build -p deploy/e2b/template -n tnega-box -c "/usr/local/bin/tnega-box-start"
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# tnega from the packed tarball, so the box runs exactly the build being deployed.
COPY tnega-*.tgz /tmp/
RUN npm install -g /tmp/tnega-*.tgz && rm /tmp/tnega-*.tgz

COPY start.sh /usr/local/bin/tnega-box-start
RUN chmod 0755 /usr/local/bin/tnega-box-start && mkdir -p /workspace

WORKDIR /workspace
