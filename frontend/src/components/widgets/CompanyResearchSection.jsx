import { useEffect, useState } from "react";
import { AlertCircle, Building2, TrendingUp, PieChart, FileText, Users, Newspaper, Info } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { fetchCompanyResearch } from "@/services/companyResearchApi";

// A section's own honest "unavailable" state — never a fabricated fallback.
const SectionUnavailable = ({ section }) => (
  <div className="flex items-start gap-2 text-sm text-gs-textMuted py-6 justify-center text-center px-4" data-testid="research-section-unavailable">
    <AlertCircle className="w-4 h-4 text-gs-textDim flex-shrink-0 mt-0.5" />
    <span>
      {section?.error?.code === 'CONFIGURATION_ERROR'
        ? 'Company research is not configured for this deployment.'
        : section?.error?.code === 'UNSUPPORTED_CAPABILITY'
          ? 'This data is not supported by the current research provider.'
          : 'This data is currently unavailable. Please try again later.'}
    </span>
  </div>
);

const SectionEmpty = ({ label }) => (
  <div className="text-sm text-gs-textMuted py-6 text-center" data-testid="research-section-empty">
    No {label} data has been reported by the provider for this company.
  </div>
);

const rawEntries = (raw) => Object.entries(raw || {}).filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object');

const RawFieldTable = ({ raw }) => {
  const entries = rawEntries(raw);
  if (!entries.length) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
      {entries.slice(0, 12).map(([key, value]) => (
        <div key={key}>
          <div className="text-[10px] uppercase tracking-wider text-gs-textDim font-mono truncate">{key}</div>
          <div className="font-mono text-[12.5px] text-gs-text tabular-nums">{String(value)}</div>
        </div>
      ))}
    </div>
  );
};

