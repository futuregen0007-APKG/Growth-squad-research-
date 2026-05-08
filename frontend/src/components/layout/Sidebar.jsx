import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Star,
  Layers,
  CalendarDays,
  Sparkles,
  TrendingUp,
  Building2,
  Train,
  Leaf,
  Factory,
  Landmark,
  HardHat,
  HeartPulse,
  CircleDot,
} from "lucide-react";
import BrandLogo from "../widgets/BrandLogo";
import { SECTORS } from "@/data/mockData";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, badge: null },
  { to: "/watchlist", label: "Watchlist", icon: Star, badge: "4" },
  { to: "/sectors", label: "Sector Intelligence", icon: Layers, badge: null },
  { to: "/earnings", label: "Earnings Intelligence", icon: CalendarDays, badge: "Q3" },
  { to: "/ai-research", label: "AI Research", icon: Sparkles, badge: "AI" },
  { to: "/stock/HAL", label: "Stock Detail", icon: TrendingUp, badge: null },
];

const SECTOR_ICON = {
  Defence: Building2,
  Railways: Train,
  "Green Energy": Leaf,
  Manufacturing: Factory,
  Banking: Landmark,
  Infrastructure: HardHat,
  Healthcare: HeartPulse,
};

export default function Sidebar() {
  return (
    <aside
      className="hidden lg:flex flex-col fixed left-0 top-0 bottom-0 w-64 bg-gs-panel border-r border-gs-border z-40"
      data-testid="sidebar"
    >
      {/* Brand */}
      <div className="h-14 flex items-center px-5 border-b border-gs-border">
        <BrandLogo />
      </div>

      {/* Status block */}
      <div className="px-5 py-3 border-b border-gs-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <CircleDot className="w-3 h-3 text-gs-pos animate-pulse-dot" />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gs-pos">
              Market Open
            </span>
          </div>
          <span className="font-mono text-[10px] text-gs-textDim">NSE • BSE</span>
        </div>
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[10px] text-gs-textDim uppercase tracking-wider">Closes</span>
          <span className="font-mono text-[11px] text-gs-textMuted">15:30 IST</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4">
        <div className="px-5 mb-2 gs-label">Workspace</div>
        <div className="px-2 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "group flex items-center justify-between gap-2 px-3 py-2 rounded-sm transition-all",
                    "text-[13px] text-gs-textMuted hover:text-gs-text hover:bg-gs-card",
                    isActive &&
                      "bg-gs-card text-gs-text border-l-2 border-l-gs-gold pl-[10px]",
                  )
                }
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4" />
                  {item.label}
                </span>
                {item.badge && (
                  <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-gs-bg border border-gs-border text-gs-textDim">
                    {item.badge}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>

        <div className="px-5 mt-6 mb-2 gs-label">Sectors</div>
        <div className="px-2 space-y-0.5">
          {SECTORS.map((s) => {
            const Icon = SECTOR_ICON[s.name] || Layers;
            const isPos = s.changePct >= 0;
            return (
              <NavLink
                key={s.id}
                to={`/sectors`}
                className="group flex items-center justify-between gap-2 px-3 py-1.5 rounded-sm hover:bg-gs-card transition-colors"
              >
                <span className="flex items-center gap-2.5 text-[12.5px] text-gs-textMuted group-hover:text-gs-text">
                  <Icon className="w-3.5 h-3.5" />
                  {s.name}
                </span>
                <span
                  className={`font-mono text-[10px] tabular-nums ${
                    isPos ? "text-gs-pos" : "text-gs-neg"
                  }`}
                >
                  {isPos ? "+" : ""}
                  {s.changePct.toFixed(2)}%
                </span>
              </NavLink>
            );
          })}
        </div>
      </nav>

      {/* User block */}
      <div className="border-t border-gs-border p-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-sm bg-gradient-to-br from-gs-gold to-amber-700 grid place-items-center text-gs-bg font-display font-bold text-xs">
            AR
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-gs-text font-medium truncate">Arjun Rao</div>
            <div className="text-[10px] text-gs-textDim font-mono uppercase tracking-wider">
              Pro Analyst
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
