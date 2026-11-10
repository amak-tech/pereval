import { describe, expect, it } from "vitest";
import { parseBasicAuth } from "@/lib/ddns";
import { isPublicIPv4, normalizeIp, clientIp } from "@/lib/ip";

describe("DynDNS2 Basic auth", () => {
  it("разбирает логин:пароль", () => {
    const h = "Basic " + Buffer.from("user@example.com:k3y").toString("base64");
    expect(parseBasicAuth(h)).toEqual({ login: "user@example.com", password: "k3y" });
  });
  it("пароль с двоеточием", () => {
    const h = "Basic " + Buffer.from("u:a:b").toString("base64");
    expect(parseBasicAuth(h)).toEqual({ login: "u", password: "a:b" });
  });
  it("мусор", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer x")).toBeNull();
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth("Basic " + Buffer.from("nocolon").toString("base64"))).toBeNull();
  });
});

describe("IP helpers", () => {
  it("публичные и приватные IPv4", () => {
    expect(isPublicIPv4("8.8.8.8")).toBe(true);
    expect(isPublicIPv4("10.1.2.3")).toBe(false);
    expect(isPublicIPv4("192.168.1.1")).toBe(false);
    expect(isPublicIPv4("172.20.0.1")).toBe(false);
    expect(isPublicIPv4("100.64.0.1")).toBe(false);
    expect(isPublicIPv4("127.0.0.1")).toBe(false);
    expect(isPublicIPv4("::1")).toBe(false);
    expect(isPublicIPv4("not-an-ip")).toBe(false);
  });
  it("нормализация IPv4-mapped", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
  });
  it("clientIp берёт X-Real-IP, затем первый XFF", () => {
    expect(clientIp(new Headers({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("5.6.7.8");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("1.1.1.1");
    expect(clientIp(new Headers())).toBe("0.0.0.0");
  });
});
