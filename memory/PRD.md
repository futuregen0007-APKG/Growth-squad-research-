# GrowthSquad Research Terminal — PRD

## Original Problem Statement
Build the foundational architecture and premium institutional UI system for **GrowthSquad Research Terminal** — an AI-powered financial research platform for Indian equity investors. Combine Bloomberg Terminal density, AlphaSense AI workflows, Koyfin modernity, FinChat conversational research, and TradingView visual cleanliness. Frontend-only MVP with mock data, optimised for ~110 Emergent credits.

## Architecture
- **Stack:** React 19 + React Router 7 + Tailwind CSS + Recharts + shadcn/ui + lucide-react + sonner
- **Theme:** Custom dark institutional palette (Archetype: Jewel & Luxury + Swiss High-Contrast)
  - bg `#060709`, panel `#0C0E12`, card `#111318`, border `#1E222A`
  - Gold accent `#D4AF37` (AI), Pos `#059669`, Neg `#DC2626`
- **Typography:** Cabinet Grotesk (display), IBM Plex Sans (body), JetBrains Mono (financial data)
- **Layout:** Fixed left sidebar (256px) + sticky topbar (56px) + market ticker + outlet
- **Data:** Single source `src/data/mockData.js` (indices, stocks, sectors, earnings, AI insights, news)

## User Personas
1. Indian retail investors (informational dashboards)
2. Equity researchers / sell-side analysts (research feed, AI lens)
3. Finance students (sector intelligence, earnings learning)
4. Long-term investors (watchlists, AI assistant)
5. Active traders (KPI tiles, top movers, real-time-like ticker)

## Core Static Requirements
- Dark institutional, premium fintech aesthetic
- Sidebar nav + Ctrl+K command palette
- Modular widgets: KPI tile, sparkline, sector heatmap, AI insight, research card, earnings card, stock table
- Mobile responsiveness via Sheet drawer
- All data mock; no backend, no auth

## What's Been Implemented (May 2026)
### v1.3 — Company Research + AI Assistant Enhancement (current iteration)
- ✅ **StockDetail.jsx — fully institutional research view** (substantial rewrite). New sections include:
  - Header with verdict pill (BUY/HOLD/SELL) + price + target with upside
  - Full-width **RatingPanel** (verdict, score 0-100, consensus target, analyst breakdown buy/hold/sell with stacked bar)
  - Right column: **Company Overview** (description, founded, HQ, employees, CEO, indices) + **Sector Positioning** (rank vs peers with metric breakdown) + **Valuation Overview** (P/E, P/B, EV/EBITDA, PEG, dividend yield each vs sector avg with cheaper/richer cue)
  - 4-tab analytics: **Financials** (revenue bar + EPS/ROE/ROCE table) · **Margins** (gross/EBITDA/net line chart) · **Debt Analysis** (D/E, IC, net cash, credit rating, current ratio, cash conversion) · **AI Outlook** (full thesis + Bull/Base/Bear cases with probability + key catalysts list)
  - **Earnings Highlights** strip — last 4 quarters with revenue/PAT YoY + beat/miss surprise pill
  - **SWOTGrid** — 4-quadrant institutional SWOT with severity-coded accents
  - **RiskFlagsList** — severity-coded (high/medium/low) risk cards with descriptions
  - **Management Commentary** — 3 quote cards with author, role, source, sentiment-coded border
  - **Peer Comparison** — 4 peer cards with price/change/mkt cap/PE
- ✅ Rich `COMPANY_RESEARCH` mock dataset for HAL + `getCompanyResearch` fallback generator that derives plausible data from any stock's metadata
- ✅ NEW reusable widgets: **RatingPanel**, **SWOTGrid**, **RiskFlagsList** (all in `/components/widgets/`)
- ✅ **AIResearch.jsx — categorized smart prompts**:
  - 10 prompt chips grouped by category (Earnings, Compare, Sector, Risk, Thesis) with colored category dots
  - 4 new mock replies: **compare** (HAL vs BEL table), **risksRailway** (4-risk map with mitigants), **defenceOrderBook** (B/B ratio table with top picks), **tataMotors** (full earnings synthesis)
  - Updated `pickReply` keyword routing for compare, vs, risks+railway, defence+best, tata+motors

### v1.2 — Dashboard Polish (current iteration)
- ✅ **Enhanced KPITile**: intraday Low/High range bar with glowing current-position marker; subtle radial accent on positive/negative; tighter typography rhythm
- ✅ **NEW MarketSentiment widget** — 3-tile row: (1) Market Breadth A/D ratio with 3-color stacked bar + 52W highs/lows, (2) AI Sentiment Index gauge (0–100) with gradient meter and PCR/VIX/Bull-Bear stats, (3) Institutional FII/DII flows with 1D/5D/1M cuts
- ✅ **NEW EarningsSnapshot strip** on dashboard — 4 upcoming Indian prints as compact cards with date pills, EPS/revenue estimates and AI 'what to watch' commentary
- ✅ **Refined Dashboard header** — "// Live Workspace · ● Market Open · Closes 15:30 IST" eyebrow row + gold-pilled "AI Synced 13:42 IST" status badge
- ✅ Mock data extended: `MARKET_BREADTH`, `SENTIMENT`, `INSTITUTIONAL_FLOWS`
- ✅ All changes additive — no routing or component-API breakage; lint clean

