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
