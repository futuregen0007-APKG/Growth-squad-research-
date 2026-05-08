// GrowthSquad Research Terminal — Mock Indian Market Data
// All data is illustrative and meant for UI demonstration only.

export const MARKET_STATUS = {
  isOpen: true,
  session: "REGULAR",
  region: "NSE / BSE",
  closesAt: "15:30 IST",
  serverTime: "13:42:18 IST",
};

const mkSeries = (start, drift = 0.4, vol = 1.2, n = 30) => {
  let v = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * vol + drift / n;
    out.push({ x: i, v: +v.toFixed(2) });
  }
  return out;
};

export const INDICES = [
  {
    symbol: "NIFTY 50",
    label: "Nifty 50",
    value: 24732.85,
    change: 184.6,
    changePct: 0.75,
    series: mkSeries(24500, 8, 60),
  },
  {
    symbol: "SENSEX",
    label: "BSE Sensex",
    value: 81342.18,
    change: 612.4,
    changePct: 0.76,
    series: mkSeries(80700, 25, 200),
  },
  {
    symbol: "BANKNIFTY",
    label: "Bank Nifty",
    value: 53120.4,
    change: -245.7,
    changePct: -0.46,
    series: mkSeries(53400, -10, 110),
  },
  {
    symbol: "NIFTYIT",
    label: "Nifty IT",
    value: 41208.65,
    change: 522.1,
    changePct: 1.28,
    series: mkSeries(40700, 22, 90),
  },
  {
    symbol: "INDIAVIX",
    label: "India VIX",
    value: 13.42,
    change: -0.38,
    changePct: -2.75,
    series: mkSeries(14, -0.05, 0.3),
  },
  {
    symbol: "USDINR",
    label: "USD / INR",
    value: 84.21,
    change: 0.06,
    changePct: 0.07,
    series: mkSeries(84.1, 0.005, 0.05),
  },
];

export const SECTORS = [
  {
    id: "defence",
    name: "Defence",
    weight: 18,
    changePct: 2.42,
    marketCap: "₹12.4L Cr",
    headline: "Order book momentum + indigenous push fuels re-rating",
    leaders: ["HAL", "BEL", "BDL"],
  },
  {
    id: "railways",
    name: "Railways",
    weight: 14,
    changePct: 3.08,
    marketCap: "₹8.6L Cr",
    headline: "Vande Bharat & freight corridor capex tailwinds intact",
    leaders: ["IRCTC", "RVNL", "TITAGARH"],
  },
  {
    id: "green-energy",
    name: "Green Energy",
    weight: 16,
    changePct: 1.18,
    marketCap: "₹14.2L Cr",
    headline: "PLI 2.0 boosts solar manufacturing margins",
    leaders: ["ADANIGREEN", "TATAPOWER", "SUZLON"],
  },
  {
    id: "manufacturing",
    name: "Manufacturing",
    weight: 12,
    changePct: 0.62,
    marketCap: "₹9.8L Cr",
    headline: "Capex cycle revival; capital goods leading the charge",
    leaders: ["LT", "SIEMENS", "ABB"],
  },
  {
    id: "banking",
    name: "Banking",
    weight: 22,
    changePct: -0.52,
    marketCap: "₹38.1L Cr",
    headline: "NIM compression concerns weigh on private banks",
    leaders: ["HDFCBANK", "ICICIBANK", "SBIN"],
  },
  {
    id: "infrastructure",
    name: "Infrastructure",
    weight: 10,
    changePct: 1.84,
    marketCap: "₹6.2L Cr",
    headline: "Highway awarding pace picks up post-monsoon",
    leaders: ["GMRINFRA", "IRB", "NCC"],
  },
  {
    id: "healthcare",
    name: "Healthcare",
    weight: 8,
    changePct: -0.18,
    marketCap: "₹11.0L Cr",
    headline: "US generics price stability; CDMO order pipeline strong",
    leaders: ["SUNPHARMA", "DRREDDY", "DIVISLAB"],
  },
];

