import { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';

export default function AnimatedPrice({ price, change, changePct, size = 'md' }) {
  const [prevPrice, setPrevPrice] = useState(price);
  const [flashDirection, setFlashDirection] = useState(null);

  useEffect(() => {
    if (price !== prevPrice) {
      setFlashDirection(price > prevPrice ? 'up' : 'down');
      setPrevPrice(price);
      
      // Clear flash after animation
      const timer = setTimeout(() => setFlashDirection(null), 1000);
      return () => clearTimeout(timer);
    }
  }, [price, prevPrice]);

  const isPositive = (changePct || 0) >= 0;
  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-2xl',
    xl: 'text-3xl',
  };

  const flashClass = flashDirection === 'up' ? 'animate-flash-green' : 
                     flashDirection === 'down' ? 'animate-flash-red' : '';

  return (
    <div className="flex items-center gap-2">
      <span className={`font-mono font-semibold tabular-nums ${sizeClasses[size]} ${flashClass}`}>
        ₹{price?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) || '--'}
      </span>
      <div className={`flex items-center gap-1 ${isPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
        {isPositive ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
        <span className="font-mono text-xs tabular-nums">
          {isPositive ? '+' : ''}{change?.toFixed(2) || 0} ({isPositive ? '+' : ''}{changePct?.toFixed(2) || 0}%)
        </span>
      </div>
    </div>
  );
}
