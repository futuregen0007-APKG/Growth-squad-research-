# 🔗 Frontend Integration Guide

## Overview

This guide shows how to update your React frontend to use the new live stock market API instead of hardcoded mock data.

---

## 📝 Summary of Changes

### Before (Current)
```javascript
// In mockData.js
export const STOCKS = [
  {
    ticker: "HAL",
    name: "Hindustan Aeronautics",
    price: 4521.3,  // HARDCODED
    changePct: 2.84,  // HARDCODED
    // ... etc
  },
  // ... 25 more hardcoded stocks
];
```

### After (New)
```javascript
// No hardcoded data!
// All data comes from API

const response = await fetch('http://localhost:3000/api/stocks');
const { data: stocks } = await response.json();

// stocks now has LIVE prices from Finnhub
```

---

## 🔄 API Endpoints Cheat Sheet

```javascript
// Get all stocks for dashboard
GET /api/stocks

// Get single stock
GET /api/stocks/HAL

// Get multiple stocks
GET /api/stocks?symbols=HAL,BEL,HDFCBANK

// Filter by sector
GET /api/stocks/search?sector=Defence

// Get company details
GET /api/stocks/HAL/details

// Force refresh price
POST /api/stocks/HAL/refresh

// Get market status
GET /api/market/status
```

---

## 📁 Files to Update

### 1. **src/pages/Dashboard.jsx**

**Current (Hardcoded):**
```javascript
import { STOCKS, INDICES, TOP_MOVERS } from "@/data/mockData";

export default function Dashboard() {
  return (
    <div>
      {STOCKS.map(stock => (
        <StockCard key={stock.ticker} stock={stock} />
      ))}
    </div>
  );
}
```

**Updated (Live API):**
```javascript
import { useState, useEffect } from "react";

const API_BASE = 'http://localhost:3000/api';

export default function Dashboard() {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchStocks();
  }, []);

  const fetchStocks = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/stocks`);
      
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      
      const { data } = await response.json();
      setStocks(data);
      setError(null);
    } catch (err) {
      setError(err.message);
      console.error('Failed to fetch stocks:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading stocks...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      {stocks.map(stock => (
        <StockCard key={stock.ticker} stock={stock} />
      ))}
    </div>
  );
}
```

**Key Changes:**
- Remove `import { STOCKS }` from mockData
- Add `useState` for stocks, loading, error
- Add `useEffect` to fetch on component mount
- Handle loading and error states
- Update render to use fetched data

---

### 2. **src/pages/StockDetail.jsx**

**Current:**
```javascript
import { STOCKS } from "@/data/mockData";

export default function StockDetail() {
  const { symbol } = useParams();
  const stock = STOCKS.find(s => s.ticker === symbol);

  return (
    <div>
      <h1>{stock.name}</h1>
      <div>Price: ₹{stock.price}</div>
      // ...
    </div>
  );
}
```

**Updated:**
```javascript
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";

const API_BASE = 'http://localhost:3000/api';

