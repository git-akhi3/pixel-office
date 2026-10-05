// Graphify code graphs (code only: tree-sitter, no LLM, no network), built by the office into
// ~/.office/graphs/<repoId>/ and served to the architect, reviewer and debugger over MCP.
// Nothing is written into the repo and no git hooks are installed.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Repo } from './db/schema.js';
import { run } from './util/exec.js';

export const GRAPHIFY_VERSION = '0.9.76';
export const GRAPHIFY_INSTALL = `uv tool install "graphifyy[mcp]==${GRAPHIFY_VERSION}"`;

/** Graph tools agents may use. The PR tools (list_prs, get_pr_impact, triage_prs) call GitHub and are left out. */
export const GRAPH_TOOLS = ['query_graph', 'get_node', 'get_neighbors', 'get_community', 'god_nodes', 'graph_stats', 'shortest_path'];
export const GRAPH_ROLES = ['architect', 'reviewer', 'debugger'];

export interface GraphStatus {
  installed: boolean;
  version: string | null;
  pinned: string;
  install: string;
}

export class Graphs {
  private building = new Set<number>();

  constructor(private dir: string) {}

  graphPath(repoId: number): string {
    return join(this.dir, String(repoId), 'graph.json');
  }

  has(repoId: number): boolean {
    return existsSync(this.graphPath(repoId));
  }

  builtAt(repoId: number): number | null {
    return this.has(repoId) ? statSync(this.graphPath(repoId)).mtimeMs : null;
  }

  isBuilding(repoId: number): boolean {
    return this.building.has(repoId);
  }

  async status(): Promise<GraphStatus> {
    const r = await run('graphify', ['--version'], { timeoutMs: 15_000 });
    const version = r.code === 0 ? ((r.stdout + r.stderr).match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown') : null;
    return { installed: version !== null, version, pinned: GRAPHIFY_VERSION, install: GRAPHIFY_INSTALL };
  }

  /** Builds or refreshes the graph from the repo's main checkout. Runs outside the repo; output goes to the office. */
  async build(repo: Repo): Promise<void> {
    if (this.building.has(repo.id)) return;
    this.building.add(repo.id);
    try {
      const out = join(this.dir, String(repo.id));
      mkdirSync(out, { recursive: true, mode: 0o700 });
      const r = await run('graphify', ['extract', repo.path, '--code-only', '--out', out], {
        cwd: out,
        env: { ...process.env, GRAPHIFY_OUT: out },
        timeoutMs: 30 * 60_000,
      });
      if (r.code !== 0) throw new Error(`graphify failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`);
      if (!this.has(repo.id)) throw new Error(`graphify finished but wrote no graph.json in ${out}`);
    } finally {
      this.building.delete(repo.id);
    }
  }

  /** MCP server config for an agent session, or undefined when this run should not get the graph. */
  mcpFor(repo: Repo, role: string): Record<string, { type: 'stdio'; command: string; args: string[] }> | undefined {
    if (!repo.graphify || !GRAPH_ROLES.includes(role) || !this.has(repo.id)) return undefined;
    const command = this.mcpBinary();
    return command ? { graphify: { type: 'stdio', command, args: [this.graphPath(repo.id)] } } : undefined;
  }

  /**
   * Absolute path of graphify-mcp, resolved from the home directory. The MCP server is started with the
   * task's worktree as cwd, so a relative PATH entry (".", node_modules/.bin) could pick up a PR's file.
   */
  private mcpBinary(): string | null {
    if (this.mcpBin === undefined) {
      try {
        const out = execFileSync('/usr/bin/which', ['graphify-mcp'], { cwd: homedir(), encoding: 'utf8' }).trim();
        this.mcpBin = isAbsolute(out) && !out.startsWith(homedir() + '/.office/worktrees') ? out : null;
      } catch {
        this.mcpBin = null;
      }
    }
    return this.mcpBin;
  }
  private mcpBin: string | null | undefined;
}
