import apiClient from '@/services/apiClient';
import API_BASE from '@/config/api';

/**
 * chatApi.js
 * ===========
 * Thread CRUD goes through apiClient (existing fetch wrapper — attaches
 * the Authorization header and auto-refreshes an expired access token).
 * Sending a message is a dedicated fetch-stream call: the backend responds
 * with `text/event-stream`, read here via response.body.getReader() rather
 * than a native EventSource, because EventSource cannot send a POST body
 * or an Authorization header.
 */

export const listThreads = () => apiClient.get('/api/chat/threads').then((r) => r.data);
export const createThread = (title) => apiClient.post('/api/chat/threads', { title }).then((r) => r.data);
export const getThread = (threadId) => apiClient.get(`/api/chat/threads/${threadId}`).then((r) => r.data);
export const renameThread = (threadId, title) => apiClient.patch(`/api/chat/threads/${threadId}`, { title }).then((r) => r.data);
export const deleteThread = (threadId) => apiClient.delete(`/api/chat/threads/${threadId}`).then((r) => r.data);

/**
 * sendMessageStream - POSTs the message and reads the SSE response as it
 * arrives, invoking `onEvent({ type, ...payload })` for each frame. Returns
 * an object with `promise` (resolves when the stream ends) and `abort()`
 * (stops generation and closes the connection — used by the composer's
 * Stop button and on component unmount).
 */
export const sendMessageStream = ({ threadId, message, clientMessageId, onEvent }) => {
  const controller = new AbortController();
  const path = threadId ? `/api/chat/threads/${threadId}/messages` : '/api/chat/messages';
  const accessToken = localStorage.getItem('accessToken');

  const promise = (async () => {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ message, clientMessageId }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      let parsedMessage = `Request failed (${response.status})`;
      try { parsedMessage = JSON.parse(text)?.error?.message || JSON.parse(text)?.error || parsedMessage; } catch { /* not JSON */ }
      throw new Error(parsedMessage);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const event = JSON.parse(line.slice('data: '.length));
          onEvent(event);
        } catch {
          // A malformed frame is skipped rather than crashing the stream.
        }
      }
    }
  })();

  return { promise, abort: () => controller.abort() };
};

export default {
  listThreads, createThread, getThread, renameThread, deleteThread, sendMessageStream,
};
