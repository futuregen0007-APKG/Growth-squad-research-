# 📊 Stock Market AI - API Documentation

## Overview

This is a production-grade REST API for real-time stock market data with intelligent caching and error handling.

**Base URL:** `http://localhost:3000/api`

**Provider:** Finnhub (Real-time global stock data)

---

## 🏗️ Architecture

```
Client Request
    ↓
Express Route Handler
    ↓
Controller (HTTP logic)
    ↓
Service (Business logic + Caching)
    ↓
Provider (External API - Finnhub)
    ↓
Redis Cache (Reduces API calls)
    ↓
Response to Client
```

**Key Pattern:** Provider → Service (caching) → Controller (HTTP) → Routes → Client

---

## 📚 API Endpoints

### 1. **Get All Stocks**

Get all supported stocks with live market data.

```
GET /api/stocks
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": [
    {
      "ticker": "HAL",
      "name": "Hindustan Aeronautics",
      "sector": "Defence",
      "price": 4521.30,
      "changePct": 2.84,
      "change": 120.50,
      "high": 4580.00,
      "low": 4450.00,
      "open": 4450.00,
      "volume": 5000000,
      "currency": "INR",
      "lastUpdate": 1721898645000,
      "priceFormatted": "₹4521.30",
      "changeFormatted": "+2.84%",
      "isPositive": true,
      "isNegative": false
    },
    { ... more stocks ... }
  ],
  "count": 26,
  "message": "All 26 supported stocks"
}
```

**Use Case:** Load dashboard with all stocks overview

**Performance:** 
- Fast if all cached (100ms)
- Slow if cache empty (1-2 seconds)

---

### 2. **Get Single Stock**

Get live data for a specific stock.

```
GET /api/stocks/:symbol
```

**Parameters:**
- `symbol` (path) - Stock ticker (e.g., `HAL`, `HDFCBANK`)

**Examples:**
```
GET /api/stocks/HAL
GET /api/stocks/HDFCBANK
GET /api/stocks/NTPC
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "ticker": "HAL",
    "name": "Hindustan Aeronautics",
    "sector": "Defence",
    "price": 4521.30,
    "changePct": 2.84,
    "change": 120.50,
    "high": 4580.00,
    "low": 4450.00,
    "open": 4450.00,
    "volume": 5000000,
    "currency": "INR",
    "lastUpdate": 1721898645000,
    "priceFormatted": "₹4521.30",
    "changeFormatted": "+2.84%",
    "isPositive": true,
    "isNegative": false
  },
  "message": "Stock data for HAL"
}
```

**Error Responses:**

404 Not Found - Symbol doesn't exist
```json
{
  "success": false,
  "error": "Stock not found: XYZ",
  "code": "NOT_FOUND",
  "status": 404
}
```

400 Bad Request - Invalid symbol format
```json
{
  "success": false,
  "error": "Symbol must be a non-empty string",
  "code": "INVALID_INPUT",
  "status": 400
}
```

503 Service Unavailable - API error
```json
{
  "success": false,
  "error": "Failed to fetch HAL: API rate limit exceeded",
  "code": "PROVIDER_ERROR",
  "status": 503
}
```

**Cache:** 5 minutes (configurable via `CACHE_TTL_STOCK`)

**Use Case:** Stock detail page, individual stock lookup

---

### 3. **Get Multiple Stocks**

Efficiently fetch multiple stocks in one request.

```
GET /api/stocks?symbols=HAL,BEL,HDFCBANK
```

**Query Parameters:**
- `symbols` (string, required) - Comma-separated stock tickers

**Examples:**
```
GET /api/stocks?symbols=HAL
GET /api/stocks?symbols=HAL,BEL,HDFCBANK
GET /api/stocks?symbols=NTPC,TATAPOWER,ADANIGREEN
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": [
    { "ticker": "HAL", "price": 4521.30, ... },
    { "ticker": "BEL", "price": 3280.50, ... },
    { "ticker": "HDFCBANK", "price": 1745.20, ... }
  ],
  "count": 3,
  "message": "Data for 3 stocks"
}
```

**Advantages over multiple GET requests:**
- Single network round-trip
- Better for batch operations
- More efficient caching

**Use Case:** Load watchlist with specific stocks

---

### 4. **Search & Filter Stocks**

Get stocks filtered by sector, price range, or sorted by performance.

```
GET /api/stocks/search?sector=Defence&sortBy=changePct
```

**Query Parameters:**
- `sector` (optional) - Filter by sector
  - Values: `Defence`, `Banking`, `Railways`, `Green Energy`, `Manufacturing`, `Infrastructure`, `Healthcare`
- `minPrice` (optional, number) - Minimum stock price
- `maxPrice` (optional, number) - Maximum stock price
- `sortBy` (optional) - Sort results
  - Values: `price`, `changePct`, `volume`

