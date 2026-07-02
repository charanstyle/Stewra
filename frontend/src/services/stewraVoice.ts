/**
 * stewraVoice — the non-hook half of the push-to-talk Stewra-voice flow.
 * `StewraVoiceScreen` owns the actual recording (via expo-audio's hook-based
 * `useAudioRecorder`, which cannot live in a plain service class); this module
 * uploads the finished recording and resolves a playable local URI for the
 * assistant's TTS reply.
 */
import type { Message, SendVoiceMessageResponse } from '@stewra/shared-types';
import { api, fetchAuthedMediaFile } from './api';

/** Upload a finished voice recording for a conversation (stewra_ai or human). */
export async function sendVoiceTurn(
  conversationId: string,
  recordingUri: string,
): Promise<SendVoiceMessageResponse> {
  const fileName = recordingUri.split('/').pop() ?? `voice-${Date.now()}.m4a`;
  return api.sendVoiceMessage(conversationId, recordingUri, fileName, 'audio/m4a');
}

/** Resolve a message's `audioUrl` (TTS reply or voice note) to a locally-playable file URI. */
export async function resolvePlayableAudio(message: Message): Promise<string | null> {
  if (!message.audioUrl) {
    return null;
  }
  return fetchAuthedMediaFile(message.audioUrl, message.id);
}
