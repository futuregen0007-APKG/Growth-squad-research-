import { AlertOctagon, AlertTriangle, AlertCircle } from "lucide-react";

const SEVERITY = {
  high: {
    label: "High",
    icon: AlertOctagon,
    text: "text-gs-neg",
    bg: "bg-gs-negBg",
    border: "border-gs-neg/30",
    bar: "bg-gs-neg",
  },
  medium: {
    label: "Medium",
    icon: AlertTriangle,
    text: "text-gs-gold",
    bg: "bg-gs-goldMuted",
    border: "border-gs-gold/30",
    bar: "bg-gs-gold",
  },
  low: {
    label: "Low",
    icon: AlertCircle,
    text: "text-gs-pos",
    bg: "bg-gs-posBg",
    border: "border-gs-pos/30",
    bar: "bg-gs-pos",
  },
};

export default function RiskFlagsList({ risks = [] }) {
  return (
    <div className="space-y-2.5" data-testid="risk-flags">
      {risks.map((r, i) => {
        const s = SEVERITY[r.severity] || SEVERITY.medium;
        const Icon = s.icon;
        return (
          <div
            key={i}
            className={`flex gap-3 p-3.5 bg-gs-card border ${s.border} rounded-sm relative overflow-hidden`}
            data-testid={`risk-${i}`}
          >
            <span className={`absolute left-0 top-0 bottom-0 w-0.5 ${s.bar}`} />
            <div
              className={`w-8 h-8 grid place-items-center rounded-sm ${s.bg} shrink-0`}
            >
              <Icon className={`w-3.5 h-3.5 ${s.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <h5 className="font-display font-bold text-gs-text text-[13.5px]">
                  {r.title}
                </h5>
                <span
                  className={`font-mono text-[9.5px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm ${s.bg} ${s.text} border ${s.border}`}
                >
                  {s.label}
                </span>
              </div>
              <p className="text-[12px] text-gs-textMuted leading-relaxed">{r.desc}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