**Examples:**
```
GET /api/stocks/search?sector=Defence
GET /api/stocks/search?sector=Banking&sortBy=changePct
GET /api/stocks/search?minPrice=1000&maxPrice=5000&sortBy=price
GET /api/stocks/search?sector=Defence&minPrice=1000&maxPrice=5000
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": [
    { "ticker": "HAL", "price": 4521.30, "changePct": 2.84, ... },
    { "ticker": "BEL", "price": 3280.50, "changePct": 1.50, ... }
  ],
  "count": 4,
  "filters": {
    "sector": "Defence",
    "sortBy": "changePct"
  },
  "message": "Found 4 stocks matching filters"
}
```

**Use Case:** 
- Sector intelligence page (filter by sector)
- Price range filtering
- Performance-based sorting

---

### 5. **Get Company Details**

Get detailed company information (profile, fundamentals).

```
GET /api/stocks/:symbol/details
```

**Parameters:**
- `symbol` (path) - Stock ticker

**Examples:**
```
GET /api/stocks/HAL/details
GET /api/stocks/HDFCBANK/details
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "ticker": "HAL",
    "name": "Hindustan Aeronautics Limited",
    "description": "Manufacturer of aircraft and aerospace products...",
    "sector": "Defence",
    "marketCap": 30200000000,
    "website": "https://hal.co.in",
    "foundedYear": 1940
  },
  "message": "Company details for HAL"
}
```

**Cache:** 1 hour (longer than prices, as company info is stable)

**Use Case:** Stock detail page - company profile section

---

### 6. **Refresh Stock Price**

Manually refresh stock price (bypass cache).

```
POST /api/stocks/:symbol/refresh
```

**Parameters:**
- `symbol` (path) - Stock ticker

**Examples:**
```
POST /api/stocks/HAL/refresh
POST /api/stocks/HDFCBANK/refresh
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "ticker": "HAL",
    "price": 4521.30,
    ... (fresh stock data)
  },
  "message": "Stock data refreshed for HAL"
}
```

**Why POST instead of GET?**
- POST = action/command (refresh), not just data retrieval
- Bypasses proxy caching
- More semantically correct for commands

**Use Case:** User clicks "Refresh" button for immediate latest prices

---

### 7. **Get Market Status**

Get current market status (open/closed, session, time).

```
GET /api/market/status
```

**Response:** 200 OK
```json
{
  "success": true,
  "data": {
    "isOpen": true,
    "region": "NSE / BSE",
    "session": "REGULAR",
    "closesAt": "15:30 IST",
    "serverTime": "14:30:45 IST"
  }
}
```

**Use Case:** 
- Display market status indicator
- Disable trading when market closed
- Show "Market closes at 3:30 PM" message

---

### 8. **Health Check** (Optional)

Check if server is running.

```
GET /health
```

**Response:** 200 OK
```json
{
  "status": "ok",
  "timestamp": "2024-07-25T14:30:45.123Z",
  "uptime": 3600,
  "environment": "development"
}
```

**Use Case:**
- Docker health checks
- Load balancer monitoring
- Frontend connection test

---

## 🗂️ Supported Stocks

**Total: 26 stocks across 7 sectors**

### Defence (4)
- `HAL` - Hindustan Aeronautics
- `BEL` - Bharat Electronics
- `BDL` - Bharat Dynamics
- `MAZDOCK` - Mazagon Dock Shipbuilders

### Railways (4)
- `IRCTC` - Indian Railway Catering and Tourism
- `RVNL` - Rail Vikas Nigam
- `RAILTEL` - RailTel Corporation
- `TITAGARH` - Titagarh Rail Systems

### Green Energy (4)
- `ADANIGREEN` - Adani Green Energy
- `TATAPOWER` - Tata Power
- `SUZLON` - Suzlon Energy
- `NTPC` - NTPC Limited

### Manufacturing (3)
- `LT` - Larsen & Toubro
- `SIEMENS` - Siemens India
- `ABB` - ABB India

### Banking (4)
- `HDFCBANK` - HDFC Bank
- `ICICIBANK` - ICICI Bank
- `SBIN` - State Bank of India
- `KOTAKBANK` - Kotak Mahindra Bank

### Infrastructure (3)
- `GMRINFRA` - GMR Airports Infrastructure
- `IRB` - IRB Infrastructure
- `NCC` - NCC Limited

### Healthcare (4)
- `SUNPHARMA` - Sun Pharmaceuticals
- `DRREDDY` - Dr. Reddy's Laboratories
- `DIVISLAB` - Divi's Laboratories
- `CIPLA` - Cipla Limited

---

## 🔒 Error Handling

All errors follow standard JSON format:

```json
{
  "success": false,
  "error": "Error message describing what went wrong",
  "code": "ERROR_CODE",
  "status": 400
}
```

### HTTP Status Codes

