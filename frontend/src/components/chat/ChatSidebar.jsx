import { useState } from "react";
import { Plus, FileText, ChevronRight, Pencil, Trash2, Check, X } from "lucide-react";

const PromptChips = ({ chips, onSelect }) => (
  <div>
    <div className="gs-label mb-2">Smart Prompts</div>
    <div className="space-y-3">
      {Object.entries(
        chips.reduce((acc, c) => {
          (acc[c.category] = acc[c.category] || []).push(c);
          return acc;
        }, {}),
      ).map(([cat, group]) => {
        const accent = group[0].color === "gold" ? "text-gs-gold" : group[0].color === "red" ? "text-gs-neg" : group[0].color === "green" ? "text-gs-pos" : "text-gs-blue";
        return (
          <div key={cat}>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className={`w-1 h-1 rounded-full ${accent.replace("text-", "bg-")}`} />
              <span className="font-mono text-[9.5px] uppercase tracking-[0.18em] text-gs-textDim">{cat}</span>
            </div>
            <div className="space-y-1.5">
              {group.map((chip, i) => (
                <button
                  key={`${cat}-${i}`}
                  onClick={() => onSelect(chip.text)}
                  className="w-full text-left gs-card p-2.5 hover:bg-gs-cardHover transition-colors"
                  data-testid={`prompt-chip-${cat.toLowerCase()}-${i}`}
                >
                  <span className="text-[12px] text-gs-textMuted hover:text-gs-text leading-snug">{chip.text}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

const ThreadRow = ({ thread, active, onSelect, onRename, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);

  if (editing) {
    return (
      <div className="flex items-center gap-1 p-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onRename(thread._id, title); setEditing(false); }
            if (e.key === "Escape") setEditing(false);
          }}
          className="flex-1 bg-gs-bg border border-gs-border rounded-sm px-2 py-1 text-[12px] text-gs-text"
        />
        <button onClick={() => { onRename(thread._id, title); setEditing(false); }} className="text-gs-pos p-1"><Check className="w-3.5 h-3.5" /></button>
        <button onClick={() => setEditing(false)} className="text-gs-textDim p-1"><X className="w-3.5 h-3.5" /></button>
      </div>
    );
  }

  return (
    <div
      className={`w-full flex items-center justify-between p-3 hover:bg-gs-cardHover transition-colors group cursor-pointer ${active ? "bg-gs-cardHover" : ""}`}
      onClick={() => onSelect(thread._id)}
      data-testid={`thread-${thread._id}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <FileText className="w-3.5 h-3.5 text-gs-textDim shrink-0" />
        <span className="text-[12px] text-gs-textMuted truncate">{thread.title}</span>
      </div>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="p-1 text-gs-textDim hover:text-gs-text" data-testid={`rename-thread-${thread._id}`}>
          <Pencil className="w-3 h-3" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(thread._id); }} className="p-1 text-gs-textDim hover:text-gs-neg" data-testid={`delete-thread-${thread._id}`}>
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-gs-textDim shrink-0 group-hover:hidden" />
    </div>
  );
};

export default function ChatSidebar({
  chips, onSelectPrompt, threads, threadsLoading, threadsError, activeThreadId, onNewChat, onSelectThread, onRenameThread, onDeleteThread,
}) {
  return (
    <aside className="col-span-12 lg:col-span-3 space-y-4 overflow-y-auto pr-1">
      <button
        onClick={onNewChat}
        className="w-full flex items-center justify-center gap-2 bg-gs-gold text-gs-bg px-3 py-2 rounded-sm font-medium text-[12.5px] hover:bg-gs-gold/90 transition-colors"
        data-testid="new-chat-btn"
      >
        <Plus className="w-3.5 h-3.5" /> New chat
      </button>

      <PromptChips chips={chips} onSelect={onSelectPrompt} />

      <div>
        <div className="gs-label mb-2">Your Threads</div>
        {threadsLoading && <div className="text-[11.5px] text-gs-textDim px-1">Loading threads…</div>}
        {threadsError && <div className="text-[11.5px] text-gs-textMuted px-1">{threadsError}</div>}
        {!threadsLoading && !threadsError && threads.length === 0 && (
          <div className="text-[11.5px] text-gs-textDim px-1">No conversations yet — start one above.</div>
        )}
        {!threadsLoading && !threadsError && threads.length > 0 && (
          <div className="gs-card divide-y divide-gs-border" data-testid="thread-list">
            {threads.map((thread) => (
              <ThreadRow
                key={thread._id}
                thread={thread}
                active={thread._id === activeThreadId}
                onSelect={onSelectThread}
                onRename={onRenameThread}
                onDelete={onDeleteThread}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
