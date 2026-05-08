import { Sparkles, ArrowUpRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * AI Insight Card — gold left-accent stripe to denote AI-generated content.
 */
export default function AIInsightCard({ insight, onOpen }) {
  return (
    <div
      className="relative gs-card p-5 border-l-2 border-l-gs-gold hover:bg-gs-cardHover transition-colors cursor-pointer group"
      onClick={() => onOpen?.(insight)}
      data-testid={`ai-insight-${insight.id}`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-gs-gold">
            AI Insight
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-gs-textDim font-semibold">
            {insight.timeframe}
          </span>
          <div className="font-mono text-xs text-gs-text bg-gs-goldMuted border border-gs-gold/20 rounded-sm px-1.5 py-0.5">
            {insight.confidence}%
          </div>
        </div>
      </div>

      <h3 className="font-display text-[15px] font-bold text-gs-text leading-snug mb-2">
        {insight.title}
      </h3>
      <p className="text-[13px] text-gs-textMuted leading-relaxed line-clamp-3">
        {insight.summary}
      </p>

      <div className="mt-4 flex items-center justify-between">
        <div className="flex flex-wrap gap-1.5">
          {insight.tickers.slice(0, 4).map((t) => (
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
