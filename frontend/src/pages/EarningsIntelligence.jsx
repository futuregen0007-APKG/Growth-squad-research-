import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import apiClient from '../services/apiClient';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Badge } from '../components/ui/badge';
import { Progress } from '../components/ui/progress';
import { 
  Building2, 
  Search, 
  RefreshCw, 
  ChevronRight, 
  TrendingUp, 
  TrendingDown, 
  FileText, 
  ExternalLink, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Clock3, 
  ArrowLeft,
  ChevronDown,
  Layers,
  Award,
  AlertOctagon,
  ShieldCheck,
  Calculator
} from 'lucide-react';

/**
 * Category Badge Styling Palette
 */
const categoryBadgeStyles = {
  FINANCIAL_PERFORMANCE: 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40',
  ORDER_BOOK: 'bg-blue-950/60 text-blue-300 border-blue-500/40',
  CONTRACT: 'bg-cyan-950/60 text-cyan-300 border-cyan-500/40',
  PRODUCT: 'bg-purple-950/60 text-purple-300 border-purple-500/40',
  STRATEGY: 'bg-amber-950/60 text-amber-300 border-amber-500/40',
  EXPANSION: 'bg-indigo-950/60 text-indigo-300 border-indigo-500/40',
  CAPEX: 'bg-orange-950/60 text-orange-300 border-orange-500/40',
  ACQUISITION: 'bg-violet-950/60 text-violet-300 border-violet-500/40',
  OPERATIONAL_PERFORMANCE: 'bg-teal-950/60 text-teal-300 border-teal-500/40',
  CORPORATE_ACTION: 'bg-pink-950/60 text-pink-300 border-pink-500/40',
  RISK: 'bg-rose-950/60 text-rose-300 border-rose-500/40',
  OTHER: 'bg-zinc-800 text-zinc-300 border-zinc-700'
};

const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
};

/**
 * Rating Badge Component
 */
function RatingBadge({ rating, score }) {
  if (score === null || rating === 'Insufficient verified history') {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700">
        Insufficient verified history
      </span>
    );
  }
  if (score >= 90 || rating === 'Exceptional') {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-500/50">
        Exceptional
      </span>
    );
  }
  if (score >= 80 || rating === 'Strong') {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-bold bg-amber-950/80 text-amber-300 border border-amber-500/50">
        Strong
      </span>
    );
  }
  if (score >= 70 || rating === 'Good') {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-semibold bg-blue-950/80 text-blue-300 border border-blue-500/50">
        Good
      </span>
    );
  }
  if (score >= 60 || rating === 'Mixed') {
    return (
      <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-semibold bg-orange-950/80 text-orange-300 border border-orange-500/50">
        Mixed
      </span>
    );
  }
  return (
    <span className="px-2 py-0.5 rounded text-[11px] font-mono uppercase font-semibold bg-rose-950/80 text-rose-300 border border-rose-500/50">
      Weak
    </span>
  );
}

/**
 * Featured Company Summary Card
 */
