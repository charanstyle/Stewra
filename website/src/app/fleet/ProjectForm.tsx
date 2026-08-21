import { useState } from 'react';
import type { CreateProjectRequest, Project, UpdateProjectRequest } from '@stewra/shared-types';
import styles from './FleetPage.module.css';

interface ProjectFormProps {
  /** Editing an existing project, or `null` to create one. */
  readonly project: Project | null;
  readonly busy: boolean;
  readonly onCreate: (body: CreateProjectRequest) => Promise<void>;
  readonly onUpdate: (projectId: string, body: UpdateProjectRequest) => Promise<void>;
  readonly onCancel: () => void;
}

function splitAliases(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * The user TYPES the project's name and states its GitHub parameters. Nothing here is derived from a
 * repo picker: the name is what they will say out loud ("Truetalk"), the repo name is what the
 * checkout is called (`product_advisor`), and those diverge for real projects.
 */
export default function ProjectForm({ project, busy, onCreate, onUpdate, onCancel }: ProjectFormProps): React.JSX.Element {
  const [name, setName] = useState(project?.name ?? '');
  const [repoName, setRepoName] = useState(project?.repoName ?? '');
  const [githubOwner, setGithubOwner] = useState(project?.githubOwner ?? '');
  const [githubRepo, setGithubRepo] = useState(project?.githubRepo ?? '');
  const [gitRemote, setGitRemote] = useState(project?.gitRemote ?? '');
  const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? '');
  const [aliases, setAliases] = useState(project?.aliases.join(', ') ?? '');
  const [description, setDescription] = useState(project?.description ?? '');

  const canSave = name.trim().length > 0 && repoName.trim().length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSave) return;
    if (project === null) {
      const body: CreateProjectRequest = {
        name: name.trim(),
        repoName: repoName.trim(),
        ...(githubOwner.trim() !== '' ? { githubOwner: githubOwner.trim() } : {}),
        ...(githubRepo.trim() !== '' ? { githubRepo: githubRepo.trim() } : {}),
        ...(gitRemote.trim() !== '' ? { gitRemote: gitRemote.trim() } : {}),
        ...(defaultBranch.trim() !== '' ? { defaultBranch: defaultBranch.trim() } : {}),
        aliases: splitAliases(aliases),
        description: description.trim(),
      };
      await onCreate(body);
      return;
    }
    // On edit an emptied optional field is a deliberate clear, sent as null.
    const body: UpdateProjectRequest = {
      name: name.trim(),
      repoName: repoName.trim(),
      githubOwner: githubOwner.trim() === '' ? null : githubOwner.trim(),
      githubRepo: githubRepo.trim() === '' ? null : githubRepo.trim(),
      gitRemote: gitRemote.trim() === '' ? null : gitRemote.trim(),
      ...(defaultBranch.trim() !== '' ? { defaultBranch: defaultBranch.trim() } : {}),
      aliases: splitAliases(aliases),
      description: description.trim(),
    };
    await onUpdate(project.id, body);
  };

  return (
    <div className={styles.dialog} data-testid="fleet-project-form">
      <h3 className={styles.dialogTitle}>{project === null ? 'New project' : `Edit ${project.name}`}</h3>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Name — what you call it</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Truetalk"
            data-testid="fleet-project-name"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Repository name — what the checkout is called</span>
          <input
            className={styles.input}
            value={repoName}
            onChange={(e) => setRepoName(e.target.value)}
            placeholder="product_advisor"
            data-testid="fleet-project-repo"
          />
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>GitHub owner</span>
          <input className={styles.input} value={githubOwner} onChange={(e) => setGithubOwner(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>GitHub repository</span>
          <input className={styles.input} value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Default branch</span>
          <input className={styles.input} value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="main" />
        </label>
      </div>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Git remote (optional — leave empty if unsure)</span>
          <input
            className={styles.input}
            value={gitRemote}
            onChange={(e) => setGitRemote(e.target.value)}
            placeholder="git@github.com:owner/repo.git"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Aliases — other names you say, comma-separated</span>
          <input
            className={styles.input}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="RankRise, rank"
            data-testid="fleet-project-aliases"
          />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>Description</span>
        <textarea className={styles.textarea} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <div className={styles.row}>
        <button type="button" className={styles.primary} disabled={!canSave} onClick={() => void submit()} data-testid="fleet-project-save">
          {busy ? 'Saving…' : project === null ? 'Create project' : 'Save'}
        </button>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
