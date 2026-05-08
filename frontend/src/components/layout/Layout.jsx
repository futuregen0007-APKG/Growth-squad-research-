import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import CommandPalette from "./CommandPalette";
import MarketTicker from "../widgets/MarketTicker";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Star,
  Layers,
  CalendarDays,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import BrandLogo from "../widgets/BrandLogo";

const MOBILE_NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/watchlist", label: "Watchlist", icon: Star },
  { to: "/sectors", label: "Sector Intelligence", icon: Layers },
  { to: "/earnings", label: "Earnings", icon: CalendarDays },
  { to: "/ai-research", label: "AI Research", icon: Sparkles },
  { to: "/stock/HAL", label: "Stock Detail", icon: TrendingUp },
];

export default function Layout() {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen bg-gs-bg text-gs-text">
      <Sidebar />
      <TopBar
        onOpenCommand={() => setCmdOpen(true)}
        onOpenMobileNav={() => setMobileOpen(true)}
      />
      <CommandPalette open={cmdOpen} setOpen={setCmdOpen} />

      {/* Mobile nav drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="left"
          className="w-72 bg-gs-panel border-r border-gs-border p-0 text-gs-text"
        >
          <div className="h-14 flex items-center px-5 border-b border-gs-border">
            <BrandLogo />
          </div>
          <nav className="p-2 space-y-0.5">
            {MOBILE_NAV.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-3 py-2.5 rounded-sm text-sm transition-colors ${
                      isActive
                        ? "bg-gs-card text-gs-text border-l-2 border-l-gs-gold"
                        : "text-gs-textMuted hover:text-gs-text hover:bg-gs-card"
                    }`
                  }
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </SheetContent>
      </Sheet>

      <div className="lg:ml-64 pt-14">
        <MarketTicker />
        <main
          className="p-4 sm:p-6 min-h-[calc(100vh-3.5rem-2.25rem)] grid-bg"
          data-testid={`page-${location.pathname.replace(/\//g, "-").replace(/^-/, "") || "root"}`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
