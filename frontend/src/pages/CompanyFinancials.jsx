import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Search } from 'lucide-react';
import { searchCompanyFinancials, explainCompanyFinancials } from '@/services/companyFinancialsApi';

const safeText = (value) => (value === null || value === undefined || value === '' ? '—' : value);
const safeNumber = (value) => (value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value));
const formatCr = (value) => { const n = safeNumber(value); return n === null ? '—' : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr`; };
const formatPct = (value) => { const n = safeNumber(value); return n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; };
const formatFetchedAt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
};

const SECTION_LABELS = {
  profile: 'Company Profile',
  balanceSheet: 'Balance Sheet',
  cashFlow: 'Cash Flow',
  incomeStatement: 'Income Statement',
  keyRatios: 'Key Ratios',
  shareholding: 'Shareholding',
  corporateActions: 'Corporate Actions',
};

function StateMessage({ children, testId }) {
  return <div className="flex min-h-28 items-center justify-center gap-2 text-sm text-gs-textMuted" data-testid={testId}><AlertCircle className="h-4 w-4 text-gs-textDim" />{children}</div>;
}

/** Every section renders its OWN loading/available/partial/unavailable/error state -- one slow/failed section never gates the others. */
function SectionCard({ title, section, onRetry, children }) {
  const status = section?.status || 'UNAVAILABLE';
  const hasBody = status === 'AVAILABLE' || status === 'PARTIAL';
  return (
    <div className="gs-card space-y-3 p-4" data-testid={`financials-section-${title.replace(/\s+/g, '-').toLowerCase()}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-gs-text">{title}</h3>
        <span className="font-mono text-[9px] uppercase tracking-wider text-gs-textDim">{status}</span>
      </div>
      {hasBody && children}
      {status === 'PARTIAL' && <p className="text-[11px] text-gs-textDim">Some fields were not reported by the provider.</p>}
      {status === 'UNAVAILABLE' && <p className="text-sm text-gs-textMuted">Not available from Upstox for this company right now.</p>}
      {status === 'PROVIDER_ERROR' && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gs-textMuted">{section?.error?.message || 'Temporarily unavailable.'}</p>
          <button type="button" onClick={onRetry} className="shrink-0 font-mono text-[11px] text-gs-gold hover:underline">Retry</button>
        </div>
      )}
      {section?.data?.fetchedAt && (
        <p className="border-t border-gs-border pt-2 text-[10px] text-gs-textDim">
          Source: Upstox · Fetched at {formatFetchedAt(section.data.fetchedAt)}{section.fromCache ? ' (cached)' : ' (live)'}
        </p>
      )}
    </div>
  );
}

function ProfileBlock({ section }) {
  const data = section?.data;
  if (!data) return null;
  return (
    <div className="space-y-2 text-[12px] text-gs-textMuted">
      <p className="leading-5">{safeText(data.companyProfile)}</p>
      <div className="text-[10px] text-gs-textDim">Sector: {safeText(data.sector)}</div>
      {data.sectorMarketCapInr?.formatted && (
        <div className="text-[10px] text-gs-textDim">Sector market cap (not company-level): {data.sectorMarketCapInr.formatted}</div>
      )}
    </div>
  );
}

function RatiosTable({ section }) {
  const ratios = section?.data?.ratios;
  if (!ratios?.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {ratios.map((r) => (
        <div key={r.name} className="border border-gs-border p-2">
          <div className="text-[10px] text-gs-textDim">{r.name}</div>
          <div className="font-mono text-sm text-gs-text">{safeText(safeNumber(r.companyValue))}</div>
          <div className="text-[10px] text-gs-textDim">Sector: {safeText(safeNumber(r.sectorValue))}</div>
        </div>
      ))}
    </div>
  );
}

