// Shipping after the merge: the staging deploy, run by the office (not an agent) with my CLI logins.
// The verifier's look-only command rule is lookOnlyCheck() in guard.ts.

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

/**
 * Why a command can't run against this repo's staging (it names another project or switches the CLIs'
 * project or configuration), or null. The pinning env vars cover gcloud; firebase deploys to the project
 * its own command names (or .firebaserc), so for firebase the command itself must name the right one.
 */
export function wrongProject(command: string, staging: StagingConfig): string | null {
  if (!staging.project) return null;
  const named = [
    ...command.matchAll(/(?:--project|--project_id|(?:^|\s)-P|(?:^|\s)-p)(?:=|\s+)["']?([\w.-]+)/g),
    ...command.matchAll(/\bfirebase\s+use\s+["']?([\w.-]+)/g),
    ...command.matchAll(/\b(?:CLOUDSDK_CORE_PROJECT|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT)=["']?([\w.-]+)/g),
    ...command.matchAll(/\bgcloud\s+config\s+set\s+(?:core\/)?project\s+["']?([\w.-]+)/g),
  ].map((m) => m[1]!);
  const other = named.find((p) => p !== staging.project);
  if (other) return `it names project ${other}, but this repo's staging is ${staging.project}`;
  if (/--configuration\b|\bgcloud\s+config\s+(set|configurations\s+activate)\b/.test(command)) return 'it changes the gcloud configuration';
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
  if (/gh auth login|gh: .*(Bad credentials|authentication)/i.test(output)) return { cli: 'gh', login: 'gh auth login' };
  return null;
}
