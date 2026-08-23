import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { collectHints } from '../state/hints.ts';
import type { PageHints } from '../state/hints.ts';
import { lastSelectorFetch } from '../data/selectors.ts';
import { profileLookupNote } from '../domain/profile-note.ts';
import { me } from '../state/me.ts';
import { page } from '../state/page.ts';

/**
 * Staff: what the per-host selectors actually grabbed from this page.
 *
 * Exists because selector failures are SILENT. A profile with empty selector
 * arrays looks identical, from the panel, to a profile that works — the send
 * simply carries no apply link and nobody is told. That is jobright.ai, and
 * finding it took a curl against prod.
 *
 * Display-only. The apply_url write that used to ride along here lives in
 * state/apply-backfill.ts, so it fires on any tracked page rather than only
 * when a staff user happens to open this section.
 *
 * Read on demand, not on every navigation — it costs a scripting call, and
 * Doug's standing rule is no extra page reads for convenience.
 */
export default class DevHints extends Component {
  @tracked hints: PageHints | null = null;
  @tracked note = '';
  @tracked busy = false;

  constructor(owner: Owner, args: object) {
    super(owner, args);
    // Clear on navigation — stale hints describing the previous page are the
    // exact failure this panel keeps producing.
    page.onChange(() => {
      this.hints = null;
      this.note = '';
    });
  }

  get isStaff(): boolean {
    return me.isStaff;
  }

  read = (): void => {
    void this.load();
  };

  private async load(): Promise<void> {
    this.busy = true;
    const hints = await collectHints(page.url);
    const outcome = lastSelectorFetch();
    const hasSelectors =
      !!hints.applyUrl || !!hints.canonicalLinkHint || Object.keys(hints.structuredPrefill).length > 0;
    this.hints = hints;
    this.note = profileLookupNote(page.host, outcome, hasSelectors);
    this.busy = false;
  }

  <template>
    {{#if this.isStaff}}
      <details class="dh">
        <summary class="dh__summary">Selector hints (staff)</summary>

        <button type="button" class="dh__btn" {{on "click" this.read}}>
          {{if this.busy "Reading…" "Read this page"}}
        </button>

        {{#if this.note}}
          <p class="dh__note">{{this.note}}</p>
        {{/if}}

        {{#if this.hints}}
          <dl class="dh__grid">
            <dt>apply</dt><dd>{{orNone this.hints.applyUrl}}</dd>
            <dt>canonical</dt><dd>{{orNone this.hints.canonicalLinkHint}}</dd>
            <dt>referrer</dt><dd>{{orNone this.hints.referrerUrl}}</dd>
            <dt>fields</dt><dd>{{fieldList this.hints.structuredPrefill}}</dd>
            <dt>readiness</dt><dd>{{readiness this.hints.knownGood this.hints.tier}}</dd>
          </dl>
        {{/if}}
      </details>
    {{/if}}
  </template>
}

function orNone(value: string | null): string {
  return value ?? '—';
}

/** Field NAMES, not values — the question is which selectors matched. */
function fieldList(prefill: Record<string, string>): string {
  const keys = Object.keys(prefill);
  return keys.length ? keys.join(', ') : '—';
}

function readiness(knownGood: boolean, tier: string | null): string {
  return `${knownGood ? 'known-good' : 'not known-good'} · tier ${tier ?? '—'}`;
}
