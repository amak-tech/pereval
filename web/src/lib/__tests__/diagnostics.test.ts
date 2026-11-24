import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Catalog } from "@/lib/catalog";
import {
  buildSupportReport,
  computeVerdict,
  lookupDomainInCatalog,
  type BeaconResult,
  type CheckAccountContext,
  type ServiceProbeResult,
} from "@/lib/diagnostics";
import { resetEnvCache } from "@/lib/env";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue(null),
}));

const SAMPLE_CATALOG: Catalog = {
  meta: {
    name: "Перевал",
    origin: "https://pereval.top",
    check_domain: "check.pereval.top",
    cert_domains: ["pereval.top", "*.pereval.top"],
  },
  free: {
    domain: "free.pereval.top",
    legacy_domains: [],
    dns_ip: "153.80.200.170",
    doh_url: "https://free.pereval.top/dns-query",
    dot_host: "free.pereval.top",
    pools: { default: { note: "", fallback: null, strict_allowlist: false } },
    workers: [{ ip: "198.51.100.10", name: "w1", weight: 1, pools: ["default"] }],
  },
  pro: {
    domain: "pro.pereval.top",
    dns_ip: "198.51.100.53",
    doh_url_template: "https://pro.pereval.top/dns/{token}",
    dot_host_template: "{token}.pro.pereval.top",
    pools: { default: { note: "", fallback: null, strict_allowlist: false } },
    workers: [{ ip: "198.51.100.20", name: "pw1", weight: 1, pools: ["default"] }],
  },
  categories: [
    {
      id: "ai",
      name: "ИИ-сервисы",
      tier: "free",
      pool: "ai",
      services: [
        {
          name: "Anthropic / Claude",
          slug: "claude",
          pool: "ai",
          domains: ["claude.ai", "anthropic.com"],
          exclude_domains: ["stun.anthropic.com"],
        },
      ],
    },
    {
      id: "work",
      name: "Работа и заметки",
      tier: "pro",
      pool: "default",
      services: [
        {
          name: "Notion",
          slug: "notion",
          pool: "default",
          domains: ["notion.so"],
        },
      ],
    },
  ],
  disabled: [
    {
      name: "Отключённые",
      note: "Не поддерживается по техническим причинам",
      domains: ["legacy-blocked.example"],
    },
  ],
  passthrough: {
    note: "Российские сервисы идут напрямую",
    domains: ["gosuslugi.ru", "sberbank.ru"],
  },
  counts: {
    free_categories: 1,
    free_services: 1,
    free_domains: 2,
    pro_categories: 1,
    pro_services: 1,
    pro_domains: 1,
  },
};

const ALL_OK_PROBES: ServiceProbeResult[] = [
  { id: "claude", name: "Claude", host: "anthropic.com", ok: true, ms: 120 },
  { id: "chatgpt", name: "ChatGPT", host: "chatgpt.com", ok: true, ms: 150 },
];

const ALL_FAIL_PROBES: ServiceProbeResult[] = [
  { id: "claude", name: "Claude", host: "anthropic.com", ok: false, ms: 8000 },
  { id: "chatgpt", name: "ChatGPT", host: "chatgpt.com", ok: false, ms: 8000 },
];

const PARTIAL_PROBES: ServiceProbeResult[] = [
  { id: "claude", name: "Claude", host: "anthropic.com", ok: true, ms: 120 },
  { id: "chatgpt", name: "ChatGPT", host: "chatgpt.com", ok: false, ms: 8000 },
];

describe("lookupDomainInCatalog", () => {
  it("normalizes full URLs with port, path, and query", () => {
    const res = lookupDomainInCatalog("HTTPS://API.Anthropic.com:443/v1/messages?foo=bar", SAMPLE_CATALOG);
    expect(res.status).toBe("free");
    if (res.status === "free") {
      expect(res.normalizedHost).toBe("api.anthropic.com");
      expect(res.matchedDomain).toBe("anthropic.com");
      expect(res.serviceName).toBe("Anthropic / Claude");
      expect(res.pool).toBe("ai");
      expect(res.categoryDisabled).toBe(false);
    }
  });

  it("detects Pro services and disabled Pro categories", () => {
    const res = lookupDomainInCatalog("https://www.notion.so/page", SAMPLE_CATALOG, ["work"]);
    expect(res.status).toBe("pro");
    if (res.status === "pro") {
      expect(res.serviceName).toBe("Notion");
      expect(res.categoryId).toBe("work");
      expect(res.categoryDisabled).toBe(true);
    }
  });

  it("detects passthrough, excluded, disabled, not_found, and invalid inputs", () => {
    expect(lookupDomainInCatalog("lk.gosuslugi.ru", SAMPLE_CATALOG).status).toBe("passthrough");
    expect(lookupDomainInCatalog("stun.anthropic.com", SAMPLE_CATALOG).status).toBe("excluded");
    expect(lookupDomainInCatalog("legacy-blocked.example", SAMPLE_CATALOG).status).toBe("disabled");
    expect(lookupDomainInCatalog("example.org", SAMPLE_CATALOG).status).toBe("not_found");
    expect(lookupDomainInCatalog("not a host", SAMPLE_CATALOG).status).toBe("invalid");
    expect(lookupDomainInCatalog("", SAMPLE_CATALOG).status).toBe("invalid");
  });
});

