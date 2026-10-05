import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a program without a shell. Never throws on a non-zero exit; check `code`. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function runOk(
  file: string,
  args: string[],
  opts: Parameters<typeof run>[2] = {},
): Promise<string> {
  const r = await run(file, args, opts);
  if (r.code !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return r.stdout;
}

export const git = (cwd: string, args: string[], opts: Parameters<typeof run>[2] = {}) =>
  runOk('git', args, { ...opts, cwd });
