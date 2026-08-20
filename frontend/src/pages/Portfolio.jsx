import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import { TrendingUp, TrendingDown, Plus, Trash2, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { STOCKS, FALLBACK_STOCK_DATA } from "@/data/mockData";
import { fetchAllStocks } from "@/services/stockApi";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import analyzeRebalance from "@/hooks/useRebalancing";

const COLORS = ['#D4AF37', '#059669', '#DC2626', '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981'];

export default function Portfolio() {
  const navigate = useNavigate();
  const [stocks, setStocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [holdings, setHoldings] = useState([
    { id: 1, symbol: 'HAL', quantity: 50, avgPrice: 4200 },
    { id: 2, symbol: 'HDFCBANK', quantity: 100, avgPrice: 1600 },
    { id: 3, symbol: 'TATAPOWER', quantity: 200, avgPrice: 380 },
    { id: 4, symbol: 'LT', quantity: 30, avgPrice: 3400 },
  ]);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newHolding, setNewHolding] = useState({ symbol: '', quantity: '', avgPrice: '' });

  // Load stocks data
  useState(() => {
    const loadStocks = async () => {
      try {
        const data = await fetchAllStocks();
        setStocks(data);
      } catch (err) {
        console.error('Error loading stocks:', err);
      } finally {
        setLoading(false);
      }
    };
    loadStocks();
  });

  // Calculate portfolio metrics
  const portfolioData = useMemo(() => {
    const holdingsWithPrice = holdings.map(holding => {
      const stock = stocks.find(s => (s.symbol || s.ticker) === holding.symbol) || 
                     FALLBACK_STOCK_DATA[holding.symbol];
      const currentPrice = stock?.price || 0;
      const currentValue = currentPrice * holding.quantity;
      const investedValue = holding.avgPrice * holding.quantity;
      const pnl = currentValue - investedValue;
      const pnlPct = investedValue > 0 ? (pnl / investedValue) * 100 : 0;
      
      return {
        ...holding,
        currentPrice,
        currentValue,
        investedValue,
        pnl,
        pnlPct,
        name: stock?.name || holding.symbol,
        sector: stock?.sector || 'N/A',
      };
    });

    const totalInvested = holdingsWithPrice.reduce((sum, h) => sum + h.investedValue, 0);
    const totalValue = holdingsWithPrice.reduce((sum, h) => sum + h.currentValue, 0);
    const totalPnl = totalValue - totalInvested;
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    // Sector allocation for pie chart
    const sectorAllocation = holdingsWithPrice.reduce((acc, h) => {
      const sector = h.sector || 'Other';
      acc[sector] = (acc[sector] || 0) + h.currentValue;
      return acc;
    }, {});

    const pieData = Object.entries(sectorAllocation).map(([name, value]) => ({
      name,
      value,
    }));

    return {
      holdings: holdingsWithPrice,
      totalInvested,
      totalValue,
      totalPnl,
      totalPnlPct,
      pieData,
      topGainer: holdingsWithPrice.reduce((max, h) => h.pnlPct > (max?.pnlPct || -Infinity) ? h : max, null),
      topLoser: holdingsWithPrice.reduce((min, h) => h.pnlPct < (min?.pnlPct || Infinity) ? h : min, null),
    };
  }, [holdings, stocks]);

  const handleAddHolding = () => {
    if (newHolding.symbol && newHolding.quantity && newHolding.avgPrice) {
      setHoldings([...holdings, {
        id: Date.now(),
        symbol: newHolding.symbol.toUpperCase(),
        quantity: Number(newHolding.quantity),
        avgPrice: Number(newHolding.avgPrice),
      }]);
      setNewHolding({ symbol: '', quantity: '', avgPrice: '' });
      setAddDialogOpen(false);
    }
  };

  const handleRemoveHolding = (id) => {
    setHoldings(holdings.filter(h => h.id !== id));
  };

  const isPositive = portfolioData.totalPnl >= 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gs-textMuted">Loading portfolio...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-up" data-testid="portfolio-page">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Investment Tracker</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Portfolio
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Track your investments, performance, and allocation across sectors.
          </p>
        </div>
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="flex items-center gap-2 bg-gs-text text-gs-bg font-medium px-4 py-2 rounded-sm hover:bg-white/90 transition">
              <Plus className="w-4 h-4" />
              Add Holding
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-gs-card border-gs-border text-gs-text">
            <DialogHeader>
              <DialogTitle>Add New Holding</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Stock Symbol</label>
                <Select value={newHolding.symbol} onValueChange={(value) => setNewHolding({...newHolding, symbol: value})}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue placeholder="Select stock" />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    {STOCKS.map(stock => (
                      <SelectItem key={stock.ticker} value={stock.ticker}>
                        {stock.ticker} - {stock.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Quantity</label>
                <Input
                  type="number"
                  value={newHolding.quantity}
                  onChange={(e) => setNewHolding({...newHolding, quantity: e.target.value})}
                  placeholder="Number of shares"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Average Buy Price</label>
                <Input
                  type="number"
                  value={newHolding.avgPrice}
                  onChange={(e) => setNewHolding({...newHolding, avgPrice: e.target.value})}
                  placeholder="₹0.00"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <Button onClick={handleAddHolding} className="w-full bg-gs-gold text-gs-bg">
                Add to Portfolio
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="gs-card p-4">
          <div className="gs-label">Total Investment</div>
          <div className="font-display text-xl font-bold text-gs-text mt-1 tabular-nums">
            ₹{portfolioData.totalInvested.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Current Value</div>
          <div className="font-display text-xl font-bold text-gs-text mt-1 tabular-nums">
            ₹{portfolioData.totalValue.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">Total P&L</div>
          <div className={`font-display text-xl font-bold mt-1 tabular-nums ${isPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
            {isPositive ? '+' : ''}₹{portfolioData.totalPnl.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="gs-card p-4">
          <div className="gs-label">P&L %</div>
          <div className={`font-display text-xl font-bold mt-1 tabular-nums ${isPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
            {isPositive ? '+' : ''}{portfolioData.totalPnlPct.toFixed(2)}%
          </div>
        </div>
      </div>

      {/* Rebalancing Suggestions */}
      {(() => {
        const alerts = analyzeRebalance(portfolioData.holdings || []);
        if (!alerts || alerts.length === 0) return null;

        return (
          <Card className="bg-gs-card border-gs-border">
            <CardContent>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="font-display text-lg font-bold text-gs-text">Rebalancing Suggestions</div>
                  <div className="text-sm text-gs-textMuted">Signals to reduce concentration and diversify risk</div>
                </div>
              </div>

              <div className="space-y-2">
                {alerts.map(a => (
                  <div key={a.id} className="p-3 rounded-sm bg-gs-panel border border-gs-border">
                    <div className="text-sm text-gs-text">{a.message}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Main Content */}
      <div className="grid grid-cols-12 gap-4">
        {/* Holdings Table */}
        <div className="col-span-12 lg:col-span-8">
          <div className="gs-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-bold text-gs-text">Holdings</h3>
              <span className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                {portfolioData.holdings.length} stocks
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gs-border bg-gs-panel/50">
                    <th className="text-left px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Stock</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Qty</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Avg Price</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Current</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Invested</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Value</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">P&L</th>
                    <th className="text-right px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">P&L %</th>
                    <th className="text-center px-3 py-2 text-[12px] uppercase tracking-wider text-gs-textDim">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {portfolioData.holdings.map(holding => {
                    const holdingPositive = holding.pnl >= 0;
                    return (
                      <tr 
                        key={holding.id}
                        className="border-b border-gs-border last:border-b-0 hover:bg-gs-cardHover transition-colors cursor-pointer"
                        onClick={() => navigate(`/stock/${holding.symbol}`)}
                      >
                        <td className="px-3 py-3">
                          <div className="font-mono text-[13px] text-gs-text font-semibold tracking-wider">
                            {holding.symbol}
                          </div>
                          <div className="text-[11px] text-gs-textMuted">{holding.name}</div>
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-[13px] text-gs-text tabular-nums">
                          {holding.quantity}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-[13px] text-gs-text tabular-nums">
                          ₹{holding.avgPrice.toLocaleString('en-IN')}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-[13px] text-gs-text tabular-nums">
                          ₹{holding.currentPrice.toLocaleString('en-IN')}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-[13px] text-gs-text tabular-nums">
                          ₹{holding.investedValue.toLocaleString('en-IN')}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-[13px] text-gs-text tabular-nums">
                          ₹{holding.currentValue.toLocaleString('en-IN')}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className={`font-mono text-[13px] text-gs-text tabular-nums ${holdingPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
                            {holdingPositive ? '+' : ''}₹{holding.pnl.toLocaleString('en-IN')}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className={`font-mono text-[13px] text-gs-text tabular-nums ${holdingPositive ? 'text-gs-pos' : 'text-gs-neg'}`}>
                            {holdingPositive ? '+' : ''}{holding.pnlPct.toFixed(2)}%
                          </div>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveHolding(holding.id);
                            }}
                            className="p-1.5 text-gs-textDim hover:text-gs-neg transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Allocation & Top Movers */}
        <div className="col-span-12 lg:col-span-4 space-y-4">
          {/* Sector Allocation */}
          <div className="gs-card p-5">
            <h3 className="font-display font-bold text-gs-text mb-4">Sector Allocation</h3>
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={portfolioData.pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {portfolioData.pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: '#0C0E12', border: '1px solid #1E222A', borderRadius: '4px' }}
                    itemStyle={{ color: '#F8FAFC' }}
                  />
                  <Legend 
                    verticalAlign="bottom" 
                    height={36}
                    iconType="circle"
                    formatter={(value) => <span style={{ color: '#94A3B8', fontSize: '11px' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Top Gainer */}
          {portfolioData.topGainer && (
            <div className="gs-card p-4 border-l-2 border-l-gs-pos">
              <div className="flex items-center justify-between mb-2">
                <span className="gs-label">Top Gainer</span>
                <TrendingUp className="w-4 h-4 text-gs-pos" />
              </div>
              <div className="font-mono text-[13px] text-gs-text font-semibold tracking-wider">
                {portfolioData.topGainer.symbol}
              </div>
              <div className="text-[11px] text-gs-textMuted">{portfolioData.topGainer.name}</div>
              <div className="font-mono text-lg text-gs-pos mt-1 tabular-nums">
                +{portfolioData.topGainer.pnlPct.toFixed(2)}%
              </div>
            </div>
          )}

          {/* Top Loser */}
          {portfolioData.topLoser && (
            <div className="gs-card p-4 border-l-2 border-l-gs-neg">
              <div className="flex items-center justify-between mb-2">
                <span className="gs-label">Top Loser</span>
                <TrendingDown className="w-4 h-4 text-gs-neg" />
              </div>
              <div className="font-mono text-[13px] text-gs-text font-semibold tracking-wider">
                {portfolioData.topLoser.symbol}
              </div>
              <div className="text-[11px] text-gs-textMuted">{portfolioData.topLoser.name}</div>
              <div className="font-mono text-lg text-gs-neg mt-1 tabular-nums">
                {portfolioData.topLoser.pnlPct.toFixed(2)}%
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
