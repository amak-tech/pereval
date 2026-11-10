#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""High-performance asynchronous DNS-over-HTTPS (DoH, RFC 8484) proxy for Перевал (pereval).

Accepts GET /dns-query?dns=<base64url> and POST /dns-query (application/dns-message)
over persistent HTTP/1.1 keep-alive connections from nginx, multiplexes queries across
a pool of persistent non-blocking UDP sockets to local dnsmasq (127.0.0.1:53) with
automatic TCP fallback on truncated (TC) responses, and spawns multiple worker
processes sharing the listening socket via SO_REUSEPORT for high concurrency.

Разбор DNS, UDP-пул и HTTP/1.1-сервер вынесены в dnscommon.py (общий модуль с
pro_dns.py); здесь остались только запуск, пул процессов и CLI.
"""

import argparse
import asyncio
import os
import signal
import socket
import sys

# dnscommon.py лежит рядом (репозиторий) или в /usr/local/lib/pereval (сервер)
for _cand in (os.path.dirname(os.path.abspath(__file__)), "/usr/local/lib/pereval"):
    if _cand not in sys.path:
        sys.path.insert(0, _cand)

# Общие примитивы + обратная совместимость: имена, которые раньше жили в этом модуле
from dnscommon import (  # noqa: E402,F401
    DNS_MEDIA_TYPE,
    MIN_DNS_PACKET_LEN,
    MAX_DNS_PACKET_LEN,
    MAX_HTTP_HEADER_BYTES,
    DohHttpServer,
    UdpDnsPool,
    _UdpDnsSocketProtocol,
    decode_base64url_dns,
    extract_min_ttl,
)


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
