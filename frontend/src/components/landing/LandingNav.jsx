import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Menu, X, ArrowUpRight } from "lucide-react";
import BrandLogo from "../widgets/BrandLogo";
import { useAuth } from "../../hooks/useAuth";

const NAV_LINKS = [
  { label: "Product", href: "#dashboard-showcase" },
  { label: "AI Workflow", href: "#ai-workflow" },
  { label: "Sectors", href: "#sector-showcase" },
  { label: "Earnings", href: "#earnings-preview" },
  { label: "Why GS", href: "#why-growthsquad" },
];

export default function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const { logout } = useAuth();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-gs-bg/85 backdrop-blur-xl border-b border-gs-border"
          : "bg-transparent border-b border-transparent"
      }`}
      data-testid="landing-nav"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
        <BrandLogo />

        <nav className="hidden lg:flex items-center gap-7">
          {NAV_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-[13px] text-gs-textMuted hover:text-gs-text transition-colors font-medium"
              data-testid={`nav-link-${l.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              logout();
              navigate("/login");
            }}
            className="hidden sm:inline-flex text-[12px] font-mono uppercase tracking-[0.18em] text-gs-textMuted hover:text-gs-text px-3 py-1.5"
            data-testid="nav-signin"
          >
            Sign in
          </button>
          <button
            onClick={() => navigate("/dashboard")}
            className="hidden sm:inline-flex items-center gap-1.5 bg-gs-gold text-gs-bg font-semibold text-[12.5px] px-4 py-2 rounded-sm hover:bg-gs-gold/90 transition-colors"
            data-testid="nav-launch-terminal"
          >
            Launch Terminal
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMobileOpen((o) => !o)}
            className="lg:hidden p-2 text-gs-textMuted hover:text-gs-text"
            aria-label="Toggle menu"
            data-testid="nav-mobile-toggle"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="lg:hidden border-t border-gs-border bg-gs-bg/95 backdrop-blur-xl">
          <nav className="px-6 py-4 flex flex-col gap-2">
            {NAV_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setMobileOpen(false)}
                className="text-[13px] text-gs-textMuted hover:text-gs-text py-2 border-b border-gs-border"
              >
                {l.label}
              </a>
            ))}
            <button
              onClick={() => {
                setMobileOpen(false);
                navigate("/dashboard");
              }}
              className="mt-3 inline-flex items-center justify-center gap-1.5 bg-gs-gold text-gs-bg font-semibold text-[12.5px] px-4 py-2.5 rounded-sm"
            >
              Launch Terminal
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </nav>
        </div>
      )}
    </header>
  );
}