export default function StockDetail() {
  const { symbol } = useParams();
  const [stock, setStock] = useState(null);
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchStockData();
  }, [symbol]);

  const fetchStockData = async () => {
    try {
      setLoading(true);
      
      // Fetch stock prices
      const stockRes = await fetch(`${API_BASE}/stocks/${symbol}`);
      if (!stockRes.ok) throw new Error('Stock not found');
      const stockData = await stockRes.json();
      setStock(stockData.data);

      // Fetch company details
      const detailsRes = await fetch(`${API_BASE}/stocks/${symbol}/details`);
      if (detailsRes.ok) {
        const detailsData = await detailsRes.json();
        setDetails(detailsData.data);
      }

      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    try {
      const res = await fetch(`${API_BASE}/stocks/${symbol}/refresh`, {
        method: 'POST'
      });
      const data = await res.json();
      setStock(data.data);
    } catch (err) {
      console.error('Refresh failed:', err);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!stock) return <div>Stock not found</div>;

  return (
    <div>
      <h1>{stock.name}</h1>
      <div>Price: ₹{stock.price}</div>
      <div>Change: {stock.changeFormatted}</div>
      {details && (
        <div>
          <p>{details.description}</p>
          <p>Sector: {details.sector}</p>
          <p>Website: {details.website}</p>
        </div>
      )}
      <button onClick={handleRefresh}>Refresh Price</button>
    </div>
  );
}
```

**Key Changes:**
- Fetch single stock from `/api/stocks/{symbol}`
- Fetch company details from `/api/stocks/{symbol}/details`
- Add refresh button that calls POST endpoint
- Handle loading/error states
- Remove mock data dependency

---

### 3. **src/pages/Watchlist.jsx**

**Current:**
```javascript
import { WATCHLISTS, STOCKS } from "@/data/mockData";

export default function Watchlist() {
  const { listId } = useParams();
  const watchlist = WATCHLISTS.find(w => w.id === listId);
  const stocks = STOCKS.filter(s => 
    watchlist.symbols.includes(s.ticker)
  );

  return (
    <div>
      {stocks.map(s => <StockRow key={s.ticker} stock={s} />)}
    </div>
  );
}
```

**Updated:**
```javascript
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";

const API_BASE = 'http://localhost:3000/api';

export default function Watchlist() {
  const { listId } = useParams();
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchWatchlist();
  }, [listId]);

  const fetchWatchlist = async () => {
    try {
      setLoading(true);
      
      // Get watchlist definition (from mockData or backend)
      // For now, using hardcoded watchlists
      const watchlist = getWatchlistDefinition(listId);
      
      if (!watchlist) {
        setError('Watchlist not found');
        return;
      }

      // Fetch live prices for all symbols
      const symbols = watchlist.symbols.join(',');
      const res = await fetch(`${API_BASE}/stocks?symbols=${symbols}`);
      
      if (!res.ok) throw new Error('Failed to fetch watchlist');
      
      const { data } = await res.json();
      setStocks(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getWatchlistDefinition = (id) => {
    // Keep this from mockData for now
    return WATCHLISTS.find(w => w.id === id);
  };

  if (loading) return <div>Loading watchlist...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      {stocks.map(s => <StockRow key={s.ticker} stock={s} />)}
    </div>
  );
}
```

---

### 4. **src/pages/SectorIntelligence.jsx**

**Current:**
```javascript
import { SECTORS, STOCKS } from "@/data/mockData";

export default function SectorIntelligence() {
  const { sectorName } = useParams();
  const stocks = STOCKS.filter(s => s.sector === sectorName);

  return (
    <div>
      {stocks.map(s => <Card key={s.ticker} stock={s} />)}
    </div>
  );
}
```

**Updated:**
```javascript
import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";

const API_BASE = 'http://localhost:3000/api';

export default function SectorIntelligence() {
  const { sectorName } = useParams();
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSectorStocks();
  }, [sectorName]);

  const fetchSectorStocks = async () => {
    try {
      setLoading(true);
      
      // Get all stocks filtered by sector
      const res = await fetch(
        `${API_BASE}/stocks/search?sector=${sectorName}&sortBy=changePct`
      );
      
      if (!res.ok) throw new Error('Failed to fetch sector data');
      
      const { data } = await res.json();
      setStocks(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading {sectorName} stocks...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div>
      <h1>{sectorName}</h1>
      <p>{stocks.length} stocks</p>
      {stocks.map(s => <Card key={s.ticker} stock={s} />)}
    </div>
  );
}
```

---

### 5. **Create Custom Hook for API Calls**

**New File: src/hooks/useStocks.js**

```javascript
import { useState, useEffect } from 'react';

const API_BASE = 'http://localhost:3000/api';

export const useStocks = () => {
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchAllStocks = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/stocks`);
      const { data } = await res.json();
      setStocks(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return { stocks, loading, error, fetchAllStocks };
};

export const useStock = (symbol) => {
  const [stock, setStock] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchStock = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/stocks/${symbol}`);
      const { data } = await res.json();
      setStock(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    try {
      const res = await fetch(`${API_BASE}/stocks/${symbol}/refresh`, {
        method: 'POST'
      });
      const { data } = await res.json();
      setStock(data);
    } catch (err) {
      setError(err.message);
    }
  };

  return { stock, loading, error, fetchStock, refresh };
};
```

**Usage:**
```javascript
// In any component
const { stock, loading, error, fetchStock, refresh } = useStock('HAL');

useEffect(() => {
  fetchStock();
}, []);
```

---

### 6. **Real-time Updates with WebSocket**

**New File: src/hooks/useStockTicker.js**

```javascript
import { useState, useEffect } from 'react';

