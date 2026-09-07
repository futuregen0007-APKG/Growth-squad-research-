# GrowthSquad Research Terminal
## Phase 1 Architecture and Project Map

This document describes the architecture confirmed from the files currently present in the repository. It intentionally covers Phase 1 only: project identity, major modules, technologies, boundaries, and high-level flows.

---

## 1. What This Project Is

GrowthSquad Research Terminal is an Indian stock-market research platform for investors and analysts.

The repository contains a React frontend and a Node.js/Express backend. The platform combines:

- Live NSE/BSE market data
- Stock dashboards and company details
- Watchlists and portfolios
- News aggregation
- Sector intelligence
- Earnings intelligence
- Historical company facts
- Management-promise tracking
- AI-assisted research and chat
- Authentication
- Real-time market updates
- Investor-relations and exchange-document collection

The primary application is under `Growth-squad-research-/`.

---

## 2. Main Architecture

```mermaid
flowchart TD
    User[Investor or Analyst]

    User --> React[React frontend]
    React --> Pages[Dashboard, Stock Detail, Watchlist, Earnings, AI Research]
    Pages --> FrontendServices[Frontend API services]

    FrontendServices --> Express[Express backend in backend/server.js]
    Express --> Routes[Express route modules]
    Routes --> Controllers[HTTP controllers]
    Routes --> DomainServices[Domain services]

    DomainServices --> Mongo[(MongoDB via Mongoose)]
    DomainServices --> Redis[(Redis cache)]
    DomainServices --> MarketProviders[Angel One, Finnhub, Twelve Data, FMP]
    DomainServices --> News[NewsAPIService]
    DomainServices --> Documents[IR, NSE, BSE, and news documents]
    DomainServices --> AI[OpenAI and LangGraph]

    Mongo --> DomainServices
    Redis --> DomainServices
    MarketProviders --> DomainServices
    News --> DomainServices
    Documents --> DomainServices
    AI --> DomainServices

    DomainServices --> Express
    Express --> FrontendServices
    FrontendServices --> Pages
    Pages --> User
```

### Simplified Request/Response View

```text
User action
    |
    v
React page
    |
    v
Frontend service in frontend/src/services/
    |
    v
HTTP request to Express
    |
    v
Route in backend/routes/
    |
    v
Controller or service
    |
    +--> MongoDB through backend/models/
    +--> Redis through backend/utils/redisClient.js
    +--> External provider through backend/providers/
    +--> Research/document pipeline
    +--> OpenAI/LangGraph
    |
    v
JSON response
    |
    v
Frontend state
    |
    v
Rendered UI
```

---

## 3. Repository Roots

```text
Stock_Market_AI/
|
+-- angelone_api/
|   Separate Angel One-related workspace area
|
+-- api_testing/
|   Separate backend/frontend API testing area
|
+-- Growth-squad-research-/
|   Primary application
|   |
|   +-- backend/
|   +-- frontend/
|   +-- memory/
|   +-- test_reports/
|   +-- project documentation
|
+-- tests/
    Workspace-level test area
```

The main runtime application is `Growth-squad-research-/backend` plus `Growth-squad-research-/frontend`.

---

## 4. Technologies Actually Present

### Frontend

Defined in `frontend/package.json`:

- React 19
- React DOM
- React Router DOM 7
- Create React App through CRACO
- Tailwind CSS
- Recharts
- Axios
- Socket.IO client
- Lucide React
- Sonner
- Radix UI components
- React Hook Form
- Zod

### Backend

Defined in `backend/package.json`:

- Node.js ES modules
- Express 5
- Axios
- Mongoose
- MongoDB
- Redis
- Socket.IO
- `ws`
- JSON Web Tokens
- bcryptjs
- OpenAI SDK
- LangChain Core
- LangGraph
- `pdf-parse`
- Angel One SmartAPI SDK
- dotenv
- CORS

### Database and Cache

```text
MongoDB
  Accessed through Mongoose
  Connection started in backend/server.js

Redis
  Initialized in backend/utils/redisClient.js
  Used mainly for stock-data caching
```

---

## 5. Frontend Entry and Routing

```mermaid
flowchart TD
    Browser[Browser]
    Browser --> Index[frontend/src/index.js]
    Index --> Strict[React.StrictMode]
    Strict --> App[frontend/src/App.js]
    App --> AuthProvider[AuthProvider from hooks/useAuth.js]
    AuthProvider --> Router[BrowserRouter]
    Router --> Routes[Routes]

    Routes --> Landing[/]
    Routes --> AuthPages[/login, /signup, /onboarding]
    Routes --> Layout[Layout wrapper]
    Layout --> ProductPages[/dashboard, /watchlist, /portfolio, /news]
    Layout --> Intelligence[/sectors, /earnings, /ai-research]
    Layout --> Stock[/stock/:ticker]
    Layout --> Planning[/goals, /baskets, /sip-planner, /retirement, /net-worth]
    Layout --> Search[/search]
```

