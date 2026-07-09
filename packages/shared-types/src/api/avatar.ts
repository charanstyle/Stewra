/**
 * Profile-photo upload contract. The photo itself is sent as multipart/form-data (field `avatar`) to
 * POST /users/me/avatar, so there is no JSON request body type — only the response, which returns the
 * relative URL of the stored image (`/media/{assetId}`). Every `PublicUser.avatarUrl` then resolves here.
 */
export interface UploadAvatarResponse {
  readonly avatarUrl: string;
}
