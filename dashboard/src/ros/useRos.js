// -----------------------------------------------------------------------------
// useRos.js - rosbridge connection + auto-reconnect (spec §4, §10).
//
// The ROSLIB.Ros connection is a MODULE SINGLETON, created and connected exactly
// once - NOT inside a React effect. Why: React StrictMode (and Vite HMR) mount
// effects twice, and driving connect()/close() from an effect churns the socket.
// roslib's connect() early-returns while a transport is still closing, which
// desyncs its internal isConnected flag from the real socket and makes the next
// send() throw "WebSocket … Still in CONNECTING state" - exactly the bug that
// white-screened Phase 0. One socket, created once, sidesteps the whole race.
//
// The hook only *subscribes to status updates*; mounting/unmounting it never
// touches the socket. Returns { ros, status, url } with status one of:
//   'connecting' | 'connected' | 'reconnecting' | 'down'
// -----------------------------------------------------------------------------
import { useSyncExternalStore } from 'react';
import * as ROSLIB from 'roslib';
import { ROSBRIDGE_URL } from './topics';

const RECONNECT_MIN = 1000;   // ms
const RECONNECT_MAX = 8000;   // ms - cap so we keep retrying without hammering

let ros = null;
let currentStatus = 'connecting';
const statusListeners = new Set();

function setStatus(s) {
  currentStatus = s;
  statusListeners.forEach((fn) => fn(s));
}

function ensureRos() {
  if (ros) return ros;
  ros = new ROSLIB.Ros({});

  let backoff = RECONNECT_MIN;
  let timer = null;

  const connect = () => {
    try {
      ros.connect(ROSBRIDGE_URL);
    } catch {
      scheduleReconnect();
    }
  };
  const scheduleReconnect = () => {
    setStatus('reconnecting');
    clearTimeout(timer);
    const delay = backoff;
    timer = setTimeout(connect, delay);
    backoff = Math.min(delay * 2, RECONNECT_MAX);
  };

  ros.on('connection', () => {
    backoff = RECONNECT_MIN;
    setStatus('connected');
    console.log(`[ros] connected → ${ROSBRIDGE_URL}`);
  });
  ros.on('error', () => {
    setStatus('down');
    // roslib fires 'close' after 'error'; reconnect is scheduled there.
  });
  ros.on('close', () => {
    setStatus('down');
    console.warn('[ros] connection closed - retrying');
    scheduleReconnect();
  });

  connect();
  return ros;
}

// useSyncExternalStore is the idiomatic React 19 way to read from the module
// singleton above: it subscribes to status changes and always reads the live
// snapshot, with no setState-in-effect (which the earlier useState/useEffect
// pattern tripped the react-hooks lint on) and no risk of missing a status
// change that lands between first render and subscribe.
function subscribeStatus(cb) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}
function getStatusSnapshot() {
  return currentStatus;
}

export function useRos() {
  const rosInstance = ensureRos();
  const status = useSyncExternalStore(subscribeStatus, getStatusSnapshot);
  return { ros: rosInstance, status, url: ROSBRIDGE_URL };
}