### Frontend Entry Files

```text
frontend/src/index.js
    Browser entry point. Renders App.

frontend/src/App.js
    Creates AuthProvider, BrowserRouter, routes, Layout, and Toaster.

frontend/src/components/layout/Layout.jsx
    Application shell around most authenticated/product pages.

frontend/src/config/api.js
    Centralizes the backend base URL.
```

### Frontend Route Groups

```text
Public/entry routes:
  /
  /login
  /signup
  /onboarding

Application routes inside Layout:
  /dashboard
  /watchlist
  /portfolio
  /goals
  /baskets
  /sip-planner
  /retirement
  /net-worth
  /settings
  /news
  /sectors
  /earnings
  /earnings/:symbol
  /earnings-intelligence/:symbol
  /ai-research
  /stock/:ticker
  /search
```

---

## 6. Backend Startup Flow

The backend startup sequence is controlled by `backend/server.js`.

```mermaid
flowchart TD
    Start[Start node server.js]
    Start --> Env[dotenv.config]
    Env --> Express[Create Express app]
    Express --> Cors[Configure CORS]
    Cors --> JSON[Enable express.json]
    JSON --> Health[Register /health and /api/health]
    Health --> Logging[Register request logging]
    Logging --> Chat[Mount /api/chat]
    Chat --> Auth[Mount /api/auth]
    Auth --> Mongo[Connect MongoDB]
    Mongo --> Seed[Run seedHistoricalIntelligence]
    Seed --> Redis[Initialize Redis]
    Redis --> Provider[Select market provider]
    Provider --> StockService[Create StockService]
    StockService --> Routes[Mount stock, research, news, goals, portfolio, watchlist, earnings, sector routes]
    Routes --> Errors[Register 404 and error handlers]
    Errors --> HTTP[Start HTTP server]
    HTTP --> Socket[Start StockSocket and live-price services]
```

### Provider Selection

`backend/server.js` reads `MARKET_DATA_PROVIDER`.

```text
angel-one / angelone / angel
    -> AngelOneProvider

financialmodelingprep
    -> FinancialModelingPrepProvider

twelve-data / twelvedata
    -> TwelveDataProvider

finnhub-related value
    -> FinnhubProvider

unknown or missing value
    -> AngelOneProvider fallback
```

The current source default is Angel One, even though some older documentation describes Finnhub as primary.

---

## 7. Stock Market Data Flow

```mermaid
sequenceDiagram
    participant User
    participant Page as React page
    participant API as frontend/src/services/stockApi.js
    participant Route as backend/routes/stocks.js
    participant Controller as StockController
    participant Service as StockService
    participant Cache as Redis
    participant Provider as Selected market provider

    User->>Page: Opens dashboard or stock detail
    Page->>API: fetchAllStocks() or fetchStockBySymbol()
    API->>Route: HTTP request to /api/stocks
    Route->>Controller: Invoke HTTP handler
    Controller->>Service: getAllStocks() or getStock(symbol)
    Service->>Cache: Check stock cache
    alt Cache hit
        Cache-->>Service: Cached stock data
    else Cache miss
        Service->>Provider: Fetch market data
        Provider-->>Service: Provider response
        Service->>Cache: Store normalized data
    end
    Service-->>Controller: Standardized stock object
    Controller-->>API: JSON response
    API-->>Page: Parsed stock data
    Page-->>User: Render prices, changes, charts, and tables
```

### Relevant Files

```text
frontend/src/services/stockApi.js
    Calls stock endpoints and normalizes list/series fields.

backend/routes/stocks.js
    Defines stock HTTP endpoints.

backend/controllers/StockController.js
    Handles HTTP parameters and responses.

backend/services/StockService.js
    Validates symbols, checks Redis, calls providers, enriches results.

backend/providers/AngelOneProvider.js
backend/providers/FinnhubProvider.js
backend/providers/TwelveDataProvider.js
backend/providers/FinancialModelingPrepProvider.js
    External market-data adapters.

backend/utils/constants.js
    Supported symbols, provider configuration, cache TTLs, and constants.
```

---

## 8. Research and Document Data Flow

