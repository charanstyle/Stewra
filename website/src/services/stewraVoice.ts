import type { SendVoiceMessageResponse } from '@stewra/shared-types';
import { api, fetchMediaObjectUrl } from './api';

/**
 * Push-to-talk recorder for a spoken turn to Stewra (or a human voice note). Wraps `MediaRecorder`:
 * `start()` opens the mic, `stop()` resolves the recorded clip as a Blob. The caller uploads it via
 * `api.sendVoiceMessage`. Kept deliberately small — no analysis, just capture.
 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  /** Pick a container the browser can actually record; whisper.cpp-side decoding handles the codec. */
  private pickMimeType(): string {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mimeType = this.pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (event): void => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    this.recorder.start();
  }

  /** Stop recording and resolve the captured audio Blob (releasing the mic). */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new Error('Recorder not started'));
        return;
      }
      recorder.onstop = (): void => {
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.releaseStream();
        this.recorder = null;
        resolve(blob);
      };
      recorder.stop();
    });
  }

  /** Abort a recording in progress without producing a clip. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.releaseStream();
    this.recorder = null;
    this.chunks = [];
  }

  private releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
  }
}

/** A file extension matching the recorded blob's container, so the server sees a sensible filename. */
function filenameForBlob(blob: Blob): string {
  if (blob.type.includes('ogg')) {
    return 'voice.ogg';
  }
  if (blob.type.includes('mp4')) {
    return 'voice.mp4';
  }
  return 'voice.webm';
}

/** Upload a recorded clip to a conversation and return the transcribed turn (+ assistant reply if any). */
export function uploadVoiceTurn(
  conversationId: string,
  blob: Blob,
): Promise<SendVoiceMessageResponse> {
  return api.sendVoiceMessage(conversationId, blob, filenameForBlob(blob));
}

/**
 * Play a message's `audioUrl` (an authenticated `/media/:id`). Fetches it as an object URL, plays it,
 * and revokes the URL when playback finishes. Resolves when playback ends.
 */
export async function playMessageAudio(audioUrl: string): Promise<void> {
  const objectUrl = await fetchMediaObjectUrl(audioUrl);
  const audio = new Audio(objectUrl);
  await audio.play();
  await new Promise<void>((resolve) => {
    audio.onended = (): void => resolve();
    audio.onerror = (): void => resolve();
  });
  URL.revokeObjectURL(objectUrl);
}
