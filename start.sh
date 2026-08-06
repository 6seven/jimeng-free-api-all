#!/usr/bin/env bash
set -euo pipefail

remote_host="192.168.2.157"
container="jimeng-free-api"
local_port="18001"
remote_url="http://$remote_host:8001"
local_url="http://127.0.0.1:$local_port"
ssh_options=(-o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=2)

command -v ssh >/dev/null 2>&1 || {
  printf 'OpenSSH is required.\n' >&2
  exit 1
}

printf 'Jimeng Free API remote host: %s\n' "$remote_host"
printf 'Service: %s\n' "$remote_url"
printf 'Local tunnel: %s\n' "$local_url"

stop_remote() {
  exit_status=$?
  trap - EXIT INT TERM
  ssh "${ssh_options[@]}" "$remote_host" "docker stop --time 20 $container >/dev/null"
  exit "$exit_status"
}

trap stop_remote EXIT INT TERM
ssh "${ssh_options[@]}" "$remote_host" "docker start $container >/dev/null"

ssh "${ssh_options[@]}" -o ExitOnForwardFailure=yes -N \
  -L "127.0.0.1:$local_port:$remote_host:8001" "$remote_host" &
tunnel_pid=$!

if ! wait "$tunnel_pid"; then
  printf 'SSH tunnel stopped unexpectedly.\n' >&2
  exit 1
fi
