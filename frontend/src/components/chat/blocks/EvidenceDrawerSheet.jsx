import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerClose,
} from "@/components/ui/drawer";
import CitationEntry from "./CitationEntry";

/**
 * EvidenceDrawerSheet.jsx
 * ==========================
 * UI Phase 1C.1: the evidence_drawer block's actual UI. Built on the
 * project's existing `ui/drawer.jsx` (vaul, already an installed
 * dependency — no new package), which wraps Radix's Dialog primitive
 * underneath, so a focus trap, Escape-to-close, and focus restoration to
 * whichever [N] button opened it are ALL already provided by that
 * primitive — this component does not reimplement any of that. vaul's
 * bottom-sheet layout is itself the mobile-appropriate one; the same
 * layout is used at every width (no separate desktop variant), matching
 * this being the first real consumer of the primitive in this codebase.
 *
 * Renders every entry (reusing CitationEntry — see its own note on why
 * this is the "reuse SourcesSection" the brief asks for), with the entry
 * matching `openEvidenceId` highlighted and scrolled/focused into view.
 */
export default function EvidenceDrawerSheet({ entries, open, onOpenChange, openEvidenceId }) {
  const highlightedRef = useRef(null);

  // Scrolls the highlighted entry into view on open, visually. Does NOT
  // also steal initial FOCUS to it: Radix Dialog's own FocusScope already
  // gives the drawer a sensible default initial focus, and overriding that
  // (tried via onOpenAutoFocus) interfered with the more important
  // guarantee -- focus RESTORATION to the [N] trigger when the drawer
  // closes, which Radix provides for free and this component must not
  // fight. A keyboard/screen-reader user still reaches the highlighted
  // entry by tabbing from the drawer's default focus target; it is the
  // first interactive element after the close button either way.
  useEffect(() => {
    if (open && highlightedRef.current) {
      highlightedRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [open, openEvidenceId]);

  if (!entries?.length) return null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[80vh]" data-testid="evidence-drawer">
        <DrawerHeader className="relative">
          <DrawerTitle>Sources</DrawerTitle>
          <DrawerDescription>{entries.length} cited source{entries.length !== 1 ? 's' : ''} behind this answer</DrawerDescription>
          <DrawerClose asChild>
            <button type="button" aria-label="Close" className="absolute right-4 top-4 text-gs-textDim hover:text-gs-text" data-testid="evidence-drawer-close">
              <X className="w-4 h-4" />
            </button>
          </DrawerClose>
        </DrawerHeader>
        <div className="overflow-y-auto px-4 pb-6 space-y-3">
          {entries.map((entry, index) => (
            <CitationEntry
              key={entry.evidenceId || index}
              citation={entry}
              index={index}
              allCitations={entries}
              showExcerpt
              highlighted={entry.evidenceId === openEvidenceId}
              entryRef={entry.evidenceId === openEvidenceId ? highlightedRef : undefined}
            />
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
