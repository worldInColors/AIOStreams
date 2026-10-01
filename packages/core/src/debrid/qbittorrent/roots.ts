/**
 * Parse the configured download roots. Comma-embedded, relative, or
 * filesystem-root paths cannot confine anything and invalidate the list.
 * Shared by the feature gate and the per-path check so the two cannot
 * disagree. Deliberately a leaf, both importers would close a cycle back
 * through the utils barrel.
 */
export function validQbittorrentRoots(): string[] {
  return (process.env.QBITTORRENT_ALLOWED_ROOTS ?? '')
    .split(',')
    .map((root) => root.trim())
    .filter(
      (root) =>
        root.startsWith('/') && root.replace(/\/+$/, '') !== '' && root !== '/'
    );
}
