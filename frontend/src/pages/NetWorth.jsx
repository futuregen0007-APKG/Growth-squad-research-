import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, TrendingDown, Plus, Trash2, PieChart, Wallet, Home, Car, Banknote, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';

const ASSET_CATEGORIES = [
  { id: 'cash', label: 'Cash & Bank', icon: Banknote, color: 'bg-green-500' },
  { id: 'investments', label: 'Investments', icon: TrendingUp, color: 'bg-blue-500' },
  { id: 'real_estate', label: 'Real Estate', icon: Home, color: 'bg-purple-500' },
  { id: 'vehicles', label: 'Vehicles', icon: Car, color: 'bg-orange-500' },
  { id: 'gold', label: 'Gold & Jewelry', icon: Wallet, color: 'bg-yellow-500' },
  { id: 'other', label: 'Other Assets', icon: Wallet, color: 'bg-gray-500' },
];

const LIABILITY_CATEGORIES = [
  { id: 'home_loan', label: 'Home Loan', icon: Home, color: 'bg-red-500' },
  { id: 'car_loan', label: 'Car Loan', icon: Car, color: 'bg-red-500' },
  { id: 'personal_loan', label: 'Personal Loan', icon: Banknote, color: 'bg-red-500' },
  { id: 'credit_card', label: 'Credit Card', icon: Banknote, color: 'bg-red-500' },
  { id: 'other_liability', label: 'Other Liabilities', icon: Banknote, color: 'bg-red-500' },
];

