import { Link } from "react-router-dom";
import {
  Twitter,
  Linkedin,
  Github,
  Youtube,
  Mail,
  ArrowUpRight,
} from "lucide-react";
import BrandLogo from "../widgets/BrandLogo";

const LINK_GROUPS = [
  {
    title: "Product",
    links: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Watchlist", href: "/watchlist" },
      { label: "Sector Intelligence", href: "/sectors" },
      { label: "Earnings Intelligence", href: "/earnings" },
      { label: "AI Research", href: "/ai-research" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Methodology", href: "#" },
      { label: "Data Sources", href: "#" },
      { label: "Changelog", href: "#" },
      { label: "Glossary", href: "#" },
      { label: "Status", href: "#" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Investors", href: "#" },
      { label: "Press", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "#" },
      { label: "Privacy", href: "#" },
      { label: "Disclosures", href: "#" },
      { label: "Compliance", href: "#" },
      { label: "Risk Disclaimer", href: "#" },
    ],
  },
];

export default function LandingFooter() {
  return (
    <footer
      className="relative bg-gs-panel/40 border-t border-gs-border pt-16 pb-10"
      data-testid="landing-footer"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-12 gap-8">
          {/* Brand block */}
          <div className="col-span-12 lg:col-span-4">
            <BrandLogo />
            <p className="text-[13px] text-gs-textMuted mt-4 leading-relaxed max-w-sm">
              The institutional-grade AI research terminal — purpose-built for Indian
              equity investors, analysts and researchers.
            </p>
            <div className="mt-5 flex items-center gap-2">
              {[Twitter, Linkedin, Github, Youtube, Mail].map((Icon, i) => (
                <a
                  key={i}
                  href="#"
                  className="w-9 h-9 grid place-items-center rounded-sm bg-gs-card border border-gs-border text-gs-textMuted hover:text-gs-gold hover:border-gs-gold/40 transition-colors"
                  aria-label="social"
                >
                  <Icon className="w-3.5 h-3.5" />
                </a>
              ))}
            </div>
            <div className="mt-6 inline-flex items-center gap-2 bg-gs-card border border-gs-border rounded-sm px-3 py-2">
              <span className="w-1.5 h-1.5 rounded-full bg-gs-pos animate-pulse-dot" />
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-textMuted">
                Made in India · For India
              </span>
            </div>
          </div>

          {/* Link groups */}
          {LINK_GROUPS.map((g) => (
            <div key={g.title} className="col-span-6 sm:col-span-3 lg:col-span-2">
              <div className="gs-label mb-3">{g.title}</div>
              <ul className="space-y-2">
                {g.links.map((l) =>
                  l.href.startsWith("/") ? (
                    <li key={l.label}>
                      <Link
                        to={l.href}
                        className="text-[12.5px] text-gs-textMuted hover:text-gs-gold transition-colors flex items-center gap-1 group"
                      >
                        {l.label}
                        <ArrowUpRight className="w-3 h-3 opacity-0 -translate-y-0.5 group-hover:opacity-100 group-hover:translate-y-0 transition-all" />
                      </Link>
                    </li>
                  ) : (
                    <li key={l.label}>
                      <a
                        href={l.href}
                        className="text-[12.5px] text-gs-textMuted hover:text-gs-gold transition-colors"
                      >
                        {l.label}
                      </a>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom bar */}
        <div className="mt-14 pt-6 border-t border-gs-border flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-gs-textDim">
            © 2026 GrowthSquad Research Pvt Ltd · CIN: U65999MH2026PTC000000
          </div>
          <div className="flex items-center gap-3 text-[10.5px] font-mono uppercase tracking-[0.18em] text-gs-textDim">
            <span>SEBI Research Compliant · v1.4.0</span>
          </div>
        </div>

        <div className="mt-6 text-[10.5px] text-gs-textDim/80 leading-relaxed max-w-3xl">
          <span className="text-gs-textMuted font-semibold">Disclaimer:</span> All data on this
          platform is illustrative and for informational purposes only. GrowthSquad does not
          provide investment advice. Past performance is not indicative of future returns.
          Consult a SEBI-registered investment advisor before taking any investment decision.
        </div>
      </div>
    </footer>
  );
}
