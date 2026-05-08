import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Cpu, RefreshCcw, FileText, ChevronRight } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { AI_CHAT_SUGGESTIONS, AI_SEED_CONVERSATION } from "@/data/mockData";
import { toast } from "sonner";

const MOCK_REPLIES = {
  default: `**Synthesis**

Based on disclosed filings, sell-side consensus and management commentary, here is a structured view:

• **Setup** — The current narrative is tilted constructive given improving order intake and indigenous policy support.
• **Numbers** — Consensus FY26E EPS at +24% YoY with EBITDA margin expansion of 80–120 bps.
• **Risks** — Execution timeline, working capital cycle, and policy continuity post-budget.

**Top Picks (illustrative)**: HAL, BEL, RVNL, TITAGARH

_This is a research-style synthesis from structured public data. Not investment advice._`,

  earnings: `**HAL · Q2 FY26 Earnings Synthesis**

**Top-line**
• Revenue ₹6,410 Cr (+15.2% YoY) — beat consensus by 3.4%
• Order book at ₹1.42L Cr (book-to-bill of 4.7x)

**Profitability**
• EBITDA margin 28.6% (vs 27.4% YoY) — 120 bps expansion
• PAT ₹1,520 Cr — beat by 5.8%

**Management commentary**
• LCA Mk1A delivery ramp on track for FY26
• GE-414 JV execution timeline reaffirmed
• Maintenance & overhaul vertical growing 18% YoY

**Verdict — BUY** (TP ₹5,400, +19% upside)`,

  margins: `**Banking Sector — NIM Cliff Analysis (HDFCBANK vs ICICIBANK · 8Q)**

| Quarter | HDFCBANK NIM | ICICIBANK NIM |
|---------|--------------|----------------|
| Q3 FY24 | 3.62%        | 4.43%          |
| Q4 FY24 | 3.46%        | 4.40%          |
| Q1 FY25 | 3.42%        | 4.36%          |
| Q2 FY25 | 3.46%        | 4.27%          |

**Key takeaways**
• HDFCBANK NIM compressed 16 bps post-merger — deposit cost re-pricing still in progress.
• ICICIBANK retains structural NIM advantage (~85 bps premium vs HDFCBANK).
• Forward outlook: 8–12 bps further NIM compression possible at HDFCB; ICICIBANK relatively more insulated.

**Verdict** — Prefer ICICIBANK on a relative basis through FY26.`,

  defence: `**Defence Sector — Order Book vs Revenue Heatmap**

Sorted by Book-to-Bill ratio (FY24):

| Ticker     | Order Book      | TTM Revenue | B/B Ratio |
|------------|-----------------|-------------|-----------|
| HAL        | ₹1.42L Cr       | ₹30.4K Cr   | **4.7x**  |
| BDL        | ₹19,400 Cr      | ₹2,800 Cr   | **6.9x**  |
| BEL        | ₹76,800 Cr      | ₹19,820 Cr  | **3.9x**  |
| MAZDOCK    | ₹38,400 Cr      | ₹9,840 Cr   | **3.9x**  |

**BDL** has the highest order-to-revenue conversion runway — but execution capacity is the bottleneck. **HAL** offers the cleanest combination of scale, margin and visibility.`,

  railways: AI_SEED_CONVERSATION[1].content,
};

const pickReply = (q) => {
  const lower = q.toLowerCase();
  if (lower.includes("earnings") || lower.includes("hal q2")) return MOCK_REPLIES.earnings;
  if (lower.includes("margin") || lower.includes("nim") || lower.includes("hdfc"))
    return MOCK_REPLIES.margins;
  if (lower.includes("defence") || lower.includes("order book"))
    return MOCK_REPLIES.defence;
  if (lower.includes("railway") || lower.includes("capex") || lower.includes("rvnl"))
    return MOCK_REPLIES.railways;
  return MOCK_REPLIES.default;
};

const formatMarkdown = (text) => {
  const lines = text.split("\n");
  return lines.map((ln, i) => {
    if (/^\*\*(.+)\*\*$/.test(ln.trim())) {
      const m = ln.trim().match(/^\*\*(.+)\*\*$/);
      return (
        <h4 key={i} className="font-display font-bold text-gs-text mt-3 mb-1.5 text-[14px]">
          {m[1]}
        </h4>
      );
    }
    if (ln.startsWith("• ") || ln.startsWith("- ")) {
      const inner = ln.slice(2);
      return (
        <li key={i} className="text-[13px] text-gs-textMuted leading-relaxed ml-4 list-disc">
          <span dangerouslySetInnerHTML={{ __html: renderInline(inner) }} />
        </li>
      );
    }
    if (ln.startsWith("|") && ln.includes("|")) {
      // simple table line — render as preformatted
      return (
        <div key={i} className="font-mono text-[11.5px] text-gs-text whitespace-pre">
          {ln}
        </div>
      );
    }
    if (ln.startsWith("_") && ln.endsWith("_")) {
      return (
        <p key={i} className="text-[11.5px] text-gs-textDim italic mt-3">
          {ln.slice(1, -1)}
        </p>
      );
    }
    if (ln.trim() === "") return <div key={i} className="h-1.5" />;
    return (
      <p
        key={i}
        className="text-[13px] text-gs-textMuted leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderInline(ln) }}
      />
    );
  });
};

const renderInline = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '<span class="font-semibold text-gs-text">$1</span>')
    .replace(
      /\b([A-Z]{3,10})\b/g,
      '<span class="font-mono text-gs-gold">$1</span>',
    );

