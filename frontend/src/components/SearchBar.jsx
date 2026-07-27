import { useState, useEffect, useRef } from 'react';
import { Search, X, TrendingUp, TrendingDown } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { SUPPORTED_STOCKS } from '@/data/mockData';

const SearchBar = () => {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const searchRef = useRef(null);

  // Filter stocks based on query
  useEffect(() => {
    if (query.length < 1) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    const filtered = Object.entries(SUPPORTED_STOCKS)
      .filter(([ticker, data]) => {
        const searchTerm = query.toLowerCase();
        return (
          ticker.toLowerCase().includes(searchTerm) ||
          data.name.toLowerCase().includes(searchTerm) ||
          data.sector.toLowerCase().includes(searchTerm)
        );
      })
      .slice(0, 8)
      .map(([ticker, data]) => ({
        ticker,
        ...data,
      }));

    setSuggestions(filtered);
    setIsOpen(true);
  }, [query]);

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
    navigate(`/stock/${ticker}`);
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
            onFocus={() => query.length >= 1 && setIsOpen(true)}
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
          <div className="text-sm text-gs-textDim">No results found</div>
          <div className="text-xs text-gs-textDim mt-1">
            Try searching for: HAL, HDFCBANK, Nifty-50
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
