import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  LayoutDashboard,
  Star,
  Layers,
  CalendarDays,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { STOCKS, SECTORS } from "@/data/mockData";

export default function CommandPalette({ open, setOpen }) {
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const go = (path) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <DialogTitle className="sr-only">Universal Search</DialogTitle>
      <DialogDescription className="sr-only">
        Search tickers, sectors, or open AI research from anywhere.
      </DialogDescription>
      <CommandInput
        placeholder="Search tickers, sectors, or ask AI…"
        data-testid="command-input"
      />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Navigate">
          <CommandItem onSelect={() => go("/dashboard")}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            <span>Dashboard</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/watchlist")}>
            <Star className="mr-2 h-4 w-4" />
            <span>Watchlist</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/sectors")}>
            <Layers className="mr-2 h-4 w-4" />
            <span>Sector Intelligence</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/earnings")}>
            <CalendarDays className="mr-2 h-4 w-4" />
            <span>Earnings Intelligence</span>
          </CommandItem>
          <CommandItem onSelect={() => go("/ai-research")}>
            <Sparkles className="mr-2 h-4 w-4" />
            <span>AI Research Assistant</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Stocks">
          {STOCKS.slice(0, 14).map((s) => (
            <CommandItem
              key={s.ticker}
              onSelect={() => go(`/stock/${s.ticker}`)}
              value={`${s.ticker} ${s.name} ${s.sector}`}
            >
              <TrendingUp className="mr-2 h-4 w-4" />
              <span className="font-mono text-xs mr-2 text-gs-text">{s.ticker}</span>
              <span className="text-gs-textMuted text-xs">{s.name}</span>
              <span
                className={`ml-auto font-mono text-xs ${
                  s.changePct >= 0 ? "text-gs-pos" : "text-gs-neg"
                }`}
              >
                {s.changePct >= 0 ? "+" : ""}
                {s.changePct.toFixed(2)}%
              </span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Sectors">
          {SECTORS.map((s) => (
            <CommandItem
              key={s.id}
              onSelect={() => go("/sectors")}
              value={`sector ${s.name}`}
            >
              <Layers className="mr-2 h-4 w-4" />
              <span>{s.name}</span>
              <span
                className={`ml-auto font-mono text-xs ${
                  s.changePct >= 0 ? "text-gs-pos" : "text-gs-neg"
                }`}
              >
                {s.changePct >= 0 ? "+" : ""}
                {s.changePct.toFixed(2)}%
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
