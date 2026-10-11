import { updateDocsVersionLabel, updateReadmeVersionBadge } from './versionMetadata';

export type ReleaseBump = 'patch' | 'minor' | 'major';

export interface PreparedReleaseSnapshot {
  bump: ReleaseBump;
  committedPackageJson: string;
  workingPackageJson: string;
  committedReadme: string;
  workingReadme: string;
  committedDocsIndex: string;
  workingDocsIndex: string;
  committedPackageLock?: string;
  workingPackageLock?: string;
}

function readPackageVersion(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value)) return null;
    const version = (value as { version?: unknown }).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

export function nextReleaseVersion(version: string, bump: ReleaseBump): string {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function normalizePackageVersion(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value)) return null;
    (value as { version: unknown }).version = '__RELEASE_VERSION__';
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizeLockfileVersions(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('version' in value)) return null;
    const lock = value as {
      version: unknown;
      packages?: Record<string, { version?: unknown }>;
    };
    lock.version = '__RELEASE_VERSION__';
    if (lock.packages?.['']) lock.packages[''].version = '__RELEASE_VERSION__';
    return JSON.stringify(lock);
  } catch {
    return null;
  }
}

/**
 * Detect the version-only working tree left by `npm run release:patch`.
 * This lets `release:ship` finalize that same version instead of bumping twice.
 */
export function isPreparedReleaseSnapshot(snapshot: PreparedReleaseSnapshot): boolean {
  const committedVersion = readPackageVersion(snapshot.committedPackageJson);
  const workingVersion = readPackageVersion(snapshot.workingPackageJson);
  if (!committedVersion || !workingVersion) return false;
  if (nextReleaseVersion(committedVersion, snapshot.bump) !== workingVersion) return false;

  if (
    normalizePackageVersion(snapshot.committedPackageJson) !==
    normalizePackageVersion(snapshot.workingPackageJson)
  ) {
    return false;
  }

  try {
    if (
      updateReadmeVersionBadge(snapshot.committedReadme, workingVersion) !== snapshot.workingReadme
    ) {
      return false;
    }
    if (
      updateDocsVersionLabel(snapshot.committedDocsIndex, workingVersion) !==
      snapshot.workingDocsIndex
    ) {
      return false;
    }
  } catch {
    return false;
  }

  const hasCommittedLock = snapshot.committedPackageLock !== undefined;
  const hasWorkingLock = snapshot.workingPackageLock !== undefined;
  if (hasCommittedLock !== hasWorkingLock) return false;
  if (hasCommittedLock && hasWorkingLock) {
    if (
      normalizeLockfileVersions(snapshot.committedPackageLock!) !==
      normalizeLockfileVersions(snapshot.workingPackageLock!)
    ) {
      return false;
    }
  }

  return true;
}
