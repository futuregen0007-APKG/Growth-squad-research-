import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Sparkles, Copy, RotateCcw, ChevronDown, ChevronUp, Check, Loader2 } from "lucide-react";
import ResponseBlocksRenderer from "@/components/chat/blocks/ResponseBlocksRenderer";
import DataQualityBlock from "@/components/chat/blocks/DataQualityBlock";
import CitationEntry from "@/components/chat/blocks/CitationEntry";
import EvidenceDrawerSheet from "@/components/chat/blocks/EvidenceDrawerSheet";
import { CitationLinkContext, useLinkifiedChildren } from "@/components/chat/blocks/CitationLinkContext";
import { buildMarkerToEvidenceId } from "@/components/chat/blocks/citationLinkify";
import { getValidBlocks } from "@/components/chat/blocks/blockRegistry";

// react-markdown renders straight to React elements from a parsed markdown
// AST — it never builds an HTML string or touches innerHTML, so literal
// "<script>"/"<img onerror=...>" text in a model response is displayed as
// plain text rather than executed. remarkGfm adds table/strikethrough/task-
// list support; remarkBreaks preserves single line breaks.
//
// UI Phase 1C.2: several of these run their text children through
// useLinkifiedChildren (CitationLinkContext.jsx, a real hook — it calls
// useContext), turning a [N] marker INSIDE THE PROSE into the same
// clickable evidence-drawer trigger SourcesSection/metric_grid/etc.
// already use. Every one of react-markdown's `components` entries is
// keyed by LOWERCASE HTML tag name (`p`, `li`, ...) — that is what
// react-markdown itself dispatches on, and renaming a key would silently
// stop that override from ever being used. But a lowercase-NAMED function
// calling a hook trips react-hooks/eslint-plugin's rules-of-hooks check
// (it only recognizes a hook caller as legitimate if the function's OWN
// name starts uppercase or with "use" — it has no way to know
// react-markdown treats these as real components at runtime). Each is
// therefore declared as its own UPPERCASE-named function first, then
// assigned to the lowercase key react-markdown actually needs — the
// key controls dispatch, not the function's name, so this changes
// nothing about which override renders which element.
const MarkdownH1 = ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{useLinkifiedChildren(children, 'h1')}</h4>;
const MarkdownH2 = ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{useLinkifiedChildren(children, 'h2')}</h4>;
const MarkdownH3 = ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{useLinkifiedChildren(children, 'h3')}</h4>;
const MarkdownH4 = ({ children }) => <h4 className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">{useLinkifiedChildren(children, 'h4')}</h4>;
const MarkdownP = ({ children }) => <p className="text-[13px] text-gs-textMuted leading-relaxed">{useLinkifiedChildren(children, 'p')}</p>;
const MarkdownUl = ({ children }) => <ul className="space-y-0.5">{children}</ul>;
const MarkdownOl = ({ children }) => <ol className="space-y-0.5">{children}</ol>;
const MarkdownLi = ({ children }) => <li className="text-[13px] text-gs-textMuted leading-relaxed ml-4 list-disc">{useLinkifiedChildren(children, 'li')}</li>;
const MarkdownStrong = ({ children }) => <span className="font-semibold text-gs-text">{useLinkifiedChildren(children, 'strong')}</span>;
const MarkdownEm = ({ children }) => <span className="text-[11.5px] text-gs-textDim italic">{useLinkifiedChildren(children, 'em')}</span>;
// Never linkified — code content is always literal text, verbatim.
const MarkdownCode = ({ children, className }) => (
  className?.includes('language-')
    ? <pre className="bg-gs-bg border border-gs-border rounded-sm p-3 overflow-x-auto my-2"><code className="font-mono text-[11.5px] text-gs-text">{children}</code></pre>
    : <code className="font-mono text-[11.5px] text-gs-text bg-gs-bg/60 px-1 rounded-sm">{children}</code>
);
// Never linkified — a real markdown link's own display text is never
// re-interpreted as a citation marker.
const MarkdownA = ({ href, children }) => (
  /^https?:\/\//.test(href || '')
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-gs-gold hover:underline">{children}</a>
    : <span className="text-gs-textMuted">{children}</span>
);
const MarkdownTable = ({ children }) => (
  <div className="overflow-x-auto my-2"><table className="w-full text-[12px] border-collapse">{children}</table></div>
);
const MarkdownThead = ({ children }) => <thead className="border-b border-gs-border">{children}</thead>;
const MarkdownTh = ({ children }) => <th className="text-left px-2 py-1.5 gs-label">{children}</th>;
const MarkdownTd = ({ children }) => <td className="px-2 py-1.5 text-gs-text border-b border-gs-border/50">{useLinkifiedChildren(children, 'td')}</td>;

