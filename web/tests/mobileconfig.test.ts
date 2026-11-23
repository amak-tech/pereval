import { describe, it, expect } from "vitest";
import { buildMobileconfig } from "@/lib/mobileconfig";
import { GET as getFreeMobileconfig } from "@/app/dns.mobileconfig/route";
import { catalog } from "@/lib/catalog";

describe("mobileconfig", () => {
  it("добавляет OnDemandRules (Action: Connect) для HTTPS и TLS профилей", () => {
    const httpsXml = buildMobileconfig({
      name: "Перевал Pro",
      domain: "pro.pereval.top",
      identifierBase: "top.pereval.pro.dns",
      profileUuidSeed: "pro:1",
      payloadUuidSeed: "pro:tok",
      description: "Test Pro",
      dns: { protocol: "HTTPS", serverURL: "https://pro.pereval.top/dns/tok", serverAddresses: ["85.209.148.147"] },
    });
    expect(httpsXml).toContain("<key>DNSProtocol</key>\n        <string>HTTPS</string>");
    expect(httpsXml).toContain("<key>ServerURL</key>\n        <string>https://pro.pereval.top/dns/tok</string>");
    expect(httpsXml).toContain("<key>OnDemandRules</key>");
    expect(httpsXml).toContain("<key>Action</key>\n          <string>Connect</string>");

    const tlsXml = buildMobileconfig({
      name: "Перевал",
      domain: "free.pereval.top",
      identifierBase: "top.pereval.free.dns",
      profileUuidSeed: "free",
      payloadUuidSeed: "free",
      description: "Test Free",
      dns: { protocol: "TLS", serverName: "free.pereval.top", serverAddresses: ["153.80.200.170"] },
    });
    expect(tlsXml).toContain("<key>DNSProtocol</key>\n        <string>TLS</string>");
    expect(tlsXml).toContain("<key>OnDemandRules</key>");
    expect(tlsXml).toContain("<key>Action</key>\n          <string>Connect</string>");
  });

  it("бесплатный маршрут /dns.mobileconfig отдаёт DoH (HTTPS) с OnDemandRules", async () => {
    const res = await getFreeMobileconfig();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-apple-aspen-config");
    const xml = await res.text();
    expect(xml).toContain("<key>DNSProtocol</key>\n        <string>HTTPS</string>");
    expect(xml).toContain(`<key>ServerURL</key>\n        <string>${catalog.free.doh_url}</string>`);
    expect(xml).toContain(`<string>${catalog.free.dns_ip}</string>`);
    expect(xml).toContain("<key>OnDemandRules</key>");
    expect(xml).toContain("<key>Action</key>\n          <string>Connect</string>");
    expect(xml).not.toContain("<string>TLS</string>");
  });
});
