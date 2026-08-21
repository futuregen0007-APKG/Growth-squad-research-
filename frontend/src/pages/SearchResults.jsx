import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, TrendingUp, TrendingDown, Filter, Grid, List, Star } from 'lucide-react';
import { SUPPORTED_STOCKS } from '@/data/mockData';
import { searchStocks } from '@/services/stockApi';
import ChangeBadge from '@/components/widgets/ChangeBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const query = searchParams.get('q') || '';
  const [results, setResults] = useState([]);
  const [viewMode, setViewMode] = useState('grid');
  const [sortBy, setSortBy] = useState('relevance');
  const [sectorFilter, setSectorFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }

    let active = true;
    setLoading(true);
    setError('');
    searchStocks(query)
      .then((filtered) => {
        if (!active) return;
        setResults(filtered);
      })
      .catch(() => {
        if (!active) return;
        setResults([]);
        setError('Unable to search live stock data. Check that the backend is running.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [query]);

  const displayedResults = useMemo(() => {
    let sorted = [...results];
    if (sortBy === 'price-desc') {
      sorted.sort((a, b) => b.price - a.price);
    } else if (sortBy === 'price-asc') {
      sorted.sort((a, b) => a.price - b.price);
    } else if (sortBy === 'change-desc') {
      sorted.sort((a, b) => b.changePct - a.changePct);
    } else if (sortBy === 'change-asc') {
      sorted.sort((a, b) => a.changePct - b.changePct);
    }

    // Filter by sector
    if (sectorFilter !== 'all') {
      sorted = sorted.filter(stock => stock.sector === sectorFilter);
    }

    return sorted;
  }, [results, sortBy, sectorFilter]);

  const sectors = [...new Set(Object.values(SUPPORTED_STOCKS).map(s => s.sector))];

  const StockCard = ({ stock }) => (
    <Link to={`/stock/${stock.ticker}`} className="block">
      <div className="bg-gs-card border border-gs-border rounded-lg p-4 hover:border-gs-accent transition-all hover:shadow-lg">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-gs-text">{stock.ticker}</span>
              <span className="text-xs text-gs-textDim bg-gs-hover px-2 py-0.5 rounded">{stock.sector}</span>
            </div>
            <div className="text-sm text-gs-textDim mt-1">{stock.name}</div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Star className="w-4 h-4 text-gs-textDim hover:text-gs-accent" />
          </Button>
        </div>

        <div className="flex items-end justify-between">
          <div>
            <div className="font-mono text-xl font-semibold text-gs-text">
              ₹{stock.price?.toFixed(2) || '0.00'}
            </div>
            <div className="text-xs text-gs-textDim mt-1">
              Vol: {(stock.volume / 1000000).toFixed(1)}M
            </div>
          </div>
          <ChangeBadge value={stock.changePct} />
        </div>

        <div className="mt-3 pt-3 border-t border-gs-border grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-gs-textDim">High</div>
            <div className="font-mono text-gs-text">₹{stock.high?.toFixed(2) || '0.00'}</div>
          </div>
          <div>
            <div className="text-gs-textDim">Low</div>
            <div className="font-mono text-gs-text">₹{stock.low?.toFixed(2) || '0.00'}</div>
          </div>
          <div>
            <div className="text-gs-textDim">P/E</div>
            <div className="font-mono text-gs-text">{stock.pe || 'N/A'}</div>
          </div>
          <div>
            <div className="text-gs-textDim">Mkt Cap</div>
            <div className="font-mono text-gs-text">{stock.marketCap || 'N/A'}</div>
          </div>
        </div>
      </div>
    </Link>
  );

  const StockListItem = ({ stock }) => (
    <Link to={`/stock/${stock.ticker}`} className="block">
      <div className="flex items-center justify-between p-4 bg-gs-card border border-gs-border rounded-lg hover:border-gs-accent transition-all">
        <div className="flex items-center gap-4 flex-1">
          <div className="flex-shrink-0">
            <div className="font-mono font-bold text-gs-text">{stock.ticker}</div>
            <div className="text-xs text-gs-textDim">{stock.sector}</div>
          </div>
          <div className="flex-1">
            <div className="text-sm text-gs-text">{stock.name}</div>
          </div>
        </div>

        <div className="flex items-center gap-8">
          <div className="text-right">
            <div className="font-mono text-lg font-semibold text-gs-text">
              ₹{stock.price?.toFixed(2) || '0.00'}
            </div>
            <div className="text-xs text-gs-textDim">
              Vol: {(stock.volume / 1000000).toFixed(1)}M
            </div>
          </div>
          <ChangeBadge value={stock.changePct} />
          <div className="text-right text-xs">
            <div className="text-gs-textDim">P/E: {stock.pe || 'N/A'}</div>
            <div className="text-gs-textDim">Mkt Cap: {stock.marketCap || 'N/A'}</div>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <Star className="w-4 h-4 text-gs-textDim hover:text-gs-accent" />
          </Button>
        </div>
      </div>
    </Link>
  );

  return (
    <div className="min-h-screen bg-gs-bg p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 text-gs-textDim mb-2">
            <Search className="w-4 h-4" />
            <span className="text-sm">Search Results</span>
          </div>
          <h1 className="text-2xl font-bold text-gs-text">
            {query ? `"${query}"` : 'All Stocks'}
          </h1>
          <p className="text-sm text-gs-textDim mt-1">
            {displayedResults.length} result{displayedResults.length !== 1 ? 's' : ''} found
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-4 mb-6 p-4 bg-gs-card border border-gs-border rounded-lg">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gs-textDim" />
            <span className="text-sm text-gs-textDim">Filters:</span>
          </div>

          <Select value={sectorFilter} onValueChange={setSectorFilter}>
            <SelectTrigger className="w-40 bg-gs-bg border-gs-border">
              <SelectValue placeholder="Sector" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="all">All Sectors</SelectItem>
              {sectors.map(sector => (
                <SelectItem key={sector} value={sector}>{sector}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="w-40 bg-gs-bg border-gs-border">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              <SelectItem value="relevance">Relevance</SelectItem>
              <SelectItem value="price-desc">Price (High-Low)</SelectItem>
              <SelectItem value="price-asc">Price (Low-High)</SelectItem>
              <SelectItem value="change-desc">Change (High-Low)</SelectItem>
              <SelectItem value="change-asc">Change (Low-High)</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('grid')}
              className="h-8 w-8"
            >
              <Grid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('list')}
              className="h-8 w-8"
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Results */}
        {loading ? (
          <div className="text-center py-12 text-gs-textDim">Searching live stock data...</div>
        ) : error ? (
          <div className="text-center py-12 text-gs-neg">{error}</div>
        ) : displayedResults.length === 0 ? (
          <div className="text-center py-12">
            <Search className="w-12 h-12 text-gs-textDim mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gs-text mb-2">No results found</h3>
            <p className="text-gs-textDim mb-4">
              Try searching for: HAL, HDFCBANK, Nifty-50, or browse by sector
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {['HAL', 'HDFCBANK', 'TATAPOWER', 'Nifty-50'].map(term => (
                <Link
                  key={term}
                  to={`/search?q=${encodeURIComponent(term)}`}
                  className="px-3 py-1 bg-gs-card border border-gs-border rounded text-sm text-gs-text hover:border-gs-accent transition-colors"
                >
                  {term}
                </Link>
              ))}
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {displayedResults.map(stock => (
              <StockCard key={stock.ticker} stock={stock} />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {displayedResults.map(stock => (
              <StockListItem key={stock.ticker} stock={stock} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchResults;
