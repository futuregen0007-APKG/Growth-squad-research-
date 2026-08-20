import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Target, Plus, Trash2, TrendingUp, Calendar, DollarSign, PieChart, ArrowRight, Edit, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FINANCIAL_GOALS } from '@/data/financialProfileData';
import { filterStocks, fetchAllStocks } from '@/services/stockApi';
import { FALLBACK_STOCK_DATA } from '@/data/mockData';

export default function Goals() {
  const navigate = useNavigate();
  const [goals, setGoals] = useState([]);
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

  const calculateProjectedValue = (goal) => {
    const years = goal.targetYear - new Date().getFullYear();
    if (years <= 0) return goal.currentAmount;
    const monthly = parseInt(goal.monthlyContribution) || 0;
    const assumedReturn = 0.12; // 12% assumed return
    const futureValue = goal.currentAmount * Math.pow(1 + assumedReturn, years) + 
                        monthly * 12 * ((Math.pow(1 + assumedReturn, years) - 1) / assumedReturn);
    return Math.round(futureValue);
  };

  // Recommendations state
  const [recDialogOpen, setRecDialogOpen] = useState(false);
  const [recLoading, setRecLoading] = useState(false);
  const [recResults, setRecResults] = useState([]);
  const [recGoal, setRecGoal] = useState(null);

  const mapGoalToFilters = (goal) => {
    const years = (goal.targetYear || new Date().getFullYear()) - new Date().getFullYear();
    // Simple heuristic: shorter horizon -> safer (lower price stocks), longer -> growth (sort by change)
    if (years >= 7) return { sortBy: 'change-desc' };
    if (years >= 3) return { sortBy: 'change-desc', minPrice: 50 };
    return { sortBy: 'price-asc', maxPrice: 500 };
  };

  const openRecommendations = async (goal) => {
    try {
      setRecGoal(goal);
      setRecDialogOpen(true);
      setRecLoading(true);
      const filters = mapGoalToFilters(goal);
      let results = await filterStocks(filters);

      // If API returned empty, try fetching all stocks and fall back to local data
      if (!results || results.length === 0) {
        try {
          const all = await fetchAllStocks();
          // simple ranking: prefer same sector (if primary goal maps to a sector), then top movers
          const sector = (goal.type === 'wealth_creation' || goal.type === '1crore') ? null : null;
          results = all.slice(0, 20).map(s => ({ ticker: s.ticker || s.symbol, name: s.name || s.companyName || s.longName, sector: s.sector || s.industry || '—', price: s.price || s.regularMarketPrice || 0 }));
        } catch (err) {
          // fallback to hardcoded mock data
          results = Object.values(FALLBACK_STOCK_DATA).map(s => ({ ticker: s.ticker, name: s.name, sector: s.sector, price: s.price }));
        }
      }

      // Enrich top results with research API (history/present/future + articles)
      const top = results.slice(0, 10).map(r => r.ticker || r.symbol);
      try {
        const resp = await fetch(`/api/research?symbols=${top.join(',')}`);
        if (resp.ok) {
          const json = await resp.json();
          const enriched = json.data || [];
          // Merge enriched info into results
          const merged = (results.slice(0, 10)).map(r => {
            const tick = (r.ticker || r.symbol).toUpperCase();
            const e = enriched.find(en => en.ticker === tick);
            return { ...r, research: e };
          });
          setRecResults(merged);
        } else {
          setRecResults(results.slice(0, 10));
        }
      } catch (err) {
        setRecResults(results.slice(0, 10));
      }
    } catch (err) {
      console.error('Error fetching recommendations', err);
      toast.error('Failed to fetch recommendations');
    } finally {
      setRecLoading(false);
    }
  };

  const generateReason = (goal, stock) => {
    // Heuristic reasons tailored to goal type and horizon
    const years = (goal?.targetYear || new Date().getFullYear()) - new Date().getFullYear();
    if (goal?.type === 'emergency') return 'Stable, lower-volatility stock suitable for short-term safety.';
    if (goal?.type === 'retirement' || years >= 7) return 'Strong long-term potential and market leadership for wealth accumulation.';
    if (goal?.type === 'house' || goal?.type === 'education') return 'Balanced growth with relatively stable fundamentals for medium-term goals.';
    return 'Good fit for diversified portfolio and growth objectives.';
  };

  const getGoalStatus = (goal) => {
    const projected = calculateProjectedValue(goal);
    const target = parseInt(goal.targetAmount);
    if (projected >= target) return { status: 'on-track', color: 'text-gs-pos', label: 'On Track' };
    if ((projected / target) >= 0.8) return { status: 'slightly-behind', color: 'text-yellow-500', label: 'Slightly Behind' };
    return { status: 'behind', color: 'text-gs-neg', label: 'Behind Schedule' };
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
          const projected = calculateProjectedValue(goal);
          const status = getGoalStatus(goal);
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
                    ₹{projected.toLocaleString('en-IN')}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">
                    Assuming 12% annual returns
                  </div>
                </div>

                {yearsRemaining > 0 && (
                  <div className="text-xs text-gs-textMuted">
                    {yearsRemaining} {yearsRemaining === 1 ? 'year' : 'years'} remaining
                  </div>
                )}

                <div className="space-y-2">
                  <Button
                    onClick={() => openRecommendations(goal)}
                    className="w-full bg-gs-accent text-gs-bg"
                  >
                    Get Recommendations
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
        <DialogContent className="bg-gs-card border-gs-border text-gs-text max-w-3xl">
          <DialogHeader>
            <DialogTitle>Recommendations for {recGoal?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
                {recLoading ? (
              <div className="text-sm text-gs-textDim">Loading recommendations...</div>
            ) : recResults.length === 0 ? (
              <div className="text-sm text-gs-textDim">No recommendations found for this goal.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {recResults.map((s) => (
                  <div
                    key={s.ticker || s.symbol}
                    className="p-3 rounded-lg border border-gs-border bg-gs-panel hover:shadow-lg"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 pr-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="font-mono font-semibold">{s.ticker || s.symbol}</div>
                            <div className="text-xs text-gs-textDim">{s.name || s.companyName || s.longName}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono">₹{(s.price || s.regularMarketPrice || 0).toFixed(2)}</div>
                            <div className="text-xs text-gs-textDim">{s.sector || s.industry || '—'}</div>
                          </div>
                        </div>

                        <div className="mt-2 text-sm text-gs-textDim">{generateReason(recGoal, s)}</div>
                        {s.research && (
                          <div className="mt-3 text-xs text-gs-textDim bg-gs-bg p-2 rounded">
                            <div className="font-medium text-sm">AI Research</div>
                            <div className="mt-1">
                              <div className="text-xs font-semibold">History</div>
                              <div className="text-xs">{s.research.historySummary || s.research.overview?.Description || ''}</div>
                            </div>
                            <div className="mt-1">
                              <div className="text-xs font-semibold">Present</div>
                              <div className="text-xs">{s.research.presentSummary || ''}</div>
                            </div>
                            <div className="mt-1">
                              <div className="text-xs font-semibold">Future</div>
                              <div className="text-xs">{s.research.futureSummary || ''}</div>
                            </div>
                            {s.research.news && s.research.news.length > 0 && (
                              <div className="mt-2 text-xs">
                                <div className="font-semibold">Articles</div>
                                <ul className="list-disc pl-5">
                                  {s.research.news.slice(0,3).map((a, idx) => (
                                    <li key={idx}><a href={a.url} target="_blank" rel="noreferrer" className="text-gs-accent">{a.title || a.source?.name}</a></li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col items-end gap-2">
                        <Button size="sm" onClick={() => navigate(`/stock/${s.ticker || s.symbol}`)} className="bg-gs-gold text-gs-bg">View</Button>
                        <Button size="sm" variant="outline" onClick={() => toast.success('Added to watchlist (mock)')}>Add</Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
