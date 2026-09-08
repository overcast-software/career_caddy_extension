/**
 * The quick-copy item contract.
 *
 * Snippets you paste into application forms over and over: your LinkedIn, your
 * GitHub, and whatever prose you have got tired of retyping.
 *
 * THIS CONTRACT IS SHARED with the web app's `app/utils/quick-copy.js`, and
 * as of frontend c11e413 the two AGREE exactly: same CUSTOM_ICONS, same
 * DEFAULT_CUSTOM_ICON of 'flag', same LEGACY_ICON_MAP of
 * {globe: 'flag', text: 'golfer'}. Verified against origin/main.
 *
 * They did drift — the web side shipped {globe, text} for a while — and the
 * merge closed it. Two copies of one contract will drift again; what keeps
 * that survivable is that normalization is forgiving in BOTH directions, so
 * prefer widening the map over renaming a key.
 *
 * Worth knowing before changing anything here: the real stored data does NOT
 * look like the contract. A live profile's `links` entries are
 * `{ url, name }` with 450+ characters of PROSE in `url` — no `value`, no
 * `icon`, no `pinned`. Every one of the fallbacks below is load-bearing
 * against data that exists right now, not defensive programming against
 * hypotheticals.
 *
 * The reason, from Doug: quick snippets "was supposed to hold just common
 * links, but sprouted into common prompts." So `url` is not a bug, it is a
 * fossil — the field kept its name while its contents outgrew it. Two
 * consequences that matter downstream:
 *
 *   1. Never validate a snippet as a URL. Most of them are not one, and the
 *      ones that are not are the ones being used most.
 *   2. A snippet is either link-ish or prose-ish, and they want different
 *      affordances — you OPEN a profile link and you PASTE a prompt. That is
 *      what `isLinkLike` is for; it is a display hint, never a filter.
 */

export type BrandIcon = 'linkedin' | 'github';
export type CustomIcon = 'flag' | 'golfer' | 'trophy' | 'target' | 'finish';
export type QuickCopyIcon = BrandIcon | CustomIcon;

export interface QuickCopyItem {
  name: string;
  value: string;
  icon: QuickCopyIcon;
  pinned: boolean;
}

/** Seeded from dedicated profile fields, not from `links`. */
const BRAND_ICONS: readonly string[] = ['linkedin', 'github'];
const CUSTOM_ICONS: readonly CustomIcon[] = [
  'flag',
  'golfer',
  'trophy',
  'target',
  'finish',
];
const DEFAULT_CUSTOM_ICON: CustomIcon = 'flag';

/** The web app's older vocabulary. Kept so nothing looks broken after a sync. */
const LEGACY_ICON_MAP: Record<string, CustomIcon> = {
  globe: 'flag',
  text: 'golfer',
};

/** The `/me` payload, snake_cased, as the api returns it. */
export interface MeAttrs {
  linkedin?: string | null;
  github?: string | null;
  links?: unknown;
  is_staff?: boolean;
  first_name?: string | null;
}

function normalizeCustomIcon(icon: unknown): CustomIcon {
  if (typeof icon === 'string') {
    if ((CUSTOM_ICONS as readonly string[]).includes(icon)) return icon as CustomIcon;
    const mapped = LEGACY_ICON_MAP[icon];
    if (mapped) return mapped;
  }
  return DEFAULT_CUSTOM_ICON;
}

export function composeQuickCopyItems(attrs: MeAttrs | null | undefined): QuickCopyItem[] {
  if (!attrs) return [];
  const items: QuickCopyItem[] = [];

  // LinkedIn and GitHub come from their own profile fields, pinned, with brand
  // marks. They are seeds, not `links` entries.
  const linkedin = (attrs.linkedin ?? '').toString().trim();
  const github = (attrs.github ?? '').toString().trim();
  if (linkedin) items.push({ name: 'LinkedIn', value: linkedin, icon: 'linkedin', pinned: true });
  if (github) items.push({ name: 'GitHub', value: github, icon: 'github', pinned: true });

  const links = Array.isArray(attrs.links) ? attrs.links : [];
  for (const raw of links) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;

    // A links entry carrying a brand icon would duplicate the seeds above,
    // which come from the dedicated fields. Drop it rather than show the same
    // profile twice.
    if (typeof entry['icon'] === 'string' && BRAND_ICONS.includes(entry['icon'])) continue;

    // `value` is the contract; `url` is what the data actually has.
    const rawValue = entry['value'] ?? entry['url'] ?? '';
    const value = String(rawValue).trim();
    if (!value) continue;

    const name = String(entry['name'] ?? '').trim();
    items.push({
      name: name || value,
      value,
      icon: normalizeCustomIcon(entry['icon']),
      pinned: Boolean(entry['pinned']),
    });
  }

  return items;
}

/**
 * Is this snippet a link, or is it prose?
 *
 * A DISPLAY HINT, never a filter — nothing is hidden or rejected on the basis
 * of this answer. It decides whether a row offers "open" alongside "copy",
 * because a LinkedIn profile and a 450-character screening-question prompt are
 * both snippets and neither is served well by the other's UI.
 *
 * Deliberately conservative: it must start with a scheme. A bare "example.com"
 * stays prose, because prose that happens to begin with a domain is far more
 * common than someone storing a schemeless URL, and guessing wrong here adds a
 * button that navigates somewhere unintended.
 */
export function isLinkLike(value: string): boolean {
  const trimmed = value.trim();
  if (/\s/.test(trimmed)) return false; // any whitespace at all means prose
  return /^https?:\/\/\S+$/i.test(trimmed);
}

/**
 * A one-line preview for a value that may be several hundred characters of
 * prose. The full value is what gets copied — this is only what gets read.
 */
export function previewOf(value: string, max = 72): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/** What pressing a snippet does. */
export type SnippetAction = 'inject' | 'copy';

/**
 * Press a snippet — does it go to the answer desk, or to the clipboard?
 * (CCEXT-86)
 *
 * Doug: *"I'd rather it put it in there explicitly but I'm willing to settle
 * for the extra copy and paste if two quick fields is confusing."* It does not
 * have to be confusing, because there is no second field to add: a saved prompt
 * IS an instruction, and the desk already keeps an accumulating, removable
 * instruction stack per question. So the snippet becomes a chip on that stack,
 * and the one existing input stays exactly what it was.
 *
 * Two things send it to the clipboard instead, and neither is a fallback for
 * failure:
 *
 *   1. **It is a link.** A LinkedIn profile is not a directive to a model —
 *      injecting one would put a bare URL under a heading that calls it a
 *      PRIORITY instruction. This is `isLinkLike` doing the exact job its
 *      docblock describes, choosing an affordance; nothing is hidden or
 *      rejected, so it is still not a filter.
 *   2. **No question is selected.** Instruction stacks are per-question
 *      (`AnswerDraft.instructions`) — with nothing selected there is no stack
 *      to push onto. Copying is the honest thing to do, provided the card SAYS
 *      that is what happened; silently doing nothing is the failure mode this
 *      whole card already had a `failed` state for.
 *
 * Pure, so the rule is testable without a page, a panel or a desk.
 */
export function actionFor(value: string, hasSelectedQuestion: boolean): SnippetAction {
  if (!value.trim()) return 'copy';
  if (isLinkLike(value)) return 'copy';
  return hasSelectedQuestion ? 'inject' : 'copy';
}
