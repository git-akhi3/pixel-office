import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll } from '../server/src/worktree.js';

const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd }).toString();

/** A repo whose setup command recorded node_modules as an artifact (it was a symlink when setup ran). */
function repoWithArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), 'office-commit-'));
  sh(dir, 'git init -q && git config user.email t@t && git config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  sh(dir, 'git add . && git commit -qm init');
  writeFileSync(join(sh(dir, 'git rev-parse --absolute-git-dir').trim(), 'office-setup-artifacts'), 'node_modules\n');
  return dir;
}

describe('commitAll', () => {
  it('commits when a setup artifact became an ignored directory (npm install replaced the symlink)', async () => {
    const dir = repoWithArtifact();
    mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'vitest', 'index.js'), '');
    writeFileSync(join(dir, 'a.ts'), 'export {};\n');
    expect(await commitAll(dir, 'msg', null)).toBe(true);
    expect(sh(dir, 'git show --name-only --format= HEAD').trim()).toBe('a.ts');
  });

  it('still keeps an unignored artifact (a symlink) out of the commit', async () => {
    const dir = repoWithArtifact();
    sh(dir, `ln -s "${dir}" node_modules`);
    writeFileSync(join(dir, 'a.ts'), 'export {};\n');
    expect(await commitAll(dir, 'msg', null)).toBe(true);
    expect(sh(dir, 'git show --name-only --format= HEAD').trim()).toBe('a.ts');
  });
});
