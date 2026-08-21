import type { ISODateString, UUID } from '../common/base';

/**
 * A PROJECT — the thing a person means when they say "run the tests on Truetalk".
 *
 * Org-owned, like every runner device and session. It is the durable, human-named identity of a
 * codebase, separate from any one checkout: `name` is what the user calls it ("Truetalk"), `repoName`
 * is what the repository is called (`product_advisor`), and the real projects this was built for prove
 * the two diverge. A session names a project; a {@link ProjectWorkspaceBinding} says where that project
 * is checked out on a given machine.
 *
 * The user TYPES the name and fills in the GitHub parameters — a project is never auto-derived from a
 * repo picker, because the machine-local path is the least stable fact about it.
 */
export interface Project {
  readonly id: UUID;
  readonly orgId: UUID;
  /** The name the user says out loud. Unique per org, case-insensitively, via `slug`. */
  readonly name: string;
  /** URL-safe handle derived from `name`; unique per org. */
  readonly slug: string;
  /** The repository's own name, e.g. `product_advisor`. Shown beside `name` when they differ. */
  readonly repoName: string;
  /**
   * The canonical git remote, when the user stated it. NULL means "not known", and that nullability is
   * load-bearing: a binding suggester must not claim a remote matches when nothing was ever declared.
   */
  readonly gitRemote: string | null;
  readonly githubOwner: string | null;
  readonly githubRepo: string | null;
  /** The branch sessions branch from, e.g. `main`. */
  readonly defaultBranch: string;
  /** Other things the user calls it — "RankRise" for LookedTwice — matched by the speech/chat layer. */
  readonly aliases: readonly string[];
  readonly description: string;
  /** Provenance only; confers nothing. Null once the creator's account is gone. */
  readonly createdBy: UUID | null;
  /** Projects are archived, never deleted: sessions keep pointing at them. */
  readonly archivedAt: ISODateString | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * Where a project is checked out on one machine — the binding between a {@link Project} and one of a
 * runner device's reported workspaces.
 *
 * Keyed by `(deviceId, workspaceId)` because a runner's `workspaceId` is derived from the absolute path
 * and therefore differs per machine. One checkout belongs to one project; a project has one checkout
 * per machine. `orgId` is carried so the database can prove the project and the device belong to the
 * same tenant.
 *
 * `workspaceName` / `workspacePath` / `gitRemote` are SNAPSHOTS of what the runner reported when the
 * binding was made. Whether the checkout is still there is a live question answered by the device's
 * latest hello, not by this row.
 */
export interface ProjectWorkspaceBinding {
  readonly id: UUID;
  readonly projectId: UUID;
  readonly orgId: UUID;
  readonly deviceId: UUID;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspacePath: string;
  readonly gitRemote: string | null;
  /** Who made the binding. Null once that account is gone. */
  readonly boundBy: UUID | null;
  /** When the runner last reported this workspace while the binding existed. Null until it has. */
  readonly lastVerifiedAt: ISODateString | null;
  readonly createdAt: ISODateString;
}
