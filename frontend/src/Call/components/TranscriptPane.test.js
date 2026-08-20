/**
 * Tests for the transcript pane's polling.
 *
 *   CI=true npm test        (from frontend/)
 *
 * A call reaches the browser over the socket before it has been transcribed, so
 * the pane refetches the call it is showing until the transcript lands. That
 * polling is the only thing standing between a listener and a pane stuck on
 * "Transcribing…" until they reload by hand, and it had no test.
 *
 * The bug these were written for: the poll counter was a ref. Refs do not
 * re-render, so incrementing one left the effect's dependencies unchanged and
 * no second timer was scheduled - the pane polled once, three seconds in, and
 * gave up. Transcription usually takes longer than that.
 */
import { render, screen, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { configureStore } from '@reduxjs/toolkit';

import TranscriptPane from './TranscriptPane';
import { callsReducer } from '../../features/calls/callsSlice';

const CALL_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';

const pendingCall = (overrides = {}) => ({
  _id: CALL_ID,
  shortName: '2msac',
  transcriptState: 'pending',
  ...overrides
});

/** A store whose user is, or is not, a Supporter. */
const makeStore = (plan) => configureStore({
  reducer: {
    calls: callsReducer,
    user: (state = { plan, authenticated: true, hasChecked: true }) => state
  }
});

const renderPane = (call, plan = 'supporter') => render(
  <Provider store={makeStore(plan)}>
    <MemoryRouter initialEntries={['/system/2msac']}>
      <TranscriptPane call={call} />
    </MemoryRouter>
  </Provider>
);

/** Runs the timers forward, letting the dispatched thunk settle each time. */
const advance = async (ms) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  // The thunk goes through fetch; answer it with a call that is still pending
  // so polling has a reason to continue.
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, call: pendingCall() }) })
  );
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('waiting for a transcript', () => {

  it('shows that transcription is under way', () => {
    renderPane(pendingCall());

    expect(screen.getByText(/Transcribing/)).toBeInTheDocument();
  });

  /**
   * The regression test. Against the previous code this stops at 1: the pane
   * polled once and then sat there, which is exactly what a listener saw.
   */
  it('keeps polling while the call is still being transcribed', async () => {
    renderPane(pendingCall());

    await advance(3000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await advance(3000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await advance(3000);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after six tries rather than polling for ever', async () => {
    renderPane(pendingCall());

    // One interval at a time: each poll only schedules the next once the
    // re-render it causes has happened, so jumping thirty seconds in one go
    // would fire a single timer and prove nothing.
    for (let i = 0; i < 10; i++) await advance(3000);

    expect(global.fetch).toHaveBeenCalledTimes(6);
  });

  it('stops as soon as the transcript arrives', async () => {
    const { rerender } = renderPane(pendingCall());

    await advance(3000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // The refetch landed and the call now carries its transcript.
    rerender(
      <Provider store={makeStore('supporter')}>
        <MemoryRouter initialEntries={['/system/2msac']}>
          <TranscriptPane call={pendingCall({ transcriptState: 'ready', transcript: 'net control this is n0call' })} />
        </MemoryRouter>
      </Provider>
    );

    await advance(3000 * 5);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('net control this is n0call')).toBeInTheDocument();
  });

  it('does not poll for a free account, which cannot see transcripts anyway', async () => {
    renderPane(pendingCall(), 'free');

    await advance(3000 * 5);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('what each state shows', () => {

  it('offers the upsell when a transcript exists but the account cannot read it', () => {
    renderPane(pendingCall({ transcriptState: 'locked' }), 'free');

    expect(screen.getByText(/Supporter feature/)).toBeInTheDocument();
  });

  it('renders nothing at all when there is no transcript to show', () => {
    const { container } = renderPane(pendingCall({ transcriptState: 'none' }));

    // Most short overs are silence; an explanation on every one would be noise.
    expect(container).toBeEmptyDOMElement();
  });
});
