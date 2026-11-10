import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCertificate, certCovers, loadPublishedCert, resetCertCache } from "@/lib/cert";
import { acmeTxtRecords, watchedHosts, certNames } from "@/jobs/certwatch";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** CA + лист с SAN через openssl CLI (как Let's Encrypt: issuer ≠ subject). */
function makeChain(dir: string, names: string[]) {
  const ssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  ssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "3", "-subj", "/CN=Test CA"]);
  ssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${names[0]}`]);
  writeFileSync(path.join(dir, "ext.cnf"), `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}\n`);
  ssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "ext.cnf"]);
  const fullchain = readFileSync(path.join(dir, "leaf.pem"), "utf8") + readFileSync(path.join(dir, "ca.pem"), "utf8");
  return { fullchain, privkey: readFileSync(path.join(dir, "leaf.key"), "utf8") };
}

describe("certCovers", () => {
  const names = ["pereval.top", "*.pereval.top", "*.pro.pereval.top", "pereval.portbuddy.tech"];
  it("точное имя и wildcard одного уровня", () => {
    expect(certCovers("pereval.top", names)).toBe(true);
    expect(certCovers("free.pereval.top", names)).toBe(true);
    expect(certCovers("abcdefghij2345672345.pro.pereval.top", names)).toBe(true);
    expect(certCovers("PEREVAL.portbuddy.tech.", names)).toBe(true);
    expect(certCovers("a.b.pereval.top", names)).toBe(false);
    expect(certCovers("example.com", names)).toBe(false);
  });
});

describe("certwatch helpers", () => {
  it("TXT-записи: apex и *.apex — одна запись с двумя значениями", () => {
    const txt = acmeTxtRecords(["pereval.top", "*.pereval.top", "*.pro.pereval.top", "pereval.portbuddy.tech"]);
    expect(txt).toEqual(["_acme-challenge.pereval.top (2 записи)", "_acme-challenge.pro.pereval.top", "_acme-challenge.pereval.portbuddy.tech"]);
  });
  it("следим за сайтом, Free-именами и Pro; все они покрыты именами сертификата", () => {
    const hosts = watchedHosts();
    expect(hosts).toContain("free.pereval.top");
    expect(hosts).toContain("pro.pereval.top");
    for (const h of hosts) expect(certCovers(h, certNames()), h).toBe(true);
    expect(certCovers("token.pro.pereval.top", certNames())).toBe(true);
  });
});

describe.skipIf(!hasOpenssl())("parseCertificate / loadPublishedCert", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pereval-cert-"));
  });

  it("разбирает SAN, срок и отличает подписанный CA от самоподписанного", async () => {
    const { fullchain, privkey } = makeChain(dir, ["pereval.test", "*.pereval.test", "*.pro.pereval.test"]);
    const parsed = parseCertificate(fullchain);
    expect(parsed.names).toEqual(["pereval.test", "*.pereval.test", "*.pro.pereval.test"]);
    expect(parsed.selfSigned).toBe(false);
    expect(parsed.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(parsed.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const pub = path.join(dir, "pub");
    execFileSync("mkdir", ["-p", pub]);
    writeFileSync(path.join(pub, "fullchain.pem"), fullchain);
    writeFileSync(path.join(pub, "privkey.pem"), privkey);
    resetCertCache();
    const cert = await loadPublishedCert(pub);
    expect(cert).not.toBeNull();
    expect(cert!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cert!.privkey).toBe(privkey);
    expect(cert!.names).toContain("*.pro.pereval.test");
  });

  it("самоподписанный (временный) сертификат не публикуется", async () => {
    const self = path.join(dir, "self");
    execFileSync("mkdir", ["-p", self]);
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "privkey.pem", "-out", "fullchain.pem", "-days", "2", "-subj", "/CN=pereval.test"], { cwd: self, stdio: "ignore" });
    resetCertCache();
    expect(await loadPublishedCert(self)).toBeNull();
    expect(parseCertificate(readFileSync(path.join(self, "fullchain.pem"), "utf8")).selfSigned).toBe(true);
  });

  it("пустой или отсутствующий каталог → null", async () => {
    resetCertCache();
    expect(await loadPublishedCert("")).toBeNull();
    expect(await loadPublishedCert(path.join(dir, "nope"))).toBeNull();
    expect(existsSync(path.join(dir, "nope"))).toBe(false);
  });
});
