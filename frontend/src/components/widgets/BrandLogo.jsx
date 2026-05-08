import { Link } from "react-router-dom";

/**
 * GS Monogram Logo — institutional, sharp, gold accent on dark.
 * Used in sidebar header. Pure CSS, no image asset.
 */
export default function BrandLogo({ compact = false }) {
  return (
    <Link
      to="/dashboard"
      className="flex items-center gap-3 group"
      data-testid="brand-logo"
    >
      <div className="relative w-9 h-9 grid place-items-center bg-gs-card border border-gs-border rounded-sm overflow-hidden shadow-inset-hi">
        {/* corner ticks for institutional precision */}
        <span className="absolute top-0 left-0 w-1.5 h-1.5 border-l border-t border-gs-gold" />
        <span className="absolute top-0 right-0 w-1.5 h-1.5 border-r border-t border-gs-gold" />
        <span className="absolute bottom-0 left-0 w-1.5 h-1.5 border-l border-b border-gs-gold" />
        <span className="absolute bottom-0 right-0 w-1.5 h-1.5 border-r border-b border-gs-gold" />
        <span className="font-display font-extrabold text-[15px] tracking-tight text-gs-gold">
          GS
        </span>
      </div>
      {!compact && (
        <div className="flex flex-col leading-none">
          <span className="font-display font-bold text-[13px] tracking-tight text-gs-text">
            GrowthSquad
          </span>
          <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-gs-textDim mt-1">
            Research Terminal
          </span>
        </div>
      )}
    </Link>
  );
}
