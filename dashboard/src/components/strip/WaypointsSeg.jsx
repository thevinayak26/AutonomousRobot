import { useMemo, useRef, useState } from 'react';
import * as ROSLIB from 'roslib';
import { TOPICS } from '../../ros/topics';
import { parseCommand } from '../../lib/commandParser';
import { WAYPOINTS } from '../../lib/waypoints';
import Skeleton from '../Skeleton';

const params = new URLSearchParams(window.location.search);
const VOICE_HOST = params.get('voicehost') || window.location.hostname || 'localhost';
const VOICE_PORT = params.get('voiceport') || '5005';
const TRANSCRIBE_URL = `http://${VOICE_HOST}:${VOICE_PORT}/transcribe`;

const Mic = ({ on }) => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" fill={on ? 'currentColor' : 'none'} />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

export default function WaypointsSeg({ ros, status, pose, loading }) {
  const connected = status === 'connected';
  const [mode, setMode] = useState('text');
  const [text, setText] = useState('');
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState('');

  const pub = useMemo(() => {
    if (!ros) return null;
    return new ROSLIB.Topic({ ros, name: TOPICS.voiceCommand.name, messageType: TOPICS.voiceCommand.type });
  }, [ros]);

  const mediaRef = useRef(null);
  const chunksRef = useRef([]);

  const send = (cmd, src) => {
    if (!cmd) { setNote(`not understood: "${src}"`); return; }
    const label = `${cmd.command}${cmd.target ? ' \u2192 ' + cmd.target : ''}`;
    if (!pub || !connected) { setNote(`no link \u00b7 would send ${label}`); return; }
    pub.publish(new ROSLIB.Message({ data: JSON.stringify(cmd) }));
    setNote(`sent ${label}`);
  };

  const sendText = () => { const t = text.trim(); if (!t) return; send(parseCommand(t), t); setText(''); };
  const sendWaypoint = (w) => send({ command: 'NAVIGATE', target: w.key }, w.name);

  const startRec = async () => {
    setNote('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setNote('transcribing\u2026');
        try {
          const fd = new FormData();
          fd.append('audio', blob, 'clip.webm');
          const res = await fetch(TRANSCRIBE_URL, { method: 'POST', body: fd });
          if (!res.ok) throw new Error(`service ${res.status}`);
          const data = await res.json();
          if (data.heard) setNote(`heard: ${data.heard}`);
          send(data.command ? { command: data.command, target: data.target ?? null } : null, data.heard || '(voice)');
        } catch (err) { setNote(`voice service down (${err.message})`); }
      };
      mr.start(); mediaRef.current = mr; setRecording(true);
    } catch { setNote('mic denied'); }
  };
  const stopRec = () => { if (mediaRef.current && recording) { mediaRef.current.stop(); setRecording(false); } };

  let activeIdx = -1;
  if (pose) {
    let best = Infinity;
    WAYPOINTS.forEach((w, i) => { const d = Math.hypot(w.x - pose.x, w.y - pose.y); if (d < best) { best = d; activeIdx = i; } });
  }

  return (
    <div className="seg">
      <div className="seghead">
        <span className="ic" />
        <h3>Destinations</h3>
        <div style={s.toggle}>
          <button onClick={() => setMode('text')} style={{ ...s.chip, ...(mode === 'text' ? s.chipOn : {}) }}>Text</button>
          <button onClick={() => setMode('voice')} style={{ ...s.chip, ...(mode === 'voice' ? s.chipOn : {}) }}>Voice</button>
        </div>
      </div>
      <div className="segbody">
        {mode === 'text' ? (
          <div style={s.row}>
            <input value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendText()}
              placeholder='"go to the dock"' style={s.input} />
            <button onClick={sendText} style={s.send} disabled={!text.trim()}>Go</button>
          </div>
        ) : (
          <button onMouseDown={startRec} onMouseUp={stopRec} onMouseLeave={stopRec}
            onTouchStart={(e) => { e.preventDefault(); startRec(); }} onTouchEnd={(e) => { e.preventDefault(); stopRec(); }}
            style={{ ...s.micBtn, ...(recording ? s.micOn : {}) }}>
            <Mic on={recording} />{recording ? 'Release to send' : 'Hold to talk'}
          </button>
        )}
        {note && <div style={s.note}>{note}</div>}
        <div style={{ marginTop: 6 }}>
          {WAYPOINTS.map((w, i) => {
            const d = pose ? Math.hypot(w.x - pose.x, w.y - pose.y) : null;
            return (
              <div className={'wp' + (i === activeIdx ? ' active' : '')} key={w.key}
                onClick={() => sendWaypoint(w)} style={{ cursor: 'pointer' }} title={`Send NAVIGATE \u2192 ${w.key}`}>
                <span className="pin" />
                <span className="nm">{w.name}</span>
                {loading ? (
                  <span className="co" style={{ marginLeft: 'auto' }}><Skeleton width={40} height={9} /></span>
                ) : (
                  <span className="co">{d != null ? d.toFixed(1) + ' m' : `${w.x}, ${w.y}`}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const s = {
  toggle: { display: 'flex', gap: 3, marginLeft: 'auto' },
  chip: { fontSize: 10, padding: '2px 7px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  chipOn: { background: 'rgba(255,255,255,0.14)', borderColor: 'rgba(255,255,255,0.3)' },
  row: { display: 'flex', gap: 6 },
  input: { flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.25)', color: 'inherit', fontSize: 12 },
  send: { padding: '5px 11px', borderRadius: 6, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: 12 },
  micBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '7px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(0,0,0,0.25)', color: 'inherit', cursor: 'pointer', fontSize: 12, userSelect: 'none' },
  micOn: { background: 'rgba(239,68,68,0.25)', borderColor: 'rgba(239,68,68,0.6)' },
  note: { fontSize: 11, opacity: 0.7, marginTop: 5 },
};
