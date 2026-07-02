import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { config } from '../config/unifiedConfig';
import { logger } from '../utils/logger';

/**
 * Speech-to-text via a locally installed whisper.cpp binary, invoked with `execFile` (args array, NO
 * shell) exactly like the Claude CLI model client — an uploaded audio path can never be interpreted as
 * shell. Paths come from config (`WHISPER_BIN`/`WHISPER_MODEL`), never hardcoded. whisper.cpp writes the
 * transcript to `<outBase>.txt`; we read it, then clean it up. Fail-loud: a non-zero exit or missing
 * output rejects (the control plane turns that into a 5xx rather than a silent empty transcript).
 *
 * NOTE: whisper.cpp decodes 16-bit PCM WAV. Callers must upload/convert to that format; a bad format
 * surfaces here as a loud transcription failure rather than a wrong answer.
 */
export class SttService {
  private readonly binary: string;
  private readonly model: string;

  constructor(binary: string, model: string) {
    this.binary = binary;
    this.model = model;
  }

  /** Transcribe the audio file at `audioPath` (absolute) and return the plain-text transcript. */
  async transcribe(audioPath: string): Promise<string> {
    const outBase = `${audioPath}.whisper`;
    const outTxt = `${outBase}.txt`;
    // `-otxt -of <base>` writes `<base>.txt`; `-nt` drops timestamps from any stdout it also prints.
    const args = ['-m', this.model, '-f', audioPath, '-otxt', '-of', outBase, '-nt'];

    await new Promise<void>((resolve, reject) => {
      execFile(this.binary, args, { maxBuffer: 8 * 1024 * 1024 }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      const transcript = await readFile(outTxt, 'utf8');
      return transcript.trim();
    } finally {
      // Best-effort cleanup of the sidecar transcript file; a failure here must not mask a good result.
      await unlink(outTxt).catch((err: unknown) => {
        logger.warn('stt transcript cleanup failed', { outTxt, err: String(err) });
      });
    }
  }
}

export const sttService = new SttService(config.voice.whisperBin, config.voice.whisperModel);