const DatedEntryList = ({ entries = [], emptyLabel }) => {
  if (!entries.length) return <SectionEmpty label={emptyLabel} />;
  return (
    <div className="space-y-3">
      {entries.slice(0, 10).map((entry, i) => (
        <div key={i} className="border-b border-gs-border last:border-b-0 pb-3 last:pb-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[12.5px] text-gs-text font-medium">{entry.title || entry.period || 'Reported item'}</span>
            <span className="font-mono text-[10px] text-gs-textDim">
              {entry.period ? entry.period : ''}{entry.date ? ` · ${new Date(entry.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ''}
            </span>
          </div>
          <div className="mt-1.5">
            <RawFieldTable raw={entry.raw} />
          </div>
          {entry.sourceUrl && (
            <a href={entry.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[10.5px] text-gs-gold hover:underline mt-1 inline-block">
              Source ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
};

const SECTION_META = {
  profile: { label: 'Overview', icon: Building2 },
  financials: { label: 'Financials', icon: TrendingUp },
  keyMetrics: { label: 'Key Metrics', icon: PieChart },
  shareholding: { label: 'Shareholding', icon: Users },
  corporateActions: { label: 'Corp. Actions', icon: FileText },
  analystData: { label: 'Analyst View', icon: Info },
  news: { label: 'News', icon: Newspaper },
};

/**
 * CompanyResearchSection - independent Stock Detail widget for the
 * IndianAPI-backed company research bundle. Fetches once on mount; a
 * failure of the *entire* request (network/backend down) shows one honest
 * error state for the whole widget, while a failure of a single *section*
 * (e.g. IndianAPI's financials endpoint down but profile still returned)
 * only affects that section — the rest keep rendering normally. Nothing
 * here is ever a fabricated fallback value.
 */
export default function CompanyResearchSection({ symbol }) {
  const [state, setState] = useState({ loading: true, bundle: null, error: null });

  useEffect(() => {
    if (!symbol) return undefined;
    let active = true;
    setState({ loading: true, bundle: null, error: null });
    fetchCompanyResearch(symbol)
      .then((bundle) => { if (active) setState({ loading: false, bundle, error: null }); })
      .catch((error) => {
        if (!active) return;
        console.error(`Error loading company research for ${symbol}:`, error);
        setState({ loading: false, bundle: null, error: 'Company research is temporarily unavailable.' });
      });
    return () => { active = false; };
  }, [symbol]);

  if (state.loading) {
    return (
      <div className="gs-card p-5" data-testid="company-research-loading">
        <div className="gs-label mb-3">// Company Research</div>
        <div className="text-sm text-gs-textDim">Loading company research…</div>
      </div>
    );
  }

  if (state.error || !state.bundle) {
    return (
      <div className="gs-card p-5" data-testid="company-research-error">
        <div className="gs-label mb-3">// Company Research</div>
        <div className="flex items-start gap-2 text-sm text-gs-textMuted">
          <AlertCircle className="w-4 h-4 text-gs-neg flex-shrink-0 mt-0.5" />
          <span>{state.error || 'Company research is unavailable.'}</span>
        </div>
      </div>
    );
  }

  const { sections, provider, configured, generatedAt } = state.bundle;

  if (!configured) {
    return (
      <div className="gs-card p-5" data-testid="company-research-not-configured">
        <div className="gs-label mb-3">// Company Research</div>
        <div className="text-sm text-gs-textMuted">Company research is not configured for this deployment.</div>
      </div>
    );
  }

  const profile = sections.profile?.data;

  return (
    <div className="gs-card p-5" data-testid="company-research-section">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="gs-label">// Company Research</div>
          {profile?.profile?.description && (
            <p className="text-[12.5px] text-gs-textMuted leading-relaxed mt-2 max-w-2xl">{profile.profile.description}</p>
          )}
        </div>
        <span className="font-mono text-[9.5px] uppercase tracking-wider text-gs-textDim bg-gs-panel border border-gs-border px-2 py-1 rounded-sm">
          Provider: {provider || 'unavailable'} · as of {generatedAt ? new Date(generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'unknown'}
        </span>
      </div>

      <Tabs defaultValue="profile">
        <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1 flex-wrap">
          {Object.entries(SECTION_META).map(([key, meta]) => (
            <TabsTrigger
              key={key}
              value={key}
              className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]"
              data-testid={`research-tab-${key}`}
            >
              <meta.icon className="w-3.5 h-3.5 mr-1.5 text-gs-gold" />
              {meta.label}
              {sections[key]?.available === false && <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-gs-textDim inline-block" title="Unavailable" />}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          {sections.profile.available ? (
            profile?.profile ? (
              <div className="space-y-2 text-[12.5px] text-gs-textMuted">
                {profile.profile.description && <p className="leading-relaxed">{profile.profile.description}</p>}
                <RawFieldTable raw={profile.profile.raw} />
              </div>
            ) : <SectionEmpty label="company profile" />
          ) : <SectionUnavailable section={sections.profile} />}
        </TabsContent>

        <TabsContent value="financials" className="mt-4">
          {sections.financials.available ? <DatedEntryList entries={sections.financials.data} emptyLabel="financial statement" /> : <SectionUnavailable section={sections.financials} />}
        </TabsContent>

        <TabsContent value="keyMetrics" className="mt-4">
          {sections.keyMetrics.available ? (
            sections.keyMetrics.data?.raw ? <RawFieldTable raw={sections.keyMetrics.data.raw} /> : <SectionEmpty label="key metric" />
          ) : <SectionUnavailable section={sections.keyMetrics} />}
        </TabsContent>

        <TabsContent value="shareholding" className="mt-4">
          {sections.shareholding.available ? <DatedEntryList entries={sections.shareholding.data} emptyLabel="shareholding" /> : <SectionUnavailable section={sections.shareholding} />}
        </TabsContent>

        <TabsContent value="corporateActions" className="mt-4">
          {sections.corporateActions.available ? <DatedEntryList entries={sections.corporateActions.data} emptyLabel="corporate action" /> : <SectionUnavailable section={sections.corporateActions} />}
        </TabsContent>

        <TabsContent value="analystData" className="mt-4">
          {sections.analystData.available ? (
            sections.analystData.data ? (
              <div className="space-y-2">
                <p className="text-[11.5px] text-gs-textDim italic">{sections.analystData.data.note}</p>
                <RawFieldTable raw={sections.analystData.data.raw} />
              </div>
            ) : <SectionEmpty label="analyst" />
          ) : <SectionUnavailable section={sections.analystData} />}
        </TabsContent>

        <TabsContent value="news" className="mt-4">
          {sections.news.available ? (
            sections.news.data?.length ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {sections.news.data.slice(0, 6).map((article, i) => (
                  <a
                    key={article.sourceUrl || i}
                    href={article.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gs-card p-3.5 bg-gs-bg/40 hover:bg-gs-cardHover transition-colors"
                  >
                    <div className="text-[10px] font-mono text-gs-textDim mb-1">
                      {article.date ? new Date(article.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Date unavailable'}
                    </div>
                    <p className="text-[12.5px] text-gs-text leading-snug">{article.title}</p>
                  </a>
                ))}
              </div>
            ) : <SectionEmpty label="news" />
          ) : <SectionUnavailable section={sections.news} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
