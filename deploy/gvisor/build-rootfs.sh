#!/bin/sh
# Build the root filesystem of a gVisor box template (issue #85), on the box
# host, as root. gVisor boxes run this tree read-only, each box writing into
# its own overlay, so build it once per release:
#
#   sudo deploy/gvisor/build-rootfs.sh tnega-0.5.7.tgz [template-name]
#
# Puts the tree at /var/lib/tnega/templates/<name>/rootfs (default name
# tnega-box): Ubuntu 22.04 minbase, Node 22, the packed tnega and the same
# start script as the E2B template (deploy/e2b/template/start.sh).
#
# Mirrors, for hosts where the defaults are slow (a China-region host fetches
# github.com and nodejs.org at a few KB/s):
#   UBUNTU_MIRROR  default http://archive.ubuntu.com/ubuntu
#                  e.g. http://mirrors.aliyun.com/ubuntu
#   NODE_MIRROR    default https://nodejs.org/dist
#                  e.g. https://npmmirror.com/mirrors/node
#   NODE_VERSION   default 22.23.0
set -eu

package="${1:?usage: build-rootfs.sh <tnega-*.tgz> [template-name]}"
name="${2:-tnega-box}"
case "$name" in
  *[!a-z0-9._-]*|'') echo "template name must be lower-case letters, digits, . _ -" >&2; exit 1 ;;
esac
ubuntu="${UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
node_mirror="${NODE_MIRROR:-https://nodejs.org/dist}"
node_version="${NODE_VERSION:-22.23.0}"
here="$(cd "$(dirname "$0")" && pwd)"
target="/var/lib/tnega/templates/$name"
work="$target.building"

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v debootstrap >/dev/null || { echo "needs debootstrap (apt install debootstrap)" >&2; exit 1; }

rm -rf "$work"
mkdir -p "$work"
debootstrap --variant=minbase --include=ca-certificates,curl,git,ripgrep,procps,python3,xz-utils jammy "$work/rootfs" "$ubuntu"

arch="$(uname -m)"
case "$arch" in
  x86_64) node_arch=x64 ;;
  aarch64) node_arch=arm64 ;;
  *) echo "unsupported architecture $arch" >&2; exit 1 ;;
esac
node_tar="node-v$node_version-linux-$node_arch.tar.xz"
curl -fsSL "$node_mirror/v$node_version/$node_tar" -o "$work/$node_tar"
curl -fsSL "$node_mirror/v$node_version/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
(cd "$work" && grep " $node_tar\$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "$work/$node_tar" -C "$work/rootfs/usr/local" --strip-components=1

cp "$package" "$work/rootfs/tmp/tnega.tgz"
chroot "$work/rootfs" /usr/local/bin/npm install -g /tmp/tnega.tgz
rm "$work/rootfs/tmp/tnega.tgz"

install -m 0755 "$here/../e2b/template/start.sh" "$work/rootfs/usr/local/bin/tnega-box-start"
mkdir -p "$work/rootfs/workspace"
# No DNS in a box: the start script maps the server's name, the proxy resolves the rest.
: > "$work/rootfs/etc/resolv.conf"

rm -f "$work/$node_tar" "$work/SHASUMS256.txt"
rm -rf "$target"
mv "$work" "$target"
echo "template $name ready at $target/rootfs"
