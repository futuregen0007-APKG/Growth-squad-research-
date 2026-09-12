import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Plus, Trash2, TrendingUp, Calendar, DollarSign, PieChart, ArrowRight, Edit, CheckCircle, Sparkles, ShieldAlert, RefreshCw, Zap, TrendingDown, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FINANCIAL_GOALS } from '@/data/financialProfileData';
import { getSectorAllocation } from '@/services/recommendationEngine';
import { getWatchlists, addWatchlistSymbol } from '@/services/watchlistApi';
import API_BASE from '@/config/api';
import { ResponsiveContainer, LineChart, Line, Tooltip } from 'recharts';

const REASON_CODE_LABELS = {
  PROVIDER_UNAVAILABLE: 'Product data provider unavailable',
  DATA_STALE: 'Latest product data is stale',
  NO_HARD_FILTER_MATCH: 'No product currently matches this risk profile',
  INSUFFICIENT_FUNDAMENTALS: 'Insufficient verified history for this category',
};

const STOCK_REJECTION_LABELS = {
  INSUFFICIENT_HISTORY: 'lack sufficient verified historical price data',
  AWAITING_FUNDAMENTALS: 'are awaiting verified fundamentals data',
  STALE_DATA: 'have only stale (though still verified) fundamentals data',
  RISK_MISMATCH: "don't fit the selected risk profile",
  HORIZON_MISMATCH: "don't fit this goal's time horizon",
  INVALID_METRICS: 'have invalid or incomplete identifying data',
  PROVIDER_UNAVAILABLE: 'could not be evaluated because a data provider was unavailable',
};

/** Builds the exact, backend-driven explanation for why the Direct Stocks bucket has no (or only some) eligible stocks -- never a generic placeholder once a real request has completed. */
const buildStockScreeningMessage = (screening, stockError) => {
  if (stockError) return `Stock screening failed: ${stockError}`;
  if (!screening) return 'Verified stock screening is unavailable.';
  const { universeCount, evaluatedCount, eligibleCount, missingDataReasons, providerStatus } = screening;
  const reasonClauses = (missingDataReasons || [])
    .filter((r) => r.count > 0)
    .map((r) => `${r.count} ${STOCK_REJECTION_LABELS[r.reasonCode] || r.reasonCode}`);
  const reasonText = reasonClauses.length ? ` Of ${evaluatedCount ?? universeCount ?? 0} stocks evaluated: ${reasonClauses.join('; ')}.` : '';
  if (screening.status === 'UNAVAILABLE') {
    return `No stock currently passes eligibility for this goal.${reasonText}${providerStatus === 'RATE_LIMITED' ? ' The fundamentals data provider is currently rate-limited.' : ''}`;
  }
  if (screening.status === 'PARTIAL') {
    return `Showing ${eligibleCount} eligible stock${eligibleCount === 1 ? '' : 's'} from a partially verified universe (${evaluatedCount ?? '?'} of ${universeCount ?? '?'} stocks evaluated).${reasonText}`;
  }
  return '';
};

const getPlanConfig = (goal, overrides = {}) => {
  const profile = JSON.parse(localStorage.getItem('financialProfile') || '{}');
  return {
    riskProfile: overrides.riskProfile || profile.riskProfile || profile.riskAppetite || goal.riskProfile || 'moderate',
    horizonYears: Math.max(1, Number(overrides.horizonYears ?? goal.horizonYears ?? Number(goal.targetYear) - new Date().getFullYear())),
    monthlyContribution: Math.max(0, Number(overrides.monthlyContribution ?? goal.monthlyContribution ?? 0)),
  };
};

const fetchAllocationPlan = async (goal, config = getPlanConfig(goal)) => {
  const params = new URLSearchParams({
    goal: JSON.stringify(goal),
    riskLevel: config.riskProfile,
    horizonYears: String(config.horizonYears),
    monthlyContribution: String(config.monthlyContribution),
  });
  const response = await fetch(`${API_BASE}/api/goals/${encodeURIComponent(goal.id)}/allocation-plan?${params.toString()}`);
  if (!response.ok) throw new Error('Allocation plan unavailable');
  const payload = await response.json();
  return payload?.data || null;
};