export default function NetWorth() {
  const [assets, setAssets] = useState([]);
  const [liabilities, setLiabilities] = useState([]);
  const [addAssetDialogOpen, setAddAssetDialogOpen] = useState(false);
  const [addLiabilityDialogOpen, setAddLiabilityDialogOpen] = useState(false);
  const [newAsset, setNewAsset] = useState({ name: '', category: '', value: '' });
  const [newLiability, setNewLiability] = useState({ name: '', category: '', value: '' });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    const savedAssets = localStorage.getItem('netWorthAssets');
    const savedLiabilities = localStorage.getItem('netWorthLiabilities');
    if (savedAssets) setAssets(JSON.parse(savedAssets));
    if (savedLiabilities) setLiabilities(JSON.parse(savedLiabilities));
  };

  const totalAssets = useMemo(() => assets.reduce((sum, a) => sum + (parseFloat(a.value) || 0), 0), [assets]);
  const totalLiabilities = useMemo(() => liabilities.reduce((sum, l) => sum + (parseFloat(l.value) || 0), 0), [liabilities]);
  const netWorth = useMemo(() => totalAssets - totalLiabilities, [totalAssets, totalLiabilities]);

  const assetsByCategory = useMemo(() => {
    const grouped = {};
    ASSET_CATEGORIES.forEach(cat => grouped[cat.id] = 0);
    assets.forEach(asset => {
      grouped[asset.category] = (grouped[asset.category] || 0) + parseFloat(asset.value);
    });
    return grouped;
  }, [assets]);

  const liabilitiesByCategory = useMemo(() => {
    const grouped = {};
    LIABILITY_CATEGORIES.forEach(cat => grouped[cat.id] = 0);
    liabilities.forEach(liability => {
      grouped[liability.category] = (grouped[liability.category] || 0) + parseFloat(liability.value);
    });
    return grouped;
  }, [liabilities]);

  const handleAddAsset = () => {
    if (newAsset.name && newAsset.category && newAsset.value) {
      const asset = {
        id: `asset-${Date.now()}`,
        ...newAsset,
        value: parseFloat(newAsset.value),
      };
      setAssets([...assets, asset]);
      localStorage.setItem('netWorthAssets', JSON.stringify([...assets, asset]));
      setNewAsset({ name: '', category: '', value: '' });
      setAddAssetDialogOpen(false);
      toast.success('Asset Added', {
        description: `"${asset.name}" has been added to your assets.`,
      });
    }
  };

  const handleAddLiability = () => {
    if (newLiability.name && newLiability.category && newLiability.value) {
      const liability = {
        id: `liability-${Date.now()}`,
        ...newLiability,
        value: parseFloat(newLiability.value),
      };
      setLiabilities([...liabilities, liability]);
      localStorage.setItem('netWorthLiabilities', JSON.stringify([...liabilities, liability]));
      setNewLiability({ name: '', category: '', value: '' });
      setAddLiabilityDialogOpen(false);
      toast.success('Liability Added', {
        description: `"${liability.name}" has been added to your liabilities.`,
      });
    }
  };

  const handleDeleteAsset = (id) => {
    const updated = assets.filter(a => a.id !== id);
    setAssets(updated);
    localStorage.setItem('netWorthAssets', JSON.stringify(updated));
    toast.success('Asset Removed');
  };

  const handleDeleteLiability = (id) => {
    const updated = liabilities.filter(l => l.id !== id);
    setLiabilities(updated);
    localStorage.setItem('netWorthLiabilities', JSON.stringify(updated));
    toast.success('Liability Removed');
  };

  const formatCurrency = (value) => '₹' + Math.round(value).toLocaleString('en-IN');

  return (
    <div className="space-y-6 animate-fade-up" data-testid="net-worth-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Financial Planning</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Net Worth Tracker
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Track your assets and liabilities to monitor your financial health.
          </p>
        </div>
      </div>

      {/* Net Worth Summary */}
      <Card className={`bg-gs-card border-2 ${netWorth >= 0 ? 'border-gs-pos' : 'border-gs-neg'}`}>
        <CardContent className="pt-6">
          <div className="text-center">
            <div className="text-sm text-gs-textMuted mb-2">Total Net Worth</div>
            <div className={`font-display text-4xl sm:text-5xl font-bold ${netWorth >= 0 ? 'text-gs-pos' : 'text-gs-neg'}`}>
              {formatCurrency(netWorth)}
            </div>
            <div className="flex items-center justify-center gap-4 mt-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-gs-pos" />
                <span className="text-sm text-gs-textMuted">Assets: {formatCurrency(totalAssets)}</span>
              </div>
              <div className="flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-gs-neg" />
                <span className="text-sm text-gs-textMuted">Liabilities: {formatCurrency(totalLiabilities)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Assets Section */}
        <Card className="bg-gs-card border-gs-border">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-gs-pos" />
                Assets
              </CardTitle>
              <Dialog open={addAssetDialogOpen} onOpenChange={setAddAssetDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-gs-pos text-gs-bg hover:bg-gs-pos/90">
                    <Plus className="w-4 h-4 mr-1" />
                    Add Asset
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-gs-card border-gs-border text-gs-text">
                  <DialogHeader>
                    <DialogTitle>Add New Asset</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 mt-4">
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Asset Name</label>
                      <Input
                        value={newAsset.name}
                        onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })}
                        placeholder="e.g., Savings Account"
                        className="bg-gs-bg border-gs-border"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Category</label>
                      <Select value={newAsset.category} onValueChange={(value) => setNewAsset({ ...newAsset, category: value })}>
                        <SelectTrigger className="bg-gs-bg border-gs-border">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent className="bg-gs-card border-gs-border">
                          {ASSET_CATEGORIES.map(cat => (
                            <SelectItem key={cat.id} value={cat.id}>{cat.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Value (₹)</label>
                      <Input
                        type="number"
                        value={newAsset.value}
                        onChange={(e) => setNewAsset({ ...newAsset, value: e.target.value })}
                        placeholder="100000"
                        className="bg-gs-bg border-gs-border"
                      />
                    </div>
                    <Button onClick={handleAddAsset} className="w-full bg-gs-pos text-gs-bg">
                      Add Asset
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Asset Breakdown */}
            <div className="space-y-2">
              {ASSET_CATEGORIES.map(cat => {
                const value = assetsByCategory[cat.id];
                const percentage = totalAssets > 0 ? (value / totalAssets) * 100 : 0;
                return (
                  <div key={cat.id} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gs-panel flex items-center justify-center">
                      <cat.icon className="w-4 h-4 text-gs-textDim" />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gs-text">{cat.label}</span>
                        <span className="text-gs-text">{formatCurrency(value)}</span>
                      </div>
                      <Progress value={percentage} className="h-1.5" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Asset List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {assets.map(asset => {
                const cat = ASSET_CATEGORIES.find(c => c.id === asset.category);
                return (
                  <div key={asset.id} className="flex items-center justify-between p-2 rounded bg-gs-panel">
                    <div className="flex items-center gap-2">
                      <cat.icon className="w-4 h-4 text-gs-textDim" />
                      <div>
                        <div className="text-sm text-gs-text">{asset.name}</div>
                        <div className="text-xs text-gs-textDim">{cat.label}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-gs-pos">{formatCurrency(asset.value)}</span>
                      <button
                        onClick={() => handleDeleteAsset(asset.id)}
                        className="p-1 text-gs-textDim hover:text-gs-neg transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {assets.length === 0 && (
                <div className="text-center py-4 text-sm text-gs-textDim">
                  No assets added yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Liabilities Section */}
        <Card className="bg-gs-card border-gs-border">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <TrendingDown className="w-5 h-5 text-gs-neg" />
                Liabilities
              </CardTitle>
              <Dialog open={addLiabilityDialogOpen} onOpenChange={setAddLiabilityDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm" className="bg-gs-neg text-gs-bg hover:bg-gs-neg/90">
                    <Plus className="w-4 h-4 mr-1" />
                    Add Liability
                  </Button>
                </DialogTrigger>
                <DialogContent className="bg-gs-card border-gs-border text-gs-text">
                  <DialogHeader>
                    <DialogTitle>Add New Liability</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 mt-4">
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Liability Name</label>
                      <Input
                        value={newLiability.name}
                        onChange={(e) => setNewLiability({ ...newLiability, name: e.target.value })}
                        placeholder="e.g., Home Loan"
                        className="bg-gs-bg border-gs-border"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Category</label>
                      <Select value={newLiability.category} onValueChange={(value) => setNewLiability({ ...newLiability, category: value })}>
                        <SelectTrigger className="bg-gs-bg border-gs-border">
                          <SelectValue placeholder="Select category" />
                        </SelectTrigger>
                        <SelectContent className="bg-gs-card border-gs-border">
                          {LIABILITY_CATEGORIES.map(cat => (
                            <SelectItem key={cat.id} value={cat.id}>{cat.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-sm text-gs-textMuted mb-1 block">Outstanding Amount (₹)</label>
                      <Input
                        type="number"
                        value={newLiability.value}
                        onChange={(e) => setNewLiability({ ...newLiability, value: e.target.value })}
                        placeholder="500000"
                        className="bg-gs-bg border-gs-border"
                      />
                    </div>
                    <Button onClick={handleAddLiability} className="w-full bg-gs-neg text-gs-bg">
                      Add Liability
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Liability Breakdown */}
            <div className="space-y-2">
              {LIABILITY_CATEGORIES.map(cat => {
                const value = liabilitiesByCategory[cat.id];
                const percentage = totalLiabilities > 0 ? (value / totalLiabilities) * 100 : 0;
                return (
                  <div key={cat.id} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-gs-panel flex items-center justify-center">
                      <cat.icon className="w-4 h-4 text-gs-textDim" />
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gs-text">{cat.label}</span>
                        <span className="text-gs-text">{formatCurrency(value)}</span>
                      </div>
                      <Progress value={percentage} className="h-1.5" />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Liability List */}
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {liabilities.map(liability => {
                const cat = LIABILITY_CATEGORIES.find(c => c.id === liability.category);
                return (
                  <div key={liability.id} className="flex items-center justify-between p-2 rounded bg-gs-panel">
                    <div className="flex items-center gap-2">
                      <cat.icon className="w-4 h-4 text-gs-textDim" />
                      <div>
                        <div className="text-sm text-gs-text">{liability.name}</div>
                        <div className="text-xs text-gs-textDim">{cat.label}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-gs-neg">{formatCurrency(liability.value)}</span>
                      <button
                        onClick={() => handleDeleteLiability(liability.id)}
                        className="p-1 text-gs-textDim hover:text-gs-neg transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {liabilities.length === 0 && (
                <div className="text-center py-4 text-sm text-gs-textDim">
                  No liabilities added yet
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Financial Health Tips */}
      <Card className="bg-gs-card border-gs-border">
        <CardHeader>
          <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
            <PieChart className="w-4 h-4" />
            Financial Health Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-3 rounded-lg bg-gs-panel border border-gs-border">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${totalLiabilities / totalAssets < 0.5 ? 'bg-gs-pos' : 'bg-gs-neg'}`} />
                <span className="text-sm text-gs-textMuted">Debt-to-Asset Ratio</span>
              </div>
              <div className="font-display text-lg font-bold text-gs-text">
                {totalAssets > 0 ? ((totalLiabilities / totalAssets) * 100).toFixed(1) : 0}%
              </div>
              <div className="text-xs text-gs-textDim mt-1">
                {totalLiabilities / totalAssets < 0.5 ? 'Healthy' : 'High debt level'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-gs-panel border border-gs-border">
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${netWorth > 0 ? 'bg-gs-pos' : 'bg-gs-neg'}`} />
                <span className="text-sm text-gs-textMuted">Net Worth Status</span>
              </div>
              <div className="font-display text-lg font-bold text-gs-text">
                {netWorth > 0 ? 'Positive' : 'Negative'}
              </div>
              <div className="text-xs text-gs-textDim mt-1">
                {netWorth > 0 ? 'Your assets exceed liabilities' : 'Liabilities exceed assets'}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-gs-panel border border-gs-border">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-gs-gold" />
                <span className="text-sm text-gs-textMuted">Total Items</span>
              </div>
              <div className="font-display text-lg font-bold text-gs-text">
                {assets.length + liabilities.length}
              </div>
              <div className="text-xs text-gs-textDim mt-1">
                {assets.length} assets, {liabilities.length} liabilities
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
