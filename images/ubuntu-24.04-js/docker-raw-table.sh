#!/bin/sh
# Decides, at every boot and before dockerd starts, whether dockerd may use the
# iptables raw table. docker.service runs this as ExecStartPre (see
# docker-raw-table.conf) and reads the file it writes through EnvironmentFile=.
#
# Docker Engine 28 and later add a raw-table PREROUTING rule for every container
# endpoint. The rule drops a packet addressed to the container's IP unless it
# arrives on the container's own bridge ("direct access filtering"). If the
# kernel has no raw table, `docker start` fails for every container, which is
# how `container:` and `services:` jobs died on the guest:
#
#   Unable to enable DIRECT ACCESS FILTERING - DROP rule: (iptables failed:
#   iptables --wait -t raw -A PREROUTING ...: can't initialize iptables table
#   `raw': Table does not exist
#
# The pinned guest kernel (Firecracker's microvm-kernel-ci 6.1 build, see
# GUEST_KERNEL_* in deploy/provision-firecracker-host.sh) sets neither
# CONFIG_IP_NF_RAW nor CONFIG_NF_TABLES, and CONFIG_MODULES is off, so there is
# no raw table to load. Docker's documented switch for such kernels is
# DOCKER_INSECURE_NO_IPTABLES_RAW=1, which skips every raw-table rule.
#
# What that gives up, here: the rule guards containers against hosts on the
# same L2 segment that route packets straight to a container IP. The guest's
# only link is a point-to-point link whose other end is the Worker, and the
# Worker's job network policy drops whatever another guest sends towards this
# one. The one party left that could send such a packet is the Worker, which
# runs the VM and can read its memory anyway. The filter-table rules that
# isolate one Docker network from another stay in place.
#
# The answer comes from the kernel, not from this file, so a guest kernel that
# gains a raw table (CONFIG_IP_NF_RAW for the legacy backend this image
# selects) turns the protection back on without an image change.
#
# RC_DOCKER_RAW_TABLE_ENV exists so smoke.sh can run this against a scratch
# file; the unit leaves it unset.
set -eu

env_file=${RC_DOCKER_RAW_TABLE_ENV:-/run/runner-center/docker-raw-table.env}
mkdir -p "$(dirname "$env_file")"

if iptables --wait -t raw -S >/dev/null 2>&1; then
  : >"$env_file"
  echo 'iptables raw table present: dockerd keeps direct access filtering'
else
  printf 'DOCKER_INSECURE_NO_IPTABLES_RAW=1\n' >"$env_file"
  echo 'guest kernel has no iptables raw table: starting dockerd with DOCKER_INSECURE_NO_IPTABLES_RAW=1'
fi
