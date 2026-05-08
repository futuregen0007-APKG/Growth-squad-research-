import { Area, AreaChart, ResponsiveContainer } from "recharts";

export default function Sparkline({ data, positive = true, height = 36, fill = true }) {
  const stroke = positive ? "#059669" : "#DC2626";
  const fillId = `gradient-${positive ? "p" : "n"}-${Math.random().toString(36).slice(2, 7)}`;
  return (
    <div style={{ height, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.32} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            fill={fill ? `url(#${fillId})` : "transparent"}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
