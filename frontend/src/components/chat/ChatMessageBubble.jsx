import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Sparkles, Copy, RotateCcw, ChevronDown, ChevronUp, Check, Loader2 } from "lucide-react";

// react-markdown renders straight to React elements from a parsed markdown
// AST — it never builds an HTML string or touches innerHTML, so literal
// "<script>"/"<img onerror=...>" text in a model response is displayed as
// plain text rather than executed. remarkGfm adds table/strikethrough/task-
// list support; remarkBreaks preserves single line breaks.
const MARKDOWN_COMPONENTS = {
  h1: ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{children}</h4>,
  h2: ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{children}</h4>,
  h3: ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{children}</h4>,
  h4: ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{children}</h4>,
  p: ({ children }) => <p className="text-[13px] text-gs-textMuted leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-[13px] text-gs-textMuted leading-relaxed ml-4 list-disc">{children}</li>,
  strong: ({ children }) => <span className="font-semibold text-gs-text">{children}</span>,
  em: ({ children }) => <span className="text-[11.5px] text-gs-textDim italic">{children}</span>,
  code: ({ children, className }) => (
    className?.includes('language-')
      ? <pre className="bg-gs-bg border border-gs-border rounded-sm p-3 overflow-x-auto my-2"><code className="font-mono text-[11.5px] text-gs-text">{children}</code></pre>
      : <code className="font-mono text-[11.5px] text-gs-text bg-gs-bg/60 px-1 rounded-sm">{children}</code>
  ),
  a: ({ href, children }) => (
    /^https?:\/\//.test(href || '')
      ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline">{children}</a>
      : <span className="text-gs-textMuted">{children}</span>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2"><table className="w-full text-[12px] border-collapse">{children}</table></div>
  ),
  thead: ({ children }) => <thead className="border-b border-gs-border">{children}</thead>,
  th: ({ children }) => <th className="text-left px-2 py-1.5 gs-label">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1.5 text-gs-text border-b border-gs-border/50">{children}</td>,
};

const ToolActivityRow = ({ activity }) => {
  if (!activity?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2" data-testid="tool-activity">
      {activity.map((t, i) => (
        <span key={`${t.tool}-${i}`} className="inline-flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-gs-panel border border-gs-border text-gs-textDim">
          {t.status === 'running' ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Check className="w-2.5 h-2.5 text-gs-pos" />}
          {t.tool}
        </span>
      ))}
    </div>
  );
};

// Dev-only tool activity panel — NEVER shown in production unless
// explicitly enabled. Gated behind an env var, not just NODE_ENV, so an
// operator can deliberately turn it on in a deployed environment for
// debugging without a rebuild-time toggle.
const SHOW_TOOL_PANEL = process.env.NODE_ENV !== 'production' || process.env.REACT_APP_SHOW_TOOL_PANEL === 'true';

const TOOL_STATUS_STYLE = {
  SUCCESS: 'text-gs-pos border-gs-pos/30 bg-gs-posBg',
  EMPTY: 'text-gs-textDim border-gs-border bg-gs-panel',
  UNAVAILABLE: 'text-gs-gold border-gs-gold/30 bg-gs-goldMuted',
  UNSUPPORTED: 'text-gs-textDim border-gs-border bg-gs-panel',
  ERROR: 'text-gs-neg border-gs-neg/30 bg-gs-negBg',
};

/**
 * ToolActivityPanel - development-only diagnostics: tool name, its final
 * SUCCESS/EMPTY/UNAVAILABLE/UNSUPPORTED/ERROR status, result count,
 * evidence count, and a safe error code (never a raw provider error —
 * see backend/graph/safeReasons.js). Collapsed by default.
 */
