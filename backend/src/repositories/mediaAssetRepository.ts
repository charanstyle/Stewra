import { db } from '../database/index';

/** The kinds of stored binary a media_assets row can hold (matches the migration CHECK). */
export type MediaAssetKind = 'voice_in' | 'tts_out' | 'image' | 'video' | 'audio' | 'file';

/** A stored media asset, owner-scoped so the streaming route can authorize before serving. */
export interface MediaAsset {
  readonly id: string;
  readonly ownerId: string;
  readonly conversationId: string | null;
  readonly kind: MediaAssetKind;
  /** Filename relative to UPLOADS_DIR (never an absolute path; resolved+bounds-checked on read). */
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
  readonly createdAt: string;
}

interface MediaAssetRow {
  readonly id: string;
  readonly owner_id: string;
  readonly conversation_id: string | null;
  readonly kind: MediaAssetKind;
  readonly path: string;
  readonly mime: string;
  readonly bytes: bigint;
  readonly created_at: Date;
}

const MEDIA_ASSET_COLUMNS = [
  'id',
  'owner_id',
  'conversation_id',
  'kind',
  'path',
  'mime',
  'bytes',
  'created_at',
] as const;

function toMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    ownerId: row.owner_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    path: row.path,
    mime: row.mime,
    bytes: Number(row.bytes),
    createdAt: row.created_at.toISOString(),
  };
}

export interface NewMediaAsset {
  readonly ownerId: string;
  readonly conversationId: string | null;
  readonly kind: MediaAssetKind;
  readonly path: string;
  readonly mime: string;
  readonly bytes: number;
}

export class MediaAssetRepository {
  /** Record a stored binary; returns the persisted row (its id becomes the `/media/:id` URL). */
  async create(input: NewMediaAsset): Promise<MediaAsset> {
    const row = await db
      .insertInto('media_assets')
      .values({
        owner_id: input.ownerId,
        conversation_id: input.conversationId,
        kind: input.kind,
        path: input.path,
        mime: input.mime,
        bytes: input.bytes,
      })
      .returning(MEDIA_ASSET_COLUMNS)
      .executeTakeFirstOrThrow();
    return toMediaAsset(row);
  }

  async findById(id: string): Promise<MediaAsset | undefined> {
    const row = await db
      .selectFrom('media_assets')
      .select(MEDIA_ASSET_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toMediaAsset(row) : undefined;
  }
}

export const mediaAssetRepository = new MediaAssetRepository();
