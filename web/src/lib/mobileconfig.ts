import { createHash } from "node:crypto";

/** Профили Apple (iOS / iPadOS / macOS) для зашифрованного DNS. */

/** UUID v5 (SHA-1) — детерминированные идентификаторы профилей, как в старом generate.py. */
export function uuidv5(name: string, namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(Buffer.concat([ns, Buffer.from(name, "utf8")])).digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type DnsProfile =
  | { protocol: "TLS"; serverName: string; serverAddresses: string[] }
  | { protocol: "HTTPS"; serverURL: string; serverAddresses: string[] };

export function buildMobileconfig(opts: {
  name: string;
  domain: string;
  identifierBase: string; // например top.pereval.free
  profileUuidSeed: string;
  payloadUuidSeed: string;
  description: string;
  dns: DnsProfile;
}): string {
  const dnsSettings =
    opts.dns.protocol === "TLS"
      ? `        <key>DNSProtocol</key>
        <string>TLS</string>
        <key>ServerAddresses</key>
        <array>
${opts.dns.serverAddresses.map((a) => `          <string>${esc(a)}</string>`).join("\n")}
        </array>
        <key>ServerName</key>
        <string>${esc(opts.dns.serverName)}</string>`
      : `        <key>DNSProtocol</key>
        <string>HTTPS</string>
        <key>ServerAddresses</key>
        <array>
${opts.dns.serverAddresses.map((a) => `          <string>${esc(a)}</string>`).join("\n")}
        </array>
        <key>ServerURL</key>
        <string>${esc(opts.dns.serverURL)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>DNSSettings</key>
      <dict>
${dnsSettings}
      </dict>
      <key>PayloadDescription</key>
      <string>${esc(`Настраивает зашифрованный DNS через ${opts.name}`)}</string>
      <key>PayloadDisplayName</key>
      <string>${esc(`${opts.name} DNS`)}</string>
      <key>PayloadIdentifier</key>
      <string>${esc(opts.identifierBase)}.dnsSettings</string>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key>
      <string>${uuidv5(`${opts.payloadUuidSeed}:dnsSettings`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>ProhibitDisablement</key>
      <false/>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>${esc(opts.description)}</string>
  <key>PayloadDisplayName</key>
  <string>${esc(`${opts.name} DNS`)}</string>
  <key>PayloadIdentifier</key>
  <string>${esc(opts.identifierBase)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadScope</key>
  <string>System</string>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuidv5(`${opts.profileUuidSeed}:profile`)}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

export function reverseDomain(domain: string): string {
  return domain.split(".").reverse().join(".");
}
