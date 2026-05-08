import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ChangeBadge({ value, suffix = "%", size = "sm", showIcon = true, className = "" }) {
  const isPos = value >= 0;
  const formatted = `${isPos ? "+" : ""}${Number(value).toFixed(2)}${suffix}`;
  const sizeClasses =
    size === "lg" ? "text-sm px-2 py-1" : size === "md" ? "text-xs px-2 py-0.5" : "text-[11px] px-1.5 py-[2px]";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono tabular-nums rounded-sm border",
        isPos
          ? "bg-gs-posBg text-gs-pos border-gs-pos/20"
          : "bg-gs-negBg text-gs-neg border-gs-neg/20",
        sizeClasses,
        className,
      )}
      data-testid={`change-badge-${isPos ? "pos" : "neg"}`}
    >
      {showIcon && (isPos ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      {formatted}
    </span>
  );
}
