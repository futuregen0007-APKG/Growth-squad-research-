import { useCallback, useRef, useState } from 'react';
import { sendMessageStream } from '@/services/chatApi';

let clientMessageCounter = 0;
const nextClientMessageId = () => `cm-${Date.now()}-${(clientMessageCounter += 1)}`;

/**
 * useChatStream - drives one GS Copilot send/stream cycle. Emits a
 * `draft` object the caller renders as the in-progress assistant bubble
 * (status text, accumulated tokens, tool activity) and resolves with the
 * final message ({ content, citations, warnings, intent }) once
 * message.completed arrives — or rejects on message.error / a network
 * failure, or resolves with { aborted: true } if the user stopped it.
 */
export const useChatStream = ({ threadId, onThreadCreated } = {}) => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [draft, setDraft] = useState(null); // { status, content, toolActivity: [] }
  const abortRef = useRef(null);

  const stop = useCallback(() => {
    abortRef.current?.();
  }, []);

  const send = useCallback((text) => new Promise((resolve, reject) => {
    if (!text?.trim() || isStreaming) { resolve(null); return; }

    const clientMessageId = nextClientMessageId();
    setIsStreaming(true);
    setDraft({ status: 'Sending…', content: '', toolActivity: [] });

    let settled = false;
    let latestToolActivity = [];
    const settleResolve = (value) => { if (!settled) { settled = true; resolve({ toolActivity: latestToolActivity, ...value }); } };
    const settleReject = (error) => { if (!settled) { settled = true; reject(error); } };

    const { promise, abort } = sendMessageStream({
      threadId,
      message: text,
      clientMessageId,
      onEvent: (event) => {
        if (event.type === 'message.started' && event.threadId && event.threadId !== threadId) {
          onThreadCreated?.(event.threadId);
        }
        if (event.type === 'message.completed') {
          setDraft((prev) => ({ ...(prev || { toolActivity: [] }), content: event.answer ?? prev?.content ?? '' }));
          settleResolve({
            content: event.answer,
            citations: event.citations || [],
            warnings: event.warnings || [],
            intent: event.intent,
            // Phase 4B: present only on a grounded research turn — every
            // other message keeps these as undefined/null, same as the
            // server's own additive-only contract (see ChatController.js).
            claims: event.claims || [],
            groundingStatus: event.groundingStatus || null,
            coverage: event.coverage || null,
            retrievalMode: event.retrievalMode || null,
            repairAttempted: Boolean(event.repairAttempted),
          });
          return;
        }
        if (event.type === 'message.error') {
          settleReject(new Error(event.message || 'GS Copilot ran into a problem.'));
          return;
        }
        setDraft((prev) => {
          const base = prev || { status: '', content: '', toolActivity: [] };
          switch (event.type) {
            case 'status':
              return { ...base, status: event.message };
            case 'tool.started':
              latestToolActivity = [...base.toolActivity, { tool: event.tool, status: 'running' }];
              return { ...base, toolActivity: latestToolActivity };
            case 'tool.completed':
              latestToolActivity = base.toolActivity.map((t) => (t.tool === event.tool ? {
                ...t, status: event.status, resultCount: event.resultCount, evidenceCount: event.evidenceCount, errorCode: event.errorCode,
              } : t));
              return { ...base, toolActivity: latestToolActivity };
            case 'token':
              return { ...base, status: '', content: base.content + event.token };
            default:
              return base;
          }
        });
      },
    });

    abortRef.current = abort;

    promise
      .then(() => { settleResolve({ aborted: false, content: null }); }) // no-op if message.completed already settled it
      .catch((error) => {
        if (error.name === 'AbortError') {
          setDraft((prev) => { settleResolve({ content: prev?.content || '', aborted: true }); return prev; });
        } else {
          settleReject(error);
        }
      })
      .finally(() => {
        setIsStreaming(false);
        abortRef.current = null;
        setDraft(null);
      });
  }), [threadId, isStreaming, onThreadCreated]);

  return { send, stop, isStreaming, draft };
};

export default useChatStream;