| Code | Meaning | Example |
|------|---------|---------|
| `200` | Success | Stock data returned |
| `400` | Bad Request | Invalid symbol format |
| `404` | Not Found | Stock symbol doesn't exist |
| `500` | Server Error | Unexpected error |
| `503` | Service Unavailable | Provider API down |

### Error Codes

| Code | Meaning | Example |
|------|---------|---------|
| `INVALID_INPUT` | Invalid parameters | Missing required field |
| `NOT_FOUND` | Resource not found | Stock symbol doesn't exist |
| `PROVIDER_ERROR` | External API error | Finnhub API rate limit |
| `CACHE_ERROR` | Cache system error | Redis connection failed |
| `INTERNAL_ERROR` | Unexpected error | Code bug |

---

## ⚡ Performance & Caching

### Cache Strategy

| Data Type | TTL | Reason |
|-----------|-----|--------|
| Stock Prices | 5 minutes | Prices update frequently |
| Company Details | 1 hour | Stable, rarely changes |
| Market Status | 1 minute | Updates during trading hours |

### Performance Metrics

- **Cache Hit:** ~50-100ms (instant response)
- **Cache Miss:** 1-3 seconds (API call to Finnhub)
- **Average with 70% hit rate:** ~500-800ms

### Optimization Tips

1. **Batch Requests:** Use `?symbols=HAL,BEL` instead of 2 separate requests
2. **Check Cache First:** Prices update every 5 minutes; check cache before refreshing
3. **Use Market Status:** Know when market is closed; avoid wasted API calls

---

## 🛠️ Setup Instructions

### Prerequisites

1. **Node.js 16+** - [Download](https://nodejs.org)
2. **Redis** - [Download](https://redis.io/download)
3. **Finnhub API Key** - [Get Free Key](https://finnhub.io)

### Installation

```bash
# 1. Copy environment config
cp .env.example .env

# 2. Add your Finnhub API key to .env
# Edit .env and set: FINNHUB_API_KEY=your_key_here

# 3. Install dependencies
npm install

# 4. Start Redis (in another terminal)
redis-server

# 5. Start backend server
npm run dev

# 6. Server runs on http://localhost:3000
```

### Environment Variables

See `.env.example` for complete configuration. Key variables:

```
PORT=3000                          # Server port
FINNHUB_API_KEY=your_api_key       # Your Finnhub API key
REDIS_HOST=localhost               # Redis host
REDIS_PORT=6379                    # Redis port
CACHE_TTL_STOCK=300                # Stock cache 5 min
CACHE_TTL_COMPANY=3600             # Company cache 1 hour
```

---

## 📝 Usage Examples

### Example 1: Load Dashboard

```bash
# Get all stocks for dashboard overview
curl "http://localhost:3000/api/stocks"
```

### Example 2: Stock Detail Page

```bash
# Get single stock + company details
curl "http://localhost:3000/api/stocks/HAL"
curl "http://localhost:3000/api/stocks/HAL/details"
```

### Example 3: Sector Intelligence

```bash
# Get all Defence sector stocks, sorted by performance
curl "http://localhost:3000/api/stocks/search?sector=Defence&sortBy=changePct"
```

### Example 4: Watchlist

```bash
# Get specific stocks for user's watchlist
curl "http://localhost:3000/api/stocks?symbols=HAL,ADANIGREEN,HDFCBANK"
```

### Example 5: Manual Refresh

```bash
# User clicked refresh button - bypass cache
curl -X POST "http://localhost:3000/api/stocks/HAL/refresh"
```

---

## 🔄 Real-time Updates (WebSocket)

WebSocket support for live price updates coming soon.

**Features planned:**
- Subscribe to price updates for specific stocks
- Automatic push updates every 5 seconds
- Less polling overhead than REST

---

## 🏭 Provider Switching

To switch from Finnhub to another provider (e.g., Twelve Data):

1. Create new provider: `TwelveDataProvider.js` extending `BaseProvider`
2. Update `server.js`:
   ```javascript
   // OLD: const provider = new FinnhubProvider(apiKey);
   // NEW:
   const provider = new TwelveDataProvider(apiKey);
   ```
3. No controller/route changes needed - provider is swappable!

---

## 🧪 Testing

```bash
# Test endpoint
curl -X GET "http://localhost:3000/api/stocks/HAL"

# With query string
curl -X GET "http://localhost:3000/api/stocks/search?sector=Defence"

# Multiple stocks
curl -X GET "http://localhost:3000/api/stocks?symbols=HAL,BEL,HDFCBANK"

# Refresh stock
curl -X POST "http://localhost:3000/api/stocks/HAL/refresh"
```

---

## 📞 Support

For issues with the API:
1. Check error code and message
2. Verify `.env` configuration
3. Ensure Redis is running
4. Check Finnhub API key is valid
5. Review logs in console

---

**Last Updated:** July 25, 2024  
**Version:** 1.0.0
