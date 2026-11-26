#!/bin/sh
# Capability probe for the Docker and services benchmark. Read-only apart from a throwaway cgroup
# directory and user namespace. Prints one key=value line per fact; the harness parses them
# (bench/src/services/probe.ts). Never fails: a missing tool is a fact, not an error.
export LC_ALL=C PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"

has() { command -v "$1" >/dev/null 2>&1; }
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }
kv() { printf '%s=%s\n' "$1" "$(printf '%s' "$2" | tr '\n=' '  ' | cut -c1-300)"; }
t() { if has timeout; then timeout "$@"; else shift; "$@"; fi; }

uid=$(id -u)
kv uid "$uid"
kv user "$(id -un 2>/dev/null)"
kv arch "$(uname -m)"
kv kernel "$(uname -r)"
kv os "$(. /etc/os-release 2>/dev/null; echo "${ID:-unknown} ${VERSION_ID:-}")"
kv libc "$(if ldd --version 2>&1 | grep -qi musl; then echo musl; elif ldd --version >/dev/null 2>&1; then echo "glibc $(ldd --version 2>&1 | head -1 | awk '{print $NF}')"; else echo unknown; fi)"
if [ "$uid" = 0 ]; then kv sudo root; elif has sudo && t 5 sudo -n true >/dev/null 2>&1; then kv sudo passwordless; else kv sudo no; fi

# Where the sandbox runs: a VM, a container, or gVisor.
virt=unknown
# systemd-detect-virt prints "none" and exits 1 on bare metal; keep its one word either way.
if has systemd-detect-virt; then virt=$(systemd-detect-virt 2>/dev/null | head -1); [ -n "$virt" ] || virt=none; fi
kv virt "$virt"
gvisor=no
if [ "$(uname -r)" = "4.4.0" ] || (dmesg 2>/dev/null | grep -qi gvisor); then gvisor=yes; fi
kv gvisor "$gvisor"
kv hypervisorFlag "$(yn grep -qw hypervisor /proc/cpuinfo)"
kv dmiVendor "$(cat /sys/class/dmi/id/sys_vendor 2>/dev/null || echo none)"
kv dmiProduct "$(cat /sys/class/dmi/id/product_name 2>/dev/null || echo none)"
kv containerMarker "$(if [ -f /.dockerenv ]; then echo dockerenv; elif [ -f /run/.containerenv ]; then echo containerenv; else echo none; fi)"
kv pid1 "$(cat /proc/1/comm 2>/dev/null || echo unknown)"

# Nested virtualization: a usable /dev/kvm and the CPU flag inside the guest.
kv kvmDevice "$(if [ -c /dev/kvm ]; then if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then echo rw; else echo present; fi; else echo none; fi)"
kv vmxSvm "$(yn grep -qwE 'vmx|svm' /proc/cpuinfo)"

# What a container runtime needs from the kernel and the sandbox.
capeff=$(awk '/^CapEff/ {print $2}' /proc/self/status 2>/dev/null)
kv capEff "${capeff:-unknown}"
if [ -n "$capeff" ]; then
  caps=$(printf '%d' "0x$capeff" 2>/dev/null || echo 0)
  kv capSysAdmin "$(if [ $(( (caps >> 21) & 1 )) = 1 ]; then echo yes; else echo no; fi)"
  kv capNetAdmin "$(if [ $(( (caps >> 12) & 1 )) = 1 ]; then echo yes; else echo no; fi)"
fi
kv seccomp "$(awk '/^Seccomp:/ {print $2}' /proc/self/status 2>/dev/null || echo unknown)"
kv noNewPrivs "$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status 2>/dev/null || echo unknown)"
kv cgroupFs "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo none)"
kv cgroupControllers "$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || echo none)"
cgw=no
if [ "$uid" = 0 ] && mkdir /sys/fs/cgroup/sbx-probe 2>/dev/null; then rmdir /sys/fs/cgroup/sbx-probe 2>/dev/null; cgw=yes; fi
kv cgroupWritable "$cgw"
kv overlayFs "$(yn grep -qw overlay /proc/filesystems)"
kv fuseDevice "$(if [ -c /dev/fuse ]; then echo yes; else echo no; fi)"
kv iptables "$(if has iptables; then iptables --version 2>/dev/null | head -1; else echo none; fi)"
kv nft "$(if has nft; then echo yes; else echo no; fi)"
kv userns "$(if has unshare; then yn t 5 unshare -Ur true; else echo no-unshare; fi)"
kv maxUserNamespaces "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unknown)"
kv newuidmap "$(if has newuidmap; then echo yes; else echo no; fi)"
kv subuid "$(if grep -q "^$(id -un 2>/dev/null):" /etc/subuid 2>/dev/null; then echo yes; else echo no; fi)"

# Container tooling already in the image.
kv dockerCli "$(if has docker; then docker --version 2>/dev/null | head -1; else echo none; fi)"
dinfo=no
if has docker; then
  if t 15 docker info >/dev/null 2>&1; then dinfo=yes
  elif [ "$uid" != 0 ] && t 5 sudo -n docker info >/dev/null 2>&1; then dinfo=sudo; fi
fi
kv dockerInfo "$dinfo"
kv dockerd "$(if has dockerd; then echo yes; else echo no; fi)"
kv dockerSocket "$(if [ -S /var/run/docker.sock ]; then echo yes; else echo no; fi)"
kv composePlugin "$(if has docker && t 10 docker compose version >/dev/null 2>&1; then docker compose version --short 2>/dev/null; else echo none; fi)"
kv podman "$(if has podman; then podman --version 2>/dev/null | head -1; else echo none; fi)"
kv podmanInfo "$(if has podman; then yn t 20 podman info; else echo no; fi)"
kv containerd "$(if has containerd; then echo yes; else echo no; fi)"

# What the no-Docker path needs.
kv node "$(if has node; then node --version 2>/dev/null; else echo none; fi)"
kv setpriv "$(if has setpriv; then echo yes; else echo no; fi)"
kv libstdcxx "$(if ldconfig -p 2>/dev/null | grep -q 'libstdc++.so.6'; then echo yes; elif ls /usr/lib*/libstdc++.so.6 /usr/lib*/*/libstdc++.so.6 /lib*/*/libstdc++.so.6 >/dev/null 2>&1; then echo yes; else echo no; fi)"
kv aptGet "$(if has apt-get; then echo yes; else echo no; fi)"
kv curl "$(if has curl; then echo yes; else echo no; fi)"
kv tmpFreeMb "$(df -Pm /tmp 2>/dev/null | awk 'NR==2 {print $4}')"
kv rootFreeMb "$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4}')"
kv memTotalMb "$(awk '/^MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
kv nproc "$(nproc 2>/dev/null || echo unknown)"

# Docker Hub reachability (the compose path pulls from it). 401 is the healthy answer.
kv dockerHub "$(if has curl; then t 20 curl -s -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/ 2>/dev/null || echo error; else echo no-curl; fi)"