export default function Goals() {
  const navigate = useNavigate();
  const [goals, setGoals] = useState([]);
  const [allocationPlans, setAllocationPlans] = useState({});
  const [watchlistCache, setWatchlistCache] = useState(null);
  const [watchlistBusy, setWatchlistBusy] = useState({});
  const [watchlistAdded, setWatchlistAdded] = useState({});
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState(null);
  const [newGoal, setNewGoal] = useState({
    type: '',
    name: '',
    targetAmount: '',
    currentAmount: '',
    targetYear: '',
    monthlyContribution: '',
  });

  useEffect(() => {
    loadGoals();
  }, []);

  useEffect(() => {
    if (!goals.length) return;
    let cancelled = false;
    Promise.all(goals.map(async (goal) => {
      try {
        const plan = await fetchAllocationPlan(goal);
        if (!cancelled && plan) setAllocationPlans((current) => ({ ...current, [goal.id]: plan }));
      } catch (error) {
        // The card remains usable; the modal can retry the deterministic plan.
      }
    }));
    return () => { cancelled = true; };
  }, [goals]);

  const loadGoals = () => {
    const savedGoals = localStorage.getItem('financialGoals');
    if (savedGoals) {
      setGoals(JSON.parse(savedGoals));
    } else {
      // Load default goals from profile if available
      const profile = JSON.parse(localStorage.getItem('financialProfile') || '{}');
      if (profile.selectedGoals && profile.selectedGoals.length > 0) {
        const defaultGoals = profile.selectedGoals.map((goalId, index) => {
          const goalInfo = FINANCIAL_GOALS.find(g => g.id === goalId);
          return {
            id: `goal-${Date.now()}-${index}`,
            type: goalId,
            name: goalInfo?.label || 'Financial Goal',
            targetAmount: profile.targetAmount || 1000000,
            currentAmount: profile.existingInvestments || 0,
            targetYear: profile.targetYear || new Date().getFullYear() + 5,
            monthlyContribution: profile.monthlySavings || 10000,
            isPrimary: profile.primaryGoal === goalId,
            icon: goalInfo?.icon || '🎯',
          };
        });
        setGoals(defaultGoals);
        localStorage.setItem('financialGoals', JSON.stringify(defaultGoals));
      }
    }
  };

  const totalTarget = useMemo(() => goals.reduce((sum, g) => sum + (parseInt(g.targetAmount) || 0), 0), [goals]);
  const totalCurrent = useMemo(() => goals.reduce((sum, g) => sum + (parseInt(g.currentAmount) || 0), 0), [goals]);
  const overallProgress = useMemo(() => totalTarget > 0 ? (totalCurrent / totalTarget) * 100 : 0, [totalCurrent, totalTarget]);

  const handleAddGoal = () => {
    if (newGoal.type && newGoal.name && newGoal.targetAmount) {
      const goalInfo = FINANCIAL_GOALS.find(g => g.id === newGoal.type);
      const goal = {
        id: `goal-${Date.now()}`,
        ...newGoal,
        currentAmount: parseInt(newGoal.currentAmount) || 0,
        targetAmount: parseInt(newGoal.targetAmount),
        targetYear: parseInt(newGoal.targetYear),
        monthlyContribution: parseInt(newGoal.monthlyContribution) || 0,
        icon: goalInfo?.icon || '🎯',
        isPrimary: goals.length === 0,
      };
      setGoals([...goals, goal]);
      localStorage.setItem('financialGoals', JSON.stringify([...goals, goal]));
      setNewGoal({ type: '', name: '', targetAmount: '', currentAmount: '', targetYear: '', monthlyContribution: '' });
      setAddDialogOpen(false);
      toast.success('Goal Added', {
        description: `"${goal.name}" has been added to your goals.`,
      });
    }
  };

  const handleEditGoal = () => {
    if (editingGoal) {
      const updatedGoals = goals.map(g => g.id === editingGoal.id ? editingGoal : g);
      setGoals(updatedGoals);
      localStorage.setItem('financialGoals', JSON.stringify(updatedGoals));
      setEditDialogOpen(false);
      setEditingGoal(null);
      toast.success('Goal Updated', {
        description: `"${editingGoal.name}" has been updated.`,
      });
    }
  };

  const handleDeleteGoal = (goalId) => {
    const updatedGoals = goals.filter(g => g.id !== goalId);
    setGoals(updatedGoals);
    localStorage.setItem('financialGoals', JSON.stringify(updatedGoals));
    toast.success('Goal Deleted', {
      description: 'The goal has been removed.',
    });
  };

  const handleSetPrimary = (goalId) => {
    const updatedGoals = goals.map(g => ({ ...g, isPrimary: g.id === goalId }));
    setGoals(updatedGoals);
    localStorage.setItem('financialGoals', JSON.stringify(updatedGoals));
    toast.success('Primary Goal Set', {
      description: 'This is now your primary financial goal.',
    });
  };

  // Recommendations & Intelligence state
  const [recDialogOpen, setRecDialogOpen] = useState(false);
  const [recLoading, setRecLoading] = useState(false);
  const [rebalancingLoading, setRebalancingLoading] = useState(false);
  const [recResults, setRecResults] = useState([]);
  const [recGoal, setRecGoal] = useState(null);
  const [recAllocation, setRecAllocation] = useState([]);
  const [recProfile, setRecProfile] = useState({});
  const [recRebalance, setRecRebalance] = useState(null);
  const [recUniverseStats, setRecUniverseStats] = useState(null);
  const [recStockScreening, setRecStockScreening] = useState(null); // { status, universeCount, evaluatedCount, eligibleCount, rejectionCounts, missingDataReasons, providerStatus }
  const [recStockError, setRecStockError] = useState(null);
  const [recStockHasLoaded, setRecStockHasLoaded] = useState(false);
  const recStockRequestIdRef = useRef(0);
  const [recPlan, setRecPlan] = useState(null);
  const [recPlanLoading, setRecPlanLoading] = useState(false);
  const [recPlanError, setRecPlanError] = useState(null);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [recConfig, setRecConfig] = useState({ riskProfile: 'moderate', sector: '', horizonYears: 5, monthlyContribution: 0 });

  const refreshAllocationPlan = async (goal, config) => {
    setRecPlanLoading(true);
    setRecPlanError(null);
    const analysisGoal = {
      ...goal,
      riskProfile: config.riskProfile,
      horizonYears: Number(config.horizonYears),
      monthlyContribution: Number(config.monthlyContribution),
    };
    setRecGoal(analysisGoal);
    try {
      const plan = await fetchAllocationPlan(analysisGoal, config);
      setRecPlan(plan);
    } catch (err) {
      setRecPlan(null);
      setRecPlanError('Allocation planning is unavailable.');
    } finally {
      setRecPlanLoading(false);
    }
  };

  const loadEligibleStocks = async () => {
    if (!recGoal || recLoading) return; // guards against double-clicks while a request is already in flight
    const requestId = recStockRequestIdRef.current + 1;
    recStockRequestIdRef.current = requestId;

    setRecLoading(true);
    setRecStockError(null); // clear only the previous stock-screening error -- fund/ETF/gold/debt/liquid buckets are untouched
    const profile = JSON.parse(localStorage.getItem('financialProfile') || '{}');
    const params = new URLSearchParams({
      goal: JSON.stringify({ ...recGoal, sector: recConfig.sector, enableAiAnalysis: true }),
      profile: JSON.stringify({ ...profile, riskProfile: recConfig.riskProfile }),
    });
    try {
      const response = await fetch(`${API_BASE}/api/goals/${encodeURIComponent(recGoal.id)}/recommendations?${params.toString()}`);
      if (recStockRequestIdRef.current !== requestId) return; // a newer click superseded this response -- discard it
      if (!response.ok) throw new Error(`Eligible stock screening failed (HTTP ${response.status})`);
      const payload = await response.json();
      if (recStockRequestIdRef.current !== requestId) return;

      const data = payload?.data || {};
      // The backend's stable "Load Eligible Stocks" contract (task 5): each
      // item already carries symbol/companyName/score/goalFit/riskLevel/
      // metricsUsed/missingMetrics/dataAsOf/source/reasons. `recommendations`
      // (the richer, existing object shape used elsewhere on this page --
      // news, projections, detail dialog) is kept as the render source so
      // nothing else on this page regresses; `stocks` is read only for the
      // stable status/count fields.
      const recommendations = data.recommendations || [];
      const screening = {
        status: data.status || (recommendations.length ? 'AVAILABLE' : 'UNAVAILABLE'),
        universeCount: data.universeCount ?? null,
        evaluatedCount: data.evaluatedCount ?? null,
        eligibleCount: data.eligibleCount ?? recommendations.length,
        rejectionCounts: data.rejectionCounts || {},
        missingDataReasons: data.missingDataReasons || [],
        providerStatus: data.providerStatus || 'UNKNOWN',
        dataAsOf: data.dataAsOf || null,
      };

      setRecResults(recommendations);
      setRecAllocation(getSectorAllocation(recommendations));
      setRecRebalance(data.rebalanceAnalysis || null);
      setRecUniverseStats(data.universeStats || null);
      setRecStockScreening(screening);
      setRecPlan((currentPlan) => currentPlan ? {
        ...currentPlan,
        productBuckets: {
          ...currentPlan.productBuckets,
          stocks: { ...currentPlan.productBuckets.stocks, status: recommendations.length ? 'VERIFIED_ELIGIBLE_STOCKS' : 'AWAITING_FUNDAMENTALS', items: recommendations },
        },
      } : currentPlan);
    } catch (error) {
      if (recStockRequestIdRef.current !== requestId) return;
      setRecResults([]);
      setRecAllocation([]);
      setRecStockScreening(null);
      setRecStockError(error.message || 'Verified stock screening is unavailable.');
      toast.error('Verified stock screening is unavailable. Allocation remains available.');
    } finally {
      if (recStockRequestIdRef.current === requestId) {
        setRecStockHasLoaded(true);
        setRecLoading(false);
      }
    }
  };

  const handleTriggerRebalance = async () => {
    if (!recGoal) return;
    setRebalancingLoading(true);
    try {
      const profile = JSON.parse(localStorage.getItem('financialProfile') || '{}');
      const response = await fetch(`${API_BASE}/api/goals/${encodeURIComponent(recGoal.id)}/rebalance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: recGoal, profile }),
      });
      if (!response.ok) throw new Error('Rebalancing request failed');
      const payload = await response.json();
      if (payload.data?.rebalancedRecommendations) {
        setRecResults(payload.data.rebalancedRecommendations);
        setRecAllocation(getSectorAllocation(payload.data.rebalancedRecommendations));
        setRecRebalance(payload.data.rebalanceAnalysis);
        toast.success('Portfolio Rebalanced!', {
          description: `Allocations shifted to match ${payload.data.glidepath || 'target'} glidepath tier.`,
        });
      }
    } catch (error) {
      console.error('Rebalance error', error);
      toast.error('Failed to trigger automated rebalance.');
    } finally {
      setRebalancingLoading(false);
    }
  };

  const openRecommendations = async (goal) => {
    const profile = JSON.parse(localStorage.getItem('financialProfile') || '{}');
    const config = {
      riskProfile: profile.riskProfile || profile.riskAppetite || goal.riskProfile || 'moderate',
      sector: goal.sector || '',
      horizonYears: Math.max(1, Number(goal.targetYear) - new Date().getFullYear()),
      monthlyContribution: Number(goal.monthlyContribution) || 0,
    };
    setRecConfig(config);
    setRecDialogOpen(true);
    setSelectedDetail(null);
    setRecResults([]);
    setRecAllocation([]);
    setRecRebalance(null);
    setRecUniverseStats(null);
    await refreshAllocationPlan(goal, config);
  };

  const updateRecommendationConfig = async (key, value) => {
    const nextConfig = { ...recConfig, [key]: value };
    setRecConfig(nextConfig);
    if (recGoal) await refreshAllocationPlan(recGoal, nextConfig);
  };

  const openDetailedRecommendation = async (symbol) => {
    if (!recGoal || !symbol) return;
    const recommendation = recResults.find((item) => String(item.symbol || item.ticker).toUpperCase() === String(symbol).toUpperCase());
    setSelectedDetail({ goal: recGoal, stock: recommendation || null, ...recommendation });
    setDetailDialogOpen(true);
  };

  const ensureDefaultWatchlist = async () => {
    if (watchlistCache) return watchlistCache;
    const response = await getWatchlists();
    const primary = (response.data || [])[0];
    if (!primary) throw new Error('No watchlist is available for this account');
    const cache = { id: primary.id, symbols: new Set(primary.symbols || []) };
    setWatchlistCache(cache);
    return cache;
  };

  const handleAddToWatchlist = async (rawSymbol) => {
    // Normalize to match the backend's stored casing (Watchlist.symbols is
    // schema-uppercased), so the local duplicate check can't false-negative
    // on a case mismatch.
    const symbol = String(rawSymbol || '').trim().toUpperCase();
    if (!symbol || watchlistBusy[symbol]) return;
    setWatchlistBusy((prev) => ({ ...prev, [symbol]: true }));
    try {
      const cache = await ensureDefaultWatchlist();
      if (cache.symbols.has(symbol)) {
        setWatchlistAdded((prev) => ({ ...prev, [symbol]: true }));
        toast.error('Already in watchlist', { description: `${symbol} is already in your watchlist.` });
        return;
      }
      await addWatchlistSymbol(cache.id, symbol);
      cache.symbols.add(symbol);
      setWatchlistAdded((prev) => ({ ...prev, [symbol]: true }));
      toast.success('Added to watchlist', { description: `${symbol} has been added to your watchlist.` });
    } catch (error) {
      toast.error(error.message || `Could not add ${symbol} to watchlist`);
    } finally {
      setWatchlistBusy((prev) => ({ ...prev, [symbol]: false }));
    }
  };

  const getGoalStatus = (plan) => {
    const status = plan?.feasibility?.status;
    if (status === 'AHEAD') return { color: 'text-gs-pos', label: 'Ahead' };
    if (status === 'ON_TRACK') return { color: 'text-gs-pos', label: 'On Track' };
    if (status === 'BEHIND') return { color: 'text-gs-neg', label: 'Behind Schedule' };
    return { color: 'text-gs-textDim', label: 'Plan unavailable' };
  };

  return (
    <div className="space-y-6 animate-fade-up" data-testid="goals-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Financial Planning</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Goals
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Track your financial goals and monitor progress towards achieving them.
          </p>
        </div>
        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button className="flex items-center gap-2 bg-gs-gold text-gs-bg font-medium px-4 py-2 rounded-sm hover:bg-gs-gold/90 transition">
              <Plus className="w-4 h-4" />
              Add Goal
            </Button>
          </DialogTrigger>
          <DialogContent className="bg-gs-card border-gs-border text-gs-text">
            <DialogHeader>
              <DialogTitle>Add New Goal</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Goal Type</label>
                <Select value={newGoal.type} onValueChange={(value) => {
                  const goalInfo = FINANCIAL_GOALS.find(g => g.id === value);
                  setNewGoal({ ...newGoal, type: value, name: goalInfo?.label || '' });
                }}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue placeholder="Select goal type" />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    {FINANCIAL_GOALS.map(goal => (
                      <SelectItem key={goal.id} value={goal.id}>
                        {goal.icon} {goal.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Goal Name</label>
                <Input
                  value={newGoal.name}
                  onChange={(e) => setNewGoal({ ...newGoal, name: e.target.value })}
                  placeholder="e.g., Dream House"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Target Amount (₹)</label>
                <Input
                  type="number"
                  value={newGoal.targetAmount}
                  onChange={(e) => setNewGoal({ ...newGoal, targetAmount: e.target.value })}
                  placeholder="1000000"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Current Amount (₹)</label>
                <Input
                  type="number"
                  value={newGoal.currentAmount}
                  onChange={(e) => setNewGoal({ ...newGoal, currentAmount: e.target.value })}
                  placeholder="0"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Target Year</label>
                <Input
                  type="number"
                  value={newGoal.targetYear}
                  onChange={(e) => setNewGoal({ ...newGoal, targetYear: e.target.value })}
                  placeholder={new Date().getFullYear() + 5}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Monthly Contribution (₹)</label>
                <Input
                  type="number"
                  value={newGoal.monthlyContribution}
                  onChange={(e) => setNewGoal({ ...newGoal, monthlyContribution: e.target.value })}
                  placeholder="10000"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <Button onClick={handleAddGoal} className="w-full bg-gs-gold text-gs-bg">
                Add Goal
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Overall Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <Target className="w-4 h-4" />
              Total Target
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-display text-2xl font-bold text-gs-text">
              ₹{totalTarget.toLocaleString('en-IN')}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Current Value
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-display text-2xl font-bold text-gs-text">
              ₹{totalCurrent.toLocaleString('en-IN')}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <PieChart className="w-4 h-4" />
              Overall Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-display text-2xl font-bold text-gs-text">
              {overallProgress.toFixed(1)}%
            </div>
            <Progress value={overallProgress} className="mt-2 h-2" />
          </CardContent>
        </Card>
      </div>

      {/* Goals List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {goals.map(goal => {
          const progress = (parseInt(goal.currentAmount) / parseInt(goal.targetAmount)) * 100;
          const plan = allocationPlans[goal.id];
          const projected = plan?.feasibility?.projectedValue;
          const status = getGoalStatus(plan);
          const yearsRemaining = goal.targetYear - new Date().getFullYear();
          
          return (
            <Card key={goal.id} className={`bg-gs-card border-gs-border ${goal.isPrimary ? 'border-gs-gold' : ''}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{goal.icon}</span>
                    <div>
                      <CardTitle className="text-lg">{goal.name}</CardTitle>
                      {goal.isPrimary && (
                        <span className="text-xs text-gs-gold font-medium">Primary Goal</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setEditingGoal(goal);
                        setEditDialogOpen(true);
                      }}
                      className="p-1.5 text-gs-textDim hover:text-gs-text transition-colors"
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteGoal(goal.id)}
                      className="p-1.5 text-gs-textDim hover:text-gs-neg transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gs-textMuted">Progress</span>
                    <span className="text-gs-text font-medium">{progress.toFixed(1)}%</span>
                  </div>
                  <Progress value={progress} className="h-2" />
                  <div className="flex justify-between text-xs text-gs-textDim mt-1">
                    <span>₹{parseInt(goal.currentAmount).toLocaleString('en-IN')}</span>
                    <span>₹{parseInt(goal.targetAmount).toLocaleString('en-IN')}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gs-textDim" />
                    <div>
                      <div className="text-gs-textDim text-xs">Target Year</div>
                      <div className="text-gs-text font-medium">{goal.targetYear}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-gs-textDim" />
                    <div>
                      <div className="text-gs-textDim text-xs">Monthly SIP</div>
                      <div className="text-gs-text font-medium">₹{parseInt(goal.monthlyContribution).toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-gs-panel border border-gs-border">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-gs-textMuted">Projected Value</span>
                    <span className={`text-sm font-medium ${status.color}`}>{status.label}</span>
                  </div>
                  <div className="font-display text-lg font-bold text-gs-text">
                    {projected == null ? 'Plan unavailable' : `₹${projected.toLocaleString('en-IN')}`}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">
                    {plan ? `Planning estimate: ${plan.assumptions.expectedAnnualReturnPct}% expected annual return · ${plan.methodologyVersion}` : 'Planning estimate is loading'}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">Planning estimate, not guaranteed return</div>
                </div>

                {yearsRemaining > 0 && (
                  <div className="text-xs text-gs-textMuted">
                    {yearsRemaining} {yearsRemaining === 1 ? 'year' : 'years'} remaining
                  </div>
                )}

                <div className="space-y-2">
                  <Button
                    onClick={() => openRecommendations(goal)}
                    className="w-full bg-gs-gold text-gs-bg hover:bg-gs-gold/90 font-semibold"
                  >
                    Plan for {goal.name}
                  </Button>

                  {!goal.isPrimary && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSetPrimary(goal.id)}
                      className="w-full border-gs-border text-gs-text hover:bg-gs-cardHover"
                    >
                      <CheckCircle className="w-4 h-4 mr-2" />
                      Set as Primary Goal
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {goals.length === 0 && (
        <Card className="bg-gs-card border-gs-border">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Target className="w-12 h-12 text-gs-textDim mb-4" />
            <h3 className="font-display font-bold text-gs-text mb-2">No Goals Yet</h3>
            <p className="text-sm text-gs-textMuted mb-4">
              Start by adding your first financial goal to track your progress.
            </p>
            <Button onClick={() => setAddDialogOpen(true)} className="bg-gs-gold text-gs-bg">
              <Plus className="w-4 h-4 mr-2" />
              Add Your First Goal
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="bg-gs-card border-gs-border text-gs-text">
          <DialogHeader>
            <DialogTitle>Edit Goal</DialogTitle>
          </DialogHeader>
          {editingGoal && (
            <div className="space-y-4 mt-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Goal Name</label>
                <Input
                  value={editingGoal.name}
                  onChange={(e) => setEditingGoal({ ...editingGoal, name: e.target.value })}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Target Amount (₹)</label>
                <Input
                  type="number"
                  value={editingGoal.targetAmount}
                  onChange={(e) => setEditingGoal({ ...editingGoal, targetAmount: e.target.value })}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Current Amount (₹)</label>
                <Input
                  type="number"
                  value={editingGoal.currentAmount}
                  onChange={(e) => setEditingGoal({ ...editingGoal, currentAmount: e.target.value })}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Target Year</label>
                <Input
                  type="number"
                  value={editingGoal.targetYear}
                  onChange={(e) => setEditingGoal({ ...editingGoal, targetYear: e.target.value })}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-1 block">Monthly Contribution (₹)</label>
                <Input
                  type="number"
                  value={editingGoal.monthlyContribution}
                  onChange={(e) => setEditingGoal({ ...editingGoal, monthlyContribution: e.target.value })}
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <Button onClick={handleEditGoal} className="w-full bg-gs-gold text-gs-bg">
                Update Goal
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Recommendations Dialog */}
      <Dialog open={recDialogOpen} onOpenChange={setRecDialogOpen}>
        <DialogContent className="bg-gs-card border-gs-border text-gs-text w-[94vw] max-w-[1200px] h-[90vh] max-h-[850px] p-0 gap-0 overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0 border-b border-gs-border px-6 py-4 pr-12 bg-gs-card">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div>
                <DialogTitle className="text-xl">Plan for {recGoal?.name}</DialogTitle>
                <p className="text-xs text-gs-textDim leading-relaxed max-w-3xl mt-1">
                  Deterministic goal feasibility, allocation and glidepath planning. Verified stock screening is optional.
                </p>
              </div>
              {recUniverseStats?.dynamicScreenerActive && (
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-gs-gold bg-gs-gold/10 border border-gs-gold/30 px-2.5 py-1 rounded-sm">
                  <Zap className="w-3.5 h-3.5 text-gs-gold" />
                  <span>Screener Active: {recUniverseStats.screenedCount || 150}+ stocks (MCap ≥ {recUniverseStats.marketCapThreshold || '₹1,000 Cr+'})</span>
                </div>
              )}
            </div>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {/* Rebalance & Glidepath Alert Banner */}
            {recRebalance && (
              <div className={`p-4 border rounded-lg ${recRebalance.recommendedAction === 'REBALANCE_RECOMMENDED' ? 'bg-amber-950/20 border-amber-500/40' : 'bg-gs-panel border-gs-border'}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-gs-gold">Rebalancing Guidance</span>
                      <span className="text-xs font-medium text-gs-text px-2 py-0.5 bg-gs-bg border border-gs-border rounded">{recRebalance.glidepathTier} ({recRebalance.yearsRemaining}y remaining)</span>
                      {recRebalance.recommendedAction === 'REBALANCE_RECOMMENDED' && (
                        <span className="text-[11px] font-medium text-amber-400 bg-amber-950/60 border border-amber-700/60 px-2 py-0.5 rounded flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3" /> Rebalance Recommended ({recRebalance.driftPercentage}% drift)
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gs-textMuted mt-1">
                      Target Sector Mix: <span className="text-gs-text font-mono">Growth {recRebalance.targetMix?.growth}% · Core {recRebalance.targetMix?.core}% · Defensive {recRebalance.targetMix?.defensive}%</span>
                      {recRebalance.currentMix && (
                        <span className="ml-2 text-gs-textDim">(Current: Growth {recRebalance.currentMix.growth}% · Core {recRebalance.currentMix.core}% · Defensive {recRebalance.currentMix.defensive}%)</span>
                      )}
                    </div>
                    {recRebalance.reasons?.length > 0 && (
                      <ul className="text-xs text-gs-textDim list-disc pl-4 mt-1 space-y-0.5">
                        {recRebalance.reasons.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    )}
                  </div>
                  {recRebalance.recommendedAction === 'REBALANCE_RECOMMENDED' && (
                    <Button
                      size="sm"
                      onClick={handleTriggerRebalance}
                      disabled={rebalancingLoading}
                      className="bg-amber-500 hover:bg-amber-600 text-black font-semibold flex items-center gap-1.5 shrink-0"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${rebalancingLoading ? 'animate-spin' : ''}`} />
                      {rebalancingLoading ? 'Rebalancing...' : 'Rebalance Portfolio'}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Analysis Controls */}
            <div className="bg-gs-panel border border-gs-border p-4 space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="gs-label">Analysis controls</div>
                  <p className="text-xs text-gs-textDim mt-1">Changing risk, horizon or contribution recalculates the deterministic plan only.</p>
                </div>
                {recLoading && <span className="text-xs text-gs-gold flex items-center gap-1"><RefreshCw className="w-3 h-3 animate-spin" /> Re-analyzing universe...</span>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs text-gs-textMuted mb-1 block">Risk level</label>
                  <Select value={recConfig.riskProfile} onValueChange={(value) => updateRecommendationConfig('riskProfile', value)}>
                    <SelectTrigger className="bg-gs-bg border-gs-border h-9"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="conservative">Low</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                      <SelectItem value="aggressive">High</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-gs-textMuted mb-1 block">Sector</label>
                  <Select value={recConfig.sector || 'all'} onValueChange={(value) => updateRecommendationConfig('sector', value === 'all' ? '' : value)}>
                    <SelectTrigger className="bg-gs-bg border-gs-border h-9"><SelectValue placeholder="All sectors" /></SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="all">All sectors</SelectItem>
                      {['Banking', 'Defence', 'IT', 'Healthcare', 'Energy', 'Infrastructure', 'Auto', 'FMCG', 'Financial Services', 'Manufacturing', 'Consumer', 'Power'].map((sector) => <SelectItem key={sector} value={sector}>{sector}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs text-gs-textMuted mb-1 block">Horizon (years)</label>
                  <Input type="number" min="1" max="50" value={recConfig.horizonYears} onChange={(event) => setRecConfig({ ...recConfig, horizonYears: event.target.value })} onBlur={(event) => updateRecommendationConfig('horizonYears', Math.max(1, Number(event.target.value) || 1))} className="bg-gs-bg border-gs-border h-9" />
                </div>
                <div>
                  <label className="text-xs text-gs-textMuted mb-1 block">Monthly contribution (₹)</label>
                  <Input type="number" min="0" value={recConfig.monthlyContribution} onChange={(event) => setRecConfig({ ...recConfig, monthlyContribution: event.target.value })} onBlur={(event) => updateRecommendationConfig('monthlyContribution', Math.max(0, Number(event.target.value) || 0))} className="bg-gs-bg border-gs-border h-9" />
                </div>
              </div>
            </div>

            {recPlanLoading && <div className="text-sm text-gs-textDim py-4 text-center">Loading deterministic allocation plan...</div>}
            {recPlanError && <div className="text-sm text-amber-300 bg-amber-950/20 border border-amber-800/50 p-3">{recPlanError}</div>}
            {recPlan && (
              <>
                <div className="bg-gs-panel border border-gs-border p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="gs-label">Goal Feasibility</div>
                      <div className="text-lg font-semibold text-gs-text mt-1">{String(recPlan.feasibility?.status || 'INSUFFICIENT_INPUT').replace('_', ' ')}</div>
                    </div>
                    <div className="text-xs text-gs-textDim">Planning estimate, not guaranteed return</div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                    {[
                      ['Projected value', recPlan.feasibility?.projectedValue],
                      ['Required monthly', recPlan.feasibility?.requiredMonthlyContribution],
                      ['Current monthly', recPlan.feasibility?.currentMonthlyContribution],
                      ['Shortfall / surplus', recPlan.feasibility?.monthlyShortfallSurplus],
                      ['Funding ratio', recPlan.feasibility?.fundingRatio == null ? null : `${(recPlan.feasibility.fundingRatio * 100).toFixed(1)}%`],
                    ].map(([label, value]) => <div key={label} className="bg-gs-bg border border-gs-border p-2"><div className="text-gs-textDim">{label}</div><div className="font-mono text-gs-text mt-1">{value == null ? 'Unavailable' : typeof value === 'number' ? `₹${value.toLocaleString('en-IN')}` : value}</div></div>)}
                  </div>
                  <div className="text-xs text-gs-textDim">Expected annual return: <span className="text-gs-text font-mono">{recPlan.assumptions?.expectedAnnualReturnPct ?? 'Unavailable'}%</span> · Methodology: <span className="text-gs-text font-mono">{recPlan.methodologyVersion || 'Unavailable'}</span></div>
                </div>

                <div className="bg-gs-panel border border-gs-border p-4 space-y-3">
                  <div className="gs-label">Asset Allocation and Monthly Split</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
                    {[
                      ['Mutual Funds', 'equityMutualFundsPct', 'equityMutualFundsAmount'],
                      ['Direct Stocks', 'directEquityPct', 'directEquityAmount'],
                      ['Debt', 'debtPct', 'debtAmount'],
                      ['Gold', 'goldPct', 'goldAmount'],
                      ['Liquid', 'liquidPct', 'liquidAmount'],
                    ].map(([label, pctKey, amountKey]) => <div key={label} className="bg-gs-bg border border-gs-border p-3"><div className="text-gs-textDim">{label}</div><div className="font-mono text-gs-text text-lg mt-1">{recPlan.allocation?.[pctKey] ?? 0}%</div><div className="text-gs-textMuted mt-1">₹{Number(recPlan.monthlySplit?.[amountKey] || 0).toLocaleString('en-IN')} / month</div></div>)}
                  </div>
                </div>

                <div className="bg-gs-panel border border-gs-border p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2"><div className="gs-label">Glidepath</div><div className="text-xs text-gs-textDim">Equity reduces as the goal approaches</div></div>
                  <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead className="text-gs-textDim border-b border-gs-border"><tr><th className="py-2 pr-3">Year</th><th className="py-2 pr-3">Remaining</th><th className="py-2 pr-3">MF equity</th><th className="py-2 pr-3">Direct equity</th><th className="py-2 pr-3">Debt</th><th className="py-2 pr-3">Gold</th><th className="py-2">Liquid</th></tr></thead><tbody>{(recPlan.glidepath || []).map((row) => <tr key={row.year} className="border-b border-gs-border/60"><td className="py-2 pr-3">{row.year}</td><td className="py-2 pr-3">{row.yearsRemaining}y</td><td className="py-2 pr-3">{row.equityMutualFundsPct}%</td><td className="py-2 pr-3">{row.directEquityPct}%</td><td className="py-2 pr-3">{row.debtPct}%</td><td className="py-2 pr-3">{row.goldPct}%</td><td className="py-2">{row.liquidPct}%</td></tr>)}</tbody></table></div>
                </div>

                <div className="bg-gs-panel border border-gs-border p-4 space-y-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="gs-label">Product Recommendations</div>
                    {recPlan.datasetAsOf && <div className="text-[11px] text-gs-textDim">Dataset as of {new Date(recPlan.datasetAsOf).toLocaleDateString('en-IN')} · Confidence: {recPlan.confidence || 'N/A'}</div>}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
                    {Object.entries(recPlan.productBuckets || {}).map(([key, bucket]) => (
                      <div key={key} className="bg-gs-bg border border-gs-border p-3">
                        <div className="text-gs-text capitalize">{key === 'stocks' ? 'Direct Stocks' : key === 'mutualFunds' ? 'Mutual Funds' : key}</div>
                        <div className="text-gs-textDim mt-1">{bucket.items?.length ? `${bucket.items.length} verified current products` : REASON_CODE_LABELS[bucket.reasonCode] || 'Awaiting verified product data'}</div>
                        {bucket.items?.length > 0 && (
                          <ul className="mt-2 space-y-1">
                            {bucket.items.slice(0, 3).map((item) => (
                              <li key={item.productId || item.symbol} className="text-gs-textMuted truncate" title={item.name}>
                                {item.name}{item.returns1Y != null ? ` · ${item.returns1Y}% 1Y` : ''}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center justify-between gap-3 flex-wrap"><p className="text-[11px] text-gs-textDim">Stock screening is separate and may use provider data.</p><Button onClick={loadEligibleStocks} disabled={recLoading} className="bg-gs-gold text-gs-bg hover:bg-gs-gold/90">{recLoading ? 'Screening stocks...' : 'Load Eligible Stocks'}</Button></div>
                  <p className="text-[11px] text-gs-textDim leading-relaxed">This allocation is an educational planning estimate based on the information provided. Returns are not guaranteed. Review product documents and consult a SEBI-registered investment adviser before investing.</p>
                </div>
              </>
            )}

            {!recLoading && recResults.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs text-gs-textDim">
                <div className="bg-gs-panel border border-gs-border p-2"><div className="gs-label">Risk Profile</div><div className="text-gs-text mt-1 uppercase">{String(recConfig.riskProfile || recProfile.riskAppetite || 'moderate').replace('_', ' ')}</div></div>
                <div className="bg-gs-panel border border-gs-border p-2"><div className="gs-label">Horizon</div><div className="text-gs-text mt-1">{recConfig.horizonYears} years</div></div>
                <div className="bg-gs-panel border border-gs-border p-2"><div className="gs-label">Target</div><div className="text-gs-text mt-1">₹{Number(recGoal?.targetAmount || 0).toLocaleString('en-IN')}</div></div>
                <div className="bg-gs-panel border border-gs-border p-2"><div className="gs-label">Monthly</div><div className="text-gs-text mt-1">₹{Number(recConfig.monthlyContribution || 0).toLocaleString('en-IN')}</div></div>
                <div className="bg-gs-panel border border-gs-border p-2"><div className="gs-label">Recommended</div><div className="text-gs-text mt-1">{recResults.length} stocks</div></div>
              </div>
            )}

            {!recLoading && recAllocation.length > 0 && (
              <div className="flex flex-wrap gap-2 text-[11px] font-mono">
                <span className="w-full text-xs text-gs-textDim">Direct Equity Details: existing verified equity-style split</span>
                {recAllocation.map((item) => <span key={item.sector} className="px-2 py-1 bg-gs-panel border border-gs-border text-gs-textDim">{item.sector} {item.percentage}%</span>)}
              </div>
            )}

            {recLoading ? (
              <div className="text-sm text-gs-textDim py-8 text-center">Loading screened recommendations & live news sentiment...</div>
            ) : recResults.length === 0 ? (
              <div className="text-sm text-gs-textDim py-8 text-center">
                {!recStockHasLoaded
                  ? 'Click "Load Eligible Stocks" to screen the verified stock universe for this goal.'
                  : buildStockScreeningMessage(recStockScreening, recStockError)}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-stretch">
                {recStockScreening?.status === 'PARTIAL' && (
                  <div className="col-span-full text-[11px] text-gs-textDim bg-gs-panel border border-gs-border p-2">
                    {buildStockScreeningMessage(recStockScreening, recStockError)}
                  </div>
                )}
                {recResults.map((s) => (
                  <div
                    key={s.ticker || s.symbol}
                    className="p-3.5 rounded-lg border border-gs-border bg-gs-panel hover:border-gs-gold/50 hover:shadow-lg flex flex-col min-w-0 transition-all"
                  >
                    <div className="flex items-start justify-between gap-3 min-h-[52px]">
                      <div className="min-w-0">
                        <div className="font-mono font-semibold truncate">{s.ticker || s.symbol}</div>
                        <div className="text-xs text-gs-textDim truncate">{s.name || s.companyName || s.longName}</div>
                        <div className="text-[11px] text-gs-textDim mt-1">{s.sector || s.industry || '—'} · {s.risk || 'N/A'} risk</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono">₹{Number(s.price || s.regularMarketPrice || 0).toFixed(2)}</div>
                        <div className="text-lg font-mono text-gs-gold mt-1">
                          {s.goalFitScore == null ? 'N/A' : s.goalFitScore}
                          {s.goalFitScore != null && <span className="text-[10px] text-gs-textDim">/100</span>}
                        </div>
                      </div>
                    </div>

                    {/* Data coverage & confidence */}
                    <div className="mt-2 flex items-center justify-between gap-2 text-[10px]">
                      <span className={`font-mono px-1.5 py-0.5 rounded border ${s.confidence === 'HIGH' ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60' : s.confidence === 'MEDIUM' ? 'text-amber-400 bg-amber-950/40 border-amber-800/50' : 'text-gs-textDim bg-gs-bg border-gs-border'}`}>
                        {s.confidence || 'LOW'} confidence
                      </span>
                      <span className="text-gs-textDim font-mono">{s.dataCoveragePct ?? 0}% data coverage</span>
                    </div>
                    {s.missingMetrics?.length > 0 && (
                      <div className="mt-1 text-[10px] text-gs-textDim">
                        Missing: {s.missingMetrics.join(', ')}
                      </div>
                    )}

                    {/* AI Sentiment & Status Row */}
                    <div className="mt-3 flex items-center justify-between border-t border-gs-border pt-2">
                      <span className="text-[10px] uppercase tracking-wider text-gs-textDim">{s.recommendation || 'INSUFFICIENT_DATA'}</span>
                      {s.sentimentBadge === 'BULLISH' ? (
                        <span className="text-emerald-400 font-mono text-[10px] bg-emerald-950/60 border border-emerald-800/60 px-2 py-0.5 rounded flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> Bullish ({s.sentimentScore > 0 ? `+${s.sentimentScore}` : s.sentimentScore})
                        </span>
                      ) : s.sentimentBadge === 'BEARISH' ? (
                        <span className="text-rose-400 font-mono text-[10px] bg-rose-950/60 border border-rose-800/60 px-2 py-0.5 rounded flex items-center gap-1">
                          <TrendingDown className="w-3 h-3" /> Bearish ({s.sentimentScore})
                        </span>
                      ) : (
                        <span className="text-slate-400 font-mono text-[10px] bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                          Neutral Sentiment
                        </span>
                      )}
                    </div>

                    {/* Why & Catalyst Drivers */}
                    <div className="mt-3 text-xs text-gs-textDim flex-1">
                      <div className="font-semibold text-gs-text">Why Recommended</div>
                      <ul className="list-disc pl-4 mt-1 space-y-1 line-clamp-3">
                        {(Array.isArray(s.reasons) ? s.reasons : [s.whyRecommended || 'Selected for its fit with this goal.']).map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}
                      </ul>
                      {s.sentimentDrivers?.length > 0 && (
                        <div className="mt-2.5 p-2 bg-gs-bg/60 border border-gs-border rounded text-[11px]">
                          <span className="font-medium text-gs-text block mb-1">AI News Catalysts:</span>
                          <ul className="list-disc pl-3 text-gs-textDim space-y-0.5 line-clamp-2">
                            {s.sentimentDrivers.map((d, idx) => <li key={idx}>{d}</li>)}
                          </ul>
                        </div>
                      )}
                      <div className="font-semibold text-gs-text mt-3">Risks</div>
                      <ul className="list-disc pl-4 mt-1 space-y-1 line-clamp-2">
                        {(Array.isArray(s.risks) ? s.risks : ['Market returns and stock prices can change; review this choice as the goal timeline changes.']).map((risk, index) => <li key={`${risk}-${index}`}>{risk}</li>)}
                      </ul>
                    </div>

                    <div className="flex gap-2 mt-4 pt-3 border-t border-gs-border">
                      <Button size="sm" onClick={() => openDetailedRecommendation(s.ticker || s.symbol)} className="flex-1 bg-gs-gold text-gs-bg">View Analysis</Button>
                      {(() => {
                        const watchSymbol = String(s.ticker || s.symbol || '').trim().toUpperCase();
                        return (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!watchSymbol || watchlistBusy[watchSymbol] || watchlistAdded[watchSymbol]}
                            onClick={() => handleAddToWatchlist(watchSymbol)}
                          >
                            {watchlistBusy[watchSymbol] ? 'Adding…' : watchlistAdded[watchSymbol] ? 'Added' : 'Add'}
                          </Button>
                        );
                      })()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Detailed Stock View Dialog */}
      <Dialog open={detailDialogOpen} onOpenChange={setDetailDialogOpen}>
        <DialogContent className="bg-gs-card border-gs-border text-gs-text max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{selectedDetail?.symbol} suggestion for {selectedDetail?.goal?.name}</DialogTitle>
          </DialogHeader>
          {selectedDetail && (
            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {[
                  ['Goal', selectedDetail.goal?.name],
                  ['Target', `₹${Number(selectedDetail.goal?.targetAmount || 0).toLocaleString('en-IN')}`],
                  ['Horizon', `${selectedDetail.goal?.horizonYears || selectedDetail.goal?.requestedHorizonYears || 0} years`],
                  ['Risk / Sector', `${selectedDetail.goal?.riskProfile || 'moderate'} / ${selectedDetail.goal?.sector || selectedDetail.goal?.selectedSector || 'All'}`],
                ].map(([label, value]) => <div key={label} className="bg-gs-panel border border-gs-border p-3"><div className="gs-label">{label}</div><div className="text-gs-text mt-1 capitalize">{value}</div></div>)}
              </div>
              <div className="flex items-end justify-between gap-3 border-b border-gs-border pb-3">
                <div><div className="gs-label">Goal fit score</div><div className="font-display text-3xl font-bold text-gs-gold">{selectedDetail.goalFitScore == null ? 'N/A' : selectedDetail.goalFitScore}{selectedDetail.goalFitScore != null && <span className="text-sm text-gs-textDim">/100</span>}</div></div>
                <div className="text-right"><div className="gs-label">Risk score</div><div className="font-mono text-xl text-gs-text">{selectedDetail.riskScore ?? 'N/A'}{selectedDetail.riskScore != null && <span className="text-xs text-gs-textDim">/100</span>}</div></div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className={`font-mono px-2 py-0.5 rounded border ${selectedDetail.confidence === 'HIGH' ? 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60' : selectedDetail.confidence === 'MEDIUM' ? 'text-amber-400 bg-amber-950/40 border-amber-800/50' : 'text-gs-textDim bg-gs-bg border-gs-border'}`}>
                  {selectedDetail.confidence || 'LOW'} confidence
                </span>
                <span className="font-mono px-2 py-0.5 rounded border border-gs-border bg-gs-bg text-gs-textDim">
                  {selectedDetail.scoreStatus || 'INSUFFICIENT_DATA'} · {selectedDetail.dataCoveragePct ?? 0}% data coverage
                </span>
              </div>
              {selectedDetail.missingMetrics?.length > 0 && (
                <div className="text-xs text-gs-textDim">
                  Missing inputs: {selectedDetail.missingMetrics.join(', ')}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                {Object.entries(selectedDetail.components || {}).map(([key, value]) => <div key={key} className="bg-gs-panel border border-gs-border p-2"><div className="text-gs-textDim capitalize">{key.replace(/([A-Z])/g, ' $1')}</div><div className="font-mono text-gs-text mt-1">{value == null ? 'Unavailable' : `${value}/100`}</div></div>)}
              </div>

              {/* AI Real-Time Sentiment Panel */}
              <div className="bg-gs-panel border border-gs-border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="gs-label flex items-center gap-1.5"><Sparkles className="w-3.5 h-3.5 text-gs-gold" /> AI Real-Time News Sentiment Analysis</div>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded ${selectedDetail.sentimentBadge === 'BULLISH' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : selectedDetail.sentimentBadge === 'BEARISH' ? 'bg-rose-950 text-rose-400 border border-rose-800' : 'bg-slate-900 text-slate-300 border border-slate-800'}`}>
                    {selectedDetail.sentimentBadge || 'NEUTRAL'} ({selectedDetail.sentimentScore != null ? (selectedDetail.sentimentScore > 0 ? `+${selectedDetail.sentimentScore}` : selectedDetail.sentimentScore) : '0.00'})
                  </span>
                </div>
                {selectedDetail.sentimentDrivers?.length > 0 && (
                  <div className="mt-2 text-xs text-gs-textMuted">
                    <span className="font-medium text-gs-text">AI-Identified News Catalysts (unverified):</span>
                    <ul className="list-disc pl-4 mt-1 space-y-0.5">
                      {selectedDetail.sentimentDrivers.map((item, idx) => <li key={idx}>{item}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              <div className="bg-gs-panel border border-gs-border p-4"><div className="gs-label mb-1">Why this stock for your goal?</div><p className="text-sm text-gs-textMuted leading-relaxed">{selectedDetail.whyRecommended}</p></div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="bg-gs-panel border border-gs-border p-4 lg:col-span-2 space-y-3"><div className="gs-label">Historical performance</div><div className="grid grid-cols-3 gap-2 text-xs"><div><div className="text-gs-textDim">1Y return</div><div className="font-mono text-gs-text">{selectedDetail.historical?.oneYearReturn == null ? 'Unavailable' : `${selectedDetail.historical.oneYearReturn}%`}</div></div><div><div className="text-gs-textDim">Volatility</div><div className="font-mono text-gs-text">{selectedDetail.historical?.volatility == null ? 'Unavailable' : `${selectedDetail.historical.volatility}%`}</div></div><div><div className="text-gs-textDim">Max drawdown</div><div className="font-mono text-gs-text">{selectedDetail.historical?.maxDrawdown == null ? 'Unavailable' : `${selectedDetail.historical.maxDrawdown}%`}</div></div></div>{selectedDetail.historical?.series?.length > 1 && <div className="h-32"><ResponsiveContainer width="100%" height="100%"><LineChart data={selectedDetail.historical.series}><Line type="monotone" dataKey="close" stroke="#D4AF37" strokeWidth={1.5} dot={false} isAnimationActive={false} /><Tooltip /></LineChart></ResponsiveContainer></div>}<p className="text-xs text-gs-textMuted leading-relaxed">{selectedDetail.history}</p><div className="text-[10px] text-gs-textDim">Source: {selectedDetail.historical?.source || 'Unavailable from configured provider'}</div></div>
                <div className="bg-gs-panel border border-gs-border p-4 space-y-3"><div className="gs-label">Current / present</div><div className="font-mono text-xl text-gs-text">₹{Number(selectedDetail.present?.price || selectedDetail.price || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div><div className="text-xs text-gs-textMuted">Day change: {selectedDetail.present?.dayChangePct ?? selectedDetail.changePct ?? 0}%</div><div className="text-xs text-gs-textDim">P/E: {selectedDetail.fundamentals?.pe ?? 'Unavailable'}</div><div className="text-xs text-gs-textDim">Source: {selectedDetail.present?.source || 'Unavailable'}</div></div>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3"><div className="bg-gs-panel border border-gs-border p-4"><div className="gs-label">Future outlook</div><ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-gs-textMuted">{(selectedDetail.future?.growthDrivers || []).length ? selectedDetail.future.growthDrivers.map((driver, index) => <li key={`${driver}-${index}`}>{driver}</li>) : <li>No sourced forward-looking driver was returned.</li>}</ul><div className="text-[10px] text-gs-textDim mt-3">{selectedDetail.future?.label}</div></div><div className="bg-gs-panel border border-gs-border p-4"><div className="gs-label">Risks</div><ul className="list-disc pl-4 mt-2 space-y-1 text-xs text-gs-textMuted">{(selectedDetail.risks || []).map((risk, index) => <li key={`${risk}-${index}`}>{risk}</li>)}</ul></div></div>
              <div className="bg-gs-panel border border-gs-border p-4"><div className="flex items-center justify-between gap-3"><div className="gs-label">Recent company news</div><span className="text-[10px] text-gs-textDim">Original publisher links</span></div>{selectedDetail.news?.length ? <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">{selectedDetail.news.map((article, index) => <a key={`${article.url || article.title}-${index}`} href={article.url} target="_blank" rel="noopener noreferrer" className="border border-gs-border p-3 hover:border-gs-gold/50 transition-colors"><div className="text-xs text-gs-text line-clamp-2">{article.title}</div><div className="text-[10px] text-gs-textDim mt-2">{article.source || 'Publisher'}{article.publishedAt ? ` · ${new Date(article.publishedAt).toLocaleDateString('en-IN')}` : ''}</div><div className="text-[10px] text-gs-gold mt-2">Read original article ↗</div></a>)}</div> : <div className="text-xs text-gs-textDim mt-3">No relevant company-specific news was returned by the configured news provider.</div>}</div>
              <div className="bg-gs-panel border border-gs-border p-4"><div className="gs-label">Investment plan and deterministic projection</div><div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm"><div><div className="text-gs-textDim">Monthly</div><div className="font-mono text-gs-text">₹{Number(selectedDetail.investmentPlan?.monthly || selectedDetail.goal?.monthlyContribution || 0).toLocaleString('en-IN')}</div></div><div><div className="text-gs-textDim">Weekly</div><div className="font-mono text-gs-text">₹{Number(selectedDetail.investmentPlan?.weekly || 0).toLocaleString('en-IN')}</div></div><div><div className="text-gs-textDim">Annual</div><div className="font-mono text-gs-text">₹{Number(selectedDetail.investmentPlan?.annual || 0).toLocaleString('en-IN')}</div></div><div><div className="text-gs-textDim">Base scenario</div><div className="font-mono text-gs-text">₹{Number(selectedDetail.projection?.projectedAmount || 0).toLocaleString('en-IN')}</div></div></div><div className="text-[10px] text-gs-textDim mt-3">Illustrative scenario only. Returns are not guaranteed.</div></div>
              <div className="flex items-center justify-between gap-3 flex-wrap"><div className="text-xs text-gs-textDim">News links open the original publisher article.</div><Button onClick={() => { setDetailDialogOpen(false); navigate(`/stock/${encodeURIComponent(selectedDetail.symbol)}`, { state: { goal: selectedDetail.goal, profile: recProfile, goalRecommendation: selectedDetail } }); }} className="bg-gs-gold text-gs-bg">Open full Stock Detail</Button></div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
