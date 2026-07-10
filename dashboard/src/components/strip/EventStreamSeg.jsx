// -----------------------------------------------------------------------------
// EventStreamSeg.jsx - renders the real event log (see hooks/useEventLog.js).
// .stream is flex column-reverse, so rendering oldest→newest puts the newest line
// on top with the slide-in animation.
// -----------------------------------------------------------------------------
import Skeleton from '../Skeleton';

export default function EventStreamSeg({ events, loading }) {
  return (
    <div className="seg wide">
      <div className="seghead">
        <span className="ic" />
        <h3>Event Stream</h3>
      </div>
      <div className="segbody">
        <div className="stream">
          {loading && events.length === 0 ? (
            [0, 1, 2].map((i) => (
              <div className="ev info" key={i}>
                <span className="ts">
                  <Skeleton width={40} height={9} />
                </span>
                <span className="dot" />
                <Skeleton width={i === 0 ? 150 : i === 1 ? 190 : 120} height={10} />
              </div>
            ))
          ) : events.length === 0 ? (
            <div className="ev info">
              <span className="ts">--:--:--</span>
              <span className="dot" />
              <span className="ms">awaiting events…</span>
            </div>
          ) : (
            events.map((e) => (
              <div className={'ev ' + e.type} key={e.id}>
                <span className="ts">{e.ts}</span>
                <span className="dot" />
                <span className="ms">{e.msg}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
