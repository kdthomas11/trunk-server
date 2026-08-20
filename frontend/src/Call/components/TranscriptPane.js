import { useEffect, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useParams } from "react-router-dom";
import { Header, Icon, Segment, Loader } from "semantic-ui-react";

import { fetchCall } from "../../features/calls/callsSlice";
import { selectIsSupporter } from "../../features/user/userSlice";

/**
 * The transcript, or an honest account of why there isn't one.
 *
 * Lives in the empty column between the call list and the info rail. It started
 * in the rail, which is 319px wide - fine for a one-line over, unreadable for
 * the 800-character ones a net produces.
 *
 * The state comes from the server, which is also the only thing that decides
 * whether the text is in the payload at all: a free account never receives it,
 * rather than receiving it and having it hidden here.
 *
 *   ready   the text
 *   pending being transcribed right now
 *   locked  there is one, but this account is not a Supporter
 *   none    nothing to show, for anybody. Renders nothing at all - most short
 *           overs are silence, and an explanation on every one would be noise.
 */
const TranscriptPane = ({ call }) => {
  const dispatch = useDispatch();
  const isSupporter = useSelector(selectIsSupporter);
  const { shortName } = useParams();

  const callId = call ? call._id : null;
  const state = call ? call.transcriptState : null;

  // A call arrives over the socket before it has been transcribed, so poll for
  // the one being looked at until the transcript lands.
  //
  // `polls` is state, not a ref. A ref does not re-render, so incrementing one
  // leaves this effect's dependencies untouched and no second timer is ever
  // scheduled - the pane polled once, three seconds in, and stopped.
  //
  // How long to wait has to scale with the call. Whisper runs at roughly a
  // quarter of realtime here, so a two-minute net over needs about thirty
  // seconds, plus up to two more for the worker to notice it. The original
  // fixed eighteen seconds came from short trunked-radio overs that transcribe
  // in five; on a net it expired seconds before the transcript landed, every
  // time. Floor for short overs, ceiling so a call that has genuinely failed
  // does not poll for ever.
  const POLL_MS = 3000;
  const budgetMs = Math.min(180000, 20000 + (call && call.len ? call.len : 0) * 500);
  const maxPolls = Math.ceil(budgetMs / POLL_MS);

  const [polls, setPolls] = useState(0);

  useEffect(() => {
    setPolls(0);
  }, [callId]);

  useEffect(() => {
    if (!callId || !isSupporter || state !== "pending") return;
    if (polls >= maxPolls) return;

    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      dispatch(fetchCall({ shortName: (call && call.shortName) || shortName, callId }));
    }, POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, isSupporter, state, callId, shortName, polls, maxPolls]);

  if (!call) return null;

  const heading = (
    <Header as="h4" className="transcript-heading">
      <Icon name="quote left" />Transcript
    </Header>
  );

  if (state === "ready" && call.transcript) {
    return (
      <div className="transcript-panel">
        {heading}
        <Segment secondary className="transcript-body">
          {call.transcript}
        </Segment>
        <div className="transcript-note">Machine transcription — may be inaccurate.</div>
      </div>
    );
  }

  if (state === "pending" && isSupporter) {
    return (
      <div className="transcript-panel">
        {heading}
        <Segment secondary className="transcript-body">
          <Loader active inline size="mini" />
          <span style={{ marginLeft: "0.75em" }}>Transcribing…</span>
        </Segment>
      </div>
    );
  }

  if (state === "locked") {
    return (
      <div className="transcript-panel">
        {heading}
        <Segment secondary textAlign="center" className="transcript-body">
          <Icon name="lock" />
          Transcripts are a Supporter feature.
          <div style={{ marginTop: "0.75em" }}>
            <a href={`${process.env.REACT_APP_ACCOUNT_SERVER}/profile`}>Become a Supporter</a>
          </div>
        </Segment>
      </div>
    );
  }

  return null;
};

export default TranscriptPane;
