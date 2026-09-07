import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, Cpu, AlertCircle } from "lucide-react";
import { AI_PROMPT_CHIPS } from "@/data/mockData";
import ChatSidebar from "@/components/chat/ChatSidebar";
import ChatMessageBubble from "@/components/chat/ChatMessageBubble";
import ChatComposer from "@/components/chat/ChatComposer";
import { useChatStream } from "@/hooks/useChatStream";
import * as chatApi from "@/services/chatApi";

const errorMessage = (error) => error?.response?.error || error?.message || 'Something went wrong.';

export default function AIResearch() {
  const [threads, setThreads] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState(null);

  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(null);
  const [pendingUserText, setPendingUserText] = useState(null); // optimistic user bubble while sending
  const [sendError, setSendError] = useState(null);

  const scrollRef = useRef(null);
  const lastUserTextRef = useRef(null);

  const loadThreads = useCallback(() => {
    setThreadsLoading(true);
    setThreadsError(null);
    chatApi.listThreads()
      .then((data) => setThreads(data || []))
      .catch((error) => setThreadsError(errorMessage(error)))
      .finally(() => setThreadsLoading(false));
  }, []);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const loadThreadMessages = useCallback((threadId) => {
    if (!threadId) { setMessages([]); return; }
    setMessagesLoading(true);
    setMessagesError(null);
    chatApi.getThread(threadId)
      .then((data) => setMessages(data.messages || []))
      .catch((error) => setMessagesError(errorMessage(error)))
      .finally(() => setMessagesLoading(false));
  }, []);

  const { send, stop, isStreaming, draft } = useChatStream({
    threadId: activeThreadId,
    onThreadCreated: (newThreadId) => {
      setActiveThreadId(newThreadId);
      loadThreads();
    },
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, draft, pendingUserText]);

  const handleSend = useCallback((text) => {
    setSendError(null);
    setPendingUserText(text);
    lastUserTextRef.current = text;
    send(text)
      .then((result) => {
        if (!result) return;
        setPendingUserText(null);
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: text, createdAt: new Date().toISOString() },
          { role: 'assistant', content: result.content || '', citations: result.citations || [], toolActivity: result.toolActivity || [], createdAt: new Date().toISOString(), status: result.aborted ? 'ABORTED' : 'COMPLETE' },
        ]);
        loadThreads(); // title may have been set from the first message
      })
      .catch((error) => {
        setPendingUserText(null);
        setSendError(errorMessage(error));
      });
  }, [send, loadThreads]);

  const handleRegenerate = useCallback(() => {
    if (!lastUserTextRef.current || isStreaming) return;
    setMessages((prev) => prev.slice(0, -1)); // drop the last assistant answer; a fresh one is appended on completion
    handleSend(lastUserTextRef.current);
  }, [handleSend, isStreaming]);

  const handleNewChat = () => {
    setActiveThreadId(null);
    setMessages([]);
    setMessagesError(null);
    setSendError(null);
  };

  const handleSelectThread = (threadId) => {
    if (isStreaming) return;
    setActiveThreadId(threadId);
    loadThreadMessages(threadId);
  };

  const handleRenameThread = (threadId, title) => {
    chatApi.renameThread(threadId, title)
      .then(() => loadThreads())
      .catch((error) => setThreadsError(errorMessage(error)));
  };

  const handleDeleteThread = (threadId) => {
    chatApi.deleteThread(threadId)
      .then(() => {
        if (threadId === activeThreadId) handleNewChat();
        loadThreads();
      })
      .catch((error) => setThreadsError(errorMessage(error)));
  };

  const showEmptyState = !messages.length && !pendingUserText && !draft && !messagesLoading;

  return (
    <div className="grid grid-cols-12 gap-4 animate-fade-up lg:h-[calc(100vh-3.5rem-2.25rem-3rem)]" data-testid="ai-research-page">
      <ChatSidebar
        chips={AI_PROMPT_CHIPS}
        onSelectPrompt={handleSend}
        threads={threads}
        threadsLoading={threadsLoading}
        threadsError={threadsError}
        activeThreadId={activeThreadId}
        onNewChat={handleNewChat}
        onSelectThread={handleSelectThread}
        onRenameThread={handleRenameThread}
        onDeleteThread={handleDeleteThread}
      />

      <section className="col-span-12 lg:col-span-9 flex flex-col gs-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gs-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm">
              <Cpu className="w-3.5 h-3.5 text-gs-gold" />
            </div>
            <div className="leading-tight">
              <div className="font-display font-bold text-gs-text text-sm">GS Copilot</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-gs-textDim">Indian Equities Research Assistant</div>
            </div>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-5 min-h-[400px]">
          {messagesLoading && <div className="text-sm text-gs-textDim text-center py-8">Loading conversation…</div>}
          {messagesError && (
            <div className="flex items-start gap-2 text-sm text-gs-textMuted justify-center py-8">
              <AlertCircle className="w-4 h-4 text-gs-neg flex-shrink-0 mt-0.5" /> {messagesError}
            </div>
          )}

          {showEmptyState && (
            <div className="h-full grid place-items-center text-center">
              <div>
                <div className="w-12 h-12 mx-auto grid place-items-center bg-gs-goldMuted border border-gs-gold/30 rounded-sm mb-3">
                  <Sparkles className="w-5 h-5 text-gs-gold" />
                </div>
                <h3 className="font-display font-bold text-gs-text">Ask the GS Copilot</h3>
                <p className="text-[13px] text-gs-textMuted max-w-md mt-1">
                  Synthesise earnings, build sector theses, and compare metrics across Indian equities — like an in-house equity analyst.
                </p>
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <ChatMessageBubble
              key={i}
              message={m}
              isLast={i === messages.length - 1 && m.role === 'assistant'}
              onRegenerate={handleRegenerate}
            />
          ))}

          {pendingUserText && <ChatMessageBubble message={{ role: 'user', content: pendingUserText }} />}

          {draft && (
            <ChatMessageBubble
              message={{ role: 'assistant', content: draft.content, toolActivity: draft.toolActivity, streaming: true }}
            />
          )}
          {draft && draft.status && !draft.content && (
            <div className="flex items-center gap-2 pl-10 text-[12px] text-gs-textDim" aria-live="polite" data-testid="stream-status">
              <span className="w-1.5 h-1.5 bg-gs-gold rounded-full animate-pulse-dot" />
              {draft.status}
            </div>
          )}

          {sendError && (
            <div className="flex items-start gap-2 text-sm text-gs-textMuted">
              <AlertCircle className="w-4 h-4 text-gs-neg flex-shrink-0 mt-0.5" /> {sendError}
            </div>
          )}
        </div>

        <ChatComposer onSend={handleSend} onStop={stop} isStreaming={isStreaming} />
      </section>
    </div>
  );
}
