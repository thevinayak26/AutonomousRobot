// -----------------------------------------------------------------------------
// useSemanticObjects.js - subscribes /detected_objects (JSON from the laptop fusion
// node) and maintains the SAME object store the Pi's semantic_obstacles_node.py
// keeps: merge each detection into the nearest same-class object within MERGE_DIST,
// stamp it "last seen", and drop it when its class-conditioned TTL elapses. Because
// the rules and the TTL table match the Pi (see lib/semantic.js), the dashboard list
// and the map icons appear/vanish on the same timeline as the costmap and RViz.
//
// Age is measured from the dashboard's own receipt time (performance.now()), NOT the
// message's t_wall - the laptop wall clock and the browser clock are not synced, and
// "time since we last saw it" is exactly what the decay needs.
// -----------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import * as ROSLIB from 'roslib';
import { TOPICS } from './topics';
import { ttlFor, survival, P_MIN, MERGE_DIST } from '../lib/semantic';

const SAMPLE_MS = 200;   // one snapshot per ~5 Hz (matches useRobotData's cadence)
const HIST_MS = 1000;    // link-age history sample cadence (1 Hz)
const HIST_LEN = 60;     // → a rolling 60 s window for the freshness sparkline
const OPACITY_FLOOR = 0.1; // spec clamp [0.1, 1.0]
const MAX_ROWS = 20;
const EMPTY = [];
const EMPTY_LINK = { ageMs: null, count: null, sinceSubMs: null, history: EMPTY };

export function useSemanticObjects(ros, status) {
  const [objects, setObjects] = useState(EMPTY);
  const [link, setLink] = useState(EMPTY_LINK);
  const storeRef = useRef([]); // {id, cls, x, y, conf, tLast}
  const idRef = useRef(0);
  // Link freshness (Feature: /detected_objects link tile). Written on every raw
  // message, sampled by an ALWAYS-ON ticker below - so when the websocket drops,
  // the age keeps counting up and the tile honestly goes red instead of freezing.
  // Note the fusion node only publishes while it HAS detections, so a growing age
  // also (correctly) means "semantic memory decaying", mirroring the Pi's own
  // LINK_STALE warning.
  const linkRef = useRef({ lastAt: 0, count: 0, subAt: 0 });
  const histRef = useRef([]); // 1 Hz samples of message age (ms); null = none yet

  useEffect(() => {
    if (status !== 'connected') {
      storeRef.current = [];
      return undefined;
    }
    const topic = new ROSLIB.Topic({
      ros, name: TOPICS.detected.name, messageType: TOPICS.detected.type,
    });
    linkRef.current.subAt = performance.now();

    const onMsg = (msg) => {
      // Any message proves the link is alive - stamp receipt BEFORE parsing.
      linkRef.current.lastAt = performance.now();
      let payload;
      try { payload = JSON.parse(msg.data); } catch { return; }
      const dets = Array.isArray(payload.detections) ? payload.detections : [];
      linkRef.current.count = dets.length;
      const now = performance.now();
      for (const d of dets) {
        const { cls, x, y } = d;
        if (cls == null || x == null || y == null) continue;
        // Merge with the nearest existing same-class object (mirrors the Pi node).
        let best = null;
        let bestD = MERGE_DIST;
        for (const o of storeRef.current) {
          if (o.cls !== cls) continue;
          const dd = Math.hypot(o.x - x, o.y - y);
          if (dd < bestD) { best = o; bestD = dd; }
        }
        if (best) {
          best.x = x; best.y = y;
          best.conf = d.conf ?? best.conf;
          best.tLast = now;
        } else {
          idRef.current += 1;
          storeRef.current.push({ id: idRef.current, cls, x, y, conf: d.conf ?? 0, tLast: now });
        }
      }
    };
    topic.subscribe(onMsg);

    const sampler = setInterval(() => {
      const now = performance.now();
      // Drop when survival falls below P_MIN (== age > TTL, mirrors the costmap),
      // then snapshot freshest-first, capped.
      storeRef.current = storeRef.current.filter((o) => survival(o.cls, (now - o.tLast) / 1000) >= P_MIN);
      const snap = storeRef.current
        .map((o) => {
          const ttl = ttlFor(o.cls);
          const age = (now - o.tLast) / 1000;
          // Survival-probability fade: opacity = exp(-lambda_c * age), clamp [0.1, 1].
          // lambda_c is derived from the class TTL so this bottoms out exactly at the
          // costmap drop (person fast ~3 s, furniture slow).
          const opacity = Math.max(OPACITY_FLOOR, Math.min(1, survival(o.cls, age)));
          return { id: o.id, cls: o.cls, x: o.x, y: o.y, conf: o.conf, age, ttl, opacity };
        })
        .sort((a, b) => a.age - b.age)
        .slice(0, MAX_ROWS);
      setObjects(snap);
    }, SAMPLE_MS);

    return () => {
      clearInterval(sampler);
      try { topic.unsubscribe(); } catch { /* socket gone */ }
    };
  }, [ros, status]);

  // The link ticker never pauses: ageMs is measured from the last raw receipt, so
  // across a websocket drop/reconnect it just keeps growing (stale → red) and then
  // snaps fresh on the first new message. History is a rolling 60 s of 1 Hz samples.
  useEffect(() => {
    let lastHist = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      const L = linkRef.current;
      const ageMs = L.lastAt ? now - L.lastAt : null;
      if (now - lastHist >= HIST_MS) {
        lastHist = now;
        histRef.current.push(ageMs);
        if (histRef.current.length > HIST_LEN) histRef.current.shift();
      }
      setLink({
        ageMs,
        count: L.lastAt ? L.count : null,
        sinceSubMs: L.subAt ? now - L.subAt : null,
        history: histRef.current.slice(),
      });
    }, SAMPLE_MS);
    return () => clearInterval(tick);
  }, []);

  return { objects: status === 'connected' ? objects : EMPTY, link };
}
