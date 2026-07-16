import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';

/**
 * Speech-to-text via a locally installed whisper.cpp binary, invoked with `execFile` (args array, NO
 * shell) exactly like the Claude CLI model client — an uploaded audio path can never be interpreted as
 * shell. Paths come from config (`WHISPER_BIN`/`WHISPER_MODEL`/`FFMPEG_BIN`), never hardcoded. whisper.cpp
 * writes the transcript to `<outBase>.txt`; we read it, then clean it up. Fail-loud: a non-zero exit or
 * missing output rejects (the control plane turns that into a 5xx rather than a silent empty transcript).
 *
 * whisper.cpp only decodes 16 kHz mono 16-bit PCM WAV, but clients record Opus (webm/ogg) or send WAVs at
 * other sample rates. So every clip is first normalized with ffmpeg to that exact format; whisper then
 * reads the normalized copy, never the raw upload.
 */
export class SttService {
  private readonly binary: string;
  private readonly model: string;
  private readonly ffmpeg: string;

  constructor(binary: string, model: string, ffmpeg: string) {
    this.binary = binary;
    this.model = model;
    this.ffmpeg = ffmpeg;
  }

  /** Run a binary with args (no shell); reject on non-zero exit, surfacing stderr for diagnosis. */
  private run(bin: string, args: readonly string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`${bin} failed: ${error.message}${stderr ? ` — ${stderr}` : ''}`));
          return;
        }
        resolve();
      });
    });
  }

  /** Transcribe the audio file at `audioPath` (absolute) and return the plain-text transcript. */
  async transcribe(audioPath: string): Promise<string> {
    // 1. Normalize any container/codec/rate → 16 kHz mono s16 WAV that whisper.cpp can decode.
    const wav16 = `${audioPath}.16k.wav`;
    await this.run(this.ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', audioPath,
      '-ar', '16000',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      wav16,
    ]);

    // 2. Transcribe the normalized WAV. `-otxt -of <base>` writes `<base>.txt`; `-nt` drops timestamps.
    const outBase = `${audioPath}.whisper`;
    const outTxt = `${outBase}.txt`;
    try {
      await this.run(this.binary, ['-m', this.model, '-f', wav16, '-otxt', '-of', outBase, '-nt']);
      const transcript = await readFile(outTxt, 'utf8');
      return transcript.trim();
    } finally {
      // Best-effort cleanup of the normalized WAV + sidecar transcript; a failure here never masks a
      // good result (or the real error on the failure path).
      await unlink(wav16).catch((err: unknown) => {
        logger.warn('stt normalized-wav cleanup failed', { wav16, err: String(err) });
      });
      await unlink(outTxt).catch((err: unknown) => {
        logger.warn('stt transcript cleanup failed', { outTxt, err: String(err) });
      });
    }
  }
}

export const sttService = new SttService(
  config.voice.whisperBin,
  config.voice.whisperModel,
  config.voice.ffmpegBin,
);
