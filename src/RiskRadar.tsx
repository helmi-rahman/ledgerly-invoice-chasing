import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

type RiskRadarRow = NonNullable<ReturnType<typeof useQuery<typeof api.riskRadar.dashboard>>>[number];
type RiskAssessment = NonNullable<RiskRadarRow["assessment"]>;
type RiskTier = RiskAssessment["tier"];

type Props = {
  rows: RiskRadarRow[] | undefined;
  asOfDate: string;
  queryError?: string;
};

const tierLabel: Record<RiskTier, string> = { unknown: "Unknown", watch: "Watch", elevated: "Elevated" };

function citationSource(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? { title: parsed.hostname, url, freshness: "unknown" as const, observedAt: undefined } : null;
  } catch { return null; }
}

function RiskRadarContent({ rows, asOfDate, queryError }: Props) {
  const [approved, setApproved] = useState<string[]>([]);

  return <section className="card risk-radar" aria-labelledby="risk-radar-heading">
    <div className="section-head">
      <div><p className="eyebrow">COLLECTIONS RISK RADAR</p><h2 id="risk-radar-heading">Overdue accounts that need a human look</h2></div>
      <span className="preview-badge">DECISION SUPPORT</span>
    </div>
    <p className="risk-note">Transparent, time-bounded signals from verified public evidence. This is not a credit score or an automated adverse decision.</p>
    {queryError ? <div className="risk-state error" role="alert"><strong>Risk data unavailable</strong><p>{queryError}</p><small>Invoice status and payment records are unchanged.</small></div>
      : rows === undefined ? <div className="risk-state" role="status"><strong>Loading overdue accounts…</strong><p>Checking your owned invoice register.</p></div>
      : rows.length === 0 ? <div className="risk-state"><strong>No overdue accounts</strong><p>Only your owned overdue invoices appear here.</p></div>
      : <div className="risk-list">{rows.map(({ invoice, assessment }) => {
        const tier = assessment?.tier ?? "unknown";
        const sources = (assessment?.citations ?? []).map(citationSource).filter((source): source is NonNullable<ReturnType<typeof citationSource>> => source !== null);
        const escalation = assessment?.proposedEscalation;
        const needsApproval = Boolean(escalation) && !approved.includes(invoice._id);
        return <article className="risk-item" key={invoice._id}>
          <div className="risk-item-head"><div><strong>{invoice.clientName}</strong><small>{invoice.invoiceNumber} · {invoice.currency} {(invoice.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}</small></div><span className={`risk-tier tier-${tier}`}>{tierLabel[tier]}</span></div>
          <div className="risk-meta"><span className={`risk-status status-${assessment?.status ?? "unknown"}`}>{assessment?.status ?? "unknown"}</span><span>As of {asOfDate}</span></div>
          <p className="risk-explanation">{assessment?.explanation ?? "No current assessment is available yet."}</p>
          {sources.length > 0 ? <ul className="risk-sources" aria-label={`Sources for ${invoice.invoiceNumber}`}>{sources.map((source) => <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a><span>{source.freshness} {source.observedAt ? `· observed ${source.observedAt}` : ""}</span></li>)}</ul> : <p className="risk-no-evidence">No verified public sources attached. Treat this assessment as unknown.</p>}
          {escalation && <div className="approval-box"><div><strong>Human approval required</strong><p>{approved.includes(invoice._id) ? "Approval recorded locally. No message was sent." : escalation.summary}</p></div>{needsApproval ? <button className="secondary" onClick={() => setApproved((current) => [...current, invoice._id])}>Approve preview</button> : <span className="approved-label">Approval recorded</span>}</div>}
        </article>;
      })}</div>}
  </section>;
}

type BoundaryProps = { children: ReactNode };
type BoundaryState = { error: Error | null };

class RiskRadarErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState { return { error }; }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    if (this.state.error) {
      return <div className="risk-state error" role="alert"><strong>Risk data unavailable</strong><p>{this.state.error.message || "Unable to load the owned overdue-account assessment."}</p><small>Invoice status and payment records are unchanged.</small></div>;
    }
    return this.props.children;
  }
}

export function RiskRadar(props: Props) {
  return <RiskRadarErrorBoundary><RiskRadarContent {...props} /></RiskRadarErrorBoundary>;
}