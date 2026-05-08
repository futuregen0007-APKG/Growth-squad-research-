import { ArrowUpRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const ratingClass = (rating) => {
  switch (rating) {
    case "BUY":
    case "OVERWEIGHT":
      return "bg-gs-posBg text-gs-pos border-gs-pos/30";
    case "SELL":
    case "UNDERWEIGHT":
      return "bg-gs-negBg text-gs-neg border-gs-neg/30";
    case "NEUTRAL":
      return "bg-gs-panel text-gs-textMuted border-gs-border";
    default:
      return "bg-gs-goldMuted text-gs-gold border-gs-gold/30";
  }
};

export default function ResearchCard({ item, onOpen }) {
  return (
    <div
      className="gs-card p-5 hover:bg-gs-cardHover transition-colors cursor-pointer group"
      onClick={() => onOpen?.(item)}
      data-testid={`research-card-${item.id}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <FileText className="w-3.5 h-3.5 text-gs-textDim" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-textDim">
            {item.type}
          </span>
        </div>
        <span
          className={`font-mono text-[10px] uppercase tracking-wider rounded-sm px-1.5 py-0.5 border ${ratingClass(
            item.rating,
          )}`}
        >
          {item.rating}
        </span>
      </div>

      <h3 className="font-display text-[15px] font-bold text-gs-text leading-snug mb-2">
        {item.title}
      </h3>
      <p className="text-[13px] text-gs-textMuted leading-relaxed line-clamp-2 mb-4">
        {item.excerpt}
      </p>

      <div className="flex items-center justify-between text-[11px]">
        <div className="text-gs-textDim">
          <span className="font-mono">{item.author}</span>
          <span className="mx-2 text-gs-border">•</span>
          <span>{item.timestamp}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="gs-label">Target</div>
            <div className="font-mono text-xs text-gs-text">{item.target}</div>
          </div>
          <div className="text-right">
            <div className="gs-label">Upside</div>
            <div className="font-mono text-xs text-gs-pos">{item.upside}</div>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-gs-border flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {item.tickers.map((t) => (
            <Badge
              key={t}
              variant="outline"
              className="font-mono text-[10px] tracking-wider rounded-sm border-gs-border bg-gs-panel text-gs-textMuted px-1.5 py-0"
            >
              {t}
            </Badge>
          ))}
        </div>
        <ArrowUpRight className="w-4 h-4 text-gs-textDim group-hover:text-gs-gold transition-colors" />
      </div>
    </div>
  );
}
