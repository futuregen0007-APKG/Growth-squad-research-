import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowLeft, Check, User, Briefcase, PiggyBank, Target, TrendingUp, Shield, Clock, GraduationCap, Heart, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { FINANCIAL_GOALS, RISK_LEVELS, INVESTMENT_HORIZONS, PROFESSION_CATEGORIES, INCOME_RANGES, EXPERIENCE_LEVELS } from '@/data/financialProfileData';

const STEPS = [
  { id: 'basic', title: 'Basic Info', icon: User },
  { id: 'income', title: 'Income & Savings', icon: Briefcase },
  { id: 'goals', title: 'Financial Goals', icon: Target },
  { id: 'risk', title: 'Risk Profile', icon: Shield },
  { id: 'experience', title: 'Investment Experience', icon: TrendingUp },
  { id: 'review', title: 'Review Profile', icon: Check },
];

export default function FinancialOnboarding() {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(0);
  const [profile, setProfile] = useState({
    // Basic Info
    age: '',
    profession: '',
    dependents: 0,
    
    // Income & Savings
    annualIncome: '',
    monthlySavings: '',
    existingInvestments: 0,
    monthlyExpenses: '',
    
    // Goals
    selectedGoals: [],
    primaryGoal: '',
    targetAmount: '',
    targetYear: '',
    
    // Risk
    riskAppetite: '',
    investmentHorizon: '',
    canHandleVolatility: false,
    
    // Experience
    investmentExperience: '',
    investmentKnowledge: '',
    
    // Responsibilities
    hasEMI: false,
    hasInsurance: false,
    hasEmergencyFund: false,
  });

  const [loading, setLoading] = useState(false);

  // Check if user already has a profile
  useEffect(() => {
    const savedProfile = localStorage.getItem('financialProfile');
    if (savedProfile) {
      setProfile(JSON.parse(savedProfile));
      setCurrentStep(STEPS.length - 1); // Go to review step
    }
  }, []);

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleGoalToggle = (goalId) => {
    setProfile(prev => ({
      ...prev,
      selectedGoals: prev.selectedGoals.includes(goalId)
        ? prev.selectedGoals.filter(g => g !== goalId)
        : [...prev.selectedGoals, goalId],
      primaryGoal: prev.primaryGoal === goalId ? '' : prev.primaryGoal,
    }));
  };

  const handlePrimaryGoal = (goalId) => {
    setProfile(prev => ({
      ...prev,
      primaryGoal: goalId,
      selectedGoals: prev.selectedGoals.includes(goalId)
        ? prev.selectedGoals
        : [...prev.selectedGoals, goalId],
    }));
  };

  const handleSaveProfile = async () => {
    setLoading(true);
    try {
      localStorage.setItem('financialProfile', JSON.stringify(profile));
      localStorage.setItem('onboardingComplete', 'true');
      
      toast.success('Profile Saved', {
        description: 'Your financial profile has been saved successfully.',
      });
      
      // Navigate to dashboard
      setTimeout(() => navigate('/dashboard'), 1500);
    } catch (error) {
      toast.error('Error', {
        description: 'Failed to save profile. Please try again.',
      });
    } finally {
      setLoading(false);
    }
  };

  const progress = ((currentStep + 1) / STEPS.length) * 100;

  return (
    <div className="min-h-screen bg-gs-bg p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="font-display text-3xl md:text-4xl font-bold text-gs-text mb-2">
            Financial Profile Setup
          </h1>
          <p className="text-gs-textMuted">
            Let us understand your financial journey to provide personalized recommendations
          </p>
        </div>

        {/* Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-gs-textMuted">Step {currentStep + 1} of {STEPS.length}</span>
            <span className="text-sm text-gs-textMuted">{Math.round(progress)}% Complete</span>
          </div>
          <Progress value={progress} className="h-2" />
          <div className="flex justify-between mt-2">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              const isCompleted = index < currentStep;
              const isCurrent = index === currentStep;
              return (
                <div
                  key={step.id}
                  className={`flex flex-col items-center ${index < STEPS.length - 1 ? 'flex-1' : ''}`}
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${
                      isCompleted ? 'bg-gs-pos text-gs-bg' : isCurrent ? 'bg-gs-gold text-gs-bg' : 'bg-gs-panel text-gs-textDim'
                    }`}
                  >
                    {isCompleted ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                  </div>
                  <span className={`text-[10px] mt-1 ${isCurrent ? 'text-gs-text' : 'text-gs-textDim'}`}>
                    {step.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Step Content */}
        <Card className="bg-gs-card border-gs-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {(() => {
                const Icon = STEPS[currentStep].icon;
                return <Icon className="w-5 h-5 text-gs-gold" />;
              })()}
              {STEPS[currentStep].title}
            </CardTitle>
            <CardDescription>
              {getStepDescription(currentStep)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {renderStepContent()}
          </CardContent>
        </Card>

        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 0}
            className="border-gs-border text-gs-text hover:bg-gs-cardHover"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          
          {currentStep === STEPS.length - 1 ? (
            <Button
              onClick={handleSaveProfile}
              disabled={loading}
              className="bg-gs-gold text-gs-bg hover:bg-gs-gold/90"
            >
              {loading ? 'Saving...' : 'Complete Setup'}
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          ) : (
            <Button
              onClick={handleNext}
              disabled={!canProceed()}
              className="bg-gs-gold text-gs-bg hover:bg-gs-gold/90"
            >
              Next
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  function getStepDescription(step) {
    const descriptions = [
      'Tell us about yourself to personalize your experience',
      'Help us understand your income and savings capacity',
      'Select your financial goals - what are you saving for?',
      'Understanding your risk tolerance helps us recommend suitable investments',
      'Your investment experience helps tailor our recommendations',
      'Review your profile before completing setup',
    ];
    return descriptions[step];
  }

  function canProceed() {
    switch (currentStep) {
      case 0: // Basic Info
        return profile.age && profile.profession;
      case 1: // Income & Savings
        return profile.annualIncome && profile.monthlySavings;
      case 2: // Goals
        return profile.selectedGoals.length > 0 && profile.primaryGoal;
      case 3: // Risk
        return profile.riskAppetite && profile.investmentHorizon;
      case 4: // Experience
        return profile.investmentExperience;
      default:
        return true;
    }
  }

  function renderStepContent() {
    switch (currentStep) {
      case 0:
        return renderBasicInfo();
      case 1:
        return renderIncomeSavings();
      case 2:
        return renderGoals();
      case 3:
        return renderRiskProfile();
      case 4:
        return renderExperience();
      case 5:
        return renderReview();
      default:
        return null;
    }
  }

  function renderBasicInfo() {
    return (
      <div className="space-y-6">
        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Age</label>
          <Input
            type="number"
            value={profile.age}
            onChange={(e) => setProfile({ ...profile, age: e.target.value })}
            placeholder="Enter your age"
            className="bg-gs-bg border-gs-border"
          />
        </div>
        
        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Profession</label>
          <Select value={profile.profession} onValueChange={(value) => setProfile({ ...profile, profession: value })}>
            <SelectTrigger className="bg-gs-bg border-gs-border">
              <SelectValue placeholder="Select your profession" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              {PROFESSION_CATEGORIES.map(cat => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Number of Dependents</label>
          <Input
            type="number"
            value={profile.dependents}
            onChange={(e) => setProfile({ ...profile, dependents: parseInt(e.target.value) || 0 })}
            placeholder="0"
            className="bg-gs-bg border-gs-border"
          />
          <p className="text-xs text-gs-textDim mt-1">Family members financially dependent on you</p>
        </div>
      </div>
    );
  }

  function renderIncomeSavings() {
    return (
      <div className="space-y-6">
        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Annual Income</label>
          <Select value={profile.annualIncome} onValueChange={(value) => setProfile({ ...profile, annualIncome: value })}>
            <SelectTrigger className="bg-gs-bg border-gs-border">
              <SelectValue placeholder="Select income range" />
            </SelectTrigger>
            <SelectContent className="bg-gs-card border-gs-border">
              {INCOME_RANGES.map(range => (
                <SelectItem key={range.id} value={range.id}>{range.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Monthly Savings (₹)</label>
          <Input
            type="number"
            value={profile.monthlySavings}
            onChange={(e) => setProfile({ ...profile, monthlySavings: e.target.value })}
            placeholder="Amount you can save monthly"
            className="bg-gs-bg border-gs-border"
          />
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Monthly Expenses (₹)</label>
          <Input
            type="number"
            value={profile.monthlyExpenses}
            onChange={(e) => setProfile({ ...profile, monthlyExpenses: e.target.value })}
            placeholder="Your monthly household expenses"
            className="bg-gs-bg border-gs-border"
          />
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-2 block">Existing Investments (₹)</label>
          <Input
            type="number"
            value={profile.existingInvestments}
            onChange={(e) => setProfile({ ...profile, existingInvestments: parseInt(e.target.value) || 0 })}
            placeholder="Total value of current investments"
            className="bg-gs-bg border-gs-border"
          />
        </div>
      </div>
    );
  }

  function renderGoals() {
    return (
      <div className="space-y-6">
        <div>
          <label className="text-sm text-gs-textMuted mb-3 block">Select Your Financial Goals</label>
          <p className="text-xs text-gs-textDim mb-4">Choose all that apply. Mark your primary goal with a star.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {FINANCIAL_GOALS.map(goal => {
              const isSelected = profile.selectedGoals.includes(goal.id);
              const isPrimary = profile.primaryGoal === goal.id;
              return (
                <div
                  key={goal.id}
                  onClick={() => handleGoalToggle(goal.id)}
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                    isSelected ? 'border-gs-gold bg-gs-gold/10' : 'border-gs-border bg-gs-panel hover:border-gs-border'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{goal.icon}</span>
                      <div>
                        <div className="font-medium text-gs-text">{goal.label}</div>
                        <div className="text-xs text-gs-textMuted mt-1">{goal.description}</div>
                      </div>
                    </div>
                    {isSelected && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePrimaryGoal(goal.id);
                        }}
                        className="text-gs-gold hover:text-gs-gold/80"
                      >
                        <Zap className={`w-5 h-5 ${isPrimary ? 'fill-current' : ''}`} />
                      </button>
                    )}
                  </div>
                  {isPrimary && (
                    <div className="mt-2 text-xs text-gs-gold font-medium">
                      ⭐ Primary Goal
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {profile.primaryGoal && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-gs-border">
            <div>
              <label className="text-sm text-gs-textMuted mb-2 block">Target Amount (₹)</label>
              <Input
                type="number"
                value={profile.targetAmount}
                onChange={(e) => setProfile({ ...profile, targetAmount: e.target.value })}
                placeholder="Amount needed for primary goal"
                className="bg-gs-bg border-gs-border"
              />
            </div>
            <div>
              <label className="text-sm text-gs-textMuted mb-2 block">Target Year</label>
              <Input
                type="number"
                value={profile.targetYear}
                onChange={(e) => setProfile({ ...profile, targetYear: e.target.value })}
                placeholder="Year you want to achieve this"
                className="bg-gs-bg border-gs-border"
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderRiskProfile() {
    return (
      <div className="space-y-6">
        <div>
          <label className="text-sm text-gs-textMuted mb-3 block">Risk Appetite</label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {RISK_LEVELS.map(level => (
              <div
                key={level.id}
                onClick={() => setProfile({ ...profile, riskAppetite: level.id })}
                className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  profile.riskAppetite === level.id ? 'border-gs-gold bg-gs-gold/10' : 'border-gs-border bg-gs-panel hover:border-gs-border'
                }`}
              >
                <div className="font-medium text-gs-text">{level.label}</div>
                <div className="text-xs text-gs-textMuted mt-1">{level.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-3 block">Investment Horizon</label>
          <div className="grid grid-cols-1 gap-3">
            {INVESTMENT_HORIZONS.map(horizon => (
              <div
                key={horizon.id}
                onClick={() => setProfile({ ...profile, investmentHorizon: horizon.id })}
                className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  profile.investmentHorizon === horizon.id ? 'border-gs-gold bg-gs-gold/10' : 'border-gs-border bg-gs-panel hover:border-gs-border'
                }`}
              >
                <div className="font-medium text-gs-text">{horizon.label}</div>
                <div className="text-xs text-gs-textMuted mt-1">{horizon.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 p-4 rounded-lg border border-gs-border bg-gs-panel">
          <Checkbox
            id="volatility"
            checked={profile.canHandleVolatility}
            onCheckedChange={(checked) => setProfile({ ...profile, canHandleVolatility: checked })}
          />
          <label htmlFor="volatility" className="text-sm text-gs-text cursor-pointer">
            I understand that investments can be volatile and I am comfortable with short-term fluctuations for long-term gains
          </label>
        </div>
      </div>
    );
  }

  function renderExperience() {
    return (
      <div className="space-y-6">
        <div>
          <label className="text-sm text-gs-textMuted mb-3 block">Investment Experience</label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {EXPERIENCE_LEVELS.map(level => (
              <div
                key={level.id}
                onClick={() => setProfile({ ...profile, investmentExperience: level.id })}
                className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                  profile.investmentExperience === level.id ? 'border-gs-gold bg-gs-gold/10' : 'border-gs-border bg-gs-panel hover:border-gs-border'
                }`}
              >
                <div className="font-medium text-gs-text">{level.label}</div>
                <div className="text-xs text-gs-textMuted mt-1">{level.description}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="text-sm text-gs-textMuted mb-3 block">Financial Responsibilities</label>
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 rounded-lg border border-gs-border bg-gs-panel">
              <Checkbox
                id="emi"
                checked={profile.hasEMI}
                onCheckedChange={(checked) => setProfile({ ...profile, hasEMI: checked })}
              />
              <label htmlFor="emi" className="text-sm text-gs-text cursor-pointer">
                I have active EMIs (Home Loan, Car Loan, Personal Loan, etc.)
              </label>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg border border-gs-border bg-gs-panel">
              <Checkbox
                id="insurance"
                checked={profile.hasInsurance}
                onCheckedChange={(checked) => setProfile({ ...profile, hasInsurance: checked })}
              />
              <label htmlFor="insurance" className="text-sm text-gs-text cursor-pointer">
                I have adequate insurance coverage (Health, Life, etc.)
              </label>
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg border border-gs-border bg-gs-panel">
              <Checkbox
                id="emergency"
                checked={profile.hasEmergencyFund}
                onCheckedChange={(checked) => setProfile({ ...profile, hasEmergencyFund: checked })}
              />
              <label htmlFor="emergency" className="text-sm text-gs-text cursor-pointer">
                I have an emergency fund (3-6 months of expenses)
              </label>
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderReview() {
    const primaryGoal = FINANCIAL_GOALS.find(g => g.id === profile.primaryGoal);
    const riskLevel = RISK_LEVELS.find(r => r.id === profile.riskAppetite);
    const horizon = INVESTMENT_HORIZONS.find(h => h.id === profile.investmentHorizon);
    const experience = EXPERIENCE_LEVELS.find(e => e.id === profile.investmentExperience);
    const incomeRange = INCOME_RANGES.find(i => i.id === profile.annualIncome);

    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="bg-gs-panel border-gs-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-gs-textMuted">Basic Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gs-textDim">Age:</span>
                <span className="text-gs-text">{profile.age} years</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Profession:</span>
                <span className="text-gs-text">{profile.profession}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Dependents:</span>
                <span className="text-gs-text">{profile.dependents}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gs-panel border-gs-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-gs-textMuted">Income & Savings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gs-textDim">Annual Income:</span>
                <span className="text-gs-text">{incomeRange?.label || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Monthly Savings:</span>
                <span className="text-gs-text">₹{parseInt(profile.monthlySavings).toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Existing Investments:</span>
                <span className="text-gs-text">₹{profile.existingInvestments.toLocaleString('en-IN')}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gs-panel border-gs-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-gs-textMuted">Primary Goal</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{primaryGoal?.icon}</span>
                <span className="text-gs-text font-medium">{primaryGoal?.label}</span>
              </div>
              {profile.targetAmount && (
                <div className="flex justify-between">
                  <span className="text-gs-textDim">Target Amount:</span>
                  <span className="text-gs-text">₹{parseInt(profile.targetAmount).toLocaleString('en-IN')}</span>
                </div>
              )}
              {profile.targetYear && (
                <div className="flex justify-between">
                  <span className="text-gs-textDim">Target Year:</span>
                  <span className="text-gs-text">{profile.targetYear}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-gs-panel border-gs-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm text-gs-textMuted">Risk Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gs-textDim">Risk Appetite:</span>
                <span className="text-gs-text">{riskLevel?.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Investment Horizon:</span>
                <span className="text-gs-text">{horizon?.label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gs-textDim">Experience:</span>
                <span className="text-gs-text">{experience?.label}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="bg-gs-panel border-gs-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm text-gs-textMuted">Selected Goals</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {profile.selectedGoals.map(goalId => {
                const goal = FINANCIAL_GOALS.find(g => g.id === goalId);
                return (
                  <div key={goalId} className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-gs-card border border-gs-border">
                    <span>{goal?.icon}</span>
                    <span className="text-sm text-gs-text">{goal?.label}</span>
                    {profile.primaryGoal === goalId && <Zap className="w-3 h-3 text-gs-gold" />}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
