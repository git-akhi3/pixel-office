// Shipping after the merge: the staging deploy, run by the office (not an agent) with my CLI logins.
// The verifier's look-only command rule is lookOnlyCommand() in guard.ts.

import type { ShipConfig } from './db/schema.js';

export type StagingConfig = NonNullable<ShipConfig['staging']>;

/** The variables that pin the CLIs to the repo's cloud project and account. */
export function pinnedEnv(staging: StagingConfig): Record<string, string> {
  return {
    ...(staging.project ? { CLOUDSDK_CORE_PROJECT: staging.project, GOOGLE_CLOUD_PROJECT: staging.project } : {}),
    ...(staging.account ? { CLOUDSDK_CORE_ACCOUNT: staging.account } : {}),
  };
}

/** The deploy's environment: my own (with my CLI logins), pinned to the repo's cloud project and account. */
export function deployEnv(staging: StagingConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...pinnedEnv(staging) };
}

/** Why a command can't run against this repo's staging (it names another project), or null. */
export function wrongProject(command: string, staging: StagingConfig): string | null {
  if (!staging.project) return null;
  for (const m of command.matchAll(/--project(?:=|\s+)["']?([\w.-]+)/g)) {
    if (m[1] !== staging.project) return `it names project ${m[1]}, but this repo's staging is ${staging.project}`;
  }
  return null;
}

/** The CLI whose login ran out, when a deploy's output says so, with the command that signs in again. */
export function expiredLogin(output: string): { cli: string; login: string } | null {
  if (/firebase[\s\S]{0,200}(login|reauth|credentials)|Failed to authenticate, have you run firebase login/i.test(output) && /auth|login|credential/i.test(output)) {
    return { cli: 'firebase', login: 'firebase login --reauth' };
  }
  if (/gcloud auth login|Reauthentication (failed|required)|invalid_grant|refresh token.*(expired|revoked)|There was a problem refreshing your current auth tokens/i.test(output)) {
    return { cli: 'gcloud', login: 'gcloud auth login' };
  }
  if (/vercel login|The specified token is not valid|Not authorized|You are not logged in/i.test(output) && /vercel/i.test(output)) {
    return { cli: 'vercel', login: 'vercel login' };
  }
  if (/gh auth login|HTTP 401|Bad credentials/i.test(output)) return { cli: 'gh', login: 'gh auth login' };
  return null;
}
