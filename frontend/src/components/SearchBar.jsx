import { useState, useEffect, useRef } from 'react';
import { Search, X, TrendingUp, TrendingDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { searchStocks } from '@/services/stockApi';
import { useBackendReadiness } from '@/hooks/useBackendReadiness';

const SearchBar = () => {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const navigate = useNavigate();
  const searchRef = useRef(null);
  // Global search shares the same single-flight readiness check as every
  // other terminal route (see useBackendReadiness.js) -- typing into
  // search while the backend is still waking up must not fire a live
  // request into it; it must wait for the same wake-up signal Layout is
  // already showing.
  const backendReadiness = useBackendReadiness();

  // Minimum query length before searching at all -- a single character
  // matches a huge fraction of the directory and is never a useful search.
  const MIN_QUERY_LENGTH = 2;
  // 400-500ms: long enough that normal typing speed never fires one
  // request per keystroke, short enough to still feel responsive.
  const SEARCH_DEBOUNCE_MS = 450;

  // Filter stocks based on query. Debounced, and the in-flight request (if
  // any) is aborted whenever the query changes again or the component
  // unmounts -- both the network call itself (AbortController) and the
  // state update (the `requestId` guard) are protected, so a slow response
  // to an old keystroke can never overwrite a newer one's results.
  const requestIdRef = useRef(0);
  useEffect(() => {
    if (query.trim().length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setIsOpen(false);
      setSearchError('');
      return undefined;
    }

    // Never fire the live search request while the backend is still
    // waking up -- show a clear status instead. Once readiness flips
    // (this effect re-runs because backendReadiness.status is a
    // dependency below), the debounce/search proceeds normally.
    if (backendReadiness.status === 'waking') {
      setSuggestions([]);
      setIsLoading(false);
      setSearchError('Backend is starting…');
      setIsOpen(true);
      return undefined;
    }

    const thisRequestId = requestIdRef.current + 1;
    requestIdRef.current = thisRequestId;
    const controller = new AbortController();

    const searchTimer = setTimeout(() => {
      setIsLoading(true);
      setSearchError('');
      searchStocks(query, { signal: controller.signal })
        .then((stocks) => {
          if (requestIdRef.current !== thisRequestId) return;
          setSuggestions(stocks.slice(0, 8));
          setIsOpen(true);
        })
        .catch((error) => {
          if (controller.signal.aborted || requestIdRef.current !== thisRequestId) return;
          setSuggestions([]);
          setSearchError('Search is temporarily unavailable');
          setIsOpen(true);
        })
        .finally(() => {
          if (requestIdRef.current === thisRequestId) setIsLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(searchTimer);
      controller.abort();
    };
  }, [query, backendReadiness.status]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) {
      navigate(`/search?q=${encodeURIComponent(query)}`);
      setIsOpen(false);
    }
  };

  const handleSuggestionClick = (ticker) => {
    const normalizedSymbol = String(ticker || '').trim().toUpperCase();
    navigate(`/stock/${encodeURIComponent(normalizedSymbol)}`);
    setQuery('');
    setIsOpen(false);
  };

  const clearSearch = () => {
    setQuery('');
    setSuggestions([]);
    setIsOpen(false);
  };

  return (
    <div ref={searchRef} className="relative w-full max-w-md">
      <form onSubmit={handleSearch} className="relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gs-textDim w-4 h-4" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stocks, companies, sectors..."
            className="w-full bg-gs-card border border-gs-border rounded-md pl-10 pr-10 py-2 text-sm text-gs-text placeholder-gs-textDim focus:outline-none focus:border-gs-accent transition-colors"
            onFocus={() => query.trim().length >= MIN_QUERY_LENGTH && suggestions.length > 0 && setIsOpen(true)}
          />
          {query && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gs-textDim hover:text-gs-text transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </form>

      {isOpen && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-gs-card border border-gs-border rounded-md shadow-lg z-50 max-h-96 overflow-y-auto">
          {suggestions.map((stock) => (
            <div
              key={stock.ticker}
              onClick={() => handleSuggestionClick(stock.ticker)}
              className="flex items-center justify-between px-4 py-3 hover:bg-gs-hover cursor-pointer transition-colors border-b border-gs-border last:border-b-0"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-gs-text">
                    {stock.ticker}
                  </span>
                  <span className="text-xs text-gs-textDim">{stock.sector}</span>
                </div>
                <div className="text-xs text-gs-textDim mt-0.5">{stock.name}</div>
              </div>
              <div className="flex items-center gap-2">
                {stock.changePct >= 0 ? (
                  <TrendingUp className="w-4 h-4 text-gs-pos" />
                ) : (
                  <TrendingDown className="w-4 h-4 text-gs-neg" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isOpen && query.length >= 1 && suggestions.length === 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-gs-card border border-gs-border rounded-md shadow-lg z-50 px-4 py-3">
          <div className="text-sm text-gs-textDim">
            {isLoading ? 'Searching live stocks...' : searchError || 'No results found'}
          </div>
          <div className="text-xs text-gs-textDim mt-1">
            Try searching for: HAL, HDFCBANK, Nifty-50
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
