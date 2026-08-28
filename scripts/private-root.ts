import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVATE_ROOT_ENV = 'ASHEBROOK_PRIVATE_ROOT';

export function repositoryRootFromModuleUrl(
  moduleUrl: string,
  fallbackRoot = process.cwd(),
): string {
  const url = new URL(moduleUrl);
  if (url.protocol !== 'file:') return path.resolve(fallbackRoot);
  return path.resolve(path.dirname(fileURLToPath(url)), '..');
}

export const REPOSITORY_ROOT = repositoryRootFromModuleUrl(import.meta.url);

export interface PrivateRootOptions {
  repositoryRoot?: string;
  configuredRoot?: string;
}

export function resolvePrivateRoot(options: PrivateRootOptions = {}): string {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const configuredRoot =
    options.configuredRoot ?? process.env[PRIVATE_ROOT_ENV] ?? '';
  const selectedRoot = configuredRoot.trim() || 'private';
  return path.resolve(repositoryRoot, selectedRoot);
}

export function resolvePrivatePath(
  segments: readonly string[],
  options: PrivateRootOptions = {},
): string {
  return path.resolve(resolvePrivateRoot(options), ...segments);
}
