import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Bell, Command, Globe, Settings, Menu } from "lucide-react";
import { useLocation } from "react-router-dom";
import BrandLogo from "../widgets/BrandLogo";
import SearchBar from "../SearchBar";

const PAGE_TITLES = {
  "/dashboard": { title: "Market Dashboard", subtitle: "Live overview of Indian equities" },
  "/watchlist": { title: "Watchlists", subtitle: "Curated baskets and tracking groups" },
  "/sectors": { title: "Sector Intelligence", subtitle: "Sectoral flows, leaders & narratives" },
  "/earnings": { title: "Earnings Intelligence", subtitle: "Calendar, surprises & AI commentary" },
  "/ai-research": { title: "AI Research Assistant", subtitle: "Conversational equity research" },
};

export default function TopBar({ onOpenCommand, onOpenMobileNav }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const isStockDetail = location.pathname.startsWith("/stock/");
  const meta = isStockDetail
    ? { title: "Equity Detail", subtitle: "AI-augmented stock terminal" }
    : PAGE_TITLES[location.pathname] || PAGE_TITLES["/dashboard"];

  const fmtTime = time.toLocaleTimeString("en-IN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <header
      className="h-14 fixed top-0 right-0 left-0 lg:left-64 border-b border-gs-border bg-gs-bg/80 backdrop-blur-xl z-30 flex items-center px-3 sm:px-6 gap-3 sm:gap-4"
      data-testid="topbar"
    >
      {/* Mobile menu */}
      <button
        onClick={onOpenMobileNav}
        className="lg:hidden p-2 -ml-2 text-gs-textMuted hover:text-gs-text"
        aria-label="Open navigation"
        data-testid="mobile-menu-toggle"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile brand */}
      <div className="lg:hidden">
        <BrandLogo compact />
      </div>

      {/* Page title */}
      <div className="hidden lg:flex flex-col leading-tight">
        <h1 className="font-display font-bold text-[15px] text-gs-text">{meta.title}</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-textDim">
          {meta.subtitle}
        </span>
      </div>

      {/* Search */}
      <div className="ml-auto lg:ml-6 flex-1 max-w-md">
        <SearchBar />
      </div>

      {/* Quick actions */}
      <div className="hidden md:flex items-center gap-1.5">
        <button
          onClick={() => navigate("/ai-research")}
          className="flex items-center gap-1.5 bg-gs-goldMuted border border-gs-gold/30 text-gs-gold rounded-sm px-2.5 py-1.5 text-[12px] hover:bg-gs-gold/20 transition-colors"
          data-testid="ai-quick-btn"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">Ask AI</span>
        </button>
        <button 
          onClick={() => navigate("/settings")}
          className="p-1.5 text-gs-textMuted hover:text-gs-text rounded-sm border border-transparent hover:border-gs-border"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button className="p-1.5 text-gs-textMuted hover:text-gs-text rounded-sm border border-transparent hover:border-gs-border">
          <Bell className="w-4 h-4" />
        </button>
        <button className="p-1.5 text-gs-textMuted hover:text-gs-text rounded-sm border border-transparent hover:border-gs-border">
          <Globe className="w-4 h-4" />
        </button>
      </div>

      {/* Clock */}
      <div className="hidden xl:flex flex-col items-end leading-tight pl-3 border-l border-gs-border">
        <span className="font-mono text-xs text-gs-text tabular-nums">{fmtTime}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">IST</span>
      </div>
    </header>
  );
}