export const useStockTicker = (symbols = []) => {
  const [prices, setPrices] = useState({});
  const [connected, setConnected] = useState(false);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    // Create WebSocket connection
    const websocket = new WebSocket('ws://localhost:5001');

    websocket.onopen = () => {
      setConnected(true);
      
      // Subscribe to symbols
      if (symbols.length > 0) {
        websocket.send(JSON.stringify({
          type: 'SUBSCRIBE',
          symbols
        }));
      }
    };

    websocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      
      if (msg.type === 'PRICE_UPDATE') {
        setPrices(prev => ({
          ...prev,
          [msg.data.ticker]: msg.data
        }));
      }
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnected(false);
    };

    websocket.onclose = () => {
      setConnected(false);
    };

    setWs(websocket);

    return () => {
      websocket.close();
    };
  }, []);

  const subscribe = (newSymbols) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'SUBSCRIBE',
        symbols: newSymbols
      }));
    }
  };

  const unsubscribe = (newSymbols) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'UNSUBSCRIBE',
        symbols: newSymbols
      }));
    }
  };

  return { prices, connected, subscribe, unsubscribe };
};
```

**Usage:**
```javascript
// In Dashboard or Watchlist
const { prices, connected } = useStockTicker(['HAL', 'BEL', 'HDFCBANK']);

return (
  <div>
    {connected ? '🟢 Live' : '⚫ Offline'}
    {Object.entries(prices).map(([ticker, data]) => (
      <div key={ticker}>
        {ticker}: ₹{data.price} ({data.changeFormatted})
      </div>
    ))}
  </div>
);
```

---

## 🔐 CORS Configuration

If frontend and backend are on different ports (likely in development):

**Update server.js CORS:**
```javascript
const corsOptions = {
  origin: ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true
};
app.use(cors(corsOptions));
```

Or in `.env`:
```
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
```

---

## 🚀 Deployment Considerations

### Development
```javascript
const API_BASE = 'http://localhost:3000/api';
```

### Production
```javascript
const API_BASE = process.env.REACT_APP_API_URL || 'https://api.yourdomain.com/api';
```

**In .env.production:**
```
REACT_APP_API_URL=https://api.yourdomain.com/api
```

---

## ✅ Migration Checklist

- [ ] Update Dashboard.jsx to fetch from `/api/stocks`
- [ ] Update StockDetail.jsx to use `/api/stocks/{symbol}`
- [ ] Update Watchlist.jsx to fetch live prices
- [ ] Update SectorIntelligence.jsx to use `/api/stocks/search`
- [ ] Create useStocks and useStock custom hooks
- [ ] Test all pages load data from API
- [ ] Remove hardcoded STOCKS from mockData (keep watchlist definitions)
- [ ] Handle loading/error states in all components
- [ ] Add WebSocket for real-time updates
- [ ] Test with actual Finnhub API key

---

## 📚 Component Before/After Examples

### Example: Stock Card Component

```javascript
// Before
<StockCard 
  stock={{
    ticker: "HAL",
    price: 4521.3,  // hardcoded
    changePct: 2.84  // hardcoded
  }}
/>

// After
const [stock, setStock] = useState(null);
useEffect(() => {
  fetch('/api/stocks/HAL').then(r => r.json()).then(d => setStock(d.data));
}, []);

<StockCard stock={stock} />
```

---

## 🆘 Common Issues

### Issue: "CORS error - blocked by browser"

**Solution:**
```javascript
// Make sure backend CORS is configured
// In server.js:
app.use(cors());

// And CORS_ORIGINS includes frontend URL
```

### Issue: "API returns 404 for valid symbol"

**Solution:**
```javascript
// Check symbol is uppercase
const symbol = 'hal'.toUpperCase(); // 'HAL'
fetch(`/api/stocks/${symbol}`);

// Or use the exact symbols from supported list
```

### Issue: "WebSocket connection refused"

**Solution:**
```javascript
// Make sure WebSocket server is running on port 5001
// Check .env has WEBSOCKET_PORT=5001
// Restart backend server
```

---

## 📞 Support

For integration issues:
1. Check browser console for errors
2. Check backend logs for API errors
3. Verify API is running: `curl http://localhost:3000/api/stocks`
4. Check Finnhub API key is valid
5. Verify Redis is running (cache)

---

**Last Updated:** July 25, 2024
