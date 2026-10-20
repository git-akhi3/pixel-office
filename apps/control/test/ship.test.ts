import { describe, expect, it } from 'vitest';
import { deployEnv, expiredLogin, wrongProject } from '../server/src/ship.js';

describe('ship', () => {
  const staging = { deployCmd: 'npm run deploy:staging', project: 'pos-staging-0', account: 'me@example.com' };

  it('pins the deploy to the repo\'s project and account, keeping my own environment', () => {
    const env = deployEnv(staging, { HOME: '/Users/me', PATH: '/bin' });
    expect(env).toEqual({ HOME: '/Users/me', PATH: '/bin', CLOUDSDK_CORE_PROJECT: 'pos-staging-0', GOOGLE_CLOUD_PROJECT: 'pos-staging-0', CLOUDSDK_CORE_ACCOUNT: 'me@example.com' });
  });

  it('refuses a command that names another project', () => {
    expect(wrongProject('firebase deploy --project zobaze-pos', staging)).toContain('zobaze-pos');
    expect(wrongProject('gcloud run deploy --project=pos-staging-0', staging)).toBeNull();
    expect(wrongProject('npm run deploy:staging', staging)).toBeNull();
    expect(wrongProject('firebase deploy --project zobaze-pos', { deployCmd: 'x' })).toBeNull();
  });

  it('knows an expired login and the command that renews it', () => {
    expect(expiredLogin('Error: Failed to authenticate, have you run firebase login?')).toEqual({ cli: 'firebase', login: 'firebase login --reauth' });
    expect(expiredLogin('ERROR: (gcloud.run.deploy) There was a problem refreshing your current auth tokens: Reauthentication failed.')).toEqual({ cli: 'gcloud', login: 'gcloud auth login' });
    expect(expiredLogin('Build failed: missing module express')).toBeNull();
  });
});
