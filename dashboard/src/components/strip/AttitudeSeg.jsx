// -----------------------------------------------------------------------------
// AttitudeSeg.jsx - yaw compass + gyro-z from /imu/data. IMU/LIDAR rows reflect
// whether those streams are actually arriving (FUSED/OK vs LOST/-).
// -----------------------------------------------------------------------------
import { toDeg, signed } from '../../lib/geometry';
import Skeleton from '../Skeleton';

export default function AttitudeSeg({ yaw, gyroZ, imuOk, lidarOk, loading }) {
  const yd = yaw != null ? toDeg(yaw) : 0;
  const wait = loading;
  return (
    <div className="seg">
      <div className="seghead">
        <span className={'ic' + (imuOk ? '' : ' off')} />
        <h3>Attitude</h3>
      </div>
      <div className="segbody">
        <div className="att">
          <svg width="74" height="74" viewBox="0 0 74 74">
            <circle cx="37" cy="37" r="30" fill="none" stroke="var(--inset)" strokeWidth="5" />
            <g transform={`rotate(${yd} 37 37)`} style={{ transition: 'transform .2s linear' }}>
              <polygon points="37,9 32,40 42,40" fill="var(--accent)" />
              <polygon points="37,65 32,40 42,40" fill="var(--inset)" />
            </g>
            <circle cx="37" cy="37" r="3" fill="var(--txt)" />
          </svg>
          <div className="vals">
            <div className="row">
              <span className="k">YAW</span>
              {wait ? <Skeleton width={48} height={11} /> : <span className="v">{yaw != null ? signed(yd, 1) + '°' : '-'}</span>}
            </div>
            <div className="row">
              <span className="k">GYRO&nbsp;Z</span>
              {wait ? <Skeleton width={48} height={11} /> : <span className="v">{gyroZ != null ? signed(gyroZ) : '-'}</span>}
            </div>
            <div className="row">
              <span className="k">IMU</span>
              {wait ? <Skeleton width={42} height={11} /> : <span className={'v ' + (imuOk ? 'ok' : 'bad')}>{imuOk ? 'FUSED' : 'LOST'}</span>}
            </div>
            <div className="row">
              <span className="k">LIDAR</span>
              {wait ? <Skeleton width={42} height={11} /> : <span className={'v ' + (lidarOk ? 'ok' : 'bad')}>{lidarOk ? 'OK' : '-'}</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
