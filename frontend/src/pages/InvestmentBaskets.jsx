import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, TrendingUp, Shield, PieChart, Plus, Info, ArrowRight, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { MODEL_PORTFOLIOS } from '@/data/financialProfileData';
import { generateRiskReport } from '@/hooks/useRiskAssessment';
import { toast } from 'sonner';

export default function InvestmentBaskets() {
  const navigate = useNavigate();
  const [selectedBaskets, setSelectedBaskets] = useState([]);
  const [profile, setProfile] = useState(null);
  const [riskReport, setRiskReport] = useState(null);
  const [infoDialogOpen, setInfoDialogOpen] = useState(false);
  const [selectedBasketInfo, setSelectedBasketInfo] = useState(null);

  useEffect(() => {
    loadProfile();
    loadSelectedBaskets();
  }, []);

  const loadProfile = () => {
    const savedProfile = localStorage.getItem('financialProfile');
    if (savedProfile) {
      const parsedProfile = JSON.parse(savedProfile);
      setProfile(parsedProfile);
      const report = generateRiskReport(parsedProfile);
      setRiskReport(report);
    }
  };

  const loadSelectedBaskets = () => {
    const saved = localStorage.getItem('selectedBaskets');
    if (saved) {
      setSelectedBaskets(JSON.parse(saved));
    }
  };

  const handleAddBasket = (basket) => {
    if (!selectedBaskets.find(b => b.id === basket.id)) {
      setSelectedBaskets([...selectedBaskets, basket]);
      localStorage.setItem('selectedBaskets', JSON.stringify([...selectedBaskets, basket]));
      toast.success('Basket Added', {
        description: `"${basket.name}" has been added to your portfolio.`,
      });
    } else {
      toast.error('Already Added', {
        description: 'This basket is already in your portfolio.',
      });
    }
  };

  const handleRemoveBasket = (basketId) => {
    const updated = selectedBaskets.filter(b => b.id !== basketId);
    setSelectedBaskets(updated);
    localStorage.setItem('selectedBaskets', JSON.stringify(updated));
    toast.success('Basket Removed', {
      description: 'The basket has been removed from your portfolio.',
    });
  };

  const getRecommendedBaskets = () => {
    if (!riskReport) return MODEL_PORTFOLIOS.slice(0, 4);
    
    return MODEL_PORTFOLIOS.filter(basket => {
      if (basket.suitableFor.includes(profile?.investmentExperience)) return true;
      if (basket.riskProfile === riskReport.riskProfile) return true;
      return false;
    }).slice(0, 6);
  };

  const getBasketCategory = (basket) => {
    if (basket.focus === 'dividend') return 'Income';
    if (basket.focus === 'value') return 'Value';
    if (basket.focus === 'momentum') return 'Growth';
    if (basket.focus === 'etf') return 'Passive';
    if (basket.focus === 'mutual_fund') return 'Mutual Fund';
    if (basket.focus === 'global') return 'International';
    if (basket.sector) return basket.sector;
    return 'Core';
  };

  const categories = ['Core', 'Growth', 'Income', 'Value', 'Sector', 'Passive', 'International'];
  const recommendedBaskets = getRecommendedBaskets();

  return (
    <div className="space-y-6 animate-fade-up" data-testid="investment-baskets-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Smart Investing</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Investment Baskets
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Curated portfolios designed for different risk profiles and investment goals.
          </p>
        </div>
      </div>

      {/* Risk Profile Summary */}
      {riskReport && (
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Your Risk Profile
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-xl font-bold text-gs-text">{riskReport.riskLabel}</div>
                <div className="text-xs text-gs-textDim mt-1">Risk Score: {riskReport.score}/100</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-gs-textMuted">Recommended Allocation</div>
                <div className="text-xs text-gs-textDim mt-1">
                  Equity: {100 - (riskReport.allocation.debt + riskReport.allocation.gold)}% | 
                  Debt: {riskReport.allocation.debt}% | 
                  Gold: {riskReport.allocation.gold}%
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Selected Baskets */}
      {selectedBaskets.length > 0 && (
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <Briefcase className="w-4 h-4" />
              Your Selected Baskets ({selectedBaskets.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {selectedBaskets.map(basket => (
                <div
                  key={basket.id}
                  className="p-3 rounded-lg bg-gs-panel border border-gs-border flex items-center justify-between"
                >
                  <div className="flex items-center gap-2">
                    <Check className="w-4 h-4 text-gs-pos" />
                    <span className="text-sm text-gs-text">{basket.name}</span>
                  </div>
                  <button
                    onClick={() => handleRemoveBasket(basket.id)}
                    className="text-gs-textDim hover:text-gs-neg transition-colors"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-gs-border">
              <Button
                onClick={() => navigate('/portfolio')}
                className="w-full bg-gs-gold text-gs-bg hover:bg-gs-gold/90"
              >
                View Portfolio
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Baskets Grid */}
      <Tabs defaultValue="recommended" className="w-full">
        <TabsList className="bg-gs-panel border border-gs-border rounded-sm h-auto p-1 flex-wrap">
          <TabsTrigger value="recommended" className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]">
            Recommended for You
          </TabsTrigger>
          <TabsTrigger value="all" className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]">
            All Baskets
          </TabsTrigger>
          {categories.map(cat => (
            <TabsTrigger key={cat} value={cat.toLowerCase()} className="rounded-sm data-[state=active]:bg-gs-card data-[state=active]:text-gs-text text-gs-textMuted px-3 py-1.5 text-[12px]">
              {cat}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="recommended" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {recommendedBaskets.map(basket => (
              <BasketCard
                key={basket.id}
                basket={basket}
                onAdd={handleAddBasket}
                isSelected={selectedBaskets.find(b => b.id === basket.id)}
                onShowInfo={() => {
                  setSelectedBasketInfo(basket);
                  setInfoDialogOpen(true);
                }}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="all" className="mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {MODEL_PORTFOLIOS.map(basket => (
              <BasketCard
                key={basket.id}
                basket={basket}
                onAdd={handleAddBasket}
                isSelected={selectedBaskets.find(b => b.id === basket.id)}
                onShowInfo={() => {
                  setSelectedBasketInfo(basket);
                  setInfoDialogOpen(true);
                }}
              />
            ))}
          </div>
        </TabsContent>

        {categories.map(cat => (
          <TabsContent key={cat} value={cat.toLowerCase()} className="mt-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {MODEL_PORTFOLIOS
                .filter(basket => getBasketCategory(basket) === cat)
                .map(basket => (
                  <BasketCard
                    key={basket.id}
                    basket={basket}
                    onAdd={handleAddBasket}
                    isSelected={selectedBaskets.find(b => b.id === basket.id)}
                    onShowInfo={() => {
                      setSelectedBasketInfo(basket);
                      setInfoDialogOpen(true);
                    }}
                  />
                ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      {/* Info Dialog */}
      <Dialog open={infoDialogOpen} onOpenChange={setInfoDialogOpen}>
        <DialogContent className="bg-gs-card border-gs-border text-gs-text max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedBasketInfo?.name}</DialogTitle>
          </DialogHeader>
          {selectedBasketInfo && (
            <div className="space-y-4 mt-4">
              <p className="text-sm text-gs-textMuted">{selectedBasketInfo.description}</p>
              
              <div>
                <div className="text-sm text-gs-textMuted mb-2">Asset Allocation</div>
                <div className="space-y-2">
                  {Object.entries(selectedBasketInfo.allocation).map(([key, value]) => (
                    <div key={key} className="flex items-center gap-2">
                      <div className="flex-1">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="capitalize text-gs-text">{key}</span>
                          <span className="text-gs-text">{value}%</span>
                        </div>
                        <Progress value={value} className="h-2" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-gs-textMuted mb-1">Risk Profile</div>
                  <div className="text-gs-text font-medium capitalize">{selectedBasketInfo.riskProfile.replace('_', ' ')}</div>
                </div>
                <div>
                  <div className="text-sm text-gs-textMuted mb-1">Expected Returns</div>
                  <div className="text-gs-text font-medium">{selectedBasketInfo.expectedReturns}% p.a.</div>
                </div>
              </div>

              <div>
                <div className="text-sm text-gs-textMuted mb-2">Suitable For</div>
                <div className="flex flex-wrap gap-2">
                  {selectedBasketInfo.suitableFor.map(level => (
                    <span key={level} className="px-2 py-1 rounded-full bg-gs-panel border border-gs-border text-xs text-gs-text capitalize">
                      {level}
                    </span>
                  ))}
                </div>
              </div>

              {!selectedBaskets.find(b => b.id === selectedBasketInfo.id) && (
                <Button
                  onClick={() => {
                    handleAddBasket(selectedBasketInfo);
                    setInfoDialogOpen(false);
                  }}
                  className="w-full bg-gs-gold text-gs-bg"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add to Portfolio
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BasketCard({ basket, onAdd, isSelected, onShowInfo }) {
  const category = basket.focus || basket.sector || 'Core';
  const categoryColors = {
    'dividend': 'text-green-400',
    'value': 'text-blue-400',
    'momentum': 'text-purple-400',
    'etf': 'text-cyan-400',
    'mutual_fund': 'text-orange-400',
    'global': 'text-pink-400',
    'Defence': 'text-red-400',
    'Technology': 'text-blue-400',
    'Banking': 'text-green-400',
    'Healthcare': 'text-pink-400',
    'Manufacturing': 'text-yellow-400',
    'Infrastructure': 'text-orange-400',
    'Green Energy': 'text-green-400',
  };

  return (
    <Card className="bg-gs-card border-gs-border hover:border-gs-gold/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base">{basket.name}</CardTitle>
            <CardDescription className="text-xs mt-1">{basket.description}</CardDescription>
          </div>
          <button
            onClick={onShowInfo}
            className="p-1 text-gs-textDim hover:text-gs-text transition-colors"
          >
            <Info className="w-4 h-4" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-xs">
          <span className={`font-medium capitalize ${categoryColors[category] || 'text-gs-gold'}`}>
            {category}
          </span>
          <span className="text-gs-textMuted">{basket.expectedReturns}% p.a.</span>
        </div>

        <div className="space-y-1.5">
          {Object.entries(basket.allocation).slice(0, 3).map(([key, value]) => (
            <div key={key} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-gs-textDim capitalize">{key}</span>
              <div className="flex-1 h-1.5 bg-gs-panel rounded-full overflow-hidden">
                <div className="h-full bg-gs-gold rounded-full" style={{ width: `${value}%` }} />
              </div>
              <span className="text-gs-text w-8 text-right">{value}%</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between text-xs pt-2 border-t border-gs-border">
          <span className="text-gs-textMuted capitalize">{basket.riskProfile.replace('_', ' ')}</span>
          {isSelected ? (
            <span className="text-gs-pos flex items-center gap-1">
              <Check className="w-3 h-3" />
              Added
            </span>
          ) : (
            <Button
              size="sm"
              onClick={() => onAdd(basket)}
              className="h-7 px-3 bg-gs-gold text-gs-bg hover:bg-gs-gold/90 text-xs"
            >
              <Plus className="w-3 h-3 mr-1" />
              Add
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
