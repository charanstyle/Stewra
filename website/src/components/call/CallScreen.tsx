import { useEffect, useRef } from 'react';
import { useCall } from '../../hooks/CallContext';
import {
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
  PhoneIcon,
  PhoneOffIcon,
} from '../icons/Icons';
import styles from './CallScreen.module.css';

/**
 * The in-call surface, shown for an outgoing/connecting/active call. Binds the local and remote media
 * streams to <video> elements (audio-only calls still use <video> — the audio track plays through it)
 * and exposes mute / camera / hang-up controls.
 */
export function CallScreen(): React.JSX.Element | null {
  const { state, endCall, toggleAudio, toggleVideo } = useCall();
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localRef.current && state.localStream) {
      localRef.current.srcObject = state.localStream;
    }
  }, [state.localStream]);

  useEffect(() => {
    if (remoteRef.current && state.remoteStream) {
      remoteRef.current.srcObject = state.remoteStream;
    }
  }, [state.remoteStream]);

  const visible =
    state.phase === 'calling' || state.phase === 'connecting' || state.phase === 'active';
  if (!visible) {
    return null;
  }

  const statusText =
    state.phase === 'calling'
      ? 'Ringing…'
      : state.phase === 'connecting'
        ? 'Connecting…'
        : 'Connected';

  const isVideo = state.callType === 'video';

  return (
    <div className={styles.overlay}>
      <div className={styles.stage}>
        {isVideo ? (
          <video ref={remoteRef} className={styles.remoteVideo} autoPlay playsInline />
        ) : (
          <>
            <div className={styles.audioAvatar}>
              <PhoneIcon size={64} />
            </div>
            <video ref={remoteRef} autoPlay playsInline className={styles.hiddenAudio} />
          </>
        )}
        <div className={styles.status}>{statusText}</div>
        {isVideo && (
          <video ref={localRef} className={styles.localVideo} autoPlay playsInline muted />
        )}
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={state.audioEnabled ? styles.ctrl : styles.ctrlOff}
          onClick={toggleAudio}
          title={state.audioEnabled ? 'Mute' : 'Unmute'}
        >
          {state.audioEnabled ? <MicIcon size={22} /> : <MicOffIcon size={22} />}
        </button>
        {isVideo && (
          <button
            type="button"
            className={state.videoEnabled ? styles.ctrl : styles.ctrlOff}
            onClick={toggleVideo}
            title={state.videoEnabled ? 'Turn camera off' : 'Turn camera on'}
          >
            {state.videoEnabled ? <VideoIcon size={22} /> : <VideoOffIcon size={22} />}
          </button>
        )}
        <button type="button" className={styles.hangup} onClick={endCall} title="Hang up">
          <PhoneOffIcon size={22} />
        </button>
      </div>
    </div>
  );
}

export default CallScreen;
