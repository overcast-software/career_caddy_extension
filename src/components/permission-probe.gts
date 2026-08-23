import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { access } from '../state/access.ts';
import { page } from '../state/page.ts';

/**
 * PHASE 0 DIAGNOSTIC — delete once the permission model is settled.
 *
 * This started as a pass/fail probe and has been rewritten as a full dump,
 * because pass/fail was not enough: three separate hypotheses about why Chrome
 * refuses page access all looked identical from the outside, and each cost a
 * build/test cycle to eliminate.
 *
 * It now reports every input to the decision at once — what tabs.query
 * returned, what the worker stashed at action-click time, which permissions
 * are actually held, and what executeScript does. One screenshot should
 * answer "why can't it read the page" without another round of guessing.
 */

interface Line {
  label: string;
  value: string;
  ok: boolean | null;
}

export default class PermissionProbe extends Component {
  @tracked lines: Line[] = [];
  @tracked busy = false;

  /**
   * `owner` is typed as the base class declares it, not as what arrives.
   * `renderComponent` is called WITHOUT an owner, so at runtime this is
   * null — the whole point of the exercise. The type follows the superclass
   * signature because that is what `super()` must satisfy; the runtime truth
   * is written here rather than smuggled in as `unknown`, which only moved
   * the lie somewhere the compiler could not see it.
   */
  constructor(owner: Owner, args: object) {
    super(owner, args);
    void this.dump();
    // A snapshot dump silently goes stale the moment you switch tabs, and a
    // stale dump is worse than none — it once showed `chrome://extensions`
    // while the panel sat beside a LinkedIn posting, which reads as a bug in
    // tab detection rather than as an old reading.
    page.onChange(() => void this.collect());
  }

  dump = (): void => {
    void this.collect();
  };

  private async collect(): Promise<void> {
    this.busy = true;
    const out: Line[] = [];

    // 1. What does tabs.query see? `id` is always available; `url` requires
    //    either the tabs permission or host access for that tab, so an
    //    undefined url here IS the diagnosis, not a symptom of one.
    let tabId: number | undefined;
    let tabUrl = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
      tabUrl = tab?.url ?? '';
      out.push({ label: 'tabs.query id', value: String(tabId ?? 'undefined'), ok: tabId !== undefined });
      out.push({
        label: 'tabs.query url',
        value: tabUrl || 'undefined  (no tabs perm, no host access)',
        ok: !!tabUrl,
      });
    } catch (error) {
      out.push({ label: 'tabs.query', value: describe(error), ok: false });
    }

    // 3. What do we actually hold? Settles "did the grant land" definitively.
    try {
      const all = await chrome.permissions.getAll();
      out.push({ label: 'origins held', value: (all.origins ?? []).join(' ') || '(none)', ok: null });
      out.push({ label: 'perms held', value: (all.permissions ?? []).join(' '), ok: null });
    } catch (error) {
      out.push({ label: 'permissions.getAll', value: describe(error), ok: false });
    }

    // 4. What the app concluded.
    await access.refresh();
    out.push({ label: 'access.state', value: access.state, ok: access.canRead });
    out.push({ label: 'access.pattern', value: access.pattern ?? 'null', ok: !!access.pattern });

    // 5. The actual capability, tried for real.
    if (tabId !== undefined) {
      try {
        const [hit] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => document.title,
        });
        out.push({ label: 'executeScript', value: `OK "${String(hit?.result ?? '')}"`, ok: true });
      } catch (error) {
        out.push({ label: 'executeScript', value: describe(error), ok: false });
      }
    }

    this.lines = out;
    this.busy = false;
  }

  /** Not async: permissions.request needs the gesture unspent. */
  grantTabs = (): void => {
    void chrome.permissions
      .request({ permissions: ['tabs'] })
      .then(() => this.collect())
      .catch(() => this.collect());
  };

  grantOrigin = (): void => {
    access.grant();
    window.setTimeout(() => void this.collect(), 600);
  };

  get page(): typeof page {
    return page;
  }

  <template>
    <details class="probe" open>
      <summary class="probe__summary">Phase 0 — diagnostics</summary>

      <div class="probe__actions">
        <button type="button" class="probe__btn" {{on "click" this.dump}}>Re-read</button>
        <button type="button" class="probe__btn" {{on "click" this.grantTabs}}>Grant tabs</button>
        <button type="button" class="probe__btn" {{on "click" this.grantOrigin}}>Grant origin</button>
      </div>

      <dl class="probe__dump">
        {{#each this.lines as |line|}}
          <dt class="probe__k">{{line.label}}</dt>
          <dd class="probe__v {{okClass line.ok}}">{{line.value}}</dd>
        {{/each}}
      </dl>
    </details>
  </template>
}

function okClass(ok: boolean | null): string {
  if (ok === null) return '';
  return ok ? 'is-ok' : 'is-err';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
