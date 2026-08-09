#!/usr/bin/env python3
"""
dns-udp-proxy.py — UDP + TCP DNS proxy: 10.100.20.240:53 → 127.0.0.1:5354 (Technitium)

Listens directly on port 53 (requires root / LaunchDaemon) on the dedicated
DNS alias IP and forwards to Technitium running inside the OrbStack VM via
OrbStack's localhost forwarder on port 5354.

Why a userspace proxy (not pf rdr):
  pf rdr redirects packets across interfaces (en0 → bridge100), but stateful
  return-path tracking breaks across interface boundaries on macOS — the VM's
  reply arrives on bridge100 without matching the state created on en0, so
  responses are never delivered. A userspace proxy on the Mac host receives on
  en0/utun0, forwards to 127.0.0.1:5354 (loopback), and returns replies to
  the original client — all without crossing interface boundaries.

OrbStack publishes TCP/UDP :5354 on localhost and forwards into the Linux VM
reliably. Override with DNS_PROXY_BACKEND_IP env var if your layout differs.

Per-client query log:
  Technitium sees every query as coming from loopback (this proxy re-originates
  from 127.0.0.1), so its own logs cannot attribute queries to LAN devices.
  This proxy is the only place the real client IP still exists, so it records
  (timestamp, client_ip, qname, qtype) for every query into a small SQLite DB
  (DNS_PROXY_CLIENTLOG, default /var/log/dns-proxy-clients.db). Logging happens
  on a background writer thread via a non-blocking queue — it can never slow or
  break the DNS path. Rows older than DNS_PROXY_CLIENTLOG_DAYS (default 7) are
  pruned hourly. Set DNS_PROXY_CLIENTLOG_ENABLED=0 to disable.

Runs as root via LaunchDaemon at boot.
"""

from __future__ import annotations

import os
import socket
import struct
import threading
import syslog
import sys
import ipaddress
import time
import queue

LISTEN_IP    = "10.100.20.240"
LISTEN_PORT  = 53
BACKEND_IP   = os.environ.get("DNS_PROXY_BACKEND_IP", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("DNS_PROXY_BACKEND_PORT", "5354"))
TIMEOUT      = 3

# Optional: force source IP for backend sockets. If unset, resolved at startup.
BACKEND_SRC_IP = os.environ.get("DNS_PROXY_BACKEND_SRC", "").strip() or None

# Per-client query log (SQLite). See module docstring.
CLIENTLOG_ENABLED = os.environ.get("DNS_PROXY_CLIENTLOG_ENABLED", "1").strip().lower() \
    not in ("0", "false", "no", "off", "")
CLIENTLOG_PATH = os.environ.get("DNS_PROXY_CLIENTLOG", "/var/log/dns-proxy-clients.db").strip()
CLIENTLOG_DAYS = int(os.environ.get("DNS_PROXY_CLIENTLOG_DAYS", "7"))

# Bounded queue so a slow/stuck writer can never grow memory unbounded or block
# the DNS path — producers use put_nowait and drop on overflow.
_clientlog_q: "queue.Queue" = queue.Queue(maxsize=100000)

# Lightweight counters (best-effort; UDP errors are the main signal).
_stats_lock = threading.Lock()
_stats = {"udp_ok": 0, "udp_err": 0, "tcp_ok": 0, "tcp_err": 0}
_stats_last_log = 0.0


def _resolve_backend_src_ip() -> str:
    """
    Local IPv4 the kernel would use to reach BACKEND_IP (OrbStack VM).
    Binding backend UDP/TCP sockets to this address avoids intermittent
    packet loss when the default source address or return path flaps
    (e.g. multiple defaults / Tailscale routes).
    """
    if BACKEND_SRC_IP:
        return BACKEND_SRC_IP
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect((BACKEND_IP, 1))
        return probe.getsockname()[0]
    finally:
        probe.close()


def _bump(stat: str) -> None:
    global _stats_last_log
    with _stats_lock:
        _stats[stat] = _stats.get(stat, 0) + 1
        now = time.monotonic()
        if now - _stats_last_log >= 300.0:
            _stats_last_log = now
            syslog.syslog(
                syslog.LOG_INFO,
                "dns-proxy stats "
                f"udp_ok={_stats['udp_ok']} udp_err={_stats['udp_err']} "
                f"tcp_ok={_stats['tcp_ok']} tcp_err={_stats['tcp_err']}",
            )


# ── Per-client query log ─────────────────────────────────────────────────────

def _parse_question(data: bytes):
    """Extract (qname, qtype) from a DNS query's first question.
    Returns (None, None) if the message is too short or malformed. Never raises
    for well-formed-but-weird input; callers also wrap this defensively."""
    if len(data) < 12:
        return None, None
    qdcount = struct.unpack("!H", data[4:6])[0]
    if qdcount < 1:
        return None, None
    offset = 12
    labels = []
    while offset < len(data):
        length = data[offset]
        if length == 0:
            offset += 1
            break
        # Compression pointers are illegal in a question — bail out cleanly.
        if (length & 0xC0) != 0:
            return None, None
        offset += 1
        labels.append(data[offset:offset + length])
        offset += length
    qname = b".".join(labels).decode("ascii", "replace").lower() if labels else "."
    qtype = struct.unpack("!H", data[offset:offset + 2])[0] if offset + 2 <= len(data) else None
    return qname, qtype


def log_client_query(client_ip: str, data: bytes) -> None:
    """Enqueue a client query for the background writer. Fully isolated: any
    failure here is swallowed so the DNS forwarding path is never affected."""
    if not CLIENTLOG_ENABLED:
        return
    try:
        qname, qtype = _parse_question(data)
        if qname is None:
            return
        _clientlog_q.put_nowait((time.time(), client_ip, qname, qtype))
    except queue.Full:
        pass  # drop rather than block or buffer unbounded
    except Exception:
        pass  # logging must never break resolution


def _clientlog_writer() -> None:
    """Single background thread: batch-insert queued queries into SQLite and
    prune old rows hourly. Owns the only write connection to the DB."""
    import sqlite3
    conn = sqlite3.connect(CLIENTLOG_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS client_logs ("
        " ts REAL NOT NULL, client_ip TEXT NOT NULL, qname TEXT, qtype INTEGER)"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cl_ts ON client_logs(ts)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cl_ip ON client_logs(client_ip)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_cl_qname ON client_logs(qname)")
    conn.commit()
    syslog.syslog(
        syslog.LOG_INFO,
        f"dns-proxy: client query log -> {CLIENTLOG_PATH} (retention {CLIENTLOG_DAYS}d)",
    )

    last_prune = time.monotonic()
    while True:
        batch = []
        try:
            batch.append(_clientlog_q.get(timeout=5.0))
        except queue.Empty:
            pass
        while len(batch) < 500:
            try:
                batch.append(_clientlog_q.get_nowait())
            except queue.Empty:
                break
        if batch:
            try:
                conn.executemany(
                    "INSERT INTO client_logs (ts, client_ip, qname, qtype) VALUES (?,?,?,?)",
                    batch,
                )
                conn.commit()
            except Exception as e:
                syslog.syslog(syslog.LOG_WARNING, f"dns-proxy clientlog write err {e!r}")
        now = time.monotonic()
        if now - last_prune >= 3600.0:
            last_prune = now
            try:
                cutoff = time.time() - CLIENTLOG_DAYS * 86400
                conn.execute("DELETE FROM client_logs WHERE ts < ?", (cutoff,))
                conn.commit()
            except Exception as e:
                syslog.syslog(syslog.LOG_WARNING, f"dns-proxy clientlog prune err {e!r}")


def make_listen_socket(kind: int) -> socket.socket:
    """Create a listening socket bound to LISTEN_IP:LISTEN_PORT.
    Binding to LISTEN_IP (not 0.0.0.0) means the kernel routes replies via
    whichever interface owns that IP — en0 for LAN clients, utun0 for
    Tailscale clients — automatically, without needing IP_BOUND_IF."""
    s = socket.socket(socket.AF_INET, kind)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    return s


# ── EDNS Client Subnet ───────────────────────────────────────────────────────

def _build_ecs_option(client_ip: str) -> bytes:
    """Build an EDNS Client Subnet option (RFC 7871) for an IPv4 address."""
    addr = ipaddress.IPv4Address(client_ip)
    prefix_len = 32
    addr_bytes = addr.packed
    # OPTION-CODE=8 (CLIENT-SUBNET), FAMILY=1 (IPv4), SOURCE PREFIX, SCOPE=0
    option_data = struct.pack("!HBB", 1, prefix_len, 0) + addr_bytes
    return struct.pack("!HH", 8, len(option_data)) + option_data


def _add_ecs_to_query(data: bytes, client_ip: str) -> bytes:
    """Inject EDNS Client Subnet into a DNS query so the backend sees the real client IP."""
    if len(data) < 12:
        return data
    # Parse header
    qdcount = struct.unpack("!H", data[4:6])[0]
    arcount = struct.unpack("!H", data[10:12])[0]

    # Walk past question section to find additional section
    offset = 12
    for _ in range(qdcount):
        while offset < len(data) and data[offset] != 0:
            if (data[offset] & 0xC0) == 0xC0:
                offset += 2
                break
            offset += 1 + data[offset]
        else:
            offset += 1  # skip null terminator
        offset += 4  # QTYPE + QCLASS

    ecs_opt = _build_ecs_option(client_ip)

    # Check if an OPT record already exists
    saved = offset
    for _ in range(arcount if qdcount else 0):
        # Skip answer + authority sections (we only parsed questions)
        break

    # Simple approach: if there's already an OPT RR (arcount > 0 and last record
    # is type 41), we'd need to splice into it. For simplicity, if no OPT exists,
    # append one. If one exists, skip ECS injection rather than risk corruption.
    if arcount > 0:
        return data

    # Build OPT pseudo-RR: NAME=0, TYPE=41, UDP=4096, RCODE=0, VERSION=0, FLAGS=0
    opt_rr = b'\x00'  # NAME (root)
    opt_rr += struct.pack("!H", 41)  # TYPE = OPT
    opt_rr += struct.pack("!H", 4096)  # UDP payload size
    opt_rr += struct.pack("!I", 0)  # extended RCODE + flags
    opt_rr += struct.pack("!H", len(ecs_opt))  # RDLENGTH
    opt_rr += ecs_opt

    # Update ARCOUNT
    new_arcount = arcount + 1
    data = data[:10] + struct.pack("!H", new_arcount) + data[12:]
    return data + opt_rr


def _strip_ecs_from_response(data: bytes) -> bytes:
    """Pass response through unchanged — Technitium may echo ECS back, clients handle it fine."""
    return data


# ── Backend (Technitium on OrbStack VM) ─────────────────────────────────────

def _query_backend_udp(query: bytes, backend_src: str) -> bytes:
    """Plain DNS UDP to Technitium via OrbStack localhost forwarder."""
    # Do not use en0_bound_socket: backend_src is loopback or the bridge IP,
    # not an en0 alias.
    be = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    be.settimeout(TIMEOUT)
    try:
        be.bind((backend_src, 0))
        be.sendto(query, (BACKEND_IP, BACKEND_PORT))
        resp, _ = be.recvfrom(65535)
        return resp
    finally:
        be.close()


def recv_dns_tcp(s: socket.socket) -> bytes:
    """Read a DNS-over-TCP message (2-byte length prefix + payload)."""
    raw_len = s.recv(2)
    if len(raw_len) < 2:
        return b""
    msg_len = struct.unpack("!H", raw_len)[0]
    data = b""
    while len(data) < msg_len:
        chunk = s.recv(msg_len - len(data))
        if not chunk:
            break
        data += chunk
    return data


# ── UDP (client) ──────────────────────────────────────────────────────────────

def handle_udp(
    data: bytes,
    client_addr: tuple,
    listen_sock: socket.socket,
    backend_src: str,
) -> None:
    try:
        log_client_query(client_addr[0], data)
        tagged = _add_ecs_to_query(data, client_addr[0])
        resp = _query_backend_udp(tagged, backend_src)
        if not resp:
            raise RuntimeError("empty DNS response from backend UDP")
        listen_sock.sendto(resp, client_addr)
        _bump("udp_ok")
    except Exception as e:
        _bump("udp_err")
        syslog.syslog(
            syslog.LOG_WARNING,
            f"dns-proxy UDP err client={client_addr[0]}:{client_addr[1]} {e!r}",
        )


def udp_listener(backend_src: str) -> None:
    sock = make_listen_socket(socket.SOCK_DGRAM)
    sock.bind((LISTEN_IP, LISTEN_PORT))
    syslog.syslog(syslog.LOG_INFO, f"dns-proxy: UDP listening on {LISTEN_IP}:{LISTEN_PORT}")
    while True:
        try:
            data, addr = sock.recvfrom(4096)
        except OSError as e:
            syslog.syslog(syslog.LOG_ERR, f"dns-proxy UDP recv: {e}")
            sys.exit(1)
        threading.Thread(
            target=handle_udp,
            args=(data, addr, sock, backend_src),
            daemon=True,
        ).start()


# ── TCP (client) ──────────────────────────────────────────────────────────────

def handle_tcp(conn: socket.socket, client_addr: tuple, backend_src: str) -> None:
    try:
        conn.settimeout(TIMEOUT)
        query = recv_dns_tcp(conn)
        if not query:
            return
        log_client_query(client_addr[0], query)
        # TCP clients → backend via UDP (same path as UDP clients).
        resp = _query_backend_udp(query, backend_src)
        if resp:
            conn.sendall(struct.pack("!H", len(resp)) + resp)
        _bump("tcp_ok")
    except Exception as e:
        _bump("tcp_err")
        syslog.syslog(
            syslog.LOG_WARNING,
            f"dns-proxy TCP err client={client_addr[0]}:{client_addr[1]} {e!r}",
        )
    finally:
        conn.close()


def tcp_listener(backend_src: str) -> None:
    sock = make_listen_socket(socket.SOCK_STREAM)
    sock.bind((LISTEN_IP, LISTEN_PORT))
    sock.listen(32)
    syslog.syslog(syslog.LOG_INFO, f"dns-proxy: TCP listening on {LISTEN_IP}:{LISTEN_PORT}")
    while True:
        try:
            conn, addr = sock.accept()
        except OSError as e:
            syslog.syslog(syslog.LOG_ERR, f"dns-proxy TCP accept: {e}")
            sys.exit(1)
        threading.Thread(
            target=handle_tcp,
            args=(conn, addr, backend_src),
            daemon=True,
        ).start()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    backend_src = _resolve_backend_src_ip()
    syslog.syslog(
        syslog.LOG_INFO,
        f"dns-proxy: backend {BACKEND_IP}:{BACKEND_PORT} via src {backend_src} "
        f"(env DNS_PROXY_BACKEND_SRC={'set' if BACKEND_SRC_IP else 'auto'})",
    )
    if CLIENTLOG_ENABLED:
        threading.Thread(target=_clientlog_writer, daemon=True).start()
    threading.Thread(target=udp_listener, args=(backend_src,), daemon=True).start()
    threading.Thread(target=tcp_listener, args=(backend_src,), daemon=True).start()
    syslog.syslog(syslog.LOG_INFO, f"dns-proxy: started on {LISTEN_IP}:{LISTEN_PORT}")
    threading.Event().wait()  # block forever


if __name__ == "__main__":
    main()
