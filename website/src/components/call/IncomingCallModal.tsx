import { useCall } from '../../hooks/CallContext';
import { PhoneIcon, VideoIcon } from '../icons/Icons';
import styles from './IncomingCallModal.module.css';

/** Full-screen ring modal shown while an incoming call is ringing (phase === 'incoming'). */
export function IncomingCallModal(): React.JSX.Element | null {
  const { state, answerCall, declineCall } = useCall();

  if (state.phase !== 'incoming') {
    return null;
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.card}>
        <div className={styles.pulse}>
          {state.callType === 'video' ? <VideoIcon size={40} /> : <PhoneIcon size={40} />}
        </div>
        <div className={styles.label}>Incoming {state.callType} call</div>
        <div className={styles.actions}>
          <button type="button" className={styles.decline} onClick={declineCall}>
            Decline
          </button>
          <button type="button" className={styles.answer} onClick={() => void answerCall()}>
            Answer
          </button>
        </div>
      </div>
    </div>
  );
}

export default IncomingCallModal;