describe("computeVerdict", () => {
  it("returns dns_not_configured when beacon answers tier=none", () => {
    const beacon: BeaconResult = { state: "ok", pereval: false, tier: "none", mode: "none", ms: 40 };
    const v = computeVerdict({ beacon, probes: ALL_OK_PROBES, account: null });
    expect(v.kind).toBe("dns_not_configured");
    expect(v.tone).toBe("err");
  });

  it("returns pro_access_issue when beacon is none and Pro account is in plain mode", () => {
    const beacon: BeaconResult = { state: "ok", pereval: false, tier: "none", mode: "none", ms: 40 };
    const account: CheckAccountContext = {
      authenticated: true,
      mode: "plain",
      subscriptionStatus: "expired",
      ipBound: false,
      ipInDynamicAcl: false,
      dynamicAclExpiresAt: null,
      lastDnsSeenAt: null,
      disabledCategories: [],
      dohUrl: null,
      dotHost: null,
    };
    const v = computeVerdict({ beacon, probes: ALL_OK_PROBES, account });
    expect(v.kind).toBe("pro_access_issue");
    expect(v.tone).toBe("warn");
  });

  it("returns ok when beacon is free/pro and all control probes succeed", () => {
    const beacon: BeaconResult = { state: "ok", pereval: true, tier: "free", mode: "proxy", ms: 35 };
    const v = computeVerdict({ beacon, probes: ALL_OK_PROBES, account: null });
    expect(v.kind).toBe("ok");
    expect(v.tone).toBe("ok");
  });

  it("returns tspu_or_network when DNS is active but all probes fail", () => {
    const beacon: BeaconResult = { state: "ok", pereval: true, tier: "free", mode: "proxy", ms: 35 };
    const v = computeVerdict({ beacon, probes: ALL_FAIL_PROBES, account: null });
    expect(v.kind).toBe("tspu_or_network");
    expect(v.tone).toBe("err");
  });

  it("returns pro_access_issue when Pro DNS is active, probes fail, and IP is neither bound nor in ACL", () => {
    const beacon: BeaconResult = { state: "ok", pereval: true, tier: "pro", mode: "proxy", ms: 45 };
    const account: CheckAccountContext = {
      authenticated: true,
      mode: "proxy",
      subscriptionStatus: "active",
      ipBound: false,
      ipInDynamicAcl: false,
      dynamicAclExpiresAt: null,
      lastDnsSeenAt: null,
      disabledCategories: [],
      dohUrl: "https://pro.pereval.top/dns/secretbase32token234",
      dotHost: "secretbase32token234.pro.pereval.top",
    };
    const v = computeVerdict({ beacon, probes: ALL_FAIL_PROBES, account });
    expect(v.kind).toBe("pro_access_issue");
    expect(v.tone).toBe("warn");
  });

  it("returns partial when only some control probes succeed", () => {
    const beacon: BeaconResult = { state: "ok", pereval: true, tier: "free", mode: "proxy", ms: 30 };
    const v = computeVerdict({ beacon, probes: PARTIAL_PROBES, account: null });
    expect(v.kind).toBe("partial");
    expect(v.tone).toBe("warn");
  });

  it("degrades to tspu_or_network when beacon fails with network error", () => {
    const beacon: BeaconResult = { state: "error", error: "timeout", ms: 6000 };
    const v = computeVerdict({ beacon, probes: ALL_FAIL_PROBES, account: null });
    expect(v.kind).toBe("tspu_or_network");
    expect(v.tone).toBe("err");
  });
});

describe("buildSupportReport", () => {
  it("includes diagnostic data and never leaks tokens, dohUrl, dotHost, or email", () => {
    const secretToken = "abcdefghijklmnopqrs2";
    const beacon: BeaconResult = { state: "ok", pereval: true, tier: "pro", mode: "proxy", ms: 42 };
    const account: CheckAccountContext = {
      authenticated: true,
      mode: "proxy",
      subscriptionStatus: "active",
      ipBound: true,
      ipInDynamicAcl: false,
      dynamicAclExpiresAt: null,
      lastDnsSeenAt: "2026-11-24T10:00:00.000Z",
      disabledCategories: ["media"],
      dohUrl: `https://pro.pereval.top/dns/${secretToken}`,
      dotHost: `${secretToken}.pro.pereval.top`,
    };
    const domainCheck = lookupDomainInCatalog("https://www.notion.so/test", SAMPLE_CATALOG, ["media"]);
    const verdict = computeVerdict({ beacon, probes: ALL_OK_PROBES, account, domainCheck });
    const report = buildSupportReport({
      timestampIso: "2026-11-24T12:00:00.000Z",
      userAgent: "Mozilla/5.0 TestBrowser",
      verdict,
      beacon,
      probes: ALL_OK_PROBES,
      ipv6: { state: "unreachable" },
      domainCheck,
      account,
    });

    expect(report).toContain("Диагностика Перевал (/check)");
    expect(report).toContain("tier=pro");
    expect(report).toContain("Claude:120ms");
    expect(report).toContain("www.notion.so -> PRO");
    expect(report).toContain("ipBound=yes");
    expect(report).toContain("disabledCats=media");
    expect(report).not.toContain(secretToken);
    expect(report).not.toContain("/dns/");
  });
});

describe("GET /api/check/context", () => {
  beforeEach(() => {
    delete process.env.IPV6_CHECK_URL;
    resetEnvCache();
  });

  it("returns 200 with account=null and Cache-Control: no-store for unauthenticated requests", async () => {
    const { GET } = await import("@/app/api/check/context/route");
    const req = new Request("https://pereval.top/api/check/context", {
      headers: { "x-real-ip": "198.51.100.42" },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.json();
    expect(body.detectedIp).toBe("198.51.100.42");
    expect(body.checkUrl).toMatch(/^https:\/\/check\..+\/ping$/);
    expect(body.ipv6CheckUrl).toBeNull();
    expect(body.account).toBeNull();
    expect(body.free.dnsIp).toBeTruthy();
  });
});
