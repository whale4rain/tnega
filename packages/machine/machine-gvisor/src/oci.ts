import type { BoxSpec } from '@tnega/machine'

/** Where one box's pieces live on the host. */
export interface BoxPaths {
  /** The template's root filesystem: the shared, never-written lower layer. */
  rootfs: string
  /** The box's own directory: bundle, writable upper layer, workspace, checkpoint. */
  box: string
  bundle: string
  /** gVisor's overlay filestore: everything the box writes outside its workspace. */
  upper: string
  /** The workspace volume, mounted at `spec.workspacePath`; it outlives a cold pause. */
  workspace: string
  checkpoint: string
  /** The box's `/etc/hosts`, written on the host and mounted read-only (the box has no DNS). */
  hosts: string
  /**
   * runsc's own log for the calls that detach. Their output goes nowhere (a
   * pipe would kill the box), so this is where a failed start says why.
   */
  log: string
  /** The network namespace the box's netstack copies its interface from. */
  netns: string
}

/** Defaults from issue #85: one box must not take a 2 vCPU / 3.6 GiB host down with it. */
export const DEFAULT_RESOURCES = { cpus: 1.5, memoryMb: 768, pids: 512 } as const

const CPU_PERIOD = 100_000

/** Who the box's processes run as, inside the sentry. */
export interface BoxUser { uid: number; gid: number }

/**
 * The OCI runtime spec of a box. The daemon starts with no capabilities and
 * no new privileges, as `user`: the owner of a mounted host folder (so it can
 * write its workspace and nothing of anyone else's), else uid 0, which then
 * owns only what the box itself made.
 */
export function ociConfig(spec: BoxSpec, paths: BoxPaths, env: Readonly<Record<string, string>>, cgroup: string, user: BoxUser = { uid: 0, gid: 0 }): Record<string, unknown> {
  const resources = { ...DEFAULT_RESOURCES, ...spec.resources }
  const variables = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // Another user has no home in the template; /tmp is the box's own tmpfs.
    HOME: user.uid === 0 ? '/root' : '/tmp/home',
    LANG: 'C.UTF-8',
    ...env,
  }
  return {
    ociVersion: '1.0.2',
    process: {
      terminal: false,
      user: { uid: user.uid, gid: user.gid },
      args: ['/usr/local/bin/tnega-box-start'],
      env: Object.entries(variables).map(([name, value]) => `${name}=${value}`),
      cwd: '/',
      capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] },
      noNewPrivileges: true,
      rlimits: [{ type: 'RLIMIT_NOFILE', hard: 65_536, soft: 65_536 }],
    },
    // Writable only through gVisor's overlay (`--overlay2 root:<upper>`): the template on the host is never written.
    root: { path: paths.rootfs, readonly: false },
    hostname: 'tnega-box',
    mounts: [
      { destination: '/proc', type: 'proc', source: 'proc' },
      { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
      { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'mode=1777'] },
      { destination: spec.workspacePath, type: 'bind', source: paths.workspace, options: ['rbind', 'rw'] },
      { destination: '/etc/hosts', type: 'bind', source: paths.hosts, options: ['rbind', 'ro'] },
    ],
    linux: {
      cgroupsPath: cgroup,
      resources: {
        memory: { limit: resources.memoryMb * 1024 * 1024 },
        cpu: { quota: Math.round(resources.cpus * CPU_PERIOD), period: CPU_PERIOD },
        pids: { limit: resources.pids },
      },
      namespaces: [
        { type: 'pid' },
        { type: 'ipc' },
        { type: 'uts' },
        { type: 'mount' },
        { type: 'network', path: paths.netns },
      ],
    },
    annotations: { ...spec.labels, 'dev.tnega.box': 'true' },
  }
}

export interface RunscGlobals {
  /** runsc's state directory (`--root`), private to tnega. */
  root: string
  platform: string
}

/**
 * Flags every runsc call for a box carries. `--network=sandbox` keeps the
 * netstack inside the sentry (the host kernel's network code never sees the
 * box's packets); the box's namespace decides where they can go.
 */
export function runscGlobals(globals: RunscGlobals): string[] {
  return ['--root', globals.root, '--platform', globals.platform, '--network', 'sandbox', '--host-uds', 'none']
}

/**
 * The root overlay: every write outside the workspace goes to the box's own
 * upper layer, a directory on the host (`dir=`; runsc takes no bare path).
 */
function overlay(paths: BoxPaths): string[] {
  return ['--overlay2', `root:dir=${paths.upper}`, '--log', paths.log]
}

/**
 * `runsc run --detach`: create and start in one call that returns once the
 * box runs. (`runsc start` is the OCI foreground call and has no `--detach`.)
 */
export function runscRun(globals: RunscGlobals, paths: BoxPaths, id: string): string[] {
  return [...runscGlobals(globals), ...overlay(paths), 'run', '--detach', '--bundle', paths.bundle, id]
}

export function runscRestore(globals: RunscGlobals, paths: BoxPaths, id: string): string[] {
  return [...runscGlobals(globals), ...overlay(paths), 'restore', '--detach', '--image-path', paths.checkpoint, '--bundle', paths.bundle, id]
}