export const STOCKS = [
  // Defence
  { ticker: "HAL", name: "Hindustan Aeronautics", sector: "Defence", price: 4521.3, changePct: 2.84, marketCap: "₹3.02L Cr", pe: 32.1, series: mkSeries(4400, 6, 35) },
  { ticker: "BEL", name: "Bharat Electronics", sector: "Defence", price: 312.45, changePct: 1.92, marketCap: "₹2.28L Cr", pe: 49.7, series: mkSeries(305, 0.5, 4) },
  { ticker: "BDL", name: "Bharat Dynamics", sector: "Defence", price: 1182.6, changePct: 3.41, marketCap: "₹0.43L Cr", pe: 81.2, series: mkSeries(1140, 3, 18) },
  { ticker: "MAZDOCK", name: "Mazagon Dock Shipbuilders", sector: "Defence", price: 4480.2, changePct: 4.12, marketCap: "₹0.90L Cr", pe: 41.6, series: mkSeries(4300, 12, 45) },
  // Railways
  { ticker: "IRCTC", name: "IRCTC", sector: "Railways", price: 812.4, changePct: -0.78, marketCap: "₹0.65L Cr", pe: 51.4, series: mkSeries(820, -0.3, 6) },
  { ticker: "RVNL", name: "Rail Vikas Nigam", sector: "Railways", price: 432.1, changePct: 2.21, marketCap: "₹0.90L Cr", pe: 64.8, series: mkSeries(420, 0.6, 6) },
  { ticker: "RAILTEL", name: "RailTel Corporation", sector: "Railways", price: 421.6, changePct: 1.62, marketCap: "₹0.13L Cr", pe: 39.2, series: mkSeries(414, 0.3, 4) },
  { ticker: "TITAGARH", name: "Titagarh Rail Systems", sector: "Railways", price: 1120.4, changePct: 3.85, marketCap: "₹0.15L Cr", pe: 58.9, series: mkSeries(1075, 2, 14) },
  // Green Energy
  { ticker: "ADANIGREEN", name: "Adani Green Energy", sector: "Green Energy", price: 1232.9, changePct: 1.04, marketCap: "₹1.95L Cr", pe: 132.3, series: mkSeries(1220, 0.6, 12) },
  { ticker: "TATAPOWER", name: "Tata Power", sector: "Green Energy", price: 432.7, changePct: 0.92, marketCap: "₹1.38L Cr", pe: 33.5, series: mkSeries(428, 0.2, 4) },
  { ticker: "SUZLON", name: "Suzlon Energy", sector: "Green Energy", price: 71.2, changePct: 2.18, marketCap: "₹0.97L Cr", pe: 84.1, series: mkSeries(69, 0.1, 1.2) },
  { ticker: "NTPC", name: "NTPC Ltd", sector: "Green Energy", price: 412.6, changePct: -0.42, marketCap: "₹4.0L Cr", pe: 18.4, series: mkSeries(415, -0.1, 3) },
  // Manufacturing
  { ticker: "LT", name: "Larsen & Toubro", sector: "Manufacturing", price: 3641.2, changePct: 0.84, marketCap: "₹5.0L Cr", pe: 36.4, series: mkSeries(3600, 1.5, 22) },
  { ticker: "SIEMENS", name: "Siemens India", sector: "Manufacturing", price: 7220.8, changePct: 1.21, marketCap: "₹2.57L Cr", pe: 78.2, series: mkSeries(7100, 4, 50) },
  { ticker: "ABB", name: "ABB India", sector: "Manufacturing", price: 7842.5, changePct: -0.31, marketCap: "₹1.66L Cr", pe: 96.5, series: mkSeries(7900, -2, 60) },
  // Banking
  { ticker: "HDFCBANK", name: "HDFC Bank", sector: "Banking", price: 1718.4, changePct: -0.62, marketCap: "₹13.1L Cr", pe: 18.9, series: mkSeries(1730, -0.4, 10) },
  { ticker: "ICICIBANK", name: "ICICI Bank", sector: "Banking", price: 1284.6, changePct: -0.18, marketCap: "₹9.0L Cr", pe: 18.2, series: mkSeries(1290, -0.1, 7) },
  { ticker: "SBIN", name: "State Bank of India", sector: "Banking", price: 812.4, changePct: -0.92, marketCap: "₹7.25L Cr", pe: 10.4, series: mkSeries(820, -0.2, 6) },
  { ticker: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking", price: 1742.3, changePct: 0.41, marketCap: "₹3.46L Cr", pe: 21.8, series: mkSeries(1735, 0.2, 9) },
  // Infrastructure
  { ticker: "GMRINFRA", name: "GMR Airports Infra", sector: "Infrastructure", price: 92.4, changePct: 1.92, marketCap: "₹0.97L Cr", pe: 64.3, series: mkSeries(90, 0.05, 1) },
  { ticker: "IRB", name: "IRB Infrastructure", sector: "Infrastructure", price: 62.8, changePct: 2.42, marketCap: "₹0.38L Cr", pe: 41.6, series: mkSeries(61, 0.05, 0.8) },
  { ticker: "NCC", name: "NCC Limited", sector: "Infrastructure", price: 287.6, changePct: 1.18, marketCap: "₹0.18L Cr", pe: 22.1, series: mkSeries(284, 0.2, 3) },
  // Healthcare
  { ticker: "SUNPHARMA", name: "Sun Pharmaceuticals", sector: "Healthcare", price: 1842.6, changePct: 0.34, marketCap: "₹4.42L Cr", pe: 38.5, series: mkSeries(1835, 0.4, 12) },
  { ticker: "DRREDDY", name: "Dr. Reddy's Laboratories", sector: "Healthcare", price: 1262.4, changePct: -0.81, marketCap: "₹1.05L Cr", pe: 19.6, series: mkSeries(1275, -0.4, 9) },
  { ticker: "DIVISLAB", name: "Divi's Laboratories", sector: "Healthcare", price: 5921.4, changePct: 0.62, marketCap: "₹1.57L Cr", pe: 71.3, series: mkSeries(5880, 1.5, 30) },
  { ticker: "CIPLA", name: "Cipla Ltd", sector: "Healthcare", price: 1462.8, changePct: -0.42, marketCap: "₹1.18L Cr", pe: 28.4, series: mkSeries(1470, -0.2, 9) },
];

export const TOP_MOVERS = {
  gainers: STOCKS.filter((s) => s.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 6),
  losers: STOCKS.filter((s) => s.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, 6),
};

export const AI_INSIGHTS = [
  {
    id: "ai-1",
    title: "Defence sector exhibits sustained order-book accretion",
    confidence: 92,
    timeframe: "Q3 FY26",
    summary:
      "Cumulative order intake across HAL, BEL, BDL and MAZDOCK has expanded 38% YoY. Indigenisation policy and accelerated MoD clearances are structurally re-rating the basket.",
    tags: ["Bullish", "Sector", "Defence"],
    tickers: ["HAL", "BEL", "BDL", "MAZDOCK"],
  },
  {
    id: "ai-2",
    title: "Banking margin compression risk into FY27",
    confidence: 78,
    timeframe: "Next 2 quarters",
    summary:
      "Fed cut transmission, deposit cost stickiness and rural credit slowdown indicate NIM downside of 18–24 bps for top-3 private banks. Watch HDFCB and KOTAKBK commentary.",
    tags: ["Caution", "Macro", "Banking"],
    tickers: ["HDFCBANK", "ICICIBANK", "KOTAKBANK"],
  },
  {
    id: "ai-3",
    title: "Railways capex cycle: front-loaded budget execution",
    confidence: 88,
    timeframe: "FY26",
    summary:
      "Budget data implies 64% capex deployment in H1 vs 5-yr avg of 51%. RVNL, TITAGARH and IRCON L1 awards are tracking ahead of consensus.",
    tags: ["Bullish", "Government", "Railways"],
    tickers: ["RVNL", "TITAGARH", "RAILTEL"],
  },
  {
    id: "ai-4",
    title: "Green Energy: PLI 2.0 selective beneficiaries identified",
    confidence: 81,
    timeframe: "Long-term",
    summary:
      "Vertical integration in solar manufacturing favours backward-integrated names. Avoid pure EPC plays; prefer module + cell capacity owners.",
    tags: ["Selective", "Policy"],
    tickers: ["ADANIGREEN", "TATAPOWER"],
  },
];

export const RESEARCH_FEED = [
  {
    id: "r-1",
    type: "Equity Note",
    title: "HAL: LCA Mk1A delivery ramp + GE-414 JV — re-rating sustained",
    author: "GS Research • Aerospace",
    timestamp: "2h ago",
    rating: "BUY",
    target: "₹5,400",
    upside: "+19.4%",
    excerpt:
      "We see HAL as the cleanest play on India's defence indigenisation. FY26-28 EPS CAGR of 27% with order book at 4.2x revenue.",
    tickers: ["HAL"],
  },
  {
    id: "r-2",
    type: "Sector Initiation",
    title: "Indian Railways — entering a 5-year structural capex super-cycle",
    author: "GS Research • Industrials",
    timestamp: "5h ago",
    rating: "OVERWEIGHT",
    target: "—",
    upside: "Sector",
    excerpt:
      "Capex deployment of ₹2.65L Cr in FY26 (highest ever) creates a multi-year tailwind. Top picks: RVNL, TITAGARH, RAILTEL.",
    tickers: ["RVNL", "TITAGARH", "RAILTEL"],
  },
  {
    id: "r-3",
    type: "Earnings Preview",
    title: "HDFC Bank Q3FY26 preview: NIM cliff or stabilisation?",
    author: "GS Research • Financials",
    timestamp: "1d ago",
    rating: "NEUTRAL",
    target: "₹1,820",
    upside: "+5.9%",
    excerpt:
      "Consensus expects NIM at 3.42% (vs 3.46% Q2). We see merger synergies offsetting deposit cost pressure. Look for credit cost guidance.",
    tickers: ["HDFCBANK"],
  },
  {
    id: "r-4",
    type: "Thematic",
    title: "Defence exports — the next leg of the indigenisation story",
    author: "GS Research • Strategy",
    timestamp: "2d ago",
    rating: "THEMATIC",
    target: "—",
    upside: "Long-term",
    excerpt:
      "India's defence exports crossed ₹21,000 Cr in FY24 — a 31% CAGR. BEL, BDL and Solar Industries are key beneficiaries.",
    tickers: ["BEL", "BDL"],
  },
];

export const EARNINGS_CALENDAR = [
  {
    id: "e-1",
    ticker: "HDFCBANK",
    name: "HDFC Bank",
    sector: "Banking",
    date: "20 Jan",
    time: "Post-market",
    epsEst: 22.4,
    revenueEst: "₹118,200 Cr",
    surprise: null,
    aiNote:
      "Watch deposit growth, retail asset quality and NIM commentary — likely the most market-moving FY26 print.",
    status: "upcoming",
  },
  {
    id: "e-2",
    ticker: "RELIANCE",
    name: "Reliance Industries",
    sector: "Conglomerate",
    date: "22 Jan",
    time: "Post-market",
    epsEst: 28.1,
    revenueEst: "₹258,400 Cr",
    surprise: null,
    aiNote:
      "Jio ARPU progression and O2C margins are key. Retail EBITDA recovery signal critical for sustained re-rating.",
    status: "upcoming",
  },
  {
    id: "e-3",
    ticker: "TCS",
    name: "Tata Consultancy Services",
    sector: "IT",
    date: "15 Jan",
    time: "Post-market",
    epsEst: 31.2,
    revenueEst: "₹64,500 Cr",
    surprise: 2.4,
    aiNote:
      "BSNL ramp + BFSI deal pipeline expansion drove a clean beat. Constant-currency growth at 4.8% YoY surprised positively.",
    status: "reported",
  },
  {
    id: "e-4",
    ticker: "INFY",
    name: "Infosys",
    sector: "IT",
    date: "16 Jan",
    time: "Post-market",
    epsEst: 16.4,
    revenueEst: "₹41,800 Cr",
    surprise: -1.2,
    aiNote:
      "Mild miss on revenue; large-deal TCV at $3.1B is healthy. Margin guidance trimmed by 30 bps — manageable.",
    status: "reported",
  },
  {
    id: "e-5",
    ticker: "BAJFINANCE",
    name: "Bajaj Finance",
    sector: "NBFC",
    date: "24 Jan",
    time: "Post-market",
    epsEst: 102.4,
    revenueEst: "₹16,200 Cr",
    surprise: null,
    aiNote:
      "AUM growth resilient; key debate is unsecured lending stress. Watch credit cost guidance for H2.",
    status: "upcoming",
  },
  {
    id: "e-6",
    ticker: "LT",
    name: "Larsen & Toubro",
    sector: "Manufacturing",
    date: "28 Jan",
    time: "Post-market",
    epsEst: 38.6,
    revenueEst: "₹64,800 Cr",
    surprise: null,
    aiNote:
      "Order inflow guidance and Hyderabad metro execution are key. Defence subsidiary update likely to be a catalyst.",
    status: "upcoming",
  },
];

export const WATCHLISTS = [
  { id: "wl-defence", name: "Defence Leaders", count: 4, tickers: ["HAL", "BEL", "BDL", "MAZDOCK"] },
  { id: "wl-railways", name: "Railways Capex", count: 4, tickers: ["IRCTC", "RVNL", "RAILTEL", "TITAGARH"] },
  { id: "wl-banks", name: "Private Banks", count: 4, tickers: ["HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK"] },
  { id: "wl-green", name: "Green Energy Basket", count: 4, tickers: ["ADANIGREEN", "TATAPOWER", "SUZLON", "NTPC"] },
];

export const AI_CHAT_SUGGESTIONS = [
  "Summarise HAL's Q2 FY26 earnings call",
  "Compare margin trends: HDFCBANK vs ICICIBANK over 8 quarters",
  "Which Indian defence stocks have the strongest order book vs revenue ratio?",
  "Build a thesis on Indian railway capex theme",
  "Which banks face the highest NIM compression risk?",
];

export const AI_SEED_CONVERSATION = [
  {
    role: "user",
    content: "Build a thesis on Indian railway capex theme.",
  },
  {
    role: "ai",
    content: `**Indian Railway Capex Theme — Investment Thesis**

**Macro setup**
• FY26 budgetary capex of ₹2.65L Cr — highest ever, +12% YoY
• 5-year cumulative outlay of ₹13L Cr targeted across track, rolling stock, electrification
• Strategic shift from operating to capital expenditure — passenger amenity & freight modernisation

**Beneficiary mapping**
• Rolling stock: **TITAGARH**, **TEXRAIL** (Vande Bharat, metro coaches)
• EPC + Track: **RVNL**, **IRCON**, **KEC** (high-margin contracts L1)
• Digital + Telecom: **RAILTEL**, **HFCL** (KAVACH deployment)
• Tourism + Catering: **IRCTC** (asset-light, monopoly)

**Risk factors**
• Execution timelines and L1-to-revenue conversion lag (~6–9 quarters)
• Working capital pressure during peak capex deployment
• Government dependency — single-buyer concentration risk

**Verdict — OVERWEIGHT**
Order intake leading indicators support a 25–30% earnings CAGR over FY26–FY28 for the basket. Preferred picks: RVNL, TITAGARH, RAILTEL.

_Data referenced from public Railway Budget docs and company disclosures. Not investment advice._`,
  },
];

export const SECTOR_HEATMAP_DATA = SECTORS.map((s) => ({
  name: s.name,
  size: s.weight,
  changePct: s.changePct,
}));

export const FINANCIAL_HIGHLIGHTS = {
  HAL: {
    revenue: [
      { period: "FY22", value: 24618 },
      { period: "FY23", value: 26928 },
      { period: "FY24", value: 30381 },
      { period: "FY25E", value: 36500 },
      { period: "FY26E", value: 43800 },
    ],
    ebitdaMargin: [
      { period: "FY22", value: 25.4 },
      { period: "FY23", value: 27.8 },
      { period: "FY24", value: 28.6 },
      { period: "FY25E", value: 29.4 },
      { period: "FY26E", value: 30.2 },
    ],
    keyMetrics: {
      "Order Book": "₹1.42L Cr",
      "Book/Bill": "4.7x",
      "ROE FY24": "26.4%",
      "Net Cash": "₹38,400 Cr",
      "P/E FY26E": "26.8x",
      "EPS FY26E": "₹168.4",
    },
    peers: ["BEL", "BDL", "MAZDOCK"],
  },
};

export const NEWS_FEED = [
  {
    id: "n1",
    headline: "Defence Ministry clears ₹84,560 Cr capital acquisition proposals",
    source: "Economic Times",
    timestamp: "1h ago",
    sentiment: "positive",
    tickers: ["HAL", "BEL"],
  },
  {
    id: "n2",
    headline: "RBI flags rising unsecured retail credit stress at NBFCs",
    source: "Mint",
    timestamp: "2h ago",
    sentiment: "negative",
    tickers: ["BAJFINANCE"],
  },
  {
    id: "n3",
    headline: "Vande Bharat sleeper variant trial run in Q4 FY26 — Railways Min",
    source: "Business Standard",
    timestamp: "4h ago",
    sentiment: "positive",
    tickers: ["TITAGARH", "RVNL"],
  },
  {
    id: "n4",
    headline: "Solar module imports drop 38% YoY; PLI II beneficiaries gain",
    source: "Reuters",
    timestamp: "6h ago",
    sentiment: "positive",
    tickers: ["ADANIGREEN", "TATAPOWER"],
  },
  {
    id: "n5",
    headline: "INR weakens past 84.20 amid FII outflows; RBI on watch",
    source: "Bloomberg Quint",
    timestamp: "8h ago",
    sentiment: "neutral",
    tickers: [],
  },
];

export const MARKET_BREADTH = {
  advances: 1532,
  declines: 821,
  unchanged: 84,
  newHighs: 142,
  newLows: 38,
  exchange: "NSE",
};

export const SENTIMENT = {
  fgScore: 64,
  fgLabel: "Greed",
  bullPct: 62,
  bearPct: 38,
  putCallRatio: 0.84,
  vixDirection: "cooling",
  niftyOiBias: "Long",
  bankNiftyOiBias: "Neutral",
};

export const INSTITUTIONAL_FLOWS = {
  asOf: "5 Feb",
  fii: { "1D": 1248, "5D": 4380, "1M": 18420 },
  dii: { "1D": 980, "5D": 3720, "1M": 24180 },
};

// =====================================================================
// COMPANY RESEARCH — institutional equity research dataset
// Rich data for HAL; helper generates fallback for other tickers.
// =====================================================================

export const COMPANY_RESEARCH = {
  HAL: {
    overview: {
      description:
        "Hindustan Aeronautics Limited (HAL) is India's largest defence aerospace public-sector undertaking — designing and manufacturing fighter aircraft, helicopters, engines, avionics and accessories for the Indian Armed Forces and export markets.",
      founded: "1940",
      hq: "Bengaluru, Karnataka",
      employees: "~25,400",
      ceo: "C.B. Ananthakrishnan",
      indices: ["NIFTY 50", "NIFTY Defence", "BSE 100"],
      isin: "INE066F01020",
    },
    rating: {
      verdict: "BUY",
      score: 87,
      target: 5400,
      upside: 19.4,
      analystCount: 28,
      breakdown: { buy: 22, hold: 4, sell: 2 },
      sentiment: "Strong Bullish",
      conviction: "High",
      lastUpdated: "2 days ago",
    },
    profitability: [
      { period: "FY22", eps: 84.5, roe: 24.1, roce: 28.4 },
      { period: "FY23", eps: 96.7, roe: 25.6, roce: 29.8 },
      { period: "FY24", eps: 108.2, roe: 26.4, roce: 31.2 },
      { period: "FY25E", eps: 138.0, roe: 28.2, roce: 33.4 },
      { period: "FY26E", eps: 168.4, roe: 29.6, roce: 35.2 },
    ],
    margins: [
      { period: "FY22", gross: 35.2, ebitda: 25.4, net: 18.6 },
      { period: "FY23", gross: 36.4, ebitda: 27.8, net: 20.2 },
      { period: "FY24", gross: 37.8, ebitda: 28.6, net: 21.2 },
      { period: "FY25E", gross: 38.8, ebitda: 29.4, net: 22.0 },
      { period: "FY26E", gross: 39.6, ebitda: 30.2, net: 22.8 },
    ],
    debt: {
      debtEquity: 0.05,
      interestCoverage: 142,
      netCash: "₹38,400 Cr",
      creditRating: "AAA / Stable",
      currentRatio: 1.4,
      cashConversion: "84%",
    },
    earningsQuarters: [
      { period: "Q3 FY24", revenue: 7508, pat: 1261, revGrowth: 9.4, patGrowth: 3.0, surprise: 1.2 },
      { period: "Q4 FY24", revenue: 14769, pat: 4309, revGrowth: 18.4, patGrowth: 50.6, surprise: 4.8 },
      { period: "Q1 FY25", revenue: 4348, pat: 1437, revGrowth: 11.2, patGrowth: 76.8, surprise: 6.2 },
      { period: "Q2 FY25", revenue: 5976, pat: 1530, revGrowth: 6.0, patGrowth: 22.4, surprise: 3.4 },
    ],
    swot: {
      strengths: [
        "₹1.42L Cr order book — 4.7x book/bill",
        "Monopoly producer of LCA Tejas & Su-30 MKI HALOE",
        "Strong balance sheet — ₹38,400 Cr net cash",
        "Vertically integrated R&D + manufacturing",
      ],
      weaknesses: [
        "Single-customer (MoD) concentration risk",
        "Long execution cycles (6–10 yrs for fighter platforms)",
        "Public-sector wage structure caps margin upside",
      ],
      opportunities: [
        "Defence exports — ₹35,000 Cr addressable by FY30",
        "GE-414 JV opens engine manufacturing vertical",
        "LCA Mk2 + AMCA pipeline (~₹2L Cr potential)",
      ],
      threats: [
        "Geopolitical disruption to defence supply chain",
        "Private competition (Tata, L&T, Adani Defence)",
        "Budget-cycle order timing slippage risk",
      ],
    },
    risks: [
      {
        severity: "medium",
        title: "Execution Timeline",
        desc: "LCA Mk1A delivery slippage by 1–2 quarters could re-rate FY26 numbers 6–8% lower.",
      },
      {
        severity: "low",
        title: "Customer Concentration",
        desc: "MoD is 98% of FY24 revenue. Diversification via exports is the long-term mitigant.",
      },
      {
        severity: "medium",
        title: "Private Competition",
        desc: "Tata Advanced Systems & L&T Defence gradually winning sub-system tenders.",
      },
      {
        severity: "low",
        title: "Working Capital",
        desc: "Receivable days at 162 (vs 148 FY23) — typical for defence PSU but worth monitoring.",
      },
    ],
    valuation: {
      pe: 32.1,
      peSector: 38.4,
      pb: 7.8,
      pbSector: 6.4,
      evEbitda: 22.1,
      evEbitdaSector: 26.8,
      pegRatio: 0.85,
      dividendYield: 1.2,
      verdict:
        "Trading at ~16% P/E discount to sector despite superior growth & balance sheet — re-rating bias.",
    },
    aiOutlook: {
      verdict: "BUY",
      score: 87,
      conviction: "High",
      thesis:
        "HAL is the cleanest play on India's defence indigenisation. The combination of a 4.7x book/bill ratio, expanding margin profile from indigenous content, and a clean balance sheet warrants a premium multiple. Three structural drivers: (1) LCA Mk1A delivery ramp through FY27, (2) GE-414 JV opens the engine vertical, (3) defence exports inflection.",
      bullCase: { target: 6400, upside: 41.6, prob: 25 },
      baseCase: { target: 5400, upside: 19.4, prob: 55 },
      bearCase: { target: 3800, upside: -16.0, prob: 20 },
      catalysts: [
        "Q3 FY26 print + delivery commentary (Jan)",
        "GE-414 JV commercial milestones",
        "Budget FY27 defence capex trajectory (Feb)",
        "AMCA program timeline confirmation",
      ],
    },
    management: [
      {
        quote:
          "We have signed contracts worth ₹47,000 crore in FY24 and our visible order pipeline through FY28 stands at ₹2.1 lakh crore — the strongest in our 80-year history.",
        author: "C.B. Ananthakrishnan",
        role: "Chairman & MD",
        source: "Q2 FY26 Earnings Call",
        sentiment: "positive",
      },
      {
        quote:
          "LCA Mk1A deliveries will commence in Q4 FY26 with a target of 16 units in FY27 and full ramp to 24 units annually thereafter.",
        author: "C.B. Ananthakrishnan",
        role: "Chairman & MD",
        source: "Q2 FY26 Earnings Call",
        sentiment: "positive",
      },
      {
        quote:
          "Working capital intensity has stabilised. We expect inventory days to compress by 12–15 days over FY26 as platform deliveries ramp.",
        author: "Mihir Joshi",
        role: "CFO",
        source: "Q2 FY26 Earnings Call",
        sentiment: "neutral",
      },
    ],
    sectorPositioning: {
      rank: 1,
      total: 8,
      metrics: [
        { name: "Order Book", value: "₹1.42L Cr", rank: 1, sectorAvg: "₹38,000 Cr" },
        { name: "EBITDA Margin", value: "28.6%", rank: 1, sectorAvg: "21.4%" },
        { name: "ROE FY24", value: "26.4%", rank: 2, sectorAvg: "18.2%" },
        { name: "Net Cash", value: "₹38,400 Cr", rank: 1, sectorAvg: "₹4,200 Cr" },
      ],
    },
  },
};

// Fallback generator — produces plausible mock data driven by stock metadata
export function getCompanyResearch(stock) {
  if (COMPANY_RESEARCH[stock.ticker]) return COMPANY_RESEARCH[stock.ticker];

  const baseScore = Math.max(48, Math.min(92, 62 + Math.round(stock.changePct * 6)));
  const verdict =
    baseScore >= 75 ? "BUY" : baseScore >= 60 ? "ACCUMULATE" : baseScore >= 45 ? "HOLD" : "REDUCE";
  const target = +(stock.price * (1 + (baseScore - 60) / 100)).toFixed(0);
  const upside = +(((target - stock.price) / stock.price) * 100).toFixed(1);
  const baseEps = +(stock.price / (stock.pe || 25)).toFixed(2);

  return {
    overview: {
      description: `${stock.name} is a key player in India's ${stock.sector} sector, with a market capitalisation of ${stock.marketCap}. Operations span manufacturing, services and adjacent verticals serving institutional and retail customers across the country.`,
      founded: "—",
      hq: "India",
      employees: "—",
      ceo: "—",
      indices: [stock.sector === "Banking" ? "NIFTY BANK" : "NIFTY 500"],
      isin: "—",
    },
    rating: {
      verdict,
      score: baseScore,
      target,
      upside,
      analystCount: 18 + Math.floor(Math.random() * 12),
      breakdown: {
        buy: Math.round(baseScore / 5),
        hold: Math.round((100 - baseScore) / 8),
        sell: Math.max(0, Math.round((100 - baseScore) / 25)),
      },
      sentiment:
        baseScore >= 75 ? "Bullish" : baseScore >= 55 ? "Constructive" : "Cautious",
      conviction: baseScore >= 70 ? "High" : baseScore >= 55 ? "Medium" : "Low",
      lastUpdated: "1 day ago",
    },
    profitability: [
      { period: "FY22", eps: +(baseEps * 0.62).toFixed(2), roe: 14.2, roce: 16.8 },
      { period: "FY23", eps: +(baseEps * 0.74).toFixed(2), roe: 16.4, roce: 18.6 },
      { period: "FY24", eps: +(baseEps * 0.86).toFixed(2), roe: 18.2, roce: 20.4 },
      { period: "FY25E", eps: +(baseEps * 0.94).toFixed(2), roe: 19.6, roce: 21.8 },
      { period: "FY26E", eps: baseEps, roe: 20.8, roce: 23.0 },
    ],
    margins: [
      { period: "FY22", gross: 28.4, ebitda: 18.2, net: 12.4 },
      { period: "FY23", gross: 29.6, ebitda: 19.4, net: 13.2 },
      { period: "FY24", gross: 30.8, ebitda: 20.6, net: 14.0 },
      { period: "FY25E", gross: 31.4, ebitda: 21.4, net: 14.6 },
      { period: "FY26E", gross: 32.0, ebitda: 22.2, net: 15.2 },
    ],
    debt: {
      debtEquity: 0.42,
      interestCoverage: 8.4,
      netCash: "—",
      creditRating: "AA / Stable",
      currentRatio: 1.6,
      cashConversion: "72%",
    },
    earningsQuarters: [
      { period: "Q3 FY24", revenue: 8420, pat: 1180, revGrowth: 12.4, patGrowth: 18.6, surprise: 1.4 },
      { period: "Q4 FY24", revenue: 9240, pat: 1320, revGrowth: 14.2, patGrowth: 22.1, surprise: 2.8 },
      { period: "Q1 FY25", revenue: 8980, pat: 1280, revGrowth: 11.6, patGrowth: 16.4, surprise: -0.6 },
      { period: "Q2 FY25", revenue: 9620, pat: 1410, revGrowth: 13.8, patGrowth: 19.8, surprise: 1.8 },
    ],
    swot: {
      strengths: [
        `Established ${stock.sector} sector positioning`,
        "Growing institutional sponsorship",
        "Operating leverage upside on capacity utilisation",
      ],
      weaknesses: [
        "Cyclicality of sector demand",
        "Margin sensitivity to input cost inflation",
        "Concentration in core geographies",
      ],
      opportunities: [
        "Indian capex cycle revival tailwind",
        "Premiumisation + product-mix improvement",
        "Adjacencies into export markets",
      ],
      threats: [
        "Macro slowdown / rate cycle",
        "Regulatory & policy shifts",
        "Increased competitive intensity",
      ],
    },
    risks: [
      {
        severity: "medium",
        title: "Cyclicality",
        desc: `Earnings are exposed to ${stock.sector} cycle volatility — a meaningful slowdown could compress FY26 numbers 8–12%.`,
      },
      {
        severity: "low",
        title: "Working Capital",
        desc: "Receivable days have stabilised but remain a watch-item for cash conversion.",
      },
      {
        severity: "medium",
        title: "Competitive Intensity",
        desc: "Pricing pressure from organised peers may delay margin expansion timelines.",
      },
    ],
    valuation: {
      pe: stock.pe,
      peSector: +(stock.pe * 1.08).toFixed(1),
      pb: 3.4,
      pbSector: 3.8,
      evEbitda: 18.2,
      evEbitdaSector: 19.6,
      pegRatio: 1.1,
      dividendYield: 0.8,
      verdict: "Fairly priced relative to sector — earnings delivery is the key swing factor.",
    },
    aiOutlook: {
      verdict,
      score: baseScore,
      conviction: baseScore >= 70 ? "High" : "Medium",
      thesis: `${stock.name} sits within the ${stock.sector} basket which is currently exhibiting a ${stock.changePct >= 0 ? "constructive" : "defensive"} tone. Earnings trajectory and capital efficiency support a ${verdict.toLowerCase()} stance, anchored by sector tailwinds and disciplined execution. Watch quarterly print + management commentary as the primary near-term re-rating triggers.`,
      bullCase: { target: +(target * 1.18).toFixed(0), upside: +(upside + 18).toFixed(1), prob: 25 },
      baseCase: { target, upside, prob: 55 },
      bearCase: { target: +(target * 0.78).toFixed(0), upside: +(upside - 22).toFixed(1), prob: 20 },
      catalysts: [
        "Quarterly earnings print",
        "Sector-level capex / policy update",
        "Management guidance refresh",
        "Peer comp re-rating trigger",
      ],
    },
    management: [
      {
        quote: `We are seeing strong demand momentum across our core ${stock.sector.toLowerCase()} verticals, supported by both private capex and government-led initiatives.`,
        author: "Management",
        role: "CEO",
        source: "Most Recent Earnings Call",
        sentiment: "positive",
      },
      {
        quote:
          "Margin trajectory remains intact. Operating leverage from capacity utilisation will continue to drive profitability into FY26 and FY27.",
        author: "Management",
        role: "CFO",
        source: "Most Recent Earnings Call",
        sentiment: "positive",
      },
      {
        quote:
          "We're cautious on near-term input cost inflation but have hedging structures in place to protect margin downside.",
        author: "Management",
        role: "COO",
        source: "Most Recent Earnings Call",
        sentiment: "neutral",
      },
    ],
    sectorPositioning: {
      rank: 3,
      total: 8,
      metrics: [
        { name: "Revenue Growth", value: "14.2%", rank: 3, sectorAvg: "11.8%" },
        { name: "EBITDA Margin", value: "21.4%", rank: 4, sectorAvg: "20.6%" },
        { name: "ROE FY24", value: "18.2%", rank: 3, sectorAvg: "16.4%" },
        { name: "P/E (TTM)", value: `${stock.pe}x`, rank: "—", sectorAvg: `${(stock.pe * 1.08).toFixed(1)}x` },
      ],
    },
  };
}

// =====================================================================
// AI Research Assistant — categorized prompt chips
// =====================================================================
export const AI_PROMPT_CHIPS = [
  { category: "Earnings", text: "Analyse HAL Q2 FY26 results", color: "gold" },
  { category: "Earnings", text: "Summarise Tata Motors latest earnings", color: "gold" },
  { category: "Compare", text: "Compare BEL vs HAL on order book", color: "blue" },
  { category: "Compare", text: "HDFCBANK vs ICICIBANK margin trends", color: "blue" },
  { category: "Sector", text: "Best defence companies by order book", color: "green" },
  { category: "Sector", text: "Build a thesis on Indian railway capex theme", color: "green" },
  { category: "Risk", text: "Risks in Indian railway sector", color: "red" },
  { category: "Risk", text: "NIM compression risk for private banks", color: "red" },
  { category: "Thesis", text: "Why is Defence sector re-rating?", color: "gold" },
  { category: "Thesis", text: "Top 3 stocks for FY27 capex theme", color: "blue" },
];

