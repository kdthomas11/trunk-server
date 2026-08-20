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

  /**
   * The window scales with the call, because transcription does. Whisper runs
   * at about a quarter of realtime, so an 80-second net over needs roughly
   * twenty seconds and a short over needs five. A fixed eighteen seconds - what
   * this used to be - expired before most net traffic finished.
   */
  it('waits longer for a long call than a short one', async () => {
    // A 10s over: 20s floor + 5s, so 9 polls.
    const short = renderPane(pendingCall({ len: 10 }));
    for (let i = 0; i < 12; i++) await advance(3000);
    const shortPolls = global.fetch.mock.calls.length;
    short.unmount();

    global.fetch.mockClear();

    // An 80s net over: 20s + 40s, so 20 polls.
    const long = renderPane(pendingCall({ len: 80 }));
    for (let i = 0; i < 25; i++) await advance(3000);
    const longPolls = global.fetch.mock.calls.length;
    long.unmount();

    expect(shortPolls).toBe(9);
    expect(longPolls).toBe(20);
  });

  it('still gives up rather than polling for ever', async () => {
    // One interval at a time: each poll only schedules the next once the
    // re-render it causes has happened, so jumping ahead in one go would fire a
    // single timer and prove nothing.
    renderPane(pendingCall({ len: 10 }));

    for (let i = 0; i < 30; i++) await advance(3000);

    // Bounded by the 25s budget for a 10s call, not still running at 90 seconds.
    expect(global.fetch).toHaveBeenCalledTimes(9);
  });

  it('caps the wait even for an absurdly long call', async () => {
    // 600s is the server's own maximum; the budget ceiling is three minutes.
    renderPane(pendingCall({ len: 600 }));

    for (let i = 0; i < 80; i++) await advance(3000);

    expect(global.fetch).toHaveBeenCalledTimes(60);
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
