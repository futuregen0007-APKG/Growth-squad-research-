import { useState, useMemo, useEffect } from "react";
import {
  Newspaper,
  Clock,
  ExternalLink,
  TrendingUp,
  Search,
} from "lucide-react";
import { STOCKS } from "@/data/mockData";
import { fetchNews } from "@/services/newsApi";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const CATEGORIES = [
  "all",
  "market",
  "company",
  "earnings",
  "economy",
  "global",
];

export default function News() {
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stockFilter, setStockFilter] = useState("all");
  const [newsFeed, setNewsFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const loadNews = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setNewsFeed(await fetchNews(STOCKS.map((stock) => stock.ticker)));
    } catch (error) {
      console.error('Unable to load news:', error);
      setLoadError(true);
      setNewsFeed([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadNews(); }, []);

  // Filter news based on search and filters
  const filteredNews = useMemo(() => {
    return newsFeed.filter((news) => {
      const tickers = news.symbol ? [news.symbol] : [];
      const headline = news.title || '';
      const matchesSearch = searchQuery === "" || headline.toLowerCase().includes(searchQuery.toLowerCase()) || news.source.toLowerCase().includes(searchQuery.toLowerCase()) || tickers.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesCategory =
        categoryFilter === "all" || String(news.category || '').toLowerCase() === categoryFilter;

      const matchesStock =
        stockFilter === "all" || tickers.includes(stockFilter);

      return matchesSearch && matchesCategory && matchesStock;
    });
  }, [newsFeed, searchQuery, categoryFilter, stockFilter]);

  // Group filtered news by category
  const newsByCategory = useMemo(() => {
    return CATEGORIES.reduce((acc, cat) => {
      acc[cat] = filteredNews.filter(
        (n) => cat === "all" || n.category === cat
      );

      return acc;
    }, {});
  }, [filteredNews]);

  return (
    <div
      className="space-y-6 animate-fade-up"
      data-testid="news-page"
    >
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Market Intelligence</div>

          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            News
          </h1>

          <p className="text-sm text-gs-textMuted mt-1">
            Latest market news, company announcements, and economic updates.
          </p>
        </div>

        <div className="flex items-center gap-2 text-[10.5px] font-mono text-gs-textDim">
          <span className="px-2 py-1 bg-gs-panel border border-gs-border rounded-sm">
            {filteredNews.length} articles
          </span>

          <span className="px-2 py-1 bg-gs-panel border border-gs-border rounded-sm">
            Live updates
          </span>
        </div>
      </div>

      {/* Filters */}
      <div className="gs-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gs-textDim" />

            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search news..."
              className="pl-8 bg-gs-bg border-gs-border text-gs-text h-9 w-full text-sm rounded-sm"
            />
          </div>

          {/* Category Filter */}
          <Select
            value={categoryFilter}
            onValueChange={setCategoryFilter}
          >
            <SelectTrigger className="bg-gs-bg border-gs-border w-40 h-9 text-sm rounded-sm">
              <SelectValue placeholder="Category" />
            </SelectTrigger>

            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="all">All Categories</SelectItem>
              <SelectItem value="market">Market</SelectItem>
              <SelectItem value="company">Company</SelectItem>
              <SelectItem value="earnings">Earnings</SelectItem>
              <SelectItem value="economy">Economy</SelectItem>
              <SelectItem value="global">Global</SelectItem>
            </SelectContent>
          </Select>

          {/* Stock Filter */}
          <Select
            value={stockFilter}
            onValueChange={setStockFilter}
          >
            <SelectTrigger className="bg-gs-bg border-gs-border w-40 h-9 text-sm rounded-sm">
              <SelectValue placeholder="Stock" />
            </SelectTrigger>

            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="all">All Stocks</SelectItem>

              {STOCKS.slice(0, 10).map((stock) => (
                <SelectItem
                  key={stock.ticker}
                  value={stock.ticker}
                >
                  {stock.ticker}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading && <div className="gs-card p-8 text-center text-sm text-gs-textDim">Loading news...</div>}
      {loadError && !loading && (
        <div className="gs-card p-8 text-center">
          <p className="text-sm text-gs-textMuted">Unable to load news.</p>
          <button onClick={loadNews} className="mt-3 text-sm text-gs-gold hover:text-gs-text">Retry</button>
        </div>
      )}

      {/* News Content */}
      {!loading && !loadError && (
      <Tabs defaultValue="all" className="w-full">
        <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1 flex-wrap">
          {CATEGORIES.map((cat) => (
            <TabsTrigger
              key={cat}
              value={cat}
              className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px] capitalize"
            >
              {cat} ({newsByCategory[cat]?.length || 0})
            </TabsTrigger>
          ))}
        </TabsList>

        {CATEGORIES.map((cat) => (
          <TabsContent
            key={cat}
            value={cat}
            className="mt-4"
          >
            {newsByCategory[cat]?.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {newsByCategory[cat].map((news) => (
                  <NewsCard
                    key={news.url}
                    news={news}
                  />
                ))}
              </div>
            ) : (
              <div className="gs-card p-8 text-center">
                <Newspaper className="w-12 h-12 mx-auto text-gs-textDim mb-3" />

                <h3 className="font-display font-bold text-gs-text mb-1">
                  No news found
                </h3>

                <p className="text-sm text-gs-textMuted">
                  Try adjusting your filters or search query
                </p>
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
      )}
    </div>
  );
}

function NewsCard({ news }) {
  const articleUrl = news.url;
  const published = news.publishedAt ? new Date(news.publishedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date unavailable';
  const openArticle = () => {
    if (articleUrl) window.open(articleUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <article className="gs-card overflow-hidden hover:bg-gs-cardHover transition-colors group cursor-pointer" onClick={openArticle} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openArticle(); } }} role={articleUrl ? 'link' : undefined} tabIndex={articleUrl ? 0 : undefined}>
      <div className="h-40 bg-gs-panel">
        {news.imageUrl ? <img src={news.imageUrl} alt="" className="w-full h-full object-cover" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <div className="h-full grid place-items-center text-[10px] uppercase tracking-wider text-gs-textDim">Image unavailable</div>}
      </div>
      <div className="p-4">
      {/* Category + Time */}
      <div className="flex items-start justify-between mb-2">
        <Badge
          variant="outline"
          className="text-[10px] uppercase tracking-wider border-gs-border text-gs-textDim"
        >
          {news.category}
        </Badge>

        <div className="flex items-center gap-1 text-[10px] text-gs-textDim">
          <Clock className="w-3 h-3" />
          {published}
        </div>
      </div>

      {/* Headline */}
      <h3 className="font-display font-bold text-gs-text text-sm mb-2 line-clamp-2 group-hover:text-gs-gold transition-colors">
        {news.title}
      </h3>

      {/* Summary */}
      <p className="text-[12px] text-gs-textMuted mb-3 line-clamp-2">
        {news.description || 'No excerpt available.'}
      </p>

      {/* Source + Tickers */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-gs-textDim font-mono uppercase tracking-wider">
          {news.source}
        </span>

        {news.symbol && (
          <div className="flex gap-1">
            <Badge variant="secondary" className="text-[10px] font-mono bg-gs-panel border-gs-border text-gs-textMuted">{news.symbol}</Badge>
          </div>
        )}
      </div>

      {/* Bottom */}
      <div className="mt-3 pt-3 border-t border-gs-border flex items-center justify-between">
        <div className="flex items-center gap-1 text-[10px] text-gs-textDim">
          <TrendingUp className="w-3 h-3" />
          <span>{news.sentiment || "Neutral"}</span>
        </div>

        {articleUrl ? <ExternalLink className="w-3.5 h-3.5 text-gs-textDim group-hover:text-gs-gold transition-colors" aria-label={`Open ${news.title}`} /> : <span className="text-[10px] text-gs-textDim">Article unavailable</span>}
      </div>
      </div>
    </article>
  );
}