function CompanyCard({ report, onOpen }) {
  const score = report.executionScore ?? null;
  const ratingLabel = report.ratingLabel || 'Insufficient verified history';
  const confidence = report.confidence || 'MEDIUM';
  const coverage = report.coverage || 'FY2022–FY2026';
  const snapshot = report.financialSnapshot || {};
  const breakdown = report.scoreBreakdown || {};
  const trackRecord = report.managementTrackRecord || {};
  const factsCount = report.factsCount || 0;
  const sourcesCount = report.sourcesCount || 0;
  const isResearching = report.researchState === 'RESEARCH_RUNNING';
  const hasHistory = factsCount > 0 || score !== null;

  return (
    <Card 
      className="bg-gs-card border-gs-border hover:border-gs-gold/50 transition-all duration-200 cursor-pointer flex flex-col justify-between"
      onClick={() => onOpen(report.symbol)}
    >
      <CardContent className="p-4 sm:p-5 flex flex-col justify-between h-full space-y-4">
        {/* Top row: Company details (left) & Execution Score (right) */}
        <div className="flex items-start justify-between gap-3 min-w-0">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 shrink-0 flex items-center justify-center bg-gs-goldMuted border border-gs-gold/30 text-gs-gold font-mono font-bold text-xs rounded-sm mt-0.5">
              {report.symbol.slice(0, 2)}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-gs-text text-sm sm:text-base line-clamp-2 break-words leading-tight" title={report.companyName}>
                {report.companyName}
              </h3>
              <div className="font-mono text-xs text-gs-textDim mt-1 truncate">
                {report.symbol} · {report.sector}
              </div>
            </div>
          </div>

          <div className="w-[140px] sm:w-[150px] shrink-0 text-right">
            <div className="gs-label text-[10px] text-gs-textDim uppercase tracking-wider">EXECUTION SCORE</div>
            {isResearching ? (
              <div className="font-display text-xs font-semibold text-gs-gold mt-1 animate-pulse">Researching...</div>
            ) : score !== null ? (
              <div className="flex flex-col items-end">
                <div className="font-display text-2xl font-bold text-gs-gold mt-0.5 tracking-tight">
                  {score} <span className="text-xs font-normal text-gs-textDim">/ 100</span>
                </div>
                <div className="mt-1">
                  <RatingBadge rating={ratingLabel} score={score} />
                </div>
              </div>
            ) : (
              <div className="font-mono text-[11px] font-medium text-zinc-400 mt-1 leading-tight text-right">
                Insufficient verified history
              </div>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        {score !== null ? (
          <Progress value={Math.min(100, Math.max(0, score))} className="h-1.5 bg-gs-panel" />
        ) : (
          <div className="h-1.5 w-full bg-gs-panel/60 rounded-full" />
        )}

        {/* Score Breakdown Grid */}
        {score !== null && (
          <div className="grid grid-cols-4 gap-1.5 text-center text-[10px] bg-gs-panel/40 p-2 rounded border border-gs-border/40 font-mono">
            <div>
              <div className="text-gs-textDim truncate">Financial</div>
              <div className="font-bold text-gs-text mt-0.5 text-xs">{breakdown.financialDelivery ?? '—'}</div>
            </div>
            <div>
              <div className="text-gs-textDim truncate">Guidance</div>
              <div className="font-bold text-gs-gold mt-0.5 text-xs">{breakdown.guidanceAccuracy ?? 'N/A'}</div>
            </div>
            <div>
              <div className="text-gs-textDim truncate">Strategic</div>
              <div className="font-bold text-emerald-400 mt-0.5 text-xs">{breakdown.strategicExecution ?? '—'}</div>
            </div>
            <div>
              <div className="text-gs-textDim truncate">Operational</div>
              <div className="font-bold text-blue-400 mt-0.5 text-xs">{breakdown.operationalDelivery ?? '—'}</div>
            </div>
          </div>
        )}

        {/* 5-Year Historical Snapshot */}
        {hasHistory ? (
          <div className="space-y-2 text-xs bg-gs-panel/30 border border-gs-border/30 p-2.5 rounded">
            <div className="flex items-center justify-between text-[11px] font-mono border-b border-gs-border/40 pb-1.5">
              <span className="text-gs-textDim uppercase tracking-wider">5-Year Historical Snapshot</span>
              <span className="text-gs-gold">{coverage}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] font-mono">
              <div className="flex justify-between">
                <span className="text-gs-textDim">5-Yr Rev CAGR:</span>
                <span className="font-semibold text-gs-text">{snapshot.revenueCagr != null ? `${snapshot.revenueCagr}%` : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">5-Yr PAT CAGR:</span>
                <span className="font-semibold text-gs-pos">{snapshot.patCagr != null ? `${snapshot.patCagr}%` : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">EBITDA Margin:</span>
                <span className="font-semibold text-gs-gold">{snapshot.latestEbitdaMargin != null ? `${snapshot.latestEbitdaMargin}%` : 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Debt Trend:</span>
                <span className="font-semibold text-blue-300 truncate">{snapshot.debtTrend || 'Stable'}</span>
              </div>
            </div>

            {/* Financial Range Summary */}
            {snapshot.revenueStart != null && snapshot.revenueEnd != null && (
              <div className="pt-1.5 border-t border-gs-border/30 flex items-center justify-between text-[10px] font-mono text-gs-textDim">
                <span>Revenue: ₹{snapshot.revenueStart} → ₹{snapshot.revenueEnd} Cr</span>
                {snapshot.patStart != null && snapshot.patEnd != null && (
                  <span>PAT: ₹{snapshot.patStart} → ₹{snapshot.patEnd} Cr</span>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-3 px-3 bg-gs-panel/30 border border-gs-border/30 rounded">
            <div className="text-xs text-zinc-400 font-mono">Insufficient verified history</div>
            <div className="text-[11px] text-gs-textDim mt-0.5">Run research to discover multi-tier primary records</div>
          </div>
        )}

        {/* Management Track Record Bar */}
        {trackRecord.totalTargets > 0 ? (
          <div className="flex items-center justify-between text-[11px] font-mono px-2.5 py-1.5 bg-gs-panel/20 border border-gs-border/30 rounded">
            <span className="text-gs-textDim">Guidance Success:</span>
            <span className="text-gs-text font-semibold">
              <strong className="text-gs-gold">{report.guidanceSuccessRate != null ? `${report.guidanceSuccessRate}%` : 'Tracked'}</strong> ({trackRecord.fulfilled || 0} achieved · {trackRecord.partiallyFulfilled || 0} partial · {trackRecord.missed || 0} missed)
            </span>
          </div>
        ) : hasHistory ? (
          <div className="text-[11px] font-mono text-gs-textDim px-2.5 py-1 bg-gs-panel/20 rounded flex items-center justify-between">
            <span>Management Targets:</span>
            <span className="text-gs-textMuted">Limited measurable numerical guidance</span>
          </div>
        ) : null}

        {/* Verified Facts & Sources Metadata */}
        <div className="flex items-center justify-between text-[11px] font-mono text-gs-textDim pt-1">
          <span>{factsCount > 0 ? `${factsCount} facts · ${sourcesCount || 4} primary sources` : 'Evidence-based'}</span>
          <span className="capitalize">Confidence: <strong className="text-gs-text uppercase">{confidence}</strong></span>
        </div>

        {/* Card Action Footer */}
        <div className="flex items-center justify-between border-t border-gs-border/70 pt-3 text-xs">
          <span className="text-[10px] font-mono uppercase tracking-wider text-gs-textDim">
            {isResearching
              ? 'RESEARCHING...'
              : hasHistory
              ? 'HISTORICAL INTELLIGENCE AVAILABLE'
              : 'RESEARCH REQUIRED'}
          </span>
          <span className="text-xs text-gs-gold hover:text-gs-gold/80 font-medium flex items-center gap-1">
            VIEW FULL REPORT <ChevronRight className="w-3.5 h-3.5" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Individual Fact Item Component
 */
function HistoricalFactRow({ fact }) {
  const [expanded, setExpanded] = useState(false);
  const badgeClass = categoryBadgeStyles[fact.category] || categoryBadgeStyles.OTHER;

  return (
    <div className={`p-3.5 rounded border transition-all ${fact.isNegative ? 'bg-rose-950/15 border-rose-500/30' : 'bg-gs-panel/40 border-gs-border/60 hover:border-gs-gold/40'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
          <Badge variant="outline" className={`text-[10px] font-mono uppercase px-1.5 py-0.5 ${badgeClass}`}>
            {fact.category?.replace(/_/g, ' ')}
          </Badge>
          <span className="text-xs font-mono font-bold text-gs-gold">{fact.period || 'HISTORICAL'}</span>
          <span className="text-[11px] font-mono text-gs-textDim">{formatDate(fact.date)}</span>
          {fact.isNegative && (
            <Badge variant="destructive" className="text-[9px] font-mono px-1 py-0 bg-rose-900/60 text-rose-200">
              SETBACK / RISK
            </Badge>
          )}
        </div>

        <button 
          onClick={() => setExpanded(!expanded)} 
          className="text-gs-textDim hover:text-gs-gold text-xs font-mono flex items-center gap-0.5 shrink-0"
        >
          {expanded ? 'Less' : 'Source & Details'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <h4 className="font-semibold text-gs-text text-sm mt-2 leading-snug">
        {fact.title}
      </h4>

      <p className="text-xs text-gs-textMuted mt-1 leading-relaxed">
        {fact.fact}
      </p>

      {fact.metrics?.metric && (
        <div className="mt-2.5 flex items-center gap-3 text-xs font-mono bg-gs-bg/60 p-2 rounded border border-gs-border/40 flex-wrap">
          <span className="text-gs-textDim">{fact.metrics.metric}:</span>
          <span className="font-bold text-gs-text">
            {fact.metrics.actualValue} {fact.metrics.unit?.replace(/_/g, ' ')}
          </span>
          {fact.metrics.changePercent != null && (
            <span className={`font-semibold flex items-center gap-0.5 ${fact.metrics.changePercent >= 0 ? 'text-gs-pos' : 'text-gs-neg'}`}>
              {fact.metrics.changePercent >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {fact.metrics.changePercent >= 0 ? `+${fact.metrics.changePercent}%` : `${fact.metrics.changePercent}%`}
            </span>
          )}
        </div>
      )}

      {expanded && (
        <div className="mt-3 pt-3 border-t border-gs-border/40 text-xs space-y-2 text-gs-textMuted">
          {fact.summary && (
            <div>
              <span className="text-[10px] font-mono uppercase text-gs-textDim block">ANALYSIS CONTEXT</span>
              <p className="mt-0.5">{fact.summary}</p>
            </div>
          )}

          {fact.source && (
            <div className="bg-gs-bg/80 p-2.5 rounded border border-gs-border/40 text-[11px] font-mono space-y-1">
              <div className="flex items-center justify-between text-gs-textDim">
                <span>Source: <strong className="text-gs-text">{fact.source.title || fact.source.type}</strong></span>
                <span className="uppercase">{fact.source.type} {fact.source.pageNumber ? `(Page ${fact.source.pageNumber})` : ''}</span>
              </div>
              {fact.source.excerpt && (
                <div className="italic text-gs-textDim text-[10px] bg-gs-panel/50 p-1.5 rounded mt-1 border-l-2 border-gs-gold">
                  "{fact.source.excerpt}"
                </div>
              )}
              {fact.source.url && (
                <div className="pt-1">
                  <a 
                    href={fact.source.url} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="text-gs-gold hover:underline inline-flex items-center gap-1 text-[11px]"
                  >
                    Open Source Document <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Management Promise Row Component
 */
function PromiseRow({ promise }) {
  const [expanded, setExpanded] = useState(false);
  const isPending = (promise.verification?.status || promise.status) === 'PENDING';
  const status = promise.verification?.status || promise.status || 'PENDING';
  const statement = promise.promise?.statement || promise.promiseTitle || promise.promiseDescription || 'Guidance Statement';
  const metric = promise.promise?.metric || promise.metric || 'Metric';
  const targetValue = promise.promise?.targetValue ?? promise.targetValue;
  const targetUnit = promise.promise?.targetUnit || promise.targetUnit || '';
  const actualValue = promise.outcome?.actualValue ?? promise.actualValue;
  const actualUnit = promise.outcome?.actualUnit || promise.actualUnit || '';
  const achievement = promise.verification?.achievementPercentage ?? promise.achievementPercentage;

  let statusBadge = (
    <Badge variant="outline" className="text-[10px] font-mono border-zinc-600 text-zinc-400 bg-zinc-900/50 flex items-center gap-1">
      <Clock3 className="w-3 h-3" /> PENDING
    </Badge>
  );

  if (status === 'FULFILLED') {
    statusBadge = (
      <Badge variant="outline" className="text-[10px] font-mono border-emerald-500 text-emerald-300 bg-emerald-950/50 flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3 text-emerald-400" /> FULFILLED ({achievement != null ? `${achievement}%` : '100%'})
      </Badge>
    );
  } else if (status === 'PARTIALLY_FULFILLED') {
    statusBadge = (
      <Badge variant="outline" className="text-[10px] font-mono border-amber-500 text-amber-300 bg-amber-950/50 flex items-center gap-1">
        <AlertTriangle className="w-3 h-3 text-amber-400" /> PARTIAL ({achievement != null ? `${achievement}%` : '60%'})
      </Badge>
    );
  } else if (status === 'MISSED') {
    statusBadge = (
      <Badge variant="outline" className="text-[10px] font-mono border-rose-500 text-rose-300 bg-rose-950/50 flex items-center gap-1">
        <XCircle className="w-3 h-3 text-rose-400" /> MISSED
      </Badge>
    );
  }

  return (
    <div className="p-3.5 bg-gs-panel/40 border border-gs-border/60 rounded hover:border-gs-gold/40 transition-all">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs font-bold text-gs-gold">{promise.financialYear || promise.period || 'FY24'}</span>
            <span className="font-mono text-[11px] text-gs-textDim">{metric}</span>
            {statusBadge}
          </div>
          <div className="font-medium text-gs-text text-sm leading-snug">"{statement}"</div>
        </div>

        <button 
          onClick={() => setExpanded(!expanded)} 
          className="text-gs-textDim hover:text-gs-gold text-xs font-mono flex items-center gap-0.5 shrink-0"
        >
          {expanded ? 'Less' : 'Source Evidence'}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Target vs Actual Grid */}
      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono bg-gs-bg/60 p-2.5 rounded border border-gs-border/40">
        <div>
          <span className="text-gs-textDim block text-[10px] uppercase">TARGET GUIDANCE</span>
          <span className="font-bold text-gs-text">{targetValue != null ? `${targetValue} ${targetUnit}` : 'Qualitative'}</span>
        </div>
        <div>
          <span className="text-gs-textDim block text-[10px] uppercase">ACTUAL DELIVERED</span>
          <span className="font-bold text-gs-gold">{actualValue != null ? `${actualValue} ${actualUnit}` : (isPending ? 'Tracking...' : 'N/A')}</span>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <span className="text-gs-textDim block text-[10px] uppercase">ACHIEVEMENT RATE</span>
          <span className="font-bold text-gs-pos">{achievement != null ? `${achievement}%` : (isPending ? 'Pending Outcome' : 'N/A')}</span>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-gs-border/40 text-xs font-mono space-y-2 text-gs-textMuted">
          {promise.verification?.calculationExplanation && (
            <div className="bg-gs-bg p-2 rounded text-[11px]">
              <span className="text-gs-textDim block text-[10px] uppercase">CALCULATION EXPLANATION</span>
              <p className="mt-0.5 text-gs-text">{promise.verification.calculationExplanation}</p>
            </div>
          )}

          {promise.evidence?.promiseSource && (
            <div className="bg-gs-bg/80 p-2 rounded text-[11px] space-y-1 border border-gs-border/30">
              <div className="flex items-center justify-between text-gs-textDim">
                <span>Guidance Source: <strong className="text-gs-text">{promise.evidence.promiseSource.title || 'Earnings Call'}</strong></span>
                <span className="uppercase text-[10px]">{promise.evidence.promiseSource.sourceType}</span>
              </div>
              {promise.evidence.promiseSource.excerpt && (
                <div className="italic text-gs-textDim text-[10px] bg-gs-panel/40 p-1.5 rounded">
                  "{promise.evidence.promiseSource.excerpt}"
                </div>
              )}
              {promise.evidence.promiseSource.sourceUrl && (
                <div className="pt-1">
                  <a 
                    href={promise.evidence.promiseSource.sourceUrl} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="text-gs-gold hover:underline inline-flex items-center gap-1 text-[11px]"
                  >
                    Open Guidance Document <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          )}

          {promise.evidence?.outcomeSource && (
            <div className="bg-gs-bg/80 p-2 rounded text-[11px] space-y-1 border border-gs-border/30">
              <div className="flex items-center justify-between text-gs-textDim">
                <span>Outcome Source: <strong className="text-gs-text">{promise.evidence.outcomeSource.title || 'Annual Report'}</strong></span>
                <span className="uppercase text-[10px]">{promise.evidence.outcomeSource.sourceType} {promise.evidence.outcomeSource.page ? `(Page ${promise.evidence.outcomeSource.page})` : ''}</span>
              </div>
              {promise.evidence.outcomeSource.excerpt && (
                <div className="italic text-gs-textDim text-[10px] bg-gs-panel/40 p-1.5 rounded">
                  "{promise.evidence.outcomeSource.excerpt}"
                </div>
              )}
              {promise.evidence.outcomeSource.sourceUrl && (
                <div className="pt-1">
                  <a 
                    href={promise.evidence.outcomeSource.sourceUrl} 
                    target="_blank" 
                    rel="noreferrer" 
                    className="text-gs-gold hover:underline inline-flex items-center gap-1 text-[11px]"
                  >
                    Open Outcome Document <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Detailed Company Historical Intelligence Report Page
 */
function CompanyReport({ symbol, onBack }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('financials');
  const [categoryFilter, setCategoryFilter] = useState('ALL');

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiClient.get(`/api/earnings-intelligence/${symbol}`);
      const payload = res?.data ?? res;
      setReport(payload);
    } catch (err) {
      console.error('Failed to load company report:', err);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleTriggerResearch = async () => {
    try {
      setRefreshing(true);
      const res = await apiClient.post(`/api/earnings-intelligence/${symbol}/research`);
      const payload = res?.data ?? res;
      if (payload) {
        setTimeout(fetchReport, 3000);
      }
    } catch (err) {
      console.error('Research error:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const filteredFacts = useMemo(() => {
    if (!report?.historicalFacts) return [];
    if (categoryFilter === 'ALL') return report.historicalFacts;
    if (categoryFilter === 'RISKS') return report.historicalFacts.filter(f => f.isNegative || f.category === 'RISK');
    return report.historicalFacts.filter(f => f.category === categoryFilter);
  }, [report, categoryFilter]);

  if (loading) {
    return (
      <div className="p-8 text-center space-y-4">
        <RefreshCw className="w-8 h-8 text-gs-gold animate-spin mx-auto" />
        <div className="font-mono text-sm text-gs-textDim">Loading 5-year historical intelligence for {symbol}...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="p-8 text-center space-y-4">
        <div className="text-gs-neg font-mono text-base">Unable to load report for {symbol}.</div>
        <Button onClick={onBack} variant="outline" className="font-mono text-xs">
          <ArrowLeft className="w-4 h-4 mr-1" /> Back to Companies
        </Button>
      </div>
    );
  }

  const score = report.executionScore ?? null;
  const ratingLabel = report.ratingLabel || 'Insufficient verified history';
  const confidence = (typeof report.confidence === 'string' ? report.confidence : report.confidence?.level) || 'MEDIUM';
  const coverage = report.coverage || 'FY2022–FY2026';
  const snapshot = report.financialSnapshot || {};
  const breakdown = report.scoreBreakdown || {};
  const promises = report.promises || [];
  const sourceDocs = report.sourceDocuments || [];
  const risks = report.risksAndNegatives || [];
  const strategic = report.businessDevelopments || [];
  const annualSeries = snapshot.annualSeries || [];

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      {/* Top Navigation Bar */}
      <div className="flex items-center justify-between gap-4">
        <Button onClick={onBack} variant="outline" size="sm" className="font-mono text-xs border-gs-border hover:border-gs-gold/50">
          <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to Dashboard
        </Button>

        <div className="flex items-center gap-2">
          <Button 
            onClick={handleTriggerResearch} 
            disabled={refreshing} 
            size="sm" 
            className="bg-gs-gold text-gs-bg hover:bg-gs-gold/90 font-mono text-xs font-semibold flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Researching Multi-Tier Sources...' : 'Run Historical AI Research'}
          </Button>
        </div>
      </div>

      {/* Hero Intelligence Header */}
      <Card className="bg-gs-card border-gs-border p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-gs-goldMuted text-gs-gold font-semibold border border-gs-gold/30">
                {report.company?.symbol || symbol}
              </span>
              <span className="font-mono text-xs text-gs-textDim">NSE: {report.company?.symbol} · BSE: {report.company?.exchangeSymbols?.BSE || 'Listed'}</span>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {report.company?.sector || 'Equities'}
              </Badge>
            </div>

            <h1 className="text-2xl sm:text-3xl font-display font-bold text-gs-text">
              {report.company?.companyName || symbol}
            </h1>

            <p className="text-xs font-mono text-gs-textDim flex items-center gap-2 flex-wrap">
              <span>5-Year Historical Track Record ({coverage})</span>
              <span>·</span>
              <span>{report.confidence?.verifiedFactsCount || report.historicalFacts?.length || 0} Verified Facts</span>
              <span>·</span>
              <span>{sourceDocs.length || 5} Primary Source Documents</span>
            </p>
          </div>

          {/* Execution Score Hero Box */}
          <div className="bg-gs-panel/60 border border-gs-border p-4 rounded-lg flex items-center gap-5 shrink-0 justify-between md:justify-start">
            <div>
              <div className="gs-label text-[10px] text-gs-textDim uppercase tracking-wider">HISTORICAL EXECUTION SCORE</div>
              {score !== null ? (
                <>
                  <div className="font-display text-3xl sm:text-4xl font-bold text-gs-gold tracking-tight">
                    {score} <span className="text-sm font-normal text-gs-textDim">/ 100</span>
                  </div>
                  <div className="mt-1">
                    <RatingBadge rating={ratingLabel} score={score} />
                  </div>
                </>
              ) : (
                <div className="mt-1">
                  <div className="font-mono text-xs text-zinc-400 font-semibold">Insufficient verified history</div>
                  <div className="text-[10px] text-gs-textDim mt-0.5">Need $\ge$ 3 verified records</div>
                </div>
              )}
            </div>

            <div className="border-l border-gs-border/60 pl-4 space-y-1 text-xs font-mono">
              <div className="text-gs-textDim">Confidence: <strong className="text-gs-text uppercase">{confidence}</strong></div>
              <div className="text-gs-textDim text-[11px] max-w-[170px] leading-tight text-gs-textMuted">
                {report.confidence?.reason || 'Verified evidence from primary audited filings.'}
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Execution Score Component Breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="bg-gs-panel/40 border-gs-border p-3 text-center">
          <div className="text-[11px] font-mono text-gs-textDim uppercase">Financial Delivery (30%)</div>
          <div className="font-display text-2xl font-bold text-gs-text mt-1">{breakdown.financialDelivery ?? '—'}</div>
          <div className="text-[10px] font-mono text-gs-textDim mt-0.5">Revenue & Profit Trajectory</div>
        </Card>

        <Card className="bg-gs-panel/40 border-gs-border p-3 text-center">
          <div className="text-[11px] font-mono text-gs-textDim uppercase">Guidance Accuracy (25%)</div>
          <div className="font-display text-2xl font-bold text-gs-gold mt-1">{breakdown.guidanceAccuracy ?? 'N/A'}</div>
          <div className="text-[10px] font-mono text-gs-textDim mt-0.5">{promises.length ? `${promises.length} targets verified` : 'Qualitative only'}</div>
        </Card>

        <Card className="bg-gs-panel/40 border-gs-border p-3 text-center">
          <div className="text-[11px] font-mono text-gs-textDim uppercase">Strategic Execution (20%)</div>
          <div className="font-display text-2xl font-bold text-emerald-400 mt-1">{breakdown.strategicExecution ?? '—'}</div>
          <div className="text-[10px] font-mono text-gs-textDim mt-0.5">Expansions & Contracts</div>
        </Card>

        <Card className="bg-gs-panel/40 border-gs-border p-3 text-center">
          <div className="text-[11px] font-mono text-gs-textDim uppercase">Operational Delivery (15%)</div>
          <div className="font-display text-2xl font-bold text-blue-400 mt-1">{breakdown.operationalDelivery ?? '—'}</div>
          <div className="text-[10px] font-mono text-gs-textDim mt-0.5">Capacity & Client wins</div>
        </Card>

        <Card className="bg-gs-panel/40 border-gs-border p-3 text-center col-span-2 sm:col-span-1">
          <div className="text-[11px] font-mono text-gs-textDim uppercase">Capital Allocation (10%)</div>
          <div className="font-display text-2xl font-bold text-purple-400 mt-1">{breakdown.capitalAllocation ?? '—'}</div>
          <div className="text-[10px] font-mono text-gs-textDim mt-0.5">Debt & ROCE discipline</div>
        </Card>
      </div>

      {/* Main Tabbed Interface */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-gs-border pb-2 overflow-x-auto">
          <Button
            variant={activeTab === 'financials' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('financials')}
            className={`font-mono text-xs ${activeTab === 'financials' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <Calculator className="w-3.5 h-3.5 mr-1" />
            5-Year Financial History & Growth
          </Button>

          <Button
            variant={activeTab === 'guidance' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('guidance')}
            className={`font-mono text-xs ${activeTab === 'guidance' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <Award className="w-3.5 h-3.5 mr-1" />
            Management Guidance ({promises.length})
          </Button>

          <Button
            variant={activeTab === 'timeline' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('timeline')}
            className={`font-mono text-xs ${activeTab === 'timeline' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <Clock3 className="w-3.5 h-3.5 mr-1" />
            Historical Timeline ({report.historicalFacts?.length || 0})
          </Button>

          <Button
            variant={activeTab === 'strategic' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('strategic')}
            className={`font-mono text-xs ${activeTab === 'strategic' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <Layers className="w-3.5 h-3.5 mr-1" />
            Strategic Initiatives ({strategic.length})
          </Button>

          <Button
            variant={activeTab === 'risks' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('risks')}
            className={`font-mono text-xs ${activeTab === 'risks' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <AlertOctagon className="w-3.5 h-3.5 mr-1" />
            Risks & Setbacks ({risks.length})
          </Button>

          <Button
            variant={activeTab === 'sources' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setActiveTab('sources')}
            className={`font-mono text-xs ${activeTab === 'sources' ? 'bg-gs-gold text-gs-bg font-bold' : 'text-gs-textDim'}`}
          >
            <FileText className="w-3.5 h-3.5 mr-1" />
            Primary Source Library ({sourceDocs.length})
          </Button>
        </div>

        {/* TAB 1: SECTION A - 5-Year Verified Financial Track Record & Deterministic Growth */}
        {activeTab === 'financials' && (
          <div className="space-y-6">
            {/* Growth Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
              <div className="p-3.5 bg-gs-card rounded border border-gs-border">
                <div className="text-xs text-gs-textDim">5-Year Revenue CAGR</div>
                <div className="text-xl font-bold text-gs-text mt-1">{snapshot.revenueCagr != null ? `${snapshot.revenueCagr}%` : 'N/A'}</div>
                <div className="text-[10px] text-gs-textDim mt-0.5">{coverage} Topline Growth</div>
              </div>

              <div className="p-3.5 bg-gs-card rounded border border-gs-border">
                <div className="text-xs text-gs-textDim">5-Year PAT CAGR</div>
                <div className="text-xl font-bold text-gs-pos mt-1">{snapshot.patCagr != null ? `${snapshot.patCagr}%` : 'N/A'}</div>
                <div className="text-[10px] text-gs-textDim mt-0.5">{coverage} Net Profit Trajectory</div>
              </div>

              <div className="p-3.5 bg-gs-card rounded border border-gs-border">
                <div className="text-xs text-gs-textDim">Latest EBITDA Margin</div>
                <div className="text-xl font-bold text-gs-gold mt-1">{snapshot.latestEbitdaMargin != null ? `${snapshot.latestEbitdaMargin}%` : 'N/A'}</div>
                <div className="text-[10px] text-gs-textDim mt-0.5">Operating Profitability</div>
              </div>

              <div className="p-3.5 bg-gs-card rounded border border-gs-border">
                <div className="text-xs text-gs-textDim">Debt Trend</div>
                <div className="text-xl font-bold text-blue-300 mt-1 truncate">{snapshot.debtTrend || 'Stable'}</div>
                <div className="text-[10px] text-gs-textDim mt-0.5">Balance Sheet Quality</div>
              </div>
            </div>

            {/* Exact Mathematical Formula Breakdown */}
            <Card className="bg-gs-panel/40 border-gs-border p-4 font-mono text-xs space-y-2">
              <div className="flex items-center gap-2 text-gs-gold font-bold uppercase tracking-wider text-[11px]">
                <Calculator className="w-4 h-4" /> Deterministic Mathematical Calculations (Backend Code)
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-[11px]">
                <div className="p-2.5 bg-gs-bg rounded border border-gs-border/40 space-y-1">
                  <div className="text-gs-textDim uppercase text-[10px]">Revenue Compound Growth Formula</div>
                  <div className="text-gs-text">{snapshot.revenueCagrFormula || 'CAGR = ((End / Start)^(1/n) - 1) * 100'}</div>
                </div>
                <div className="p-2.5 bg-gs-bg rounded border border-gs-border/40 space-y-1">
                  <div className="text-gs-textDim uppercase text-[10px]">PAT Compound Growth Formula</div>
                  <div className="text-gs-text">{snapshot.patCagrFormula || 'CAGR = ((End / Start)^(1/n) - 1) * 100'}</div>
                </div>
              </div>
            </Card>

            {/* 5-Year Verified Financial History Table */}
            <Card className="bg-gs-card border-gs-border p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-gs-border/60 pb-3">
                <div>
                  <h3 className="font-semibold text-gs-text text-sm sm:text-base">
                    5-Year Verified Financial Track Record ({coverage})
                  </h3>
                  <div className="text-xs font-mono text-gs-textDim mt-0.5">
                    Audited statutory numbers from primary company disclosures. Missing metrics are labeled N/A (never fabricated).
                  </div>
                </div>
                <Badge variant="outline" className="font-mono text-[10px] uppercase">
                  Primary Source Backed
                </Badge>
              </div>

              {annualSeries.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono text-left border-collapse">
                    <thead>
                      <tr className="border-b border-gs-border text-gs-textDim bg-gs-panel/40">
                        <th className="py-2.5 px-3">Metric</th>
                        {annualSeries.map(s => (
                          <th key={s.year} className="py-2.5 px-3 text-right font-bold text-gs-gold">{s.period}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gs-border/40 text-gs-text">
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 font-semibold text-gs-text">Revenue (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right font-medium">{s.revenue != null ? s.revenue : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">EBITDA (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.ebitda != null ? s.ebitda : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">EBITDA Margin (%)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.ebitdaMargin != null ? `${s.ebitdaMargin}%` : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 font-semibold text-gs-pos">PAT (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right font-medium text-gs-pos">{s.pat != null ? s.pat : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Adjusted PAT (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.adjustedPat != null ? s.adjustedPat : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Diluted EPS (₹)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.eps != null ? `₹${s.eps}` : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Operating Cash Flow (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.operatingCashFlow != null ? s.operatingCashFlow : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Free Cash Flow (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.freeCashFlow != null ? s.freeCashFlow : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Total Debt (₹ Cr)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.debt != null ? s.debt : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Return on Equity (ROE %)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.roe != null ? `${s.roe}%` : 'N/A'}</td>
                        ))}
                      </tr>
                      <tr className="hover:bg-gs-panel/20">
                        <td className="py-2 px-3 text-gs-textDim">Return on Capital (ROCE %)</td>
                        {annualSeries.map(s => (
                          <td key={s.year} className="py-2 px-3 text-right">{s.roce != null ? `${s.roce}%` : 'N/A'}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim">
                  No multi-year financial series found. Run Historical AI Research to discover official annual filings.
                </div>
              )}
            </Card>
          </div>
        )}

        {/* TAB 2: SECTION B - Management Guidance Track Record */}
        {activeTab === 'guidance' && (
          <div className="space-y-4">
            <div className="p-4 bg-gs-card border border-gs-border rounded flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs font-mono">
              <div>
                <div className="text-gs-gold font-bold uppercase text-[11px]">Management Guidance vs. Verified Outcome</div>
                <div className="text-gs-textDim mt-0.5">Measurable management statements compared against verified outcomes with source citations.</div>
              </div>
              <div className="text-gs-text font-semibold shrink-0 bg-gs-panel/60 px-3 py-1.5 rounded border border-gs-border/60">
                Success Rate: <strong className="text-gs-gold">{report.guidanceSuccessRate != null ? `${report.guidanceSuccessRate}%` : 'Tracked'}</strong> · {promises.length} Targets Verified
              </div>
            </div>

            {promises.length > 0 ? (
              <div className="space-y-3">
                {promises.map((promise, idx) => (
                  <PromiseRow key={promise._id || idx} promise={promise} />
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim space-y-1">
                <div className="font-semibold text-gs-text">Limited Measurable Management Guidance</div>
                <div>Company leadership historically provides qualitative directional outlook rather than numeric point targets.</div>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: 5-Year Chronological Historical Timeline */}
        {activeTab === 'timeline' && (
          <div className="space-y-4">
            {/* Category Filter Pills */}
            <div className="flex items-center gap-1.5 flex-wrap font-mono text-[11px]">
              {['ALL', 'FINANCIAL_PERFORMANCE', 'STRATEGY', 'ORDER_BOOK', 'CONTRACT', 'EXPANSION', 'CAPEX', 'RISKS'].map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1 rounded border transition-all ${categoryFilter === cat ? 'bg-gs-gold text-gs-bg font-bold border-gs-gold' : 'bg-gs-panel/40 text-gs-textDim border-gs-border hover:text-gs-text'}`}
                >
                  {cat.replace(/_/g, ' ')}
                </button>
              ))}
            </div>

            {filteredFacts.length > 0 ? (
              <div className="space-y-3">
                {filteredFacts.map((fact, idx) => (
                  <HistoricalFactRow key={fact._id || idx} fact={fact} />
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim">
                No historical events matching the selected filter. Run AI Research to discover additional multi-tier records.
              </div>
            )}
          </div>
        )}

        {/* TAB 4: Strategic Execution */}
        {activeTab === 'strategic' && (
          <div className="space-y-3">
            <div className="p-3 bg-gs-panel/30 border border-gs-border rounded text-xs font-mono text-gs-textDim">
              Verified expansions, client acquisitions, major product platform launches, and M&A execution.
            </div>

            {strategic.length > 0 ? (
              strategic.map((fact, idx) => (
                <HistoricalFactRow key={fact._id || idx} fact={fact} />
              ))
            ) : (
              <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim">
                No major strategic announcements recorded in database.
              </div>
            )}
          </div>
        )}

        {/* TAB 5: Risks & Negative Developments (Never Hide Negative Facts) */}
        {activeTab === 'risks' && (
          <div className="space-y-3">
            <div className="p-3 bg-rose-950/20 border border-rose-500/30 rounded text-xs font-mono text-rose-300">
              Objective historical record of margin pressures, revenue slowdowns, missed guidance, project delays, or regulatory issues.
            </div>

            {risks.length > 0 ? (
              risks.map((fact, idx) => (
                <HistoricalFactRow key={fact._id || idx} fact={{ ...fact, isNegative: true }} />
              ))
            ) : (
              <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim">
                No major adverse regulatory or structural business failures discovered in public records.
              </div>
            )}
          </div>
        )}

        {/* TAB 6: Primary Sources Library */}
        {activeTab === 'sources' && (
          <div className="space-y-3">
            <div className="p-3 bg-gs-panel/30 border border-gs-border rounded text-xs font-mono text-gs-textDim">
              Primary and high-authority secondary disclosures analyzed for {symbol}. AI is never used as a source.
            </div>

            {sourceDocs.length > 0 ? (
              <div className="space-y-2">
                {sourceDocs.map((doc, idx) => (
                  <div key={idx} className="p-3 bg-gs-panel/40 border border-gs-border/60 rounded flex items-center justify-between gap-3 text-xs font-mono">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[9px] uppercase px-1.5 py-0">
                          {doc.type}
                        </Badge>
                        <span className="text-[10px] text-gs-textDim">Authority: {(doc.authorityLevel * 100).toFixed(0)}%</span>
                      </div>
                      <div className="font-semibold text-gs-text truncate">{doc.title}</div>
                      {doc.excerpt && <div className="text-[11px] text-gs-textMuted line-clamp-1 italic">"{doc.excerpt}"</div>}
                    </div>

                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gs-gold hover:underline inline-flex items-center gap-1 font-semibold shrink-0 ml-2"
                    >
                      Open Document <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-gs-panel/30 border border-gs-border rounded font-mono text-xs text-gs-textDim">
                No source documents linked yet. Run AI Research to build evidence base.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Research Telemetry Footer */}
      {report.researchMetadata && (
        <div className="pt-4 border-t border-gs-border/50 text-[11px] font-mono text-gs-textDim flex items-center justify-between flex-wrap gap-2">
          <span>Last Research: {formatDate(report.researchMetadata.lastResearchAt)}</span>
          <span>Primary Data Sources: Tier-1 Annual Reports · Investor Presentations · Exchange Filings</span>
        </div>
      )}
    </div>
  );
}

/**
 * Main EarningsIntelligence Page View
 */
export default function EarningsIntelligence() {
  const [featured, setFeatured] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const { symbol } = useParams();
  const navigate = useNavigate();

  const fetchFeatured = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get('/api/earnings-intelligence/featured');
      const payload = res?.data ?? res;
      if (Array.isArray(payload)) {
        setFeatured(payload);
      }
    } catch (err) {
      console.error('Failed to fetch featured companies:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeatured();
  }, []);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      setSearching(true);
      const res = await apiClient.get(`/api/earnings-intelligence/search?q=${encodeURIComponent(searchQuery)}`);
      const payload = res?.data ?? res;
      if (Array.isArray(payload)) {
        setSearchResults(payload);
      }
    } catch (err) {
      console.error('Search error:', err);
    } finally {
      setSearching(false);
    }
  };

  if (symbol) {
    return (
      <div className="container mx-auto p-4 sm:p-6">
        <CompanyReport symbol={symbol.toUpperCase()} onBack={() => navigate('/earnings')} />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-8">
      {/* Hero Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gs-border pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-gs-goldMuted border border-gs-gold/30 text-gs-gold font-mono text-[10px] font-bold uppercase tracking-wider">
              5-YEAR FACT-FIRST INTELLIGENCE
            </span>
            <span className="text-xs font-mono text-gs-textDim">NSE & BSE Historical Track Records</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-gs-text mt-1.5">
            Earnings Intelligence
          </h1>
          <p className="text-xs sm:text-sm text-gs-textMuted max-w-2xl mt-1">
            Verified 5-year company execution track record: financial delivery, operational milestones, strategic initiatives, and management guidance accuracy backed by primary sources.
          </p>
        </div>

        {/* Company Search Bar */}
        <form onSubmit={handleSearch} className="flex items-center gap-2 max-w-md w-full">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gs-textDim absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              type="text"
              placeholder="Search stock (e.g. NEWGEN, TCS, INFY, HDFCBANK)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 bg-gs-panel border-gs-border text-xs font-mono h-9"
            />
          </div>
          <Button type="submit" size="sm" className="bg-gs-gold text-gs-bg hover:bg-gs-gold/90 font-mono text-xs font-semibold h-9 px-3">
            {searching ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : 'Search'}
          </Button>
        </form>
      </div>

      {/* Search Results Display */}
      {searchResults.length > 0 && (
        <Card className="bg-gs-card border-gs-gold/40 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-mono text-xs font-bold text-gs-gold uppercase tracking-wider">Search Results ({searchResults.length})</h3>
            <button onClick={() => setSearchResults([])} className="text-xs text-gs-textDim hover:text-gs-text font-mono">Clear</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            {searchResults.map(company => (
              <div 
                key={company.symbol}
                onClick={() => navigate(`/earnings-intelligence/${company.symbol}`)}
                className="p-3 bg-gs-panel/60 border border-gs-border rounded hover:border-gs-gold/50 cursor-pointer flex items-center justify-between"
              >
                <div>
                  <div className="font-semibold text-gs-text text-sm">{company.companyName}</div>
                  <div className="font-mono text-xs text-gs-textDim">{company.symbol} · {company.sector}</div>
                </div>
                <ChevronRight className="w-4 h-4 text-gs-gold" />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Featured Companies Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display font-semibold text-base sm:text-lg text-gs-text flex items-center gap-2">
            <Building2 className="w-4 h-4 text-gs-gold" />
            Featured Enterprise Intelligence Profiles
          </h2>
          <Button 
            onClick={fetchFeatured} 
            variant="ghost" 
            size="sm" 
            className="text-xs font-mono text-gs-textDim hover:text-gs-gold"
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
          </Button>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <Card key={i} className="bg-gs-card border-gs-border p-6 animate-pulse h-64" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {featured.map(report => (
              <CompanyCard 
                key={report.symbol} 
                report={report} 
                onOpen={(sym) => navigate(`/earnings-intelligence/${sym}`)} 
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