```mermaid
flowchart TD
    User[User opens or triggers research]
    User --> EarningsPage[frontend/src/pages/EarningsIntelligence.jsx]
    EarningsPage --> EarningsAPI[Frontend earnings API calls]
    EarningsAPI --> EarningsRoute[backend/routes/earningsIntelligence.js]
    EarningsRoute --> MPS[ManagementPromiseService.js]

    MPS --> ResearchRun[ResearchRun model]
    MPS --> DocumentService[DocumentResearchService.js]
    DocumentService --> Profile[CompanyResearchProfiles.js]
    DocumentService --> IR[Investor-relations URLs]
    DocumentService --> Exchange[NSE/BSE exchange pages]
    DocumentService --> NewsDocs[Historical/news sources]
    DocumentService --> PDF[PdfResearchProvider.js]

    MPS --> Facts[CompanyHistoricalFact model]
    MPS --> Promises[ManagementPromise model]
    Promises --> Verification[Deterministic verification]
    Facts --> Verification
    Verification --> Reliability[Reliability and execution calculations]
    Reliability --> EarningsPage
```

Research-related files include:

```text
backend/services/ManagementPromiseService.js
backend/research/DocumentResearchService.js
backend/research/ManagementResearchProviders.js
backend/research/PdfResearchProvider.js
backend/research/CompanyResearchProfiles.js
backend/models/ResearchRun.js
backend/models/CompanyHistoricalFact.js
backend/models/ManagementPromise.js
backend/services/ExecutionScoreService.js
```

The current NEWGEN investigation found that exchange pages return static shells or JavaScript-rendered content, while the company IR domain has TLS certificate-chain failures.

---

## 9. Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant Login as Login/Signup page
    participant AuthAPI as frontend/src/services/authApi.js
    participant Route as backend/routes/auth.js
    participant Controller as auth.controller.js
    participant Hash as bcryptjs
    participant UserModel as models/User.js
    participant Tokens as utils/authTokens.js
    participant Middleware as middleware/auth.js

    User->>Login: Submit registration or sign-in form
    Login->>AuthAPI: Send credentials
    AuthAPI->>Route: POST /api/auth/register or /api/auth/signin
    Route->>Controller: Run auth handler
    Controller->>UserModel: Read or create user
    Controller->>Hash: Hash or compare password
    Controller->>Tokens: Create access and refresh tokens
    Tokens-->>Controller: Token pair
    Controller-->>AuthAPI: User and token response
    AuthAPI-->>Login: Store/update auth state

    User->>AuthAPI: Request protected resource
    AuthAPI->>Middleware: Include access token
    Middleware->>Tokens: Verify token
    Tokens-->>Middleware: User identity
    Middleware->>Route: Continue with req.userId
    Route-->>AuthAPI: User-scoped response
```

Relevant files:

```text
frontend/src/hooks/useAuth.js
frontend/src/services/authApi.js
frontend/src/pages/Login.jsx
frontend/src/pages/Signup.jsx
backend/routes/auth.js
backend/controllers/auth.controller.js
backend/middleware/auth.js
backend/utils/authTokens.js
backend/models/User.js
```

The backend uses bcryptjs and JWT. The exact frontend token-storage details should be traced in the authentication phase.

---

## 10. Watchlist Data Boundary

```mermaid
flowchart TD
    User[Authenticated user]
    User --> Frontend[Watchlist.jsx]
    Frontend --> API[watchlistApi.js]
    API --> Route[backend/routes/watchlist.js]
    Route --> Auth[auth middleware]
    Auth --> Controller[watchlist.controller.js]
    Controller --> Query[Mongo query filtered by userId]
    Query --> Watchlist[(Watchlist collection)]
    Watchlist --> Controller
    Controller --> API
    API --> Frontend
    Frontend --> UI[Watchlist-specific stock table]
```

The relevant backend controller queries watchlists using `req.userId`. Symbol additions and removals also include both the watchlist ID and authenticated user ID in the database filter.

Relevant files:

```text
frontend/src/pages/Watchlist.jsx
frontend/src/services/watchlistApi.js
backend/routes/watchlist.js
backend/controllers/watchlist.controller.js
backend/models/Watchlist.js
backend/middleware/auth.js
```

---

## 11. Real-Time Market Updates

The current startup path in `backend/server.js` uses the `socket/` implementation.

```mermaid
sequenceDiagram
    participant Browser
    participant Hook as Frontend socket hook
    participant Socket as backend/socket/stock.socket.js
    participant Live as live-price.service.js
    participant AngelWS as angel-websocket.service.js
    participant Angel as Angel One
    participant UI as React component

    Browser->>Hook: Open socket connection
    Hook->>Socket: Connect and subscribe to symbols
    Socket->>Live: Register requested symbols
    Live->>AngelWS: Subscribe through provider websocket
    AngelWS->>Angel: Subscribe to market stream
    Angel-->>AngelWS: Price event
    AngelWS-->>Live: Normalize live price
    Live-->>Socket: Broadcast stock update
    Socket-->>Hook: Send stockUpdate event
    Hook-->>UI: Update React state
    UI-->>Browser: Render new price
