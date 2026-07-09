import styles from './TypingIndicator.module.css';

/** The three bouncing dots shown while another participant is composing a message (pure-CSS animation). */
export function TypingIndicator(): React.JSX.Element {
  return (
    <div className={styles.bubble} aria-label="typing">
      <span className={styles.dot} />
      <span className={styles.dot} />
      <span className={styles.dot} />
    </div>
  );
}

export default TypingIndicator;
