import { randomBytes } from 'node:crypto'

/**
 * The files `tnega server deploy` writes: a Docker Compose project with
 * Postgres, the tnega server, and Caddy in front for HTTPS when a domain is
 * given. Pure text here, so a test can read what would be written.
 */

export interface DeployOptions {
  /** A DNS name pointing at this host: Caddy gets a certificate for it. */
  domain?: string
  /** For the certificate authority's notices; optional. */
  email?: string
  /** The npm version of tnega the image installs. */
  version: string
  /** Where the server is published on this host when there is no domain. */
  port: number
  /**
   * Pull the base images from this registry path instead of Docker Hub
   * (`public.ecr.aws/docker/library`, or a mirror reachable in your region).
   */
  mirror?: string
  /** Debian package mirror for the image (`http://mirrors.aliyun.com`). */
  aptMirror?: string
  /** npm registry for installing tnega in the image (`https://registry.npmmirror.com`). */
  npmRegistry?: string
  /** A packed tnega (`npm pack`) copied next to the files and installed instead of the npm one. */
  packageFile?: string
}

/** The images a deploy uses, from Docker Hub or the mirror. */
export function deployImages(options: Pick<DeployOptions, 'mirror'>): { postgres: string; node: string; caddy: string } {
  const prefix = options.mirror ? `${options.mirror.replace(/\/+$/u, '')}/` : ''
  return { postgres: `${prefix}postgres:17`, node: `${prefix}node:22-bookworm-slim`, caddy: `${prefix}caddy:2` }
}

/** Only a packed tnega goes into the image build; `.env` and the rest stay out of it. */
export const DOCKERIGNORE = '*\n!*.tgz\n'

/** `KEY=value` lines; values here never need quoting (hex, base64, plain words). */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return values
}

export function formatEnvFile(values: Readonly<Record<string, string>>, header: string): string {
  const lines = Object.entries(values).map(([key, value]) => {
    if (/[\r\n]/u.test(value)) throw new Error(`${key} cannot hold a line break`)
    return `${key}=${value}`
  })
  return `${header.split('\n').map(line => `# ${line}`).join('\n')}\n${lines.join('\n')}\n`
}

export function newMasterKey(): string {
  return randomBytes(32).toString('base64')
}

/** A database password with nothing a URL would need to escape. */
export function newDatabasePassword(): string {
  return randomBytes(24).toString('hex')
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu

export function assertDomain(domain: string): void {
  if (!DOMAIN.test(domain)) throw new Error(`${domain} is not a DNS name (an IP address cannot get a certificate here; use --port and an SSH tunnel, or a name)`)
}

export const SERVER_DOCKERFILE = `# The tnega server image: Node, the tools agents use, and tnega from npm.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM \${NODE_IMAGE}
# APT_MIRROR replaces deb.debian.org (http://mirrors.aliyun.com, say; the image has no CA bundle before this step).
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|http://deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \\
 && apt-get update \\
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates git ripgrep tini \\
 && rm -rf /var/lib/apt/lists/*
# TNEGA_PACKAGE is an npm spec (tnega@0.6.0) or a packed file copied in below.
ARG TNEGA_PACKAGE=tnega@latest
ARG NPM_REGISTRY=
COPY . /build/
RUN npm install -g \${NPM_REGISTRY:+--registry=$NPM_REGISTRY} "\${TNEGA_PACKAGE}" && npm cache clean --force && rm -rf /build
# The server runs as its own user; everything it keeps is under /data.
RUN useradd --create-home --uid 10001 tnega && mkdir -p /data && chown tnega:tnega /data
USER tnega
ENV HOME=/data TNEGA_SERVER_DIR=/data/server
WORKDIR /data
EXPOSE 8765
ENTRYPOINT ["tini", "--"]
CMD ["tnega", "server", "start"]
`

export function caddyfile(options: DeployOptions): string {
  if (!options.domain) throw new Error('Caddy needs a domain')
  return `${options.email ? `{\n\temail ${options.email}\n}\n\n` : ''}${options.domain} {
\tencode zstd gzip
\treverse_proxy server:8765 {
\t\t# Server-sent events: hand bytes on as they come.
\t\tflush_interval -1
\t}
}
`
}

export function composeFile(options: DeployOptions): string {
  const caddy = options.domain !== undefined
  const images = deployImages(options)
  return `# Written by \`tnega server deploy\`. Secrets are in .env next to this file.
name: tnega

services:
  postgres:
    image: \${POSTGRES_IMAGE:-${images.postgres}}
    restart: unless-stopped
    environment:
      POSTGRES_USER: tnega
      POSTGRES_DB: tnega
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?run tnega server deploy}
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tnega -d tnega"]
      interval: 2s
      timeout: 5s
      retries: 30

  server:
    build:
      context: .
      dockerfile: server.Dockerfile
      args:
        NODE_IMAGE: \${NODE_IMAGE:-${images.node}}
        TNEGA_PACKAGE: \${TNEGA_PACKAGE:-tnega@${options.version}}
        NPM_REGISTRY: \${NPM_REGISTRY:-${options.npmRegistry ?? ''}}
        APT_MIRROR: \${APT_MIRROR:-${options.aptMirror ?? ''}}
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://tnega:\${POSTGRES_PASSWORD}@postgres:5432/tnega
      TNEGA_MASTER_KEY: \${TNEGA_MASTER_KEY:?run tnega server deploy}
      TNEGA_SERVER_HOST: 0.0.0.0
      TNEGA_SERVER_PORT: "8765"
${caddy
    ? `      # Caddy terminates TLS in front; trust what it says about the client.
      TNEGA_TRUST_PROXY: "1"
      TNEGA_PUBLIC_URL: https://${options.domain}
`
    : `      # Published on this host's loopback only: reach it over an SSH tunnel.
      TNEGA_ALLOW_HTTP: "1"
      TNEGA_PUBLIC_URL: http://localhost:${options.port}
`}    volumes:
      - data:/data
    # bubblewrap, the command sandbox, needs user namespaces inside the container.
    security_opt:
      - seccomp=unconfined
      - apparmor=unconfined
    ports:
      - "127.0.0.1:${options.port}:8765"
${caddy
    ? `
  caddy:
    image: \${CADDY_IMAGE:-${images.caddy}}
    restart: unless-stopped
    depends_on:
      - server
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
`
    : ''}
volumes:
  postgres:
  data:
${caddy ? '  caddy-data:\n  caddy-config:\n' : ''}`
}
