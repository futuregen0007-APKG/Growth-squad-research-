import { useState, useMemo, useEffect } from "react";
import {
  Newspaper,
  Clock,
  ExternalLink,
  Search,
  AlertCircle,
  ImageOff,
} from "lucide-react";
import { fetchAllStocks } from "@/services/stockApi";
import { fetchNewsWithStatus, fetchStockNews } from "@/services/newsApi";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

// Bounded default symbol set — News fetches real provider data per symbol,
// so the default "trending" view must stay small regardless of how many
// stocks the platform supports (matches the pattern already used by
// Dashboard's Newsflow widget). Selecting a specific company below fetches
// just that one symbol instead of widening this set.
const DEFAULT_SYMBOL_COUNT = 12;
const FALLBACK_SYMBOLS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'LT', 'HAL', 'TATAMOTORS', 'ITC', 'AXISBANK', 'BHARTIARTL'];

const publisherOrigin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const formatIstDate = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
};

export default function News() {
  const [searchQuery, setSearchQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [sortOrder, setSortOrder] = useState("newest");

  const [allStocks, setAllStocks] = useState([]);
  const [articles, setArticles] = useState([]);
  const [failedSymbols, setFailedSymbols] = useState([]);
  const [providerStatus, setProviderStatus] = useState('OK');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Company list (for the filter dropdown) loads once, independent of the
  // news fetch below — it never itself triggers a provider news request.
  useEffect(() => {
    const controller = new AbortController();
    fetchAllStocks({ signal: controller.signal })
      .then((stocks) => setAllStocks(Array.isArray(stocks) ? stocks : []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const requestOptions = { signal: controller.signal };

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        if (companyFilter === 'all') {
          const defaultSymbols = [...new Set(allStocks
            .map((s) => (s.ticker || s.symbol || '').toUpperCase())
            .filter(Boolean))].slice(0, DEFAULT_SYMBOL_COUNT);
          const symbols = defaultSymbols.length ? defaultSymbols : FALLBACK_SYMBOLS;
          const result = await fetchNewsWithStatus(symbols, requestOptions);
          if (!active) return;
          setArticles(result.articles);
          setFailedSymbols(result.failedSymbols);
          setProviderStatus(result.providerStatus);
        } else {
          const result = await fetchStockNews(companyFilter, requestOptions);
          if (!active) return;
          setArticles(result);
          setFailedSymbols([]);
          setProviderStatus('OK');
        }
      } catch (error) {
        if (!active || error.name === 'CanceledError' || error.code === 'ERR_CANCELED') return;
        console.error('Unable to load news:', error);
        setLoadError('Unable to load news right now.');
        setArticles([]);
        setFailedSymbols([]);
      } finally {
        if (active) setLoading(false);
      }
    };
    // News.jsx intentionally waits for allStocks so the default scope uses
    // real tickers when available; the fallback list covers the case where
    // /api/stocks itself is unavailable.
    load();
    return () => { active = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyFilter, allStocks.length, reloadToken]);

  const sources = useMemo(() => {
    return [...new Set(articles.map((a) => a.source).filter(Boolean))].sort();
  }, [articles]);

  const filteredNews = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = articles.filter((article) => {
      const symbols = article.symbols || [];
      const matchesSearch = !query
        || article.title?.toLowerCase().includes(query)
        || article.description?.toLowerCase().includes(query)
        || article.source?.toLowerCase().includes(query)
        || symbols.some((s) => s.toLowerCase().includes(query));
      const matchesSource = sourceFilter === 'all' || article.source === sourceFilter;
      return matchesSearch && matchesSource;
    });
    const sorted = [...filtered].sort((a, b) => {
      const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : -Infinity;
      const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : -Infinity;
      return sortOrder === 'newest' ? bTime - aTime : aTime - bTime;
    });
    return sorted;
  }, [articles, searchQuery, sourceFilter, sortOrder]);

  const companyOptions = useMemo(() => {
    return [...allStocks]
      .map((s) => ({ ticker: (s.ticker || s.symbol || '').toUpperCase(), name: s.name }))
      .filter((s) => s.ticker)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [allStocks]);

  return (
    <div className="space-y-6 animate-fade-up" data-testid="news-page">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Market Intelligence</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">News</h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Real, sourced articles from the news provider — no fabricated or placeholder stories.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[10.5px] font-mono text-gs-textDim">
          <span className="px-2 py-1 bg-gs-panel border border-gs-border rounded-sm">
            {filteredNews.length} article{filteredNews.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="gs-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gs-textDim" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search news..."
              className="pl-8 bg-gs-bg border-gs-border text-gs-text h-9 w-full text-sm rounded-sm"
            />
          </div>

          <Select value={companyFilter} onValueChange={setCompanyFilter}>
            <SelectTrigger className="bg-gs-bg border-gs-border w-44 h-9 text-sm rounded-sm">
              <SelectValue placeholder="Company" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border max-h-72">
              <SelectItem value="all">Trending (all)</SelectItem>
              {companyOptions.map((s) => (
                <SelectItem key={s.ticker} value={s.ticker}>{s.ticker}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="bg-gs-bg border-gs-border w-40 h-9 text-sm rounded-sm">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="all">All Sources</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortOrder} onValueChange={setSortOrder}>
            <SelectTrigger className="bg-gs-bg border-gs-border w-40 h-9 text-sm rounded-sm">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {!loading && !loadError && providerStatus === 'PARTIAL' && failedSymbols.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-gs-textDim" data-testid="news-degraded">
          <AlertCircle className="w-3.5 h-3.5 text-gs-gold shrink-0" />
          News unavailable for {failedSymbols.length} symbol{failedSymbols.length === 1 ? '' : 's'} — showing available results.
        </div>
      )}

      {loading && (
        <div className="gs-card p-8 text-center text-sm text-gs-textDim" data-testid="news-loading">Loading news...</div>
      )}

      {!loading && loadError && (
        <div className="gs-card p-8 text-center" data-testid="news-error">
          <p className="text-sm text-gs-textMuted">{loadError}</p>
          <button onClick={() => setReloadToken((t) => t + 1)} className="mt-3 text-sm text-gs-gold hover:text-gs-text">Retry</button>
        </div>
      )}

      {!loading && !loadError && (
        filteredNews.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="news-grid">
            {filteredNews.map((news) => (
              <NewsCard key={news.url} news={news} />
            ))}
          </div>
        ) : (
          <div className="gs-card p-8 text-center" data-testid="news-empty">
            <Newspaper className="w-12 h-12 mx-auto text-gs-textDim mb-3" />
            <h3 className="font-display font-bold text-gs-text mb-1">No news found</h3>
            <p className="text-sm text-gs-textMuted">
              {articles.length === 0 ? 'No articles are available for this selection right now.' : 'Try adjusting your search or filters.'}
            </p>
          </div>
        )
      )}
    </div>
  );
}

function NewsCard({ news }) {
  const articleUrl = news.url;
  const published = formatIstDate(news.publishedAt) || 'Date unavailable';
  const origin = publisherOrigin(articleUrl);
  const openArticle = () => {
    if (articleUrl) window.open(articleUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <article
      className="gs-card overflow-hidden hover:bg-gs-cardHover transition-colors group cursor-pointer"
      onClick={openArticle}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArticle(); } }}
      role={articleUrl ? 'link' : undefined}
      tabIndex={articleUrl ? 0 : undefined}
    >
      <div className="h-40 bg-gs-panel">
        {news.imageUrl ? (
          <img
            src={news.imageUrl}
            alt=""
            className="w-full h-full object-cover"
            onError={(event) => { event.currentTarget.style.display = 'none'; event.currentTarget.nextSibling && (event.currentTarget.nextSibling.style.display = 'grid'); }}
          />
        ) : null}
        <div className={`h-full ${news.imageUrl ? 'hidden' : 'grid'} place-items-center gap-1 text-[10px] uppercase tracking-wider text-gs-textDim`}>
          <ImageOff className="w-5 h-5" />
          Image unavailable
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-1 text-[10px] text-gs-textDim">
            <Clock className="w-3 h-3" />
            {published}
          </div>
        </div>

        <h3 className="font-display font-bold text-gs-text text-sm mb-2 line-clamp-2 group-hover:text-gs-gold transition-colors">
          {news.title}
        </h3>

        <p className="text-[12px] text-gs-textMuted mb-3 line-clamp-2">
          {news.description || 'No excerpt available.'}
        </p>

        <div className="flex items-center justify-between">
          {origin ? (
            <a
              href={origin}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-gs-textDim font-mono uppercase tracking-wider hover:text-gs-gold hover:underline"
            >
              {news.source}
            </a>
          ) : (
            <span className="text-[11px] text-gs-textDim font-mono uppercase tracking-wider">{news.source}</span>
          )}

          {news.symbols?.length > 0 && (
            <div className="flex gap-1">
              {news.symbols.slice(0, 3).map((symbol) => (
                <Badge key={symbol} variant="secondary" className="text-[10px] font-mono bg-gs-panel border-gs-border text-gs-textMuted">{symbol}</Badge>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 pt-3 border-t border-gs-border flex items-center justify-end">
          {articleUrl ? <ExternalLink className="w-3.5 h-3.5 text-gs-textDim group-hover:text-gs-gold transition-colors" aria-label={`Open ${news.title}`} /> : <span className="text-[10px] text-gs-textDim">Article unavailable</span>}
        </div>
      </div>
    </article>
  );
}
