import { execFile } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import type { BridgeVoiceNote } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import type { MediaAsset } from '../repositories/mediaAssetRepository.js';
import { mediaService } from './mediaService.js';
import { ttsService } from './ttsService.js';
import { logger } from '../utils/logger.js';

/** The one container WhatsApp renders as a voice note on every client. Pinned on the bridge wire too. */
export const VOICE_NOTE_MIME = 'audio/ogg';

/**
 * Stewra's spoken replies for WhatsApp.
 *
 * The in-app clip is the WAV Piper writes. WhatsApp will not play a WAV as a voice note — it arrives as
 * a file attachment with no play button, which is not "Stewra talking back". A voice note is OGG/Opus,
 * mono, 48 kHz, so every clip bound for WhatsApp is transcoded here with ffmpeg (the same binary STT
 * already normalises with) and stored as its own `tts_out` asset. Fail-loud throughout: a failed Piper
 * run or a failed transcode rejects, and the caller decides what the person is told.
 */
class WhatsappVoiceService {
  /** Whether spoken replies can be produced at all on this deploy (Piper and ffmpeg configured). */
  get available(): boolean {
    return config.voice.enabled;
  }

  /** Speak `text` and store it as an OGG/Opus voice-note asset owned by the user. */
  async voiceNoteFor(userId: string, conversationId: string | null, text: string): Promise<MediaAsset> {
    if (!this.available) {
      throw new Error('voice is disabled on this deploy (VOICE_ENABLED=false); cannot synthesize a voice note');
    }
    const wav = await mediaService.reserve('.wav');
    const ogg = await mediaService.reserve('.ogg');
    try {
      await ttsService.synthesize(text, wav.absPath);
      await this.transcodeToOpus(wav.absPath, ogg.absPath);
    } finally {
      // The WAV was only ever an intermediate; the OGG is the asset.
      await unlink(wav.absPath).catch((err: unknown) => {
        logger.warn('whatsapp voice: intermediate wav cleanup failed', { path: wav.absPath, err: String(err) });
      });
    }
    const { size } = await stat(ogg.absPath);
    return mediaService.record({
      ownerId: userId,
      conversationId,
      kind: 'tts_out',
      filename: ogg.filename,
      mime: VOICE_NOTE_MIME,
      bytes: size,
    });
  }

  /** The bytes of a stored voice note, as the bridge wire carries them. Owner-checked on the way. */
  async wirePayload(userId: string, assetId: string): Promise<BridgeVoiceNote> {
    const { asset, absPath } = await mediaService.resolveForDownload(userId, assetId);
    if (asset.mime !== VOICE_NOTE_MIME) {
      throw new Error(`asset ${assetId} is ${asset.mime}, not a ${VOICE_NOTE_MIME} voice note`);
    }
    const data = await readFile(absPath);
    return { data: data.toString('base64'), mime: VOICE_NOTE_MIME };
  }

  /** WAV → OGG/Opus at voice-note settings. `execFile` with an args array; nothing reaches a shell. */
  private transcodeToOpus(wavPath: string, oggPath: string): Promise<void> {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', wavPath,
      '-c:a', 'libopus',
      '-b:a', '24k',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'voip',
      oggPath,
    ];
    return new Promise<void>((resolve, reject) => {
      execFile(config.voice.ffmpegBin, args, { maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`ffmpeg opus transcode failed: ${error.message}${stderr ? ` — ${stderr}` : ''}`));
          return;
        }
        resolve();
      });
    });
  }
}

export const whatsappVoiceService = new WhatsappVoiceService();