function StatementTable({ section }) {
  const data = section?.data;
  if (!data?.metrics?.length) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gs-textDim">{safeText(data.statementType)} · {safeText(data.period)} · Units: ₹ Cr</div>
      <div className="max-h-72 divide-y divide-gs-border overflow-y-auto">
        {data.metrics.map((m, index) => (
          <div key={`${m.label}-${m.financialYear}-${index}`} className="flex items-center justify-between gap-3 py-1.5 text-[12px]">
            <span className="capitalize text-gs-textMuted">{String(m.label || '').replace(/_/g, ' ')} <span className="text-gs-textDim">({safeText(m.financialYear)})</span></span>
            <span className="font-mono text-gs-text">{formatCr(m.value)}{m.changePct != null ? <span className="ml-2 text-gs-textDim">{formatPct(m.changePct)}</span> : null}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareholdingBlock({ section }) {
  const categories = section?.data?.categories;
  if (!categories?.length) return null;
  return (
    <div className="space-y-2">
      {categories.map((c) => (
        <div key={c.category}>
          <div className="text-[11px] capitalize text-gs-text">{String(c.category || '').replace(/_/g, ' ')}</div>
          <div className="mt-1 flex flex-wrap gap-2">
            {c.history.slice(0, 6).map((h, index) => (
              <span key={`${h.period}-${index}`} className="border border-gs-border px-1.5 py-0.5 font-mono text-[10px] text-gs-textMuted">
                {safeText(h.period)}: {safeText(safeNumber(h.valuePct))}{safeNumber(h.valuePct) !== null ? '%' : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CorporateActionsBlock({ section }) {
  const actions = section?.data?.actions;
  if (!actions?.length) return null;
  return (
    <div className="divide-y divide-gs-border">
      {actions.slice(0, 10).map((a, index) => (
        <div key={`${a.name}-${index}`} className="flex justify-between gap-3 py-2 text-[12px]">
          <span className="text-gs-text">{safeText(a.name)}</span>
          <span className="text-right font-mono text-gs-textMuted">
            {a.amount != null ? a.amount : safeText(a.ratio)}
            {a.expiryDate ? ` · ${new Date(a.expiryDate).toLocaleDateString('en-IN')}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

const SECTION_BODY = {
  profile: ProfileBlock,
  keyRatios: RatiosTable,
  balanceSheet: StatementTable,
  cashFlow: StatementTable,
  incomeStatement: StatementTable,
  shareholding: ShareholdingBlock,
  corporateActions: CorporateActionsBlock,
};

export default function CompanyFinancials() {
  const { symbol: routeSymbol } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const activeQuery = String(routeSymbol || searchParams.get('q') || '').trim();

  const [queryInput, setQueryInput] = useState(activeQuery);
  const [loading, setLoading] = useState(Boolean(activeQuery));
  const [loadError, setLoadError] = useState(null);
  const [result, setResult] = useState(null);
  // A simple local counter bumped by a button click, used as a re-fetch
  // trigger -- mirrors News.jsx's reloadToken idiom rather than a new retry
  // abstraction.
  const [retryToken, setRetryToken] = useState(0);
  const [explanation, setExplanation] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);

  useEffect(() => { setQueryInput(activeQuery); }, [activeQuery]);

  useEffect(() => {
    if (!activeQuery) { setLoading(false); setResult(null); return undefined; }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    searchCompanyFinancials(activeQuery, { signal: controller.signal })
      .then((data) => { if (active) setResult(data); })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setLoadError('Company financials search is temporarily unavailable.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [activeQuery, retryToken]);

  // AI explanation is fetched AFTER the figures above resolve, in its own
  // effect -- a slow/failed explanation must never block or delay the
  // financial statements themselves.
  useEffect(() => {
    if (!result?.data?.symbol) { setExplanation(null); return undefined; }
    let active = true;
    const controller = new AbortController();
    setExplainLoading(true);
    setExplanation(null);
    const sections = Object.fromEntries(
      Object.entries(result.data.sections).map(([key, section]) => [key, section.available ? section.data : null]),
    );
    explainCompanyFinancials(result.data.symbol, { sections, companyName: result.data.companyName }, { signal: controller.signal })
      .then((data) => { if (active) setExplanation(data); })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setExplanation({ available: false, reason: 'AI explanation is temporarily unavailable.' });
      })
      .finally(() => { if (active) setExplainLoading(false); });
    return () => { active = false; controller.abort(); };
    // `result` (not just its symbol) is the real dependency -- it's a fresh
    // object on every resolved fetch, so this only re-runs on a genuinely
    // new result, same as before, while satisfying exhaustive-deps for the
    // companyName/sections fields actually read above.
  }, [result, retryToken]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    const q = queryInput.trim();
    if (q) navigate(`/company-financials/${encodeURIComponent(q.toUpperCase())}`);
  };

  return (
    <div className="space-y-4" data-testid="company-financials-page">
      <button type="button" onClick={() => navigate(-1)} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim hover:text-gs-text">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>

      <form onSubmit={handleSearchSubmit} className="flex max-w-md gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gs-textDim" />
          <input
            type="text"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="Search company (ticker or name)…"
            className="w-full rounded-md border border-gs-border bg-gs-card py-2 pl-10 pr-3 text-sm text-gs-text placeholder-gs-textDim focus:border-gs-accent focus:outline-none"
          />
        </div>
        <button type="submit" className="rounded-md border border-gs-border px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-gs-text hover:border-gs-gold">Search</button>
      </form>

      {!activeQuery && <StateMessage testId="company-financials-empty">Search for a company to view its reported financial statements.</StateMessage>}

      {loading && <div className="gs-card p-8 text-center text-sm text-gs-textDim" data-testid="company-financials-loading">Fetching financial statements from Upstox…</div>}

      {!loading && loadError && (
        <div className="gs-card p-8 text-center" data-testid="company-financials-error">
          <p className="text-sm text-gs-textMuted">{loadError}</p>
          <button type="button" onClick={() => setRetryToken((t) => t + 1)} className="mt-3 text-sm text-gs-gold hover:text-gs-text">Retry</button>
        </div>
      )}

      {!loading && !loadError && result?.ambiguous && (
        <div className="gs-card space-y-3 p-5" data-testid="company-financials-ambiguous">
          <p className="text-sm text-gs-text">Multiple companies match &quot;{result.query}&quot;. Please choose one:</p>
          <div className="flex flex-wrap gap-2">
            {(result.candidates || []).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => navigate(`/company-financials/${encodeURIComponent(candidate)}`)}
                className="border border-gs-border px-3 py-1.5 font-mono text-[11px] text-gs-text hover:border-gs-gold"
              >
                {candidate}
              </button>
            ))}
          </div>
        </div>
      )}

      {!loading && !loadError && result?.notFound && (
        <StateMessage testId="company-financials-notfound">No matching company found for &quot;{result.query}&quot;. Try a ticker or the full company name.</StateMessage>
      )}

      {!loading && !loadError && result?.isinUnavailable && (
        <StateMessage testId="company-financials-no-isin">{safeText(result.companyName)} ({safeText(result.symbol)}) has no ISIN on file yet — financial statements cannot be fetched.</StateMessage>
      )}

      {!loading && !loadError && result?.data && (
        <>
          <header className="gs-card space-y-2 border-t-2 border-t-gs-gold/60 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xl font-bold text-gs-text">{result.data.symbol}</span>
              <span className="text-sm text-gs-textMuted">{safeText(result.data.companyName)}</span>
            </div>
            <p className="text-[11px] text-gs-textDim">
              These are periodic reported financial statements (source: Upstox), <strong className="text-gs-text">not a real-time quote</strong>. Data coverage: {result.data.dataCoveragePct}%
              {result.data.configurationError ? ' — Upstox is not configured on the server yet.' : ''}
            </p>
          </header>

          <div className="grid gap-4 md:grid-cols-2">
            {Object.entries(SECTION_LABELS).map(([key, label]) => {
              const Body = SECTION_BODY[key];
              return (
                <SectionCard key={key} title={label} section={result.data.sections[key]} onRetry={() => setRetryToken((t) => t + 1)}>
                  <Body section={result.data.sections[key]} />
                </SectionCard>
              );
            })}
          </div>

          <div className="gs-card space-y-2 p-4" data-testid="company-financials-ai-explanation">
            <h3 className="font-display text-sm font-semibold text-gs-text">AI Explanation</h3>
            {explainLoading && <p className="text-sm text-gs-textDim">Generating a grounded explanation…</p>}
            {!explainLoading && explanation?.available && (
              <div className="space-y-2 text-[12px] text-gs-textMuted">
                <p className="leading-5">{explanation.summary}</p>
                {explanation.missingSectionsNote && <p className="text-[11px] text-gs-textDim">{explanation.missingSectionsNote}</p>}
                <p className="border-t border-gs-border pt-2 text-[10px] text-gs-textDim">Generated {formatFetchedAt(explanation.generatedAt)} — interpretation of the figures above, not investment advice.</p>
              </div>
            )}
            {!explainLoading && explanation && !explanation.available && (
              <p className="text-sm text-gs-textDim">{explanation.reason || 'AI explanation is not available right now.'}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
