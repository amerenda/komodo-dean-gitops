#!/bin/bash
# Writes a node-exporter textfile-collector .prom file with mac-mini-m4's
# native TCP ephemeral-port state. Must run natively on macOS (via
# LaunchDaemon) — node-exporter itself runs inside OrbStack's Linux VM and
# has no visibility into the real Darwin netinet stack (see
# INC-2026-09-07: `netstat -n -p tcp` inside a container reflects the VM's
# own network namespace, not the host's).
#
# Run every 30s by com.local.tcp-textfile-exporter.plist.
set -euo pipefail

OUT_DIR="${TCP_TEXTFILE_DIR:-/Users/alex/monitoring/textfile-collector}"
OUT_FILE="$OUT_DIR/mac_mini_tcp.prom"

mkdir -p "$OUT_DIR"
TMP_FILE="$(mktemp "$OUT_DIR/.mac_mini_tcp.prom.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

time_wait_count="$(netstat -n -p tcp 2>/dev/null | grep -c TIME_WAIT || true)"
port_first="$(sysctl -n net.inet.ip.portrange.first)"
port_last="$(sysctl -n net.inet.ip.portrange.last)"
ephemeral_total=$(( port_last - port_first + 1 ))
utilization="$(awk -v tw="$time_wait_count" -v total="$ephemeral_total" \
  'BEGIN { if (total > 0) printf "%.6f", tw / total; else print "0" }')"

cat > "$TMP_FILE" <<EOF
# HELP mac_mini_tcp_time_wait_sockets TCP sockets in TIME_WAIT on mac-mini-m4's native macOS network stack.
# TYPE mac_mini_tcp_time_wait_sockets gauge
mac_mini_tcp_time_wait_sockets $time_wait_count
# HELP mac_mini_tcp_ephemeral_ports_total Size of the ephemeral port pool (net.inet.ip.portrange.last - .first + 1).
# TYPE mac_mini_tcp_ephemeral_ports_total gauge
mac_mini_tcp_ephemeral_ports_total $ephemeral_total
# HELP mac_mini_tcp_ephemeral_port_utilization_ratio TIME_WAIT sockets as a fraction of the ephemeral port pool. INC-2026-09-07 reached 1.0 (34539 TIME_WAIT against a 16383-port pool), blocking all new outbound TCP.
# TYPE mac_mini_tcp_ephemeral_port_utilization_ratio gauge
mac_mini_tcp_ephemeral_port_utilization_ratio $utilization
EOF

trap - EXIT
mv "$TMP_FILE" "$OUT_FILE"
