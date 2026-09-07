import { useRef, useState } from "react";
import { Send, Square } from "lucide-react";

const MAX_LENGTH = 4000; // mirrors backend/graph/nodes/validateInput.js's MAX_INPUT_LENGTH

export default function ChatComposer({ onSend, onStop, isStreaming, disabled }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  const autoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const submit = () => {
    const text = value.trim();
    if (!text || isStreaming || disabled) return;
    onSend(text);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  return (
    <div className="border-t border-gs-border p-3">
      <div className="flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value.slice(0, MAX_LENGTH)); autoGrow(e.target); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? "Sign in to use GS Copilot…" : "Ask about a stock, sector, earnings call or thesis…"}
          disabled={disabled}
          rows={1}
          className="bg-gs-bg border border-gs-border text-gs-text resize-none min-h-[44px] max-h-40 text-sm rounded-sm flex-1 px-3 py-2.5 focus:outline-none focus:border-gs-gold/50 disabled:opacity-50"
          data-testid="ai-chat-input"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="bg-gs-negBg border border-gs-neg/40 text-gs-neg px-4 py-2.5 rounded-sm font-medium text-sm hover:bg-gs-neg/10 transition-colors flex items-center gap-1.5"
            data-testid="ai-chat-stop"
          >
            <Square className="w-3.5 h-3.5" /> Stop
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!value.trim() || disabled}
            className="bg-gs-gold text-gs-bg px-4 py-2.5 rounded-sm font-medium text-sm hover:bg-gs-gold/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            data-testid="ai-chat-send"
          >
            <Send className="w-3.5 h-3.5" /> Send
          </button>
        )}
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px] font-mono text-gs-textDim uppercase tracking-wider">
        <span>Shift+Enter · new line</span>
        <span>{value.length}/{MAX_LENGTH}</span>
      </div>
    </div>
  );
}
