import { useState, useMemo } from 'react';
import { Calculator, TrendingUp, Calendar, DollarSign, PieChart, ArrowRight, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

export default function SIPPlanner() {
  const [calculatorMode, setCalculatorMode] = useState('sip');
  const [mode, setMode] = useState('target'); // 'target' or 'investment'
  const [targetAmount, setTargetAmount] = useState('');
  const [timeYears, setTimeYears] = useState('');
  const [expectedReturn, setExpectedReturn] = useState('12');
  const [monthlyInvestment, setMonthlyInvestment] = useState('');
  const [initialInvestment, setInitialInvestment] = useState('');
  const [stepUp, setStepUp] = useState('0');
  const [swpCorpus, setSwpCorpus] = useState('');
  const [swpWithdrawal, setSwpWithdrawal] = useState('');
  const [swpYears, setSwpYears] = useState('');
  const [swpReturn, setSwpReturn] = useState('8');

  const calculations = useMemo(() => {
    if (mode === 'target') {
      // Calculate required monthly SIP to reach target
      const target = parseFloat(targetAmount) || 0;
      const years = parseFloat(timeYears) || 0;
      const rate = parseFloat(expectedReturn) / 100 || 0.12;
      const initial = parseFloat(initialInvestment) || 0;
      const stepUpRate = parseFloat(stepUp) / 100 || 0;

      if (target <= 0 || years <= 0) return null;

      // Future value of initial investment
      const fvInitial = initial * Math.pow(1 + rate, years);

      // Required future value from SIP
      const fvRequired = target - fvInitial;

      // Calculate monthly SIP with step-up
      const months = years * 12;
      const monthlyRate = rate / 12;
      
      let monthlySIP = 0;
      if (stepUpRate > 0) {
        // Approximate calculation for step-up SIP
        monthlySIP = fvRequired / months; // Simplified
      } else {
        monthlySIP = fvRequired * monthlyRate / (Math.pow(1 + monthlyRate, months) - 1);
      }

      const totalInvestment = monthlySIP * months + initial;
      const wealthGained = target - totalInvestment;

      return {
        monthlySIP: Math.max(0, monthlySIP),
        totalInvestment,
        wealthGained: Math.max(0, wealthGained),
        finalAmount: target,
        years,
      };
    } else {
      // Calculate final amount from monthly SIP
      const monthly = parseFloat(monthlyInvestment) || 0;
      const years = parseFloat(timeYears) || 0;
      const rate = parseFloat(expectedReturn) / 100 || 0.12;
      const initial = parseFloat(initialInvestment) || 0;
      const stepUpRate = parseFloat(stepUp) / 100 || 0;

      if (monthly <= 0 || years <= 0) return null;

      const months = years * 12;
      const monthlyRate = rate / 12;

      // Future value of initial investment
      const fvInitial = initial * Math.pow(1 + rate, years);

      // Future value of SIP
      let fvSIP = 0;
      if (stepUpRate > 0) {
        // Step-up SIP calculation
        for (let i = 0; i < months; i++) {
          const stepUpAmount = monthly * Math.pow(1 + stepUpRate, Math.floor(i / 12));
          fvSIP += stepUpAmount * Math.pow(1 + monthlyRate, months - i);
        }
      } else {
        fvSIP = monthly * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
      }

      const totalInvestment = monthly * months + initial;
      const finalAmount = fvInitial + fvSIP;
      const wealthGained = finalAmount - totalInvestment;

      return {
        monthlySIP: monthly,
        totalInvestment,
        wealthGained: Math.max(0, wealthGained),
        finalAmount,
        years,
      };
    }
  }, [mode, targetAmount, timeYears, expectedReturn, monthlyInvestment, initialInvestment, stepUp]);

  const swpCalculations = useMemo(() => {
    const corpus = parseFloat(swpCorpus) || 0;
    const withdrawal = parseFloat(swpWithdrawal) || 0;
    const years = parseFloat(swpYears) || 0;
    const annualReturn = parseFloat(swpReturn) / 100 || 0;
    if (corpus <= 0 || withdrawal <= 0 || years <= 0) return null;

    const months = Math.round(years * 12);
    const monthlyRate = annualReturn / 12;
    const growthFactor = Math.pow(1 + monthlyRate, months);
    const withdrawalGrowth = monthlyRate === 0
      ? withdrawal * months
      : withdrawal * ((growthFactor - 1) / monthlyRate);
    const endingCorpus = Math.max(0, corpus * growthFactor - withdrawalGrowth);
    const totalWithdrawn = withdrawal * months;
    const wealthGained = endingCorpus + totalWithdrawn - corpus;

    return {
      endingCorpus,
      totalWithdrawn,
      wealthGained,
      years,
      withdrawal,
      depletionRisk: endingCorpus <= 0,
    };
  }, [swpCorpus, swpWithdrawal, swpYears, swpReturn]);

  const formatCurrency = (value) => {
    return '₹' + Math.round(value).toLocaleString('en-IN');
  };

  return (
    <div className="space-y-6 animate-fade-up" data-testid="sip-planner-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Financial Planning</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Smart SIP Planner
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Calculate your SIP investments and plan your financial goals.
          </p>
        </div>
      </div>

      <Tabs value={calculatorMode} onValueChange={setCalculatorMode} className="w-full">
        <TabsList className="bg-gs-panel border border-gs-border rounded-sm w-full max-w-md">
          <TabsTrigger value="sip" className="flex-1 rounded-sm data-[state=active]:bg-gs-card">SIP Calculator</TabsTrigger>
          <TabsTrigger value="swp" className="flex-1 rounded-sm data-[state=active]:bg-gs-card">SWP Calculator</TabsTrigger>
        </TabsList>
      </Tabs>

      {calculatorMode === 'sip' ? <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Calculator */}
        <Card className="bg-gs-card border-gs-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calculator className="w-5 h-5 text-gs-gold" />
              SIP Calculator
            </CardTitle>
            <CardDescription>
              Choose your calculation mode
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs value={mode} onValueChange={setMode} className="w-full">
              <TabsList className="bg-gs-panel border border-gs-border rounded-sm w-full">
                <TabsTrigger value="target" className="flex-1 rounded-sm data-[state=active]:bg-gs-card">
                  I have a target amount
                </TabsTrigger>
                <TabsTrigger value="investment" className="flex-1 rounded-sm data-[state=active]:bg-gs-card">
                  I want to invest monthly
                </TabsTrigger>
              </TabsList>

              <TabsContent value="target" className="space-y-4 mt-4">
                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Target Amount (₹)</label>
                  <Input
                    type="number"
                    value={targetAmount}
                    onChange={(e) => setTargetAmount(e.target.value)}
                    placeholder="1000000"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Time Period (Years)</label>
                  <Input
                    type="number"
                    value={timeYears}
                    onChange={(e) => setTimeYears(e.target.value)}
                    placeholder="10"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Initial Investment (₹)</label>
                  <Input
                    type="number"
                    value={initialInvestment}
                    onChange={(e) => setInitialInvestment(e.target.value)}
                    placeholder="0"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Expected Return (% p.a.)</label>
                  <Select value={expectedReturn} onValueChange={setExpectedReturn}>
                    <SelectTrigger className="bg-gs-bg border-gs-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="8">8% (Conservative)</SelectItem>
                      <SelectItem value="10">10% (Moderate)</SelectItem>
                      <SelectItem value="12">12% (Aggressive)</SelectItem>
                      <SelectItem value="15">15% (High Growth)</SelectItem>
                      <SelectItem value="18">18% (Very Aggressive)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Annual Step-up (%)</label>
                  <Select value={stepUp} onValueChange={setStepUp}>
                    <SelectTrigger className="bg-gs-bg border-gs-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="0">0% (Fixed SIP)</SelectItem>
                      <SelectItem value="5">5% (Step-up SIP)</SelectItem>
                      <SelectItem value="10">10% (Step-up SIP)</SelectItem>
                      <SelectItem value="15">15% (Step-up SIP)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gs-textDim mt-1">Increase your SIP amount annually by this %</p>
                </div>
              </TabsContent>

              <TabsContent value="investment" className="space-y-4 mt-4">
                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Monthly Investment (₹)</label>
                  <Input
                    type="number"
                    value={monthlyInvestment}
                    onChange={(e) => setMonthlyInvestment(e.target.value)}
                    placeholder="10000"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Time Period (Years)</label>
                  <Input
                    type="number"
                    value={timeYears}
                    onChange={(e) => setTimeYears(e.target.value)}
                    placeholder="10"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Initial Investment (₹)</label>
                  <Input
                    type="number"
                    value={initialInvestment}
                    onChange={(e) => setInitialInvestment(e.target.value)}
                    placeholder="0"
                    className="bg-gs-bg border-gs-border"
                  />
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Expected Return (% p.a.)</label>
                  <Select value={expectedReturn} onValueChange={setExpectedReturn}>
                    <SelectTrigger className="bg-gs-bg border-gs-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="8">8% (Conservative)</SelectItem>
                      <SelectItem value="10">10% (Moderate)</SelectItem>
                      <SelectItem value="12">12% (Aggressive)</SelectItem>
                      <SelectItem value="15">15% (High Growth)</SelectItem>
                      <SelectItem value="18">18% (Very Aggressive)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="text-sm text-gs-textMuted mb-2 block">Annual Step-up (%)</label>
                  <Select value={stepUp} onValueChange={setStepUp}>
                    <SelectTrigger className="bg-gs-bg border-gs-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gs-card border-gs-border">
                      <SelectItem value="0">0% (Fixed SIP)</SelectItem>
                      <SelectItem value="5">5% (Step-up SIP)</SelectItem>
                      <SelectItem value="10">10% (Step-up SIP)</SelectItem>
                      <SelectItem value="15">15% (Step-up SIP)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gs-textDim mt-1">Increase your SIP amount annually by this %</p>
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* Results */}
        {calculations && (
          <div className="space-y-4">
            <Card className="bg-gs-card border-gs-border">
              <CardHeader>
                <CardTitle className="text-sm text-gs-textMuted">Results</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {mode === 'target' ? (
                  <div className="text-center py-4">
                    <div className="text-sm text-gs-textMuted mb-2">Required Monthly SIP</div>
                    <div className="font-display text-3xl font-bold text-gs-gold">
                      {formatCurrency(calculations.monthlySIP)}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4">
                    <div className="text-sm text-gs-textMuted mb-2">Final Amount</div>
                    <div className="font-display text-3xl font-bold text-gs-gold">
                      {formatCurrency(calculations.finalAmount)}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Card className="bg-gs-panel border-gs-border">
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 mb-1">
                        <DollarSign className="w-4 h-4 text-gs-textDim" />
                        <span className="text-xs text-gs-textMuted">Total Investment</span>
                      </div>
                      <div className="font-display text-lg font-bold text-gs-text">
                        {formatCurrency(calculations.totalInvestment)}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="bg-gs-panel border-gs-border">
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 mb-1">
                        <TrendingUp className="w-4 h-4 text-gs-pos" />
                        <span className="text-xs text-gs-textMuted">Wealth Gained</span>
                      </div>
                      <div className="font-display text-lg font-bold text-gs-pos">
                        {formatCurrency(calculations.wealthGained)}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gs-textMuted">Investment vs Returns</span>
                    <span className="text-gs-text">
                      {((calculations.wealthGained / calculations.finalAmount) * 100).toFixed(1)}% returns
                    </span>
                  </div>
                  <div className="h-4 bg-gs-panel rounded-full overflow-hidden flex">
                    <div
                      className="bg-gs-text h-full"
                      style={{ width: `${(calculations.totalInvestment / calculations.finalAmount) * 100}%` }}
                    />
                    <div
                      className="bg-gs-pos h-full"
                      style={{ width: `${(calculations.wealthGained / calculations.finalAmount) * 100}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-gs-textDim mt-1">
                    <span>Invested</span>
                    <span>Returns</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gs-card border-gs-border">
              <CardHeader>
                <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  Year-wise Breakdown
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {Array.from({ length: Math.min(calculations.years, 10) }, (_, i) => {
                    const year = i + 1;
                    const yearValue = mode === 'target'
                      ? calculations.monthlySIP * 12 * year
                      : calculations.finalAmount * (year / calculations.years);
                    
                    return (
                      <div key={year} className="flex items-center justify-between text-sm p-2 rounded bg-gs-panel">
                        <span className="text-gs-textMuted">Year {year}</span>
                        <span className="font-mono text-gs-text">{formatCurrency(yearValue)}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-gs-card border-gs-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Calculator className="w-5 h-5 text-gs-gold" /> SWP Calculator</CardTitle>
              <CardDescription>Plan regular withdrawals from your invested corpus.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Initial Corpus (₹)</label>
                <Input type="number" min="0" value={swpCorpus} onChange={(e) => setSwpCorpus(e.target.value)} placeholder="1000000" className="bg-gs-bg border-gs-border" />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Monthly Withdrawal (₹)</label>
                <Input type="number" min="0" value={swpWithdrawal} onChange={(e) => setSwpWithdrawal(e.target.value)} placeholder="10000" className="bg-gs-bg border-gs-border" />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Withdrawal Period (Years)</label>
                <Input type="number" min="1" value={swpYears} onChange={(e) => setSwpYears(e.target.value)} placeholder="10" className="bg-gs-bg border-gs-border" />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Expected Return (% p.a.)</label>
                <Select value={swpReturn} onValueChange={setSwpReturn}>
                  <SelectTrigger className="bg-gs-bg border-gs-border"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    <SelectItem value="6">6% (Conservative)</SelectItem>
                    <SelectItem value="8">8% (Moderate)</SelectItem>
                    <SelectItem value="10">10% (Growth)</SelectItem>
                    <SelectItem value="12">12% (Aggressive)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-gs-textDim">Illustrative scenario only. Actual returns and withdrawal outcomes will vary with market performance.</p>
            </CardContent>
          </Card>

          {swpCalculations ? (
            <div className="space-y-4">
              <Card className="bg-gs-card border-gs-border">
                <CardHeader><CardTitle className="text-sm text-gs-textMuted">SWP Projection</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="text-center py-3"><div className="text-sm text-gs-textMuted mb-2">Estimated Ending Corpus</div><div className={`font-display text-3xl font-bold ${swpCalculations.depletionRisk ? 'text-gs-neg' : 'text-gs-gold'}`}>{formatCurrency(swpCalculations.endingCorpus)}</div><div className={`text-xs mt-2 ${swpCalculations.depletionRisk ? 'text-gs-neg' : 'text-gs-textDim'}`}>{swpCalculations.depletionRisk ? 'Corpus may be depleted under this scenario' : 'Corpus remains after the withdrawal period'}</div></div>
                  <div className="grid grid-cols-2 gap-3">
                    <Card className="bg-gs-panel border-gs-border"><CardContent className="pt-4"><div className="text-xs text-gs-textMuted">Total Withdrawn</div><div className="font-display text-lg font-bold text-gs-text mt-1">{formatCurrency(swpCalculations.totalWithdrawn)}</div></CardContent></Card>
                    <Card className="bg-gs-panel border-gs-border"><CardContent className="pt-4"><div className="text-xs text-gs-textMuted">Estimated Gain / Loss</div><div className={`font-display text-lg font-bold mt-1 ${swpCalculations.wealthGained >= 0 ? 'text-gs-pos' : 'text-gs-neg'}`}>{formatCurrency(swpCalculations.wealthGained)}</div></CardContent></Card>
                  </div>
                  <div className="flex justify-between text-xs text-gs-textDim"><span>Monthly withdrawal</span><span>{formatCurrency(swpCalculations.withdrawal)}</span></div>
                  <div className="flex justify-between text-xs text-gs-textDim"><span>Period</span><span>{swpCalculations.years} years</span></div>
                </CardContent>
              </Card>
              <Card className="bg-gs-card border-gs-border"><CardContent className="pt-5 text-sm text-gs-textMuted"><div className="flex items-center gap-2 mb-2 text-gs-text"><Info className="w-4 h-4 text-gs-gold" /> How SWP works</div>Your monthly withdrawal is deducted while the remaining corpus compounds at the selected illustrative rate. Taxes, fees, inflation, and changing market returns are not included.</CardContent></Card>
            </div>
          ) : <Card className="bg-gs-card border-gs-border"><CardContent className="flex items-center justify-center min-h-64 text-sm text-gs-textDim">Enter your corpus, withdrawal, and period to see the projection.</CardContent></Card>}
        </div>
      )}

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <Info className="w-4 h-4" />
              What is SIP?
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gs-textMuted">
            Systematic Investment Plan (SIP) is a way to invest in mutual funds by investing a fixed amount regularly. It helps in building wealth over time through the power of compounding.
          </CardContent>
        </Card>

        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Step-up SIP
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gs-textMuted">
            Step-up SIP allows you to increase your investment amount annually by a fixed percentage. This helps you keep pace with inflation and growing income.
          </CardContent>
        </Card>

        <Card className="bg-gs-card border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
              <PieChart className="w-4 h-4" />
              Power of Compounding
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-gs-textMuted">
            Starting early and investing regularly can significantly grow your wealth. The longer you stay invested, the more your money compounds and grows.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
