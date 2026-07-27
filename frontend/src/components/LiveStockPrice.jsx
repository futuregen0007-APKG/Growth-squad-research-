import { ArrowUpRight, ArrowDownRight, CircleDot } from 'lucide-react';
import { useMemo } from 'react';
import { useStockSocket } from '@/hooks/useStockSocket';
import AnimatedPrice from './widgets/AnimatedPrice';

export default function LiveStockPrice({ symbol, companyName, initialData }) {
  const { status, quote } = useStockSocket(symbol);
  const data = quote || initialData || {};

  const formattedPrice = useMemo(
    () => (data.price != null ? Number(data.price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '--'),
    [data.price]
  );

  const isPositive = (data.percentage || 0) >= 0;
  const changeSign = isPositive ? '+' : '';

  return (
    <div className="gs-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="text-sm text-gs-textDim">{companyName || symbol}</div>
          <AnimatedPrice 
            price={data.price} 
            change={data.change} 
            changePct={data.percentage} 
            size="xl" 
          />
        </div>
        <div className="text-right text-xs uppercase tracking-[0.2em] text-gs-textDim">
          LIVE
          <div className="mt-2 flex items-center justify-end gap-2">
            <CircleDot className={`h-3 w-3 ${status === 'Connected' ? 'text-gs-pos' : 'text-gs-neg'}`} />
            {status === 'Connected' ? 'Connected' : 'Disconnected'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm text-gs-textDim">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em]">Open</div>
          <div className="font-mono text-sm text-gs-text">₹{Number(data.open || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em]">High</div>
          <div className="font-mono text-sm text-gs-text">₹{Number(data.high || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em]">Low</div>
          <div className="font-mono text-sm text-gs-text">₹{Number(data.low || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em]">Volume</div>
          <div className="font-mono text-sm text-gs-text">{Number(data.volume || 0).toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div className="pt-3 border-t border-gs-border text-[11px] text-gs-textDim">
        Last Updated: {data.timestamp ? new Date(data.timestamp).toLocaleTimeString('en-IN') : '--'}
      </div>
    </div>
  );
}
