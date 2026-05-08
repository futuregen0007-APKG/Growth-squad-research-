import { Shield, AlertTriangle, Lightbulb, Skull } from "lucide-react";

const QUADRANTS = [
  {
    key: "strengths",
    label: "Strengths",
    icon: Shield,
    accent: "border-l-gs-pos",
    iconColor: "text-gs-pos",
    bg: "bg-gs-posBg",
  },
  {
    key: "weaknesses",
    label: "Weaknesses",
    icon: AlertTriangle,
    accent: "border-l-gs-neg",
    iconColor: "text-gs-neg",
    bg: "bg-gs-negBg",
  },
  {
    key: "opportunities",
    label: "Opportunities",
    icon: Lightbulb,
    accent: "border-l-gs-gold",
    iconColor: "text-gs-gold",
    bg: "bg-gs-goldMuted",
  },
  {
    key: "threats",
    label: "Threats",
    icon: Skull,
    accent: "border-l-orange-500",
    iconColor: "text-orange-500",
    bg: "bg-orange-500/10",
  },
];

export default function SWOTGrid({ swot }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="swot-grid">
      {QUADRANTS.map((q) => {
        const Icon = q.icon;
        const items = swot[q.key] || [];
        return (
          <div
            key={q.key}
            className={`gs-card p-4 border-l-2 ${q.accent}`}
            data-testid={`swot-${q.key}`}
          >
            <div className="flex items-center justify-between mb-3 pb-3 border-b border-gs-border">
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 grid place-items-center rounded-sm ${q.bg}`}>
                  <Icon className={`w-3.5 h-3.5 ${q.iconColor}`} />
                </div>
                <h4 className="font-display font-bold text-gs-text text-[14px]">
                  {q.label}
                </h4>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                {items.length}
              </span>
            </div>
            <ul className="space-y-2">
              {items.map((it, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-[12.5px] text-gs-textMuted leading-relaxed"
                >
                  <span
                    className={`mt-1.5 w-1 h-1 rounded-full shrink-0 ${q.iconColor.replace("text-", "bg-")}`}
                  />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
