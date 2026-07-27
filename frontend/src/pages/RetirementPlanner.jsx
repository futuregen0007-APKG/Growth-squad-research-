import { useState, useMemo } from 'react';
import { Umbrella, TrendingUp, Calendar, DollarSign, PieChart, AlertTriangle, CheckCircle, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export default function RetirementPlanner() {
  const [currentAge, setCurrentAge] = useState('');
  const [retirementAge, setRetirementAge] = useState('60');
  const [lifeExpectancy, setLifeExpectancy] = useState('85');
  const [monthlyExpenses, setMonthlyExpenses] = useState('');
  const [currentSavings, setCurrentSavings] = useState('');
  const [expectedReturn, setExpectedReturn] = useState('12');
  const [inflationRate, setInflationRate] = useState('6');

  const calculations = useMemo(() => {
    const age = parseInt(currentAge) || 30;
    const retireAge = parseInt(retirementAge) || 60;
    const lifeExp = parseInt(lifeExpectancy) || 85;
    const expenses = parseInt(monthlyExpenses) || 50000;
    const savings = parseInt(currentSavings) || 0;
    const returnRate = parseFloat(expectedReturn) / 100 || 0.12;
    const inflation = parseFloat(inflationRate) / 100 || 0.06;

    const yearsToRetirement = retireAge - age;
    const yearsInRetirement = lifeExp - retireAge;
    const realReturn = (1 + returnRate) / (1 + inflation) - 1;

    // Calculate required corpus at retirement
    // Using the 4% rule adjusted for inflation
    const annualExpenses = expenses * 12;
    const inflationAdjustedExpenses = annualExpenses * Math.pow(1 + inflation, yearsToRetirement);
    const requiredCorpus = inflationAdjustedExpenses / 0.04; // 4% withdrawal rule

    // Calculate future value of current savings
    const futureValueSavings = savings * Math.pow(1 + returnRate, yearsToRetirement);

    // Calculate required monthly savings
    const shortfall = requiredCorpus - futureValueSavings;
    const months = yearsToRetirement * 12;
    const monthlyRate = returnRate / 12;
    const requiredMonthlySIP = shortfall > 0 
      ? shortfall * monthlyRate / (Math.pow(1 + monthlyRate, months) - 1)
      : 0;

    // Calculate retirement corpus if investing required SIP
    const futureValueSIP = requiredMonthlySIP * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
    const totalRetirementCorpus = futureValueSavings + futureValueSIP;

    // Monthly income in retirement
    const monthlyRetirementIncome = totalRetirementCorpus * 0.04 / 12;

    return {
      yearsToRetirement,
      yearsInRetirement,
      requiredCorpus,
      futureValueSavings,
      shortfall,
      requiredMonthlySIP,
      totalRetirementCorpus,
      monthlyRetirementIncome,
      inflationAdjustedExpenses,
      annualExpenses,
    };
  }, [currentAge, retirementAge, lifeExpectancy, monthlyExpenses, currentSavings, expectedReturn, inflationRate]);

  const formatCurrency = (value) => '₹' + Math.round(value).toLocaleString('en-IN');

  const isOnTrack = calculations.shortfall <= 0;

  return (
    <div className="space-y-6 animate-fade-up" data-testid="retirement-planner-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="gs-label">Financial Planning</div>
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-gs-text mt-1">
            Retirement Planner
          </h1>
          <p className="text-sm text-gs-textMuted mt-1">
            Plan your retirement and ensure financial freedom in your golden years.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Calculator */}
        <Card className="bg-gs-card border-gs-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Umbrella className="w-5 h-5 text-gs-gold" />
              Retirement Calculator
            </CardTitle>
            <CardDescription>
              Enter your details to calculate retirement needs
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Current Age</label>
                <Input
                  type="number"
                  value={currentAge}
                  onChange={(e) => setCurrentAge(e.target.value)}
                  placeholder="30"
                  className="bg-gs-bg border-gs-border"
                />
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Retirement Age</label>
                <Select value={retirementAge} onValueChange={setRetirementAge}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    <SelectItem value="55">55</SelectItem>
                    <SelectItem value="58">58</SelectItem>
                    <SelectItem value="60">60</SelectItem>
                    <SelectItem value="62">62</SelectItem>
                    <SelectItem value="65">65</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className="text-sm text-gs-textMuted mb-2 block">Life Expectancy</label>
              <Select value={lifeExpectancy} onValueChange={setLifeExpectancy}>
                <SelectTrigger className="bg-gs-bg border-gs-border">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-gs-card border-gs-border">
                  <SelectItem value="80">80 years</SelectItem>
                  <SelectItem value="85">85 years</SelectItem>
                  <SelectItem value="90">90 years</SelectItem>
                  <SelectItem value="95">95 years</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm text-gs-textMuted mb-2 block">Monthly Expenses (Current ₹)</label>
              <Input
                type="number"
                value={monthlyExpenses}
                onChange={(e) => setMonthlyExpenses(e.target.value)}
                placeholder="50000"
                className="bg-gs-bg border-gs-border"
              />
              <p className="text-xs text-gs-textDim mt-1">Your current monthly household expenses</p>
            </div>

            <div>
              <label className="text-sm text-gs-textMuted mb-2 block">Current Savings (₹)</label>
              <Input
                type="number"
                value={currentSavings}
                onChange={(e) => setCurrentSavings(e.target.value)}
                placeholder="1000000"
                className="bg-gs-bg border-gs-border"
              />
              <p className="text-xs text-gs-textDim mt-1">Total current investments and savings</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Expected Return (% p.a.)</label>
                <Select value={expectedReturn} onValueChange={setExpectedReturn}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    <SelectItem value="8">8%</SelectItem>
                    <SelectItem value="10">10%</SelectItem>
                    <SelectItem value="12">12%</SelectItem>
                    <SelectItem value="15">15%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm text-gs-textMuted mb-2 block">Inflation Rate (% p.a.)</label>
                <Select value={inflationRate} onValueChange={setInflationRate}>
                  <SelectTrigger className="bg-gs-bg border-gs-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-gs-card border-gs-border">
                    <SelectItem value="4">4%</SelectItem>
                    <SelectItem value="5">5%</SelectItem>
                    <SelectItem value="6">6%</SelectItem>
                    <SelectItem value="7">7%</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results */}
        <div className="space-y-4">
          {/* Status Card */}
          <Card className={`bg-gs-card border-2 ${isOnTrack ? 'border-gs-pos' : 'border-gs-neg'}`}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {isOnTrack ? (
                  <>
                    <CheckCircle className="w-5 h-5 text-gs-pos" />
                    <span className="text-gs-pos">On Track!</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-gs-neg" />
                    <span className="text-gs-neg">Attention Needed</span>
                  </>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isOnTrack ? (
                <p className="text-sm text-gs-text">
                  Great! Your current savings trajectory is sufficient for retirement. You're on track to achieve financial freedom.
                </p>
              ) : (
                <p className="text-sm text-gs-text">
                  You need to save more to achieve your retirement goals. Start investing the recommended monthly amount to bridge the gap.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Key Metrics */}
          <Card className="bg-gs-card border-gs-border">
            <CardHeader>
              <CardTitle className="text-sm text-gs-textMuted">Retirement Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-gs-panel">
                  <div className="text-xs text-gs-textMuted mb-1">Years to Retirement</div>
                  <div className="font-display text-xl font-bold text-gs-text">
                    {calculations.yearsToRetirement}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-gs-panel">
                  <div className="text-xs text-gs-textMuted mb-1">Years in Retirement</div>
                  <div className="font-display text-xl font-bold text-gs-text">
                    {calculations.yearsInRetirement}
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-gs-panel border border-gs-border">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-gs-textMuted">Required Corpus</span>
                  <span className="font-display text-lg font-bold text-gs-gold">
                    {formatCurrency(calculations.requiredCorpus)}
                  </span>
                </div>
                <div className="text-xs text-gs-textDim">
                  Amount needed at retirement to maintain current lifestyle
                </div>
              </div>

              <div className="p-4 rounded-lg bg-gs-panel border border-gs-border">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm text-gs-textMuted">Future Value of Savings</span>
                  <span className="font-display text-lg font-bold text-gs-text">
                    {formatCurrency(calculations.futureValueSavings)}
                  </span>
                </div>
                <div className="text-xs text-gs-textDim">
                  Your current savings will grow to this amount
                </div>
              </div>

              {!isOnTrack && (
                <div className="p-4 rounded-lg bg-gs-panel border border-gs-neg/30">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-gs-textMuted">Shortfall</span>
                    <span className="font-display text-lg font-bold text-gs-neg">
                      {formatCurrency(calculations.shortfall)}
                    </span>
                  </div>
                  <div className="text-xs text-gs-textDim">
                    Additional amount needed
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Action Required */}
          {!isOnTrack && (
            <Card className="bg-gs-card border-gs-border">
              <CardHeader>
                <CardTitle className="text-sm text-gs-textMuted flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Recommended Action
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center py-4">
                  <div className="text-sm text-gs-textMuted mb-2">Required Monthly Investment</div>
                  <div className="font-display text-3xl font-bold text-gs-gold">
                    {formatCurrency(calculations.requiredMonthlySIP)}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">
                    Invest this amount monthly to reach your retirement goal
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Detailed Breakdown */}
      <Card className="bg-gs-card border-gs-border">
        <CardHeader>
          <CardTitle className="text-sm text-gs-textMuted">Detailed Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="corpus" className="w-full">
            <TabsList className="bg-gs-panel border border-gs-border rounded-sm">
              <TabsTrigger value="corpus">Corpus Breakdown</TabsTrigger>
              <TabsTrigger value="income">Retirement Income</TabsTrigger>
              <TabsTrigger value="inflation">Inflation Impact</TabsTrigger>
            </TabsList>

            <TabsContent value="corpus" className="mt-4">
              <div className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-gs-textMuted">Future Value of Current Savings</span>
                    <span className="text-gs-text">{formatCurrency(calculations.futureValueSavings)}</span>
                  </div>
                  <Progress value={(calculations.futureValueSavings / calculations.requiredCorpus) * 100} className="h-2" />
                </div>
                {!isOnTrack && (
                  <div>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-gs-textMuted">Future Value of Required SIP</span>
                      <span className="text-gs-text">
                        {formatCurrency(calculations.totalRetirementCorpus - calculations.futureValueSavings)}
                      </span>
                    </div>
                    <Progress 
                      value={((calculations.totalRetirementCorpus - calculations.futureValueSavings) / calculations.requiredCorpus) * 100} 
                      className="h-2"
                    />
                  </div>
                )}
                <div className="pt-4 border-t border-gs-border">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium text-gs-text">Total Retirement Corpus</span>
                    <span className="font-display text-lg font-bold text-gs-gold">
                      {formatCurrency(calculations.totalRetirementCorpus)}
                    </span>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="income" className="mt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-gs-panel">
                  <div className="text-sm text-gs-textMuted mb-2">Monthly Income in Retirement</div>
                  <div className="font-display text-2xl font-bold text-gs-text">
                    {formatCurrency(calculations.monthlyRetirementIncome)}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">Based on 4% withdrawal rule</div>
                </div>
                <div className="p-4 rounded-lg bg-gs-panel">
                  <div className="text-sm text-gs-textMuted mb-2">Annual Income in Retirement</div>
                  <div className="font-display text-2xl font-bold text-gs-text">
                    {formatCurrency(calculations.monthlyRetirementIncome * 12)}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">Based on 4% withdrawal rule</div>
                </div>
                <div className="p-4 rounded-lg bg-gs-panel">
                  <div className="text-sm text-gs-textMuted mb-2">Current Annual Expenses</div>
                  <div className="font-display text-2xl font-bold text-gs-text">
                    {formatCurrency(calculations.annualExpenses)}
                  </div>
                </div>
                <div className="p-4 rounded-lg bg-gs-panel">
                  <div className="text-sm text-gs-textMuted mb-2">Inflation-Adjusted Expenses at Retirement</div>
                  <div className="font-display text-2xl font-bold text-gs-text">
                    {formatCurrency(calculations.inflationAdjustedExpenses)}
                  </div>
                  <div className="text-xs text-gs-textDim mt-1">Future value of current expenses</div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="inflation" className="mt-4">
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-gs-panel border border-gs-border">
                  <div className="flex items-center gap-2 mb-2">
                    <Info className="w-4 h-4 text-gs-gold" />
                    <span className="text-sm text-gs-textMuted">Understanding Inflation Impact</span>
                  </div>
                  <p className="text-sm text-gs-text">
                    Inflation reduces the purchasing power of money over time. At {inflationRate}% inflation, 
                    your current monthly expenses of {formatCurrency(calculations.annualExpenses / 12)} will become 
                    {formatCurrency(calculations.inflationAdjustedExpenses / 12)} per month in {calculations.yearsToRetirement} years.
                  </p>
                </div>
                <div className="p-4 rounded-lg bg-gs-panel border border-gs-border">
                  <div className="flex items-center gap-2 mb-2">
                    <PieChart className="w-4 h-4 text-gs-gold" />
                    <span className="text-sm text-gs-textMuted">4% Withdrawal Rule</span>
                  </div>
                  <p className="text-sm text-gs-text">
                    The 4% rule suggests you can safely withdraw 4% of your retirement corpus annually without depleting it over 30 years. 
                    This means you need a corpus 25 times your annual expenses.
                  </p>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
