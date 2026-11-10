# -*- coding: utf-8 -*-
"""Вспомогательные примитивы для тестов DNS-демонов: сборка запросов, разбор ответов,
фейковый upstream (UDP+TCP на 127.0.0.1), самоподписанный сертификат через openssl."""

import asyncio
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

import dnscommon  # noqa: E402

UPSTREAM_A = "93.184.216.34"


def make_query(qname, qtype=1, qid=0x1234, edns=True, do=False, payload=1232, rd=True, qclass=1):
    """Собирает DNS-запрос с одним вопросом и (опционально) OPT."""
    flags = 0x0100 if rd else 0
    hdr = struct.pack("!HHHHHH", qid, flags, 1, 0, 0, 1 if edns else 0)
    q = dnscommon.encode_name(qname) + struct.pack("!HH", qtype, qclass)
    opt = b""
    if edns:
        opt = b"\x00" + struct.pack("!HHIH", 41, payload, 0x8000 if do else 0, 0)
    return hdr + q + opt


def parse_header(wire):
    qid, flags, qd, an, ns, ar = struct.unpack("!HHHHHH", wire[:12])
    return {"id": qid, "flags": flags, "qd": qd, "an": an, "ns": ns, "ar": ar,
            "rcode": flags & 0xF, "qr": bool(flags & 0x8000), "tc": bool(flags & 0x0200),
            "rd": bool(flags & 0x0100), "ra": bool(flags & 0x0080), "aa": bool(flags & 0x0400)}


def parse_records(wire):
    """-> (answers, authority, additional) как списки (name, type, class, ttl, rdata)."""
    h = parse_header(wire)
    pos = 12
    for _ in range(h["qd"]):
        _labels, pos = dnscommon.read_name(wire, pos)
        pos += 4
    sections = []
    for count in (h["an"], h["ns"], h["ar"]):
        recs = []
        for _ in range(count):
            labels, p2 = dnscommon.read_name(wire, pos)
            rtype, rclass, ttl, rdlen = struct.unpack("!HHIH", wire[p2:p2 + 10])
            rdata = wire[p2 + 10:p2 + 10 + rdlen]
            recs.append((dnscommon.labels_to_name(labels), rtype, rclass, ttl, rdata))
            pos = p2 + 10 + rdlen
        sections.append(recs)
    return sections[0], sections[1], sections[2]


def a_answers(wire):
    """Список IPv4 из секции answer."""
    ans, _ns, _ar = parse_records(wire)
    return [socket.inet_ntoa(r[4]) for r in ans if r[1] == 1]


def free_port(kind=socket.SOCK_STREAM):
    s = socket.socket(socket.AF_INET, kind)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeUpstream:
    """Фейковый upstream DNS: A -> UPSTREAM_A, AAAA -> NODATA. Имена с «big.» получают по
    UDP ответ с TC=1, а по TCP — полный (для проверки fallback). Считает запросы."""

    class _Udp(asyncio.DatagramProtocol):
        def __init__(self, owner):
            self.owner = owner
            self.transport = None

        def connection_made(self, transport):
            self.transport = transport

        def datagram_received(self, data, addr):
            self.owner.udp_queries += 1
            self.transport.sendto(self.owner.answer(data, via_udp=True), addr)

    def __init__(self, host="127.0.0.1"):
        self.host = host
        self.port = None
        self.udp_queries = 0
        self.tcp_queries = 0
        self.udp_transport = None
        self.tcp_server = None
        self.answer_ip = UPSTREAM_A

    def answer(self, data, via_udp):
        try:
            q = dnscommon.parse_question(data)
        except ValueError:
            return dnscommon.build_header_only(data, dnscommon.RCODE_FORMERR)
        if via_udp and "big." in q.qname:
            return dnscommon.build_truncated(data)
        if q.qtype == 1:
            return dnscommon.build_response(data, [dnscommon.a_record(q.qname, self.answer_ip, 300)])
        return dnscommon.build_nodata(data)

    async def _tcp_client(self, reader, writer):
        try:
            while True:
                msg = await dnscommon.read_tcp_message(reader, 5.0)
                if msg is None:
                    break
                self.tcp_queries += 1
                writer.write(dnscommon.frame_tcp(self.answer(msg, via_udp=False)))
                await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    async def start(self):
        loop = asyncio.get_running_loop()
        self.port = free_port(socket.SOCK_DGRAM)
        self.udp_transport, _ = await loop.create_datagram_endpoint(
            lambda: FakeUpstream._Udp(self), local_addr=(self.host, self.port))
        self.tcp_server = await asyncio.start_server(self._tcp_client, self.host, self.port)
        return self

    async def stop(self):
        if self.udp_transport:
            self.udp_transport.close()
        if self.tcp_server:
            self.tcp_server.close()
            await self.tcp_server.wait_closed()


def openssl_available():
    return shutil.which("openssl") is not None


def gen_self_signed(directory, cn="pro.test", san=None, days=2):
    """Самоподписанный RSA-2048 сертификат через openssl CLI. -> (cert_path, key_path).
    san — список DNS-имён для subjectAltName (например ["pereval.test", "*.pereval.test"])."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    cert = directory / ("%s.crt.pem" % cn.replace("*", "wildcard"))
    key = directory / ("%s.key.pem" % cn.replace("*", "wildcard"))
    cmd = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
           "-out", str(cert), "-days", str(days), "-subj", "/CN=%s" % cn]
    if san:
        cmd += ["-addext", "subjectAltName=" + ",".join("DNS:%s" % n for n in san)]
    subprocess.run(cmd, check=True, capture_output=True)
    return str(cert), str(key)


def tmpdir():
    return tempfile.mkdtemp(prefix="pereval-test-")