export default function AIResearch() {
  const [messages, setMessages] = useState(AI_SEED_CONVERSATION);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, thinking]);

  const send = (text) => {
    const q = (text ?? input).trim();
    if (!q) return;
    setMessages((m) => [...m, { role: "user", content: q }]);
    setInput("");
    setThinking(true);
    setTimeout(() => {
      setMessages((m) => [...m, { role: "ai", content: pickReply(q) }]);
      setThinking(false);
    }, 750);
  };

  const reset = () => {
    setMessages([]);
    toast.success("Conversation cleared", {
      description: "Start a fresh research thread.",
    });
  };

  return (
    <div
      className="grid grid-cols-12 gap-4 animate-fade-up h-[calc(100vh-3.5rem-2.25rem-3rem)]"
      data-testid="ai-research-page"
    >
      {/* Left rail — suggestions & threads */}
      <aside className="col-span-12 lg:col-span-3 space-y-4">
        <div>
          <div className="gs-label mb-2">Prompts</div>
          <div className="space-y-2">
            {AI_CHAT_SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                onClick={() => send(s)}
                className="w-full text-left gs-card p-3 hover:bg-gs-cardHover transition-colors group"
                data-testid={`suggestion-${i}`}
              >
                <div className="flex items-start gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-gs-gold mt-0.5 shrink-0" />
                  <span className="text-[12.5px] text-gs-textMuted group-hover:text-gs-text leading-snug">
                    {s}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="gs-label mb-2">Recent Threads</div>
          <div className="gs-card divide-y divide-gs-border">
            {[
              "Indian Railway capex theme",
              "Defence order book mapping",
              "HDFCBANK Q2 NIM analysis",
              "Green Energy PLI II winners",
            ].map((t) => (
              <button
                key={t}
                className="w-full flex items-center justify-between p-3 hover:bg-gs-cardHover transition-colors"
              >
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-gs-textDim" />
                  <span className="text-[12px] text-gs-textMuted truncate">{t}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-gs-textDim" />
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Chat area */}
      <section className="col-span-12 lg:col-span-9 flex flex-col gs-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gs-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
              <Cpu className="w-3.5 h-3.5 text-gs-gold" />
            </div>
            <div className="leading-tight">
              <div className="font-display font-bold text-gs-text text-sm">
                GS Research Copilot
              </div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">
                Indian Equities · v1.4
              </div>
            </div>
          </div>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-gs-textDim hover:text-gs-text"
            data-testid="reset-chat-btn"
          >
            <RefreshCcw className="w-3 h-3" /> Reset
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-5 min-h-[400px]">
          {messages.length === 0 && (
            <div className="h-full grid place-items-center text-center">
              <div>
                <div className="w-12 h-12 mx-auto grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm mb-3">
                  <Sparkles className="w-5 h-5 text-gs-gold" />
                </div>
                <h3 className="font-display font-bold text-gs-text">Ask the GS Copilot</h3>
                <p className="text-[13px] text-gs-textMuted max-w-md mt-1">
                  Synthesise earnings, build sector theses, and compare metrics across Indian
                  equities — like an in-house equity analyst.
                </p>
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end" data-testid={`msg-user-${i}`}>
                <div className="bg-gs-card border border-gs-border rounded-sm px-4 py-2.5 max-w-[80%] text-[13px] text-gs-text">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3" data-testid={`msg-ai-${i}`}>
                <div className="w-7 h-7 shrink-0 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
                  <Sparkles className="w-3.5 h-3.5 text-gs-gold" />
                </div>
                <div className="flex-1 max-w-[90%] pt-0.5">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-gs-gold mb-1.5">
                    GS Copilot
                  </div>
                  <div className="space-y-0.5">{formatMarkdown(m.content)}</div>
                </div>
              </div>
            ),
          )}

          {thinking && (
            <div className="flex gap-3" data-testid="ai-thinking">
              <div className="w-7 h-7 shrink-0 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
                <Sparkles className="w-3.5 h-3.5 text-gs-gold animate-pulse" />
              </div>
              <div className="flex items-center gap-1 pt-1.5">
                <span className="w-1.5 h-1.5 bg-gs-gold rounded-full animate-pulse-dot" />
                <span
                  className="w-1.5 h-1.5 bg-gs-gold rounded-full animate-pulse-dot"
                  style={{ animationDelay: "0.2s" }}
                />
                <span
                  className="w-1.5 h-1.5 bg-gs-gold rounded-full animate-pulse-dot"
                  style={{ animationDelay: "0.4s" }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-gs-border p-3">
          <div className="flex gap-2 items-end">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask about a stock, sector, earnings call or thesis…"
              className="bg-gs-bg border-gs-border text-gs-text resize-none min-h-[44px] max-h-32 text-sm rounded-sm flex-1"
              data-testid="ai-chat-input"
            />
            <button
              onClick={() => send()}
              disabled={!input.trim() || thinking}
              className="bg-gs-gold text-gs-bg px-4 py-2.5 rounded-sm font-medium text-sm hover:bg-gs-gold/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              data-testid="ai-chat-send"
            >
              <Send className="w-3.5 h-3.5" /> Send
            </button>
          </div>
          <div className="flex items-center justify-between mt-2 text-[10px] font-mono text-gs-textDim uppercase tracking-wider">
            <span>Shift+Enter · new line</span>
            <span>Mock responses · for UI demo</span>
          </div>
        </div>
      </section>
    </div>
  );
}