const ToolActivityPanel = ({ activity }) => {
  const [open, setOpen] = useState(false);
  if (!SHOW_TOOL_PANEL || !activity?.length) return null;
  return (
    <div className="mt-2.5 pt-2.5 border-t border-dashed border-gs-border" data-testid="tool-activity-panel">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text">
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        Dev: tool activity ({activity.length})
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {activity.map((t, i) => (
            <div key={`${t.tool}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] font-mono px-2 py-1.5 rounded-sm border border-gs-border bg-gs-bg/40" data-testid={`tool-activity-row-${t.tool}`}>
              <span className="text-gs-text min-w-[9rem]">{t.tool}</span>
              <span className={`px-1.5 py-0.5 rounded-sm border ${TOOL_STATUS_STYLE[t.status] || 'text-gs-textDim border-gs-border'}`}>{t.status}</span>
              <span className="text-gs-textDim">results: {t.resultCount ?? '—'}</span>
              <span className="text-gs-textDim">evidence: {t.evidenceCount ?? '—'}</span>
              {t.errorCode && <span className="text-gs-neg">{t.errorCode}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Phase 4B Part 10: safe link check reused for the richer grounded-citation
// card below — same rule ChatMessageBubble's markdown `a` renderer already
// applies to model-generated links (only http(s), never a raw scheme like
// javascript:).
const isSafeHref = (href) => /^https?:\/\//.test(href || '');

// Phase 4D Part 7: temporal citation labels. `temporalStatus`/`supersededBy`/
// `supersedes`/`canonicalGuidance` are trusted, server-computed metadata
// (see services/EvidenceEnvelope.js's reconcileEvidenceEnvelope) — this
// component only ever DISPLAYS them, never re-derives or second-guesses
// them, and never shows any internal verifier diagnostic (reasonCode,
// relationshipId, confidence) in this production UI.
const TEMPORAL_LABEL_STYLE = {
  SUPERSEDED: { label: 'Superseded', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
  CURRENT: { label: 'Current', className: 'text-gs-pos border-gs-pos/30 bg-gs-posBg' },
  HISTORICAL: { label: 'Historical outcome', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
  CONFLICTING: { label: 'Conflicting source', className: 'text-gs-neg border-gs-neg/30 bg-gs-negBg' },
  UNRESOLVED: { label: 'Unverified figure', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
};

/** formatGuidanceRange - a short "21%-23%" / "22%" label from canonicalGuidance, or null when nothing was safely extracted -- never guessed here either. */
const formatGuidanceRange = (canonicalGuidance) => {
  if (!canonicalGuidance) return null;
  const unitSuffix = canonicalGuidance.unit === 'PERCENTAGE' ? '%' : '';
  if (canonicalGuidance.valueType === 'range' && canonicalGuidance.lowerBound != null && canonicalGuidance.upperBound != null) {
    return `${canonicalGuidance.lowerBound}${unitSuffix}-${canonicalGuidance.upperBound}${unitSuffix}`;
  }
  if (canonicalGuidance.valueType === 'exact' && canonicalGuidance.exactValue != null) {
    return `${canonicalGuidance.exactValue}${unitSuffix}`;
  }
  return null;
};

const SourcesSection = ({ citations }) => {
  const [open, setOpen] = useState(false);
  if (!citations?.length) return null;
  const byId = new Map(citations.map((c) => [c.evidenceId, c]));
  return (
    <div className="mt-2.5 pt-2.5 border-t border-gs-border" data-testid="sources-section">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text">
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {citations.length} source{citations.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {citations.map((c, i) => {
            // documentTitle/reportingPeriod/pageStart/sourceAuthority are
            // only present on a Phase 4B grounded citation (see
            // graph/groundedAnswer.js's citationFromEvidence) — a legacy
            // citation just renders as before via the title/provider
            // aliases that builder also sets for exactly this reason.
            const label = c.documentTitle || c.title || c.sourceUrl || 'Source unavailable';
            const metaParts = [
              c.symbol, c.reportingPeriod, c.sourceAuthority || c.provider,
              c.pageStart ? `p.${c.pageStart}${c.pageEnd && c.pageEnd !== c.pageStart ? `-${c.pageEnd}` : ''}` : null,
            ].filter(Boolean);
            const temporalStyle = TEMPORAL_LABEL_STYLE[c.temporalStatus];
            // "Revised from X to Y" — only rendered when the OLD value it
            // superseded is ALSO one of this answer's real citations (never
            // fabricated from a value the user can't independently see).
            const supersededSibling = c.supersedes?.length ? byId.get(c.supersedes[0]) : null;
            const revisionSummary = c.temporalStatus === 'CURRENT' && supersededSibling
              ? (() => {
                const from = formatGuidanceRange(supersededSibling.canonicalGuidance);
                const to = formatGuidanceRange(c.canonicalGuidance);
                return from && to ? `Revised from ${from} to ${to}` : null;
              })()
              : null;
            return (
              <div key={c.evidenceId || i} className="text-[11px] text-gs-textMuted flex items-start gap-1.5">
                <span className="text-gs-textDim shrink-0">[{i + 1}]</span>
                <div className="min-w-0">
                  {c.sourceUrl && isSafeHref(c.sourceUrl) ? (
                    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline break-words">
                      {label}
                    </a>
                  ) : (
                    <span className="break-words">{label}</span>
                  )}
                  {temporalStyle && (
                    <span className={`ml-1.5 inline-flex items-center font-mono text-[9px] uppercase tracking-wider px-1 py-0.5 rounded-sm border ${temporalStyle.className}`}>
                      {temporalStyle.label}
                    </span>
                  )}
                  {(metaParts.length > 0 || c.publishedAt) && (
                    <div className="text-gs-textDim">
                      {metaParts.join(' · ')}
                      {c.publishedAt && ` ${metaParts.length ? '· ' : ''}${new Date(c.publishedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
                    </div>
                  )}
                  {revisionSummary && <div className="mt-0.5 text-gs-gold">{revisionSummary}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// Phase 4B Part 10: grounding-status badge + honest insufficient-evidence
// copy. Absent entirely for a non-research message (groundingStatus is
// null) — never shown on ordinary chat.
const GROUNDING_STATUS_STYLE = {
  grounded: { label: 'Verified from documents', className: 'text-gs-pos border-gs-pos/30 bg-gs-posBg' },
  partially_grounded: { label: 'Partially verified', className: 'text-gs-gold border-gs-gold/30 bg-gs-goldMuted' },
  insufficient_evidence: { label: 'Insufficient evidence', className: 'text-gs-textDim border-gs-border bg-gs-panel' },
};

const GroundingStatusBadge = ({ groundingStatus, coverage }) => {
  const style = GROUNDING_STATUS_STYLE[groundingStatus];
  if (!style) return null;
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1.5" data-testid="grounding-status">
      <span className={`inline-flex items-center font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm border ${style.className}`}>
        {style.label}
      </span>
      {coverage?.limitations?.length > 0 && (
        <span className="text-[10.5px] text-gs-textDim">{coverage.limitations.join('; ')}</span>
      )}
    </div>
  );
};

export default function ChatMessageBubble({ message, onRegenerate, isLast }) {
  const [copied, setCopied] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end" data-testid="msg-user">
        <div className="bg-gs-card border border-gs-border rounded-sm px-4 py-2.5 max-w-[80%] text-[13px] text-gs-text whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  const copy = () => {
    navigator.clipboard?.writeText(message.content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex gap-3" data-testid="msg-assistant">
      <div className="w-7 h-7 shrink-0 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
        <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
      </div>
      <div className="flex-1 max-w-[90%] pt-0.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-gs-gold">GS Copilot</span>
          {message.createdAt && (
            <span className="font-mono text-[9.5px] text-gs-textDim">{new Date(message.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>

        <ToolActivityRow activity={message.toolActivity} />
        <GroundingStatusBadge groundingStatus={message.groundingStatus} coverage={message.coverage} />

        {message.status === 'ERROR' ? (
          <p className="text-[13px] text-gs-neg">{message.content}</p>
        ) : (
          <div className="space-y-0.5">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
              {message.content || ''}
            </ReactMarkdown>
          </div>
        )}

        <SourcesSection citations={message.citations} />
        <ToolActivityPanel activity={message.toolActivity} />

        {message.content && !message.streaming && (
          <div className="flex items-center gap-3 mt-2">
            <button onClick={copy} className="flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text" data-testid="copy-response">
              {copied ? <Check className="w-3 h-3 text-gs-pos" /> : <Copy className="w-3 h-3" />} {copied ? 'Copied' : 'Copy'}
            </button>
            {isLast && onRegenerate && (
              <button onClick={onRegenerate} className="flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text" data-testid="regenerate-response">
                <RotateCcw className="w-3 h-3" /> Regenerate
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
