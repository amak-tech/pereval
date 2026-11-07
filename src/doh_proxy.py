#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""High-performance asynchronous DNS-over-HTTPS (DoH, RFC 8484) proxy for Перевал (pereval).

Accepts GET /dns-query?dns=<base64url> and POST /dns-query (application/dns-message)
over persistent HTTP/1.1 keep-alive connections from nginx, multiplexes queries across
a pool of persistent non-blocking UDP sockets to local dnsmasq (127.0.0.1:53) with
automatic TCP fallback on truncated (TC) responses, and spawns multiple worker
processes sharing the listening socket via SO_REUSEPORT for high concurrency.
"""

import argparse
import asyncio
import base64
import os
import signal
import socket
import struct
import sys
from urllib.parse import parse_qs, urlsplit

DNS_MEDIA_TYPE = "application/dns-message"
MIN_DNS_PACKET_LEN = 12
MAX_DNS_PACKET_LEN = 4096
MAX_HTTP_HEADER_BYTES = 16384


def extract_min_ttl(packet: bytes, default_ttl: int = 60, max_ttl: int = 3600) -> int:
    """Extract minimum TTL from DNS answer/authority/additional sections for Cache-Control."""
    if len(packet) < MIN_DNS_PACKET_LEN:
        return default_ttl
    try:
        _qid, flags, qdcount, ancount, nscount, arcount = struct.unpack("!HHHHHH", packet[:12])
        rcode = flags & 0x000F
        if rcode != 0:
            return 10
        rr_total = ancount + nscount
        if rr_total == 0:
            return default_ttl

        offset = 12
        length = len(packet)

        def skip_name(pos: int) -> int:
            jumps = 0
            while pos < length:
                label_len = packet[pos]
                if label_len == 0:
                    return pos + 1
                if (label_len & 0xC0) == 0xC0:
                    return pos + 2
                if (label_len & 0xC0) != 0:
                    return -1
                pos += 1 + label_len
                jumps += 1
                if jumps > 128:
                    return -1
            return -1

        for _ in range(qdcount):
            offset = skip_name(offset)
            if offset < 0 or offset + 4 > length:
                return default_ttl
            offset += 4

        min_ttl = None
        for _ in range(rr_total):
            offset = skip_name(offset)
            if offset < 0 or offset + 10 > length:
                break
            rtype, _rclass, ttl, rdlength = struct.unpack("!HHIH", packet[offset:offset + 10])
            offset += 10
            if offset + rdlength > length:
                break
            offset += rdlength
            if rtype != 41:  # Skip OPT pseudo-RR (EDNS0)
                if min_ttl is None or ttl < min_ttl:
                    min_ttl = ttl

        if min_ttl is None:
            return default_ttl
        return max(1, min(int(min_ttl), max_ttl))
    except Exception:
        return default_ttl


class _UdpDnsSocketProtocol(asyncio.DatagramProtocol):
    """Multiplexes up to 65536 in-flight DNS queries over a single connected UDP socket."""

    def __init__(self):
        self.transport = None
        self.pending = {}  # txid -> asyncio.Future
        self._next_id = 0

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data: bytes, _addr):
        if len(data) < MIN_DNS_PACKET_LEN:
            return
        txid = (data[0] << 8) | data[1]
        fut = self.pending.pop(txid, None)
        if fut is not None and not fut.done():
            fut.set_result(data)

    def error_received(self, exc):
        pass

    def connection_lost(self, exc):
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(exc or ConnectionError("UDP transport closed"))
        self.pending.clear()

    def allocate_txid(self) -> int:
        for _ in range(65536):
            txid = self._next_id
            self._next_id = (txid + 1) & 0xFFFF
            if txid not in self.pending:
                return txid
        return -1


class UdpDnsPool:
    """Pool of persistent connected UDP sockets to upstream DNS server."""

    def __init__(self, upstream_host: str, upstream_port: int, pool_size: int = 8, timeout: float = 2.5):
        self.upstream_host = upstream_host
        self.upstream_port = upstream_port
        self.pool_size = max(1, pool_size)
        self.timeout = timeout
        self.protocols = []
        self._rr = 0

    async def start(self):
        loop = asyncio.get_running_loop()
        for _ in range(self.pool_size):
            _, proto = await loop.create_datagram_endpoint(
                _UdpDnsSocketProtocol,
                remote_addr=(self.upstream_host, self.upstream_port),
            )
            self.protocols.append(proto)

    def close(self):
        for proto in self.protocols:
            if proto.transport is not None:
                proto.transport.close()
        self.protocols.clear()

    async def query(self, wire_query: bytes) -> bytes:
        if len(wire_query) < MIN_DNS_PACKET_LEN or len(wire_query) > MAX_DNS_PACKET_LEN:
            raise ValueError("invalid DNS query size")

        orig_id = wire_query[:2]
        proto = self.protocols[self._rr % len(self.protocols)]
        self._rr += 1

        txid = proto.allocate_txid()
        if txid < 0 or proto.transport is None:
            return await self.query_tcp(wire_query)

        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        proto.pending[txid] = fut
        try:
            rewritten = struct.pack("!H", txid) + wire_query[2:]
            proto.transport.sendto(rewritten)
            resp = await asyncio.wait_for(fut, timeout=self.timeout)
        finally:
            proto.pending.pop(txid, None)

        # Restore original transaction ID
        resp = orig_id + resp[2:]

        # Check TC (TrunCation) bit (byte 2, bit 1: 0x02). If set, retry over TCP.
        if len(resp) >= 4 and (resp[2] & 0x02):
            try:
                return await self.query_tcp(wire_query)
            except Exception:
                return resp
        return resp

    async def query_tcp(self, wire_query: bytes) -> bytes:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(self.upstream_host, self.upstream_port),
            timeout=self.timeout,
        )
        try:
            framed = struct.pack("!H", len(wire_query)) + wire_query
            writer.write(framed)
            await asyncio.wait_for(writer.drain(), timeout=self.timeout)
            hdr = await asyncio.wait_for(reader.readexactly(2), timeout=self.timeout)
            (resp_len,) = struct.unpack("!H", hdr)
            if resp_len < MIN_DNS_PACKET_LEN or resp_len > 65535:
                raise ValueError("invalid TCP DNS response length")
            return await asyncio.wait_for(reader.readexactly(resp_len), timeout=self.timeout)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass


def decode_base64url_dns(param: str) -> bytes:
    """Decode RFC 8484 base64url-encoded `dns` query parameter (unpadded)."""
    cleaned = param.strip()
    if not cleaned:
        raise ValueError("empty dns parameter")
    pad = (-len(cleaned)) % 4
    if pad:
        cleaned += "=" * pad
    raw = base64.urlsafe_b64decode(cleaned.encode("ascii"))
    if len(raw) < MIN_DNS_PACKET_LEN or len(raw) > MAX_DNS_PACKET_LEN:
        raise ValueError("DNS packet length out of bounds")
    return raw


class DohHttpServer:
    """Minimal zero-dependency async HTTP/1.1 server tailored for RFC 8484 DoH."""

    def __init__(self, dns_pool: UdpDnsPool, endpoint_path: str = "/dns-query", max_inflight: int = 4096):
        self.dns_pool = dns_pool
        self.endpoint_path = endpoint_path
        self._sem = asyncio.Semaphore(max_inflight)

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            while True:
                try:
                    header_block = await asyncio.wait_for(
                        reader.readuntil(b"\r\n\r\n"),
                        timeout=30.0,
                    )
                except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError):
                    break
                except asyncio.LimitOverrunError:
                    await self._send_response(writer, 413, b"Header too large", keep_alive=False)
                    break

                if len(header_block) > MAX_HTTP_HEADER_BYTES:
                    await self._send_response(writer, 413, b"Header too large", keep_alive=False)
                    break

                lines = header_block[:-4].decode("latin-1", errors="replace").split("\r\n")
                if not lines or not lines[0]:
                    break

                parts = lines[0].split(" ")
                if len(parts) != 3:
                    await self._send_response(writer, 400, b"Bad Request", keep_alive=False)
                    break

                method, target, version = parts[0].upper(), parts[1], parts[2].upper()
                headers = {}
                for hline in lines[1:]:
                    if ":" in hline:
                        k, v = hline.split(":", 1)
                        headers[k.strip().lower()] = v.strip()

                conn_hdr = headers.get("connection", "").lower()
                if version == "HTTP/1.0":
                    keep_alive = conn_hdr == "keep-alive"
                else:
                    keep_alive = conn_hdr != "close"

                content_length = 0
                if "content-length" in headers:
                    try:
                        content_length = int(headers["content-length"])
                    except ValueError:
                        await self._send_response(writer, 400, b"Invalid Content-Length", keep_alive=False)
                        break
                    if content_length < 0 or content_length > MAX_DNS_PACKET_LEN:
                        await self._send_response(writer, 413, b"Payload Too Large", keep_alive=False)
                        break

                body = b""
                if content_length > 0:
                    try:
                        body = await asyncio.wait_for(reader.readexactly(content_length), timeout=5.0)
                    except (asyncio.IncompleteReadError, asyncio.TimeoutError):
                        break

                keep_alive = await self._process_request(
                    writer, method, target, headers, body, keep_alive
                )
                if not keep_alive:
                    break
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _process_request(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        target: str,
        headers: dict,
        body: bytes,
        keep_alive: bool,
    ) -> bool:
        parsed = urlsplit(target)
        path = parsed.path

        if path == "/healthz":
            await self._send_response(writer, 200, b"ok\n", content_type="text/plain", keep_alive=keep_alive)
            return keep_alive

        if path != self.endpoint_path:
            await self._send_response(writer, 404, b"Not Found", keep_alive=keep_alive)
            return keep_alive

        if method == "OPTIONS":
            await self._send_response(
                writer,
                204,
                b"",
                content_type="text/plain",
                keep_alive=keep_alive,
                extra_headers=(
                    "Access-Control-Allow-Origin: *\r\n"
                    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                    "Access-Control-Allow-Headers: Content-Type, Accept\r\n"
                    "Access-Control-Max-Age: 86400\r\n"
                ),
            )
            return keep_alive

        wire_query = None
        if method == "POST":
            ctype = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if ctype and ctype != DNS_MEDIA_TYPE:
                await self._send_response(writer, 415, b"Unsupported Media Type", keep_alive=keep_alive)
                return keep_alive
            if len(body) < MIN_DNS_PACKET_LEN or len(body) > MAX_DNS_PACKET_LEN:
                await self._send_response(writer, 400, b"Bad DNS message size", keep_alive=keep_alive)
                return keep_alive
            wire_query = body
        elif method in ("GET", "HEAD"):
            qs = parse_qs(parsed.query, keep_blank_values=True)
            dns_vals = qs.get("dns")
            if not dns_vals:
                await self._send_response(
                    writer,
                    400,
                    b"Missing ?dns= parameter (RFC 8484 DNS-over-HTTPS endpoint)\n",
                    content_type="text/plain; charset=utf-8",
                    keep_alive=keep_alive,
                )
                return keep_alive
            try:
                wire_query = decode_base64url_dns(dns_vals[0])
            except Exception:
                await self._send_response(writer, 400, b"Invalid base64url dns parameter", keep_alive=keep_alive)
                return keep_alive
        else:
            await self._send_response(
                writer,
                405,
                b"Method Not Allowed",
                keep_alive=keep_alive,
                extra_headers="Allow: GET, POST, OPTIONS\r\n",
            )
            return keep_alive

        try:
            async with self._sem:
                wire_resp = await self.dns_pool.query(wire_query)
        except asyncio.TimeoutError:
            await self._send_response(writer, 504, b"DNS Upstream Timeout", keep_alive=keep_alive)
            return keep_alive
        except Exception:
            await self._send_response(writer, 502, b"DNS Upstream Error", keep_alive=keep_alive)
            return keep_alive

        ttl = extract_min_ttl(wire_resp)
        payload = b"" if method == "HEAD" else wire_resp
        await self._send_response(
            writer,
            200,
            payload,
            content_type=DNS_MEDIA_TYPE,
            keep_alive=keep_alive,
            content_length_override=len(wire_resp),
            extra_headers=(
                f"Cache-Control: max-age={ttl}\r\n"
                "Access-Control-Allow-Origin: *\r\n"
            ),
        )
        return keep_alive

    @staticmethod
    async def _send_response(
        writer: asyncio.StreamWriter,
        status: int,
        body: bytes,
        content_type: str = "text/plain; charset=utf-8",
        keep_alive: bool = True,
        content_length_override: int = None,
        extra_headers: str = "",
    ):
        reasons = {
            200: "OK",
            204: "No Content",
            400: "Bad Request",
            404: "Not Found",
            405: "Method Not Allowed",
            413: "Payload Too Large",
            415: "Unsupported Media Type",
            502: "Bad Gateway",
            504: "Gateway Timeout",
        }
        reason = reasons.get(status, "OK")
        clen = len(body) if content_length_override is None else content_length_override
        conn_val = "keep-alive" if keep_alive else "close"
        head = (
            f"HTTP/1.1 {status} {reason}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {clen}\r\n"
            f"Connection: {conn_val}\r\n"
            f"{extra_headers}"
            "\r\n"
        ).encode("latin-1")
        writer.write(head + body)
        await writer.drain()


def create_listen_socket(host: str, port: int, reuse_port: bool = True, backlog: int = 4096) -> socket.socket:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    if reuse_port and hasattr(socket, "SO_REUSEPORT"):
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
        except OSError:
            pass
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.setblocking(False)
    sock.bind((host, port))
    sock.listen(backlog)
    return sock


async def run_worker(
    listen_host: str,
    listen_port: int,
    upstream_host: str,
    upstream_port: int,
    udp_pool_size: int = 16,
    upstream_timeout: float = 2.5,
    max_inflight: int = 4096,
    reuse_port: bool = True,
    ready_event: asyncio.Event = None,
    stop_event: asyncio.Event = None,
):
    dns_pool = UdpDnsPool(
        upstream_host=upstream_host,
        upstream_port=upstream_port,
        pool_size=udp_pool_size,
        timeout=upstream_timeout,
    )
    await dns_pool.start()
    doh = DohHttpServer(dns_pool=dns_pool, max_inflight=max_inflight)

    sock = create_listen_socket(listen_host, listen_port, reuse_port=reuse_port)
    server = await asyncio.start_server(
        doh.handle_client,
        sock=sock,
        limit=MAX_HTTP_HEADER_BYTES * 2,
    )

    if stop_event is None:
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop_event.set)
            except NotImplementedError:
                pass

    if ready_event is not None:
        ready_event.set()

    try:
        await stop_event.wait()
    finally:
        server.close()
        await server.wait_closed()
        dns_pool.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        description="Асинхронный RFC 8484 DNS-over-HTTPS (DoH) прокси к локальному dnsmasq."
    )
    p.add_argument("--listen-host", default="127.0.0.1",
                   help="адрес для прослушивания HTTP от nginx (по умолчанию 127.0.0.1)")
    p.add_argument("--listen-port", type=int, default=8053,
                   help="порт для прослушивания HTTP от nginx (по умолчанию 8053)")
    p.add_argument("--upstream-host", default="127.0.0.1",
                   help="адрес локального DNS-сервера dnsmasq (по умолчанию 127.0.0.1)")
    p.add_argument("--upstream-port", type=int, default=53,
                   help="порт локального DNS-сервера dnsmasq (по умолчанию 53)")
    p.add_argument("--workers", type=int, default=0,
                   help="число рабочих процессов (0 = по числу ядер CPU, до 8)")
    p.add_argument("--udp-pool", type=int, default=16,
                   help="размер пула UDP-сокетов на один воркер (по умолчанию 16)")
    p.add_argument("--timeout", type=float, default=2.5,
                   help="таймаут ответа от dnsmasq в секундах (по умолчанию 2.5)")
    p.add_argument("--max-inflight", type=int, default=4096,
                   help="максимум одновременных запросов на один воркер (по умолчанию 4096)")
    args = p.parse_args(argv)

    workers = args.workers
    if workers <= 0:
        cpu_cnt = os.cpu_count() or 2
        workers = max(2, min(cpu_cnt, 8))

    if workers == 1 or not hasattr(os, "fork") or not hasattr(socket, "SO_REUSEPORT"):
        asyncio.run(
            run_worker(
                listen_host=args.listen_host,
                listen_port=args.listen_port,
                upstream_host=args.upstream_host,
                upstream_port=args.upstream_port,
                udp_pool_size=args.udp_pool,
                upstream_timeout=args.timeout,
                max_inflight=args.max_inflight,
                reuse_port=False,
            )
        )
        return 0

    children = []
    shutting_down = False

    def spawn_child():
        pid = os.fork()
        if pid == 0:
            try:
                asyncio.run(
                    run_worker(
                        listen_host=args.listen_host,
                        listen_port=args.listen_port,
                        upstream_host=args.upstream_host,
                        upstream_port=args.upstream_port,
                        udp_pool_size=args.udp_pool,
                        upstream_timeout=args.timeout,
                        max_inflight=args.max_inflight,
                        reuse_port=True,
                    )
                )
            except KeyboardInterrupt:
                pass
            os._exit(0)
        children.append(pid)

    for _ in range(workers):
        spawn_child()

    def handle_master_signal(signum, _frame):
        nonlocal shutting_down
        shutting_down = True
        for pid in list(children):
            try:
                os.kill(pid, signum)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, handle_master_signal)
    signal.signal(signal.SIGINT, handle_master_signal)

    while children:
        try:
            pid, _status = os.wait()
        except InterruptedError:
            continue
        except ChildProcessError:
            break
        if pid in children:
            children.remove(pid)
        if not shutting_down:
            # Respawn crashed worker automatically
            spawn_child()

    return 0


if __name__ == "__main__":
    sys.exit(main())
