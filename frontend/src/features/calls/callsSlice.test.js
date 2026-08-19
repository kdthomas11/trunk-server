/**
 * Characterization tests for the calls reducer.
 *
 *   CI=true npm test            (from frontend/)
 *
 * This is the state the call list is drawn from: which calls are on screen, in
 * what order, which have been played, and the time window used to ask for more.
 * It had no tests.
 *
 * The reducer is exercised directly with action objects rather than by running
 * the thunks, so nothing here touches fetch, the network, or the player.
 */
import {
  callsReducer,
  addCall,
  playedCall,
  getCalls,
  getOlderCalls,
  fetchCall,
  addStar,
  removeStar
} from './callsSlice';

/** A call as the backend sends it. */
const makeCall = (overrides = {}) => ({
  _id: 'aaaaaaaaaaaaaaaaaaaaaaa1',
  talkgroupNum: 145250,
  time: '2026-08-19T01:00:00.000Z',
  len: 11,
  star: false,
  transcriptState: 'none',
  ...overrides
});

const emptyState = () => callsReducer(undefined, { type: '@@INIT' });

/** State holding the given calls, as a completed getCalls would leave it. */
const stateWith = (...calls) =>
  callsReducer(emptyState(), { type: getCalls.fulfilled.type, payload: { calls } });

describe('adding calls', () => {

  it('marks a newly arrived call as not yet played', () => {
    const state = callsReducer(emptyState(), addCall(makeCall()));

    const call = state.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'];
    expect(call).toBeDefined();
    // played is client-only state - the server has no idea and never sends it.
    expect(call.played).toBe(false);
  });

  it('marks a call played once it has been listened to', () => {
    let state = callsReducer(emptyState(), addCall(makeCall()));

    state = callsReducer(state, playedCall('aaaaaaaaaaaaaaaaaaaaaaa1'));

    expect(state.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'].played).toBe(true);
  });
});

describe('loading a page of calls', () => {

  it('holds the newest call first', () => {
    const state = stateWith(
      makeCall({ _id: 'older', time: '2026-08-19T01:00:00.000Z' }),
      makeCall({ _id: 'newer', time: '2026-08-19T02:00:00.000Z' })
    );

    expect(state.data.ids[0]).toBe('newer');
  });

  it('records the window the loaded calls cover', () => {
    const state = stateWith(
      makeCall({ _id: 'older', time: '2026-08-19T01:00:00.000Z' }),
      makeCall({ _id: 'newer', time: '2026-08-19T02:00:00.000Z' })
    );

    // These two drive the "load more" requests in both directions; if they are
    // wrong the list either stops loading or fetches the same page forever.
    expect(state.newestCallTime).toBe(new Date('2026-08-19T02:00:00.000Z').getTime());
    expect(state.oldestCallTime).toBe(new Date('2026-08-19T01:00:00.000Z').getTime());
  });

  it('replaces the list, while an older page adds to it', () => {
    const first = stateWith(makeCall({ _id: 'one' }));

    const replaced = callsReducer(first, {
      type: getCalls.fulfilled.type,
      payload: { calls: [makeCall({ _id: 'two' })] }
    });
    const appended = callsReducer(first, {
      type: getOlderCalls.fulfilled.type,
      payload: { calls: [makeCall({ _id: 'two', time: '2026-08-19T00:00:00.000Z' })] }
    });

    expect(replaced.data.ids).toEqual(['two']);
    expect(appended.data.ids).toHaveLength(2);
  });

  it('clears the loading flag whether the request succeeds or fails', () => {
    const pending = callsReducer(emptyState(), { type: getCalls.pending.type });
    expect(pending.loading).toBe(true);

    const rejected = callsReducer(pending, { type: getCalls.rejected.type });
    expect(rejected.loading).toBe(false);
  });
});

describe('refreshing a single call', () => {

  it('keeps it marked played when the refreshed copy arrives', () => {
    let state = stateWith(makeCall());
    state = callsReducer(state, playedCall('aaaaaaaaaaaaaaaaaaaaaaa1'));

    state = callsReducer(state, {
      type: fetchCall.fulfilled.type,
      payload: { success: true, call: makeCall({ transcriptState: 'ready', transcript: 'hello' }) }
    });

    const call = state.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'];
    expect(call.transcriptState).toBe('ready');
    // The refresh exists to pick up a transcript. Losing `played` would make a
    // call you have already heard look unheard again.
    expect(call.played).toBe(true);
  });

  it('ignores a call that is no longer on screen', () => {
    const state = stateWith(makeCall({ _id: 'still-here' }));

    const after = callsReducer(state, {
      type: fetchCall.fulfilled.type,
      payload: { success: true, call: makeCall({ _id: 'filtered-away' }) }
    });

    // A filter change can drop a call while its refetch is still in flight;
    // reviving it would put back a row that no longer belongs on screen.
    expect(after.data.entities['filtered-away']).toBeUndefined();
    expect(after.data.ids).toEqual(['still-here']);
  });
});

describe('starring a call', () => {

  it('reflects the new star state', () => {
    const state = stateWith(makeCall());

    const after = callsReducer(state, {
      type: addStar.fulfilled.type,
      payload: { success: true, call: makeCall({ star: true }) }
    });

    expect(after.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'].star).toBe(true);
  });

  it('unstars again', () => {
    const state = stateWith(makeCall({ star: true }));

    const after = callsReducer(state, {
      type: removeStar.fulfilled.type,
      payload: { success: true, call: makeCall({ star: false }) }
    });

    expect(after.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'].star).toBe(false);
  });

  /**
   * Documents a defect rather than endorsing it.
   *
   * addStar and removeStar replace the entity wholesale with the server's copy.
   * `played` is client-only - the server has never heard of it - so starring a
   * call you have already listened to silently marks it unplayed again.
   *
   * fetchCall.fulfilled directly above has the same shape and does preserve it,
   * with a comment noting it is "the same wholesale replacement the star actions
   * use". The fix was applied to one of the three and not the other two.
   *
   * When that is fixed, this expectation flips to toBe(true) and the two star
   * reducers should carry the same guard fetchCall has.
   */
  it('loses the played flag - known defect', () => {
    let state = stateWith(makeCall());
    state = callsReducer(state, playedCall('aaaaaaaaaaaaaaaaaaaaaaa1'));
    expect(state.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'].played).toBe(true);

    const after = callsReducer(state, {
      type: addStar.fulfilled.type,
      payload: { success: true, call: makeCall({ star: true }) }
    });

    expect(after.data.entities['aaaaaaaaaaaaaaaaaaaaaaa1'].played).toBeUndefined();
  });
});
