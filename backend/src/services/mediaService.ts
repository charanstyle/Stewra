import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { config } from '../config/unifiedConfig.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import {
  mediaAssetRepository,
  type MediaAsset,
  type MediaAssetKind,
} from '../repositories/mediaAssetRepository.js';
import { ForbiddenError, NotFoundError } from '../utils/errors.js';

/** Fallback extensions per common audio/image mime so a stored binary keeps a sensible suffix on disk. */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Owner-scoped media store. All uploaded/synthesized binaries land under `UPLOADS_DIR` with a random,
 * server-generated filename (the client never controls the path), and every read is authorized through
 * `resolveForDownload` before the route streams — audio is as access-controlled as the messages it backs.
 */
class MediaService {
  private get dir(): string {
    return config.uploads.dir;
  }

  /** Extension for a mime, defaulting to `.bin` when unknown (the mime, not the suffix, is authoritative). */
  extensionForMime(mime: string): string {
    return EXT_BY_MIME[mime] ?? '.bin';
  }

  /** Reserve a fresh absolute path (+ its UPLOADS_DIR-relative filename) for a binary about to be written. */
  async reserve(ext: string): Promise<{ filename: string; absPath: string }> {
    await mkdir(this.dir, { recursive: true });
    const filename = `${randomUUID()}${ext}`;
    return { filename, absPath: join(this.dir, filename) };
  }

  /** Write a buffer to an already-reserved absolute path. */
  async writeBuffer(absPath: string, buffer: Buffer): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(absPath, buffer);
  }

  /** Persist the asset row for a written binary. `filename` is stored relative to UPLOADS_DIR. */
  async record(input: {
    ownerId: string;
    conversationId: string | null;
    kind: MediaAssetKind;
    filename: string;
    mime: string;
    bytes: number;
  }): Promise<MediaAsset> {
    return mediaAssetRepository.create({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      kind: input.kind,
      path: input.filename,
      mime: input.mime,
      bytes: input.bytes,
    });
  }

  /** Convenience: write an uploaded buffer to disk and record it in one step. */
  async saveUpload(input: {
    ownerId: string;
    conversationId: string | null;
    kind: MediaAssetKind;
    mime: string;
    buffer: Buffer;
  }): Promise<MediaAsset> {
    const { filename, absPath } = await this.reserve(this.extensionForMime(input.mime));
    await this.writeBuffer(absPath, input.buffer);
    return this.record({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      kind: input.kind,
      filename,
      mime: input.mime,
      bytes: input.buffer.length,
    });
  }

  /** The in-app URL for an asset — served only via the authenticated GET /media/:id route. */
  urlFor(asset: MediaAsset): string {
    return `/media/${asset.id}`;
  }

  /**
   * Authorize a download and return the asset + its resolved absolute path. The caller must be the
   * owner OR an active participant of the asset's conversation. Avatars are the one exception: a profile
   * photo is visible to any authenticated user (contacts must be able to see each other's picture, and
   * they share no conversation until they start one). A missing asset is a 404; a present but
   * unauthorized one is a 403. The resolved path is bounds-checked against UPLOADS_DIR so a crafted
   * stored filename can never escape the uploads root (defense in depth — filenames are server-generated).
   */
  async resolveForDownload(
    userId: string,
    assetId: string,
  ): Promise<{ asset: MediaAsset; absPath: string }> {
    const asset = await mediaAssetRepository.findById(assetId);
    if (asset === undefined) throw new NotFoundError('Media not found');

    if (asset.kind !== 'avatar' && asset.ownerId !== userId) {
      const participant = asset.conversationId
        ? await conversationRepository.getActiveParticipant(asset.conversationId, userId)
        : undefined;
      if (participant === undefined) throw new ForbiddenError('You cannot access this media');
    }

    const root = resolve(this.dir);
    const absPath = resolve(root, asset.path);
    if (absPath !== root && !absPath.startsWith(root + sep)) {
      throw new NotFoundError('Media not found');
    }
    return { asset, absPath };
  }

  /**
   * Erase every binary this user owns from disk. Returns how many files were removed.
   *
   * The `media_assets` rows are `ON DELETE CASCADE` on `owner_id`, which makes this the ONLY window
   * in which the deletion is possible: once the `users` row goes, the rows naming these paths go
   * with it and the bytes — voice notes, photos, avatars — are unreachable orphans under
   * `UPLOADS_DIR` that no code can ever attribute to anyone again. So this runs BEFORE the DB
   * delete, and the caller must treat a failure here as a failed deletion rather than press on.
   *
   * Paths are bounds-checked against `UPLOADS_DIR` exactly as `resolveForDownload` does, for the
   * same defense-in-depth reason: filenames are server-generated, but an unbounded `rm` driven by a
   * stored string is not something to leave to that assumption.
   *
   * `force: true` is not a swallowed error — it is scoped precisely to "the file is already gone",
   * which is a legitimate state (an earlier partial deletion, or a hand-cleaned uploads dir) and one
   * where the desired end state already holds. Every other failure — a permission error, a read-only
   * mount, an I/O fault — still throws, because those mean the user's data is still on disk.
   */
  async deleteAllForOwner(ownerId: string): Promise<number> {
    const assets = await mediaAssetRepository.listForOwner(ownerId);
    const root = resolve(this.dir);
    let removed = 0;

    for (const asset of assets) {
      const absPath = resolve(root, asset.path);
      if (absPath !== root && !absPath.startsWith(root + sep)) {
        throw new Error(
          `media asset ${asset.id} resolves outside UPLOADS_DIR (${asset.path}); refusing to delete`,
        );
      }
      await rm(absPath, { force: true });
      removed += 1;
    }

    return removed;
  }
}

export const mediaService = new MediaService();
