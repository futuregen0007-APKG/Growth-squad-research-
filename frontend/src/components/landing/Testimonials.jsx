import { Quote } from "lucide-react";

const TESTIMONIALS = [
  {
    initials: "PS",
    bg: "#D4AF37",
    name: "Priya Sharma, CFA",
    role: "Senior Equity Analyst, Mumbai",
    quote:
      "Earnings season used to be a brutal grind. With the AI copilot summarising calls and surfacing deltas vs consensus, I've cut my pre-print prep from 6 hours to 40 minutes.",
  },
  {
    initials: "RM",
    bg: "#059669",
    name: "Rohit Mehra",
    role: "Independent Trader · Founder, R-Capital",
    quote:
      "The sector heatmap and AI flow telemetry are the cleanest I've seen for Indian markets. It's the first product that genuinely respects how Indian equity actually behaves.",
  },
  {
    initials: "AK",
    bg: "#2563EB",
    name: "Aanya Krishnan",
    role: "Finance MBA, IIM-A '25",
    quote:
      "I write better case studies on GrowthSquad than I ever did with three Bloomberg subscriptions. Source citations on every AI output is a complete game-changer for academic rigour.",
  },
];

export default function Testimonials() {
  return (
    <section
      className="relative py-20 sm:py-28"
      data-testid="testimonials-section"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="max-w-3xl mb-12">
          <div className="gs-label">// Voices from the desk</div>
          <h2 className="font-display text-3xl sm:text-4xl lg:text-5xl font-bold text-gs-text mt-2 leading-tight tracking-tight">
            Trusted by India's
            <br />
            <span className="text-gs-gold">next-generation analysts.</span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {TESTIMONIALS.map((t, i) => (
            <figure
              key={t.name}
              className="gs-card p-6 flex flex-col justify-between hover:bg-gs-cardHover transition-colors"
              data-testid={`testimonial-${i}`}
            >
              <Quote className="w-5 h-5 text-gs-gold mb-4 opacity-80" />
              <blockquote className="text-[14px] text-gs-text leading-relaxed font-display font-medium">
                "{t.quote}"
              </blockquote>
              <figcaption className="mt-6 pt-4 border-t border-gs-border flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-sm grid place-items-center font-display font-bold text-gs-bg text-sm"
                  style={{ background: t.bg }}
                >
                  {t.initials}
                </div>
                <div>
                  <div className="font-display font-bold text-gs-text text-[13px]">
                    {t.name}
                  </div>
                  <div className="font-mono text-[10.5px] uppercase tracking-wider text-gs-textDim mt-0.5">
                    {t.role}
                  </div>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
