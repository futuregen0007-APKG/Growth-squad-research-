import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import AIResearch from '@/pages/AIResearch';
import * as chatApi from '@/services/chatApi';

/** Test-only: renders the current URL search string so a test can assert on it -- MemoryRouter's history is in-memory and never touches window.location. */
const LocationProbe = () => {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
};

/**
 * aiResearchThreadUrlPersistence.test.jsx
 * ===========================================
 * UI Phase 1D: a confirmed live bug found via real browser verification --
 * reloading /ai-research lost the open thread entirely (activeThreadId was
 * plain useState, nothing persisted which thread was open across a hard
 * reload), so "refresh the page" silently dropped back to the empty
 * new-chat state instead of restoring the same conversation. Fixed by
 * making the `thread` URL query param the durable source of truth.
 */

jest.mock('@/services/chatApi');

const THREAD = { _id: 'thread-1', title: 'Tell me about TCS', updatedAt: new Date().toISOString() };
const MESSAGE = {
  _id: 'msg-1', role: 'assistant', content: 'TCS revenue was ₹240,893 Cr.', status: 'COMPLETE', createdAt: new Date().toISOString(), citations: [],
};

beforeEach(() => {
  chatApi.listThreads.mockResolvedValue([THREAD]);
  chatApi.getThread.mockResolvedValue({ thread: THREAD, messages: [MESSAGE] });
});

afterEach(() => jest.clearAllMocks());

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <LocationProbe />
    <Routes>
      <Route path="/ai-research" element={<AIResearch />} />
    </Routes>
  </MemoryRouter>,
);

test('mounting with ?thread=<id> in the URL (a reload, or a shared link) restores that exact thread\'s messages', async () => {
  renderAt('/ai-research?thread=thread-1');
  await waitFor(() => expect(chatApi.getThread).toHaveBeenCalledWith('thread-1'));
  await waitFor(() => expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument());
});

test('mounting with NO thread in the URL shows the empty new-chat state, never crashes, never calls getThread', async () => {
  renderAt('/ai-research');
  await waitFor(() => expect(chatApi.listThreads).toHaveBeenCalled());
  expect(chatApi.getThread).not.toHaveBeenCalled();
  expect(screen.getByText(/Ask the GS Copilot/i)).toBeInTheDocument();
});

test('selecting a thread from the sidebar writes its id into the URL, so a SUBSEQUENT reload would restore it', async () => {
  renderAt('/ai-research');
  await waitFor(() => expect(screen.getByTestId('thread-thread-1')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('thread-thread-1'));
  await waitFor(() => expect(chatApi.getThread).toHaveBeenCalledWith('thread-1'));
  await waitFor(() => expect(screen.getByTestId('location-probe')).toHaveTextContent('thread=thread-1'));
});

test('starting a new chat clears the thread from the URL', async () => {
  renderAt('/ai-research?thread=thread-1');
  await waitFor(() => expect(screen.getByText(/TCS revenue was/)).toBeInTheDocument());
  expect(screen.getByTestId('location-probe')).toHaveTextContent('thread=thread-1');
  fireEvent.click(screen.getByTestId('new-chat-btn'));
  await waitFor(() => expect(screen.getByText(/Ask the GS Copilot/i)).toBeInTheDocument());
  expect(screen.getByTestId('location-probe')).not.toHaveTextContent('thread=thread-1');
});
