import LandingNav from "@/components/landing/LandingNav";
import Hero from "@/components/landing/Hero";
import DashboardShowcase from "@/components/landing/DashboardShowcase";
import FeaturesGrid from "@/components/landing/FeaturesGrid";
import AIWorkflow from "@/components/landing/AIWorkflow";
import SectorShowcase from "@/components/landing/SectorShowcase";
import EarningsPreview from "@/components/landing/EarningsPreview";
import AIAssistantPreview from "@/components/landing/AIAssistantPreview";
import WhyGrowthSquad from "@/components/landing/WhyGrowthSquad";
import InstitutionalBenefits from "@/components/landing/InstitutionalBenefits";
import MarketIntelligence from "@/components/landing/MarketIntelligence";
import Testimonials from "@/components/landing/Testimonials";
import CTABanner from "@/components/landing/CTABanner";
import LandingFooter from "@/components/landing/LandingFooter";

export default function Landing() {
  return (
    <div className="bg-gs-bg text-gs-text min-h-screen overflow-x-hidden" data-testid="landing-page">
      <LandingNav />
      <Hero />
      <MarketIntelligence />
      <DashboardShowcase />
      <FeaturesGrid />
      <AIWorkflow />
      <SectorShowcase />
      <EarningsPreview />
      <AIAssistantPreview />
      <WhyGrowthSquad />
      <InstitutionalBenefits />
      <Testimonials />
      <CTABanner />
      <LandingFooter />
    </div>
  );
}
