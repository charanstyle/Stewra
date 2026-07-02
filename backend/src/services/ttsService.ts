import { execFile } from 'node:child_process';
import { config } from '../config/unifiedConfig';

/**
 * Text-to-speech via a locally installed Piper binary, invoked with `execFile` (args array, NO shell)
 * like the STT wrapper and the Claude CLI client. The text is written to Piper's STDIN — never
 * interpolated into args or a shell — so an assistant reply can't be interpreted as a command. The
 * voice model path comes from config (`PIPER_VOICE`); Piper writes a WAV to `--output_file`. Fail-loud:
 * a non-zero exit rejects so the caller degrades gracefully (reply text without audio) rather than
 * silently producing a broken clip.
 */
export class TtsService {
  private readonly binary: string;
  private readonly voice: string;

  constructor(binary: string, voice: string) {
    this.binary = binary;
    this.voice = voice;
  }

  /** Synthesize `text` to a WAV file at `outPath` (absolute). Resolves once the file is written. */
  async synthesize(text: string, outPath: string): Promise<void> {
    const args = ['--model', this.voice, '--output_file', outPath];
    await new Promise<void>((resolve, reject) => {
      const child = execFile(this.binary, args, { maxBuffer: 8 * 1024 * 1024 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      child.stdin?.end(text);
    });
  }
}

export const ttsService = new TtsService(config.voice.piperBin, config.voice.piperVoice);