```

There is also an alternate/older ticker implementation:

```text
backend/websocket/ticker.js
frontend/src/hooks/useStockTicker.js
frontend/src/hooks/useStockSocket.js
```

The repository contains both paths. The source of truth for the currently started server is the `StockSocket` path imported in `backend/server.js`.

---

## 12. AI and LLM Locations

```mermaid
flowchart TD
    ChatUser[User asks AI question]
    ChatUser --> ChatPage[AIResearch.jsx or chat UI]
    ChatPage --> ChatAPI[Frontend chat request]
    ChatAPI --> ChatRoute[backend/routes/chat.js]
    ChatRoute --> Graph[backend/graph/graph.js]
    Graph --> State[graph/state.js]
    Graph --> Node[graph/nodes.js]
    Node --> OpenAI[services/openaiClient.js]
    OpenAI --> Model[OpenAI API]
    Model --> Node
    Node --> Graph
    Graph --> ChatRoute
    ChatRoute --> ChatPage
```

The LangGraph structure currently represented in `graph/graph.js` is:

```text
START
  |
  v
chatbot node
  |
  v
END
```

There is also AI-related logic in the earnings research system. That distinction should be traced in depth later:

```text
AI/LLM responsibility:
  Extract or interpret research information.

Code responsibility:
  Validate data, match periods, normalize units, verify outcomes,
  calculate reliability, and calculate execution scores.
```

The frontend AI research page also contains product-level AI research UI and may contain mocked or keyword-routed responses. The exact active path should be confirmed during the frontend and AI phases.

---

## 13. Major Product Areas

```text
Dashboard
  frontend/src/pages/Dashboard.jsx
  Loads stock data, indices, news, and market status.

Stock Detail
  frontend/src/pages/StockDetail.jsx
  Loads a stock, company details, news, charts, and research information.

Watchlist
  frontend/src/pages/Watchlist.jsx
  Loads authenticated watchlists and associated live stock data.

Portfolio
  frontend/src/pages/Portfolio.jsx
  Uses portfolio API and backend portfolio routes/models.

Sector Intelligence
  frontend/src/pages/SectorIntelligence.jsx
  Uses live stocks plus sector-rotation data.

News
  frontend/src/pages/News.jsx
  Uses frontend news service and backend news route/service.

Earnings Intelligence
  frontend/src/pages/EarningsIntelligence.jsx
  Uses research, facts, promises, company history, and research-job endpoints.

AI Research
  frontend/src/pages/AIResearch.jsx
  Provides AI research interaction and connects to the chat/research architecture.

Financial Planning
  Goals, SIP, retirement, net-worth, and investment-basket pages.
```

---

## 14. Current Architecture Caveats

### Documentation versus source code

Some repository documentation describes an older architecture where Finnhub is primary and the frontend is largely mock-data driven. The current source entry point is more authoritative.

For current backend provider selection, inspect:

```text
backend/server.js
backend/providers/
backend/services/StockService.js
```

### Multiple implementations

The repository contains multiple implementations or generations for:

- Market-data providers
- WebSocket systems
- Stock controllers
- Server files
- Frontend mock and live data paths

The active runtime path should always be traced from:

```text
backend/server.js
frontend/src/App.js
```

### What cannot yet be confirmed in Phase 1

The following require deeper tracing in later phases:

- Exact implementation of every frontend token-storage detail
- Exact active frontend WebSocket consumer for each page
- Complete AIResearch response path
- Every database relationship and write operation
- Complete request lifecycle for each user action
- Exact production deployment wiring

---

## 15. Initial Learning Order

```text
Level 1   Project architecture
Level 2   Frontend entry point and routing
Level 3   Frontend API services and request flow
Level 4   Backend server and route mounting
Level 5   Backend services and providers
Level 6   MongoDB models and Redis cache
Level 7   Authentication and user-scoped data
Level 8   Stock-market data
Level 9   News and sector intelligence
Level 10  Earnings Intelligence
Level 11  Document Research Pipeline
Level 12  AI, promises, and verification
Level 13  Reliability and execution score
Level 14  Testing
Level 15  Deployment
```

The next walkthrough phase should begin with the actual folders and important files, starting from the entry points identified above.

---

## Phase 1 Checkpoint

You should now be able to explain this basic chain:

```text
User clicks a feature
    |
    v
React page in frontend/src/pages/
    |
    v
Frontend API service in frontend/src/services/
    |
    v
Express route in backend/routes/
    |
    v
Controller or domain service
    |
    +--> MongoDB model
    +--> Redis cache
    +--> External market/news provider
    +--> Document research pipeline
    +--> OpenAI/LangGraph
    |
    v
JSON response
    |
    v
React state update
    |
    v
UI rendering
```

Phase 1 ends here. No line-by-line explanation or implementation changes are included.
