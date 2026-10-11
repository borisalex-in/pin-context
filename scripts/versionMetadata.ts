/** Pure transformations used by the npm `version` lifecycle hook. */

const VERSION_BADGE_PATTERN = /(badge\/version-)\d+\.\d+\.\d+(-blue\.svg)/g;
const HERO_META_PATTERN =
  /<div\b(?=[^>]*\bclass=["'][^"']*\bhero-meta\b[^"']*["'])[^>]*>[\s\S]*?<\/div>/gi;
const VERSION_SPAN_PATTERN = /(<span\b[^>]*>)\s*v?\d+\.\d+\.\d+\s*(<\/span>)/i;

export function updateReadmeVersionBadge(content: string, version: string): string {
  const matches = content.match(VERSION_BADGE_PATTERN);
  if (matches?.length !== 1) {
    throw new Error(`Expected exactly one README version badge, found ${matches?.length ?? 0}`);
  }

  return content.replace(
    VERSION_BADGE_PATTERN,
    (_match, prefix: string, suffix: string) => `${prefix}${version}${suffix}`
  );
}

export function updateDocsVersionLabel(content: string, version: string): string {
  const heroBlocks = content.match(HERO_META_PATTERN);
  if (heroBlocks?.length !== 1) {
    throw new Error(
      `Expected exactly one .hero-meta block in docs/index.html, found ${heroBlocks?.length ?? 0}`
    );
  }

  let versionUpdated = false;
  const updated = content.replace(HERO_META_PATTERN, (heroBlock) => {
    if (versionUpdated) return heroBlock;

    if (!VERSION_SPAN_PATTERN.test(heroBlock)) {
      throw new Error('Could not find a version label inside docs/index.html .hero-meta block');
    }

    versionUpdated = true;
    return heroBlock.replace(
      VERSION_SPAN_PATTERN,
      (_match, openingTag: string, closingTag: string) => `${openingTag}v${version}${closingTag}`
    );
  });

  if (!versionUpdated) {
    throw new Error('Could not update the version label in docs/index.html');
  }

  return updated;
}