const MARKDOWN_COMPONENTS = {
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  h4: MarkdownH4,
  p: MarkdownP,
  ul: MarkdownUl,
  ol: MarkdownOl,
  li: MarkdownLi,
  strong: MarkdownStrong,
  em: MarkdownEm,
  code: MarkdownCode,
  a: MarkdownA,
  table: MarkdownTable,
  thead: MarkdownThead,
  th: MarkdownTh,
  td: MarkdownTd,
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

// UI Phase 1C.1: SourcesSection's per-citation rendering (temporal badges,
// "Revised from X to Y", qualitative labels) moved, UNCHANGED, into the
// shared CitationEntry component — this list now maps over it instead of
// inline JSX. Nothing about what is DISPLAYED here changed (see
// chatMessageBubbleGrounded.test.jsx, still green against this refactor);
// `onOpenIndex` is new — wires each [N] into the evidence drawer when one
// exists for this message, a no-op fallback (plain, unclickable [N]) when
// it does not.
const SourcesSection = ({ citations, onOpenEvidence }) => {
  const [open, setOpen] = useState(false);
  if (!citations?.length) return null;
  return (
    <div className="mt-2.5 pt-2.5 border-t border-gs-border" data-testid="sources-section">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[10.5px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text">
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {citations.length} source{citations.length !== 1 ? 's' : ''}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {citations.map((c, i) => (
            <CitationEntry key={c.evidenceId || i} citation={c} index={i} allCitations={citations} onOpenIndex={onOpenEvidence} />
          ))}
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

export default function ChatMessageBubble({ message, onRegenerate, isLast, onAskSuggestedQuestion }) {
  const [copied, setCopied] = useState(false);
  // Hooks must run unconditionally on every render (a user message hits
  // the early return just below) -- declared here, before that return,
  // even though most of this is only ever USED in the assistant branch
  // further down. getValidBlocks/buildMarkerToEvidenceId both handle
  // undefined input safely, so computing them for a user message (where
  // responseBlocks/content mean nothing) is harmless.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeEvidenceId, setActiveEvidenceId] = useState(null);
  // UI Phase 1B: filtered ONCE per render (recognized + shape-valid types
  // only — see blockRegistry.js). `[]` for a pre-Phase-1B persisted
  // message or any turn whose builders produced nothing valid; every
  // consumer below already treats that as "render nothing extra."
  const validBlocks = getValidBlocks(message.responseBlocks);
  const dataQualityBlock = validBlocks.find((block) => block.type === 'data_quality');
  // UI Phase 1C.1: the evidence_drawer block, if this turn produced one.
  // Its Component is a deliberate no-op (see EvidenceDrawerBlock.jsx) —
  // the drawer itself is mounted directly below, once per message.
  const evidenceDrawerBlock = validBlocks.find((block) => block.type === 'evidence_drawer');
  // UI Phase 1C.2: recomputed only when the answer text or the drawer's
  // entries actually change (see citationLinkify.js for why this must be
  // built from the FULL answer text). An empty map (no evidence_drawer
  // block) makes useLinkifiedChildren a true no-op everywhere it's used.
  const markerToEvidenceId = useMemo(
    () => buildMarkerToEvidenceId(message.content, evidenceDrawerBlock?.entries),
    [message.content, evidenceDrawerBlock],
  );

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

  // Clicking a [N] citation opens the drawer at its matching entry. A
  // click on a citation this message's evidence_drawer does not (or does
  // not yet) cover is simply ignored — degrading gracefully rather than
  // opening an empty or mismatched drawer (isolate invalid state, never
  // break the surrounding answer).
  const handleOpenEvidence = (evidenceId) => {
    if (!evidenceDrawerBlock?.entries?.some((entry) => entry.evidenceId === evidenceId)) return;
    setActiveEvidenceId(evidenceId);
    setDrawerOpen(true);
  };
  // Passed to citation markers ONLY when a drawer genuinely exists for
  // this message -- otherwise those [N] markers stay plain, inert text
  // (their pre-Phase-1C.1 appearance) rather than looking clickable and
  // doing nothing.
  const openEvidenceHandler = evidenceDrawerBlock ? handleOpenEvidence : undefined;

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
        {/* company_header sits above everything else -- the company being
            discussed, before its data quality/numbers/prose. */}
        <ResponseBlocksRenderer
          blocks={validBlocks}
          exclude={['source_list', 'data_quality', 'metric_grid', 'comparison_table', 'news_list', 'chart', 'evidence_drawer', 'suggested_questions']}
          onOpenEvidence={openEvidenceHandler}
        />
        {/* UI Phase 1B: a valid data_quality block REPLACES this badge (it
            is a strict superset — see DataQualityBlock's own module note);
            absent a block, behavior is byte-identical to before Phase 1B. */}
        {dataQualityBlock
          ? <DataQualityBlock block={dataQualityBlock} />
          : <GroundingStatusBadge groundingStatus={message.groundingStatus} coverage={message.coverage} />}

        {message.status === 'ERROR' ? (
          <p className="text-[13px] text-gs-neg">{message.content}</p>
        ) : (
          <div className="space-y-0.5">
            {/* The Markdown answer, rendered EXACTLY ONCE — every
                responseBlock below is a supplement to it, never a
                replacement or a second copy of the same prose. The
                Provider makes [N] markers INSIDE this prose clickable
                (Phase 1C.2) — see CitationLinkContext.jsx. */}
            <CitationLinkContext.Provider value={{ markerToEvidenceId, onOpenEvidence: openEvidenceHandler }}>
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MARKDOWN_COMPONENTS}>
                {message.content || ''}
              </ReactMarkdown>
            </CitationLinkContext.Provider>
          </div>
        )}

        {/* metric_grid/comparison_table/news_list/chart supplement the
            prose's own numbers and citations; source_list/data_quality/
            company_header/evidence_drawer are excluded here --
            SourcesSection, the badge above, the header above, and the
            drawer below already own those slots (see each block's own
            module note), and suggested_questions is placed separately,
            below everything. Citations here open the SAME evidence drawer
            SourcesSection's own [N] labels do. */}
        <ResponseBlocksRenderer
          blocks={validBlocks}
          exclude={['source_list', 'data_quality', 'company_header', 'evidence_drawer', 'suggested_questions']}
          onOpenEvidence={openEvidenceHandler}
        />

        <SourcesSection citations={message.citations} onOpenEvidence={openEvidenceHandler} />
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

        {/* Placed below the response, per the brief -- literally last, after sources and actions. */}
        <ResponseBlocksRenderer
          blocks={validBlocks}
          exclude={['source_list', 'data_quality', 'company_header', 'metric_grid', 'comparison_table', 'news_list', 'chart', 'evidence_drawer']}
          onAskSuggestedQuestion={onAskSuggestedQuestion}
        />

        <EvidenceDrawerSheet
          entries={evidenceDrawerBlock?.entries}
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          openEvidenceId={activeEvidenceId}
        />
      </div>
    </div>
  );
}
