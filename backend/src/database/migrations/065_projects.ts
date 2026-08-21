import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Projects, and where they are checked out.
 *
 * A project is the human identity of a codebase ("Truetalk"), owned by an organization, separate from
 * any one checkout of it. Until now the only thing a session could name was a runner's WORKSPACE — a
 * machine-local path hashed into an id — so "run the tests on Truetalk" had nothing to resolve
 * against. Now it does: a project, plus a binding saying which workspace on which machine IS Truetalk.
 *
 * `name` and `repo_name` are separate columns because the real projects prove they diverge
 * (Truetalk is `product_advisor`). `git_remote` is nullable and the NULL means "not stated": a binding
 * suggester must not then claim a remote matches.
 *
 * Tenancy is enforced in the database, not only in the service. `projects` carries
 * `UNIQUE (id, org_id)` so `project_workspaces` can reference `(project_id, org_id)` as a composite
 * foreign key, and `(device_id, org_id)` likewise (064 added the matching key on `runner_devices`).
 * A binding row therefore cannot exist unless its project and its device agree on the tenant — a
 * cross-tenant bind is a constraint violation, whatever code tried it.
 *
 * Sessions gain `project_id` (ON DELETE RESTRICT — projects are archived, never deleted, and the
 * RESTRICT makes any attempt to delete one a loud 409 for free) and `project_name`, a snapshot so the
 * history still reads "Truetalk" after a rename.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name varchar(120) NOT NULL,
      slug varchar(64) NOT NULL,
      repo_name varchar(120) NOT NULL,
      git_remote varchar(512),
      github_owner varchar(120),
      github_repo varchar(120),
      default_branch varchar(256) NOT NULL DEFAULT 'main',
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      description text NOT NULL DEFAULT '',
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      archived_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_projects_id_org UNIQUE (id, org_id)
    )
  `.execute(db);
  // "Truetalk" once per org, whatever the casing — the slug is the case-folded name.
  await sql`CREATE UNIQUE INDEX uq_projects_org_slug ON projects (org_id, slug)`.execute(db);
  await sql`CREATE INDEX idx_projects_org ON projects (org_id, archived_at)`.execute(db);

  await sql`
    CREATE TABLE project_workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL,
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      device_id uuid NOT NULL,
      workspace_id varchar(128) NOT NULL,
      workspace_name varchar(128) NOT NULL,
      workspace_path varchar(1024) NOT NULL,
      git_remote varchar(512),
      bound_by uuid REFERENCES users(id) ON DELETE SET NULL,
      last_verified_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      -- The tenant proof: both parents must carry THIS org_id, or the row cannot exist.
      CONSTRAINT fk_project_workspaces_project
        FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
      CONSTRAINT fk_project_workspaces_device
        FOREIGN KEY (device_id, org_id) REFERENCES runner_devices (id, org_id) ON DELETE CASCADE
    )
  `.execute(db);
  // One checkout belongs to one project …
  await sql`CREATE UNIQUE INDEX uq_project_workspaces_device_ws ON project_workspaces (device_id, workspace_id)`.execute(db);
  // … and a project has one checkout per machine.
  await sql`CREATE UNIQUE INDEX uq_project_workspaces_project_device ON project_workspaces (project_id, device_id)`.execute(db);
  await sql`CREATE INDEX idx_project_workspaces_org ON project_workspaces (org_id)`.execute(db);

  await sql`
    ALTER TABLE runner_sessions
      ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
      ADD COLUMN project_name varchar(120) NOT NULL DEFAULT ''
  `.execute(db);
  await sql`CREATE INDEX idx_runner_sessions_project ON runner_sessions (project_id) WHERE project_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_runner_sessions_project`.execute(db);
  await sql`ALTER TABLE runner_sessions DROP COLUMN IF EXISTS project_name, DROP COLUMN IF EXISTS project_id`.execute(db);
  await db.schema.dropTable('project_workspaces').execute();
  await db.schema.dropTable('projects').execute();
}
