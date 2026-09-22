export const RISK_STATUSES = ["ready", "unknown", "error", "stale"] as const;
export const RISK_TIERS = ["unknown", "watch", "elevated"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
export type RiskTier = (typeof RISK_TIERS)[number];

export type ModelAssessment = { tier: RiskTier; explanation: string };

export const RISK_RADAR_FIXTURES = {
  allowedOfficial: { url: "https://acme.example/news/restructuring", title: "Restructuring update", description: "Acme announced a restructuring plan.", publishedAt: "2026-08-20T09:00:00Z" },
  allowedRegulator: { url: "https://www.sec.gov/Archives/edgar/data/1/filing.htm", title: "Regulatory filing", description: "A bounded regulatory filing excerpt." },
  blockedPrivate: { url: "http://internal.example/report", title: "Private report", description: "Should not be imported." },
} as const;

type Allowlist = { officialHosts: readonly string[]; regulatorHosts: readonly string[]; reputableNewsHosts: readonly string[] };
type FirecrawlResult = { url?: unknown; title?: unknown; description?: unknown; publishedAt?: unknown };
export function normalizeFirecrawlEvidence(results: readonly FirecrawlResult[], options: { observedAt: string; allowlist: Allowlist; provider: string }): {
  evidence: Array<{ sourceType: "official" | "regulator" | "news"; url: string; title: string; excerpt: string; observedAt: string; publishedAt?: string; freshness: "fresh" | "stale" | "unknown"; provenance: { provider: string; operation: "search" } }>;
  errors: Array<{ error: string; url?: string; freshness: "unknown" }>;
} {
  const observed = new Date(options.observedAt);
  if (Number.isNaN(observed.getTime())) return { evidence: [], errors: [{ error: "observedAt must be a valid ISO timestamp", freshness: "unknown" }] };
  const observedAt = observed.toISOString();
  const evidence: Array<{ sourceType: "official" | "regulator" | "news"; url: string; title: string; excerpt: string; observedAt: string; publishedAt?: string; freshness: "fresh" | "stale" | "unknown"; provenance: { provider: string; operation: "search" } }> = [];
  const errors: Array<{ error: string; url?: string; freshness: "unknown" }> = [];
  for (const result of results) {
    if (typeof result.url !== "string" || !result.url.startsWith("https://")) { errors.push({ error: "missing or non-HTTPS URL", freshness: "unknown" }); continue; }
    let host: string; try { host = new URL(result.url).hostname; } catch { errors.push({ error: "missing or non-HTTPS URL", url: result.url, freshness: "unknown" }); continue; }
    const sourceType = options.allowlist.officialHosts.includes(host) ? "official" : options.allowlist.regulatorHosts.includes(host) ? "regulator" : options.allowlist.reputableNewsHosts.includes(host) ? "news" : undefined;
    if (!sourceType) { errors.push({ error: "source host is not allowlisted", url: result.url, freshness: "unknown" }); continue; }
    if (typeof result.title !== "string" || !result.title.trim() || typeof result.description !== "string" || !result.description.trim() || result.description.length > 8_000) { errors.push({ error: "source title and bounded excerpt are required", url: result.url, freshness: "unknown" }); continue; }
    let publishedAt: string | undefined; let freshness: "fresh" | "stale" | "unknown" = "unknown";
    if (typeof result.publishedAt === "string") { const date = new Date(result.publishedAt); if (!Number.isNaN(date.getTime())) { publishedAt = date.toISOString(); freshness = date.getTime() >= observed.getTime() - 90 * 86_400_000 ? "fresh" : "stale"; } }
    evidence.push({ sourceType, url: result.url, title: result.title.trim(), excerpt: result.description.trim(), observedAt, ...(publishedAt ? { publishedAt } : {}), freshness, provenance: { provider: options.provider, operation: "search" as const } });
  }
  return { evidence, errors };
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname); } catch { return false; }
}

/** Treat provider output as hostile data; only this closed shape is accepted. */
export function parseModelAssessment(input: unknown): ModelAssessment {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { throw new Error("Malformed model output"); }
  }
  if (!value || typeof value !== "object") throw new Error("Malformed model output");
  const record = value as Record<string, unknown>;
  if (!RISK_TIERS.includes(record.tier as RiskTier) || typeof record.explanation !== "string") throw new Error("Invalid model assessment");
  if (record.explanation.trim().length === 0 || record.explanation.length > 4_000) throw new Error("Model explanation is out of bounds");
  return { tier: record.tier as RiskTier, explanation: record.explanation.trim() };
}

export function assessLocal(input: { amountCents: number; dueDate: string; asOfDate: string }): ModelAssessment {
  if (!isValidDate(input.dueDate) || !isValidDate(input.asOfDate)) return { tier: "unknown", explanation: "Insufficient valid dates for a local assessment." };
  const overdue = input.dueDate < input.asOfDate;
  if (!overdue) return { tier: "unknown", explanation: "No overdue signal is present in the local invoice data." };
  return { tier: input.amountCents >= 100_000 ? "elevated" : "watch", explanation: "Local deterministic assessment: invoice is overdue; review the cited evidence before acting." };
}