### v1.1 — Landing Page Extension (current iteration)
- ✅ **Routing change:** `/` now renders new premium Landing page (no Sidebar). `/dashboard` and all app routes preserved inside `Layout` — zero breakage.
- ✅ **14-section landing page** composed at `/app/frontend/src/pages/Landing.jsx`:
  1. Sticky LandingNav (glass blur on scroll, anchor links + Launch Terminal CTA + mobile drawer)
  2. Hero (headline, subhead, dual CTA, dashboard preview frame with live KPI tiles + AI insight, social proof)
  3. Market Intelligence stats strip (5,200+ stocks · 1.2M filings · 7 sectors · 24/7 AI)
  4. Dashboard Showcase (Bloomberg-style mock terminal with full KPI grid + heatmap + movers)
  5. Features Grid (8 capability cards with iconography & accent stripes)
  6. AI Workflow (3-stage pipeline: Ingest · Reason · Deliver with source tags)
  7. Sector Showcase (7 Indian sector cards with sparklines, market cap, leaders)
  8. Earnings Preview (live calendar mock + post-print AI lens)
  9. AI Assistant Preview (chat-style mockup with formatted markdown reply)
  10. Why GrowthSquad (8-row comparison table vs generic stock apps)
  11. Institutional Benefits (6 persona cards: Analysts, Researchers, PMs, Students, Citations, Indian Hours)
  12. Testimonials (3 placeholder Indian-analyst quotes with monogram avatars)
  13. CTA Banner (final conversion CTA with gold wash)
  14. Premium Footer (4 link columns, social icons, SEBI compliance, disclaimer)
- ✅ Reused existing widgets: KPITile, AIInsightCard, SectorHeatmap, Sparkline, BrandLogo
- ✅ Deep section linking via anchors (#dashboard-showcase, #ai-workflow, #sector-showcase, #earnings-preview, #why-growthsquad)
- ✅ Full data-testid coverage on all interactive landing elements
- ✅ Fully responsive (mobile drawer, single-col stack at <lg)

### v1.0 — Foundation MVP
- ✅ Tailwind theme + custom palette (`gs-*` tokens)
- ✅ Fonts loaded from Fontshare + Google Fonts
- ✅ GS monogram brand logo (CSS-only, gold accents, corner ticks)
- ✅ Institutional left sidebar — workspace nav + 7 sectors with live-style change %
- ✅ Top bar — universal search, AI button, clock, mobile menu toggle
- ✅ Cmd+K Command Palette (shadcn Command + Dialog) with sr-only DialogTitle for a11y
- ✅ Mobile drawer (shadcn Sheet) with sr-only SheetTitle for a11y
- ✅ Marquee market ticker (CSS keyframe scroll)
- ✅ **Dashboard** page — 6 KPI tiles, Nifty intraday chart, AI insight cards, sector heatmap (Recharts Treemap), top gainers/losers, research feed, news feed
- ✅ **Watchlist** page — 4 thematic baskets, summary tiles, filterable table with sparklines
- ✅ **Sector Intelligence** page — 7 Indian sectors heatmap + AI narrative + constituents table + sector snapshot
- ✅ **Earnings Intelligence** page — calendar with upcoming/reported tabs, AI commentary
- ✅ **AI Research Assistant** page — chat UI with prompt suggestions, recent threads, mocked keyword-aware replies, markdown formatting (headings, bullets, ticker highlight, italics)
- ✅ **Stock Detail** page — header (price, change, P/E, mkt cap), price area chart with timeframe pills, Financials/Margins/AI Lens tabs, key metrics (filtered), peers, news
- ✅ Reusable widgets: BrandLogo, ChangeBadge, Sparkline, KPITile, MarketTicker, AIInsightCard, SectorHeatmap, EarningsCard, ResearchCard, StockTable
- ✅ Sonner toaster with dark theme
- ✅ data-testid coverage on all interactive elements
- ✅ Testing agent: 100% frontend pass rate

## Prioritized Backlog
### P1 (next phase candidates)
- Real WebSocket-backed live ticker (Alpha Vantage / Zerodha Kite Connect)
- Persist watchlists in MongoDB (FastAPI backend)
- AI Research Assistant powered by Emergent LLM Key (Claude Sonnet / GPT) instead of mocked replies
- Authentication (Emergent Google OAuth)
- Save / export research notes (PDF, Markdown)

### P2
- Real earnings calendar via NSE / BSE feed
- News integration (Reuters / Bloomberg / Mint API)
- Portfolio tracking and P&L analytics
- Sector deep-dive with management commentary NLP
- Custom AI prompt templates for analysts
- Admin ingestion pipeline for filings & investor presentations

### P3 (revenue/growth)
- Tiered subscriptions (Free / Pro / Enterprise) via Stripe
- Team workspaces with shared watchlists / annotations
- Public landing page + waitlist + referral program
- Mobile native app (React Native)

## Next Action Items
- Decide if user wants to add a backend layer next (auth + persistence)
- Optional: hook AI Research to real LLM via Emergent LLM Key
- Optional: integrate live data feed (Alpha Vantage / NSE) for at least Nifty + Sensex
