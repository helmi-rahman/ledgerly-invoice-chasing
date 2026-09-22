import { describe, expect, it } from "vitest";
import { normalizeFirecrawlEvidence, RISK_RADAR_FIXTURES } from "./riskRadar";

describe("risk radar evidence seam", () => {
  const allowlist = {
    officialHosts: ["acme.example"],
    regulatorHosts: ["www.sec.gov"],
    reputableNewsHosts: ["reuters.com"],
  } as const;

  it("normalizes allowlisted public results deterministically", () => {
    const options = { observedAt: "2026-08-30T00:00:00Z", allowlist, provider: "fixture" as const };
    const first = normalizeFirecrawlEvidence([RISK_RADAR_FIXTURES.allowedOfficial], options);
    expect(first).toEqual(normalizeFirecrawlEvidence([RISK_RADAR_FIXTURES.allowedOfficial], options));
    expect(first).toMatchObject({ evidence: [{ sourceType: "official", url: "https://acme.example/news/restructuring", publishedAt: "2026-08-20T09:00:00.000Z", freshness: "fresh", provenance: { provider: "fixture", operation: "search" } }], errors: [] });
  });

  it("accepts regulator sources but rejects non-HTTPS and unlisted hosts", () => {
    const result = normalizeFirecrawlEvidence([RISK_RADAR_FIXTURES.allowedRegulator, RISK_RADAR_FIXTURES.blockedPrivate], { observedAt: "2026-08-30T00:00:00Z", allowlist, provider: "fixture" });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ sourceType: "regulator", url: "https://www.sec.gov/Archives/edgar/data/1/filing.htm" });
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ error: "missing or non-HTTPS URL", freshness: "unknown" }),
    ]));
  });

  it("does not invent dates and reports incomplete or invalid inputs as unknown errors", () => {
    const result = normalizeFirecrawlEvidence([
      { url: "https://reuters.com/news", title: "News", description: "A bounded excerpt." },
      { url: "https://reuters.com/missing-title", description: "Excerpt only." },
    ], { observedAt: "2026-08-30T00:00:00Z", allowlist, provider: "fixture" });
    expect(result.evidence[0]).toMatchObject({ observedAt: "2026-08-30T00:00:00.000Z", freshness: "unknown" });
    expect(result.evidence[0]).not.toHaveProperty("publishedAt");
    expect(result.errors[0]).toMatchObject({ error: "source title and bounded excerpt are required", freshness: "unknown" });
    expect(normalizeFirecrawlEvidence([], { observedAt: "not-a-date", allowlist, provider: "fixture" }).errors[0].error).toBe("observedAt must be a valid ISO timestamp");
  });
});
