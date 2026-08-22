import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';

/**
 * PHASE 0 DIAGNOSTIC — delete once the permission model is settled.
 *
 * The question this answers is the riskiest one in the whole rewrite:
 *
 *   `activeTab` grants host access to ONE tab, at the moment the user invokes
 *   the action, and revokes it when that tab navigates. A popup dies almost
 *   immediately so it never notices. A panel is open for minutes across tab
 *   switches and navigations — and every capability worth shipping goes
 *   through scripting.executeScript into whatever tab you are now looking at.
 *
 * If the grant really does lapse, it fails LATE and in disguise: fine on the
 * tab you opened the panel from, then executeScript starts rejecting on tab
 * two, which reads as "the selectors didn't match this site" rather than as a
 * permissions problem. That is why this is worth measuring rather than
 * reasoning about.
 *
 * Run the matrix: probe → navigate → probe → switch tab → probe → switch back
 * → probe. Then grant the origin and repeat. The log below is the evidence.
 */

/**
 * A discriminated union again, and for the same reason as before: the `ok`
 * field is a literal type, so `if (entry.ok)` tells the compiler which shape
 * it is holding and which fields therefore exist.
 */
type ProbeEntry =
  | { ok: true; at: string; url: string; title: string }
  | { ok: false; at: string; url: string; error: string };

export default class PermissionProbe extends Component {
  @tracked url = '(unknown)';
  @tracked origin = '';
  @tracked hasOrigin = false;
  @tracked log: ProbeEntry[] = [];

  private tabId: number | undefined;

  constructor(owner: unknown, args: object) {
    super(owner, args);
    void this.refresh();
  }

  /** Read the active tab and whether we already hold a durable grant for it. */
  refresh = async (): Promise<void> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.tabId = tab?.id;
      this.url = tab?.url ?? '(no active tab)';
      this.origin = tab?.url ? new URL(tab.url).origin + '/*' : '';
      this.hasOrigin = this.origin
        ? await chrome.permissions.contains({ origins: [this.origin] })
        : false;
    } catch (error) {
      this.url = `(cannot read: ${describe(error)})`;
    }
  };

  /**
   * The actual test: can we execute in the tab the user is looking at RIGHT
   * NOW, as opposed to the one that was active when the panel was opened?
   */
  probe = async (): Promise<void> => {
    await this.refresh();
    const at = new Date().toLocaleTimeString();
    const url = short(this.url);

    if (this.tabId === undefined) {
      this.append({ ok: false, at, url, error: 'no active tab' });
      return;
    }

    try {
      const [hit] = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: () => document.title,
      });
      this.append({ ok: true, at, url, title: String(hit?.result ?? '(no title)') });
    } catch (error) {
      // THIS is the interesting branch. Chrome words it roughly as "Cannot
      // access contents of the page. Extension manifest must request
      // permission to access the respective host."
      this.append({ ok: false, at, url, error: describe(error) });
    }
  };

  /**
   * NOT async, and it does not await anything before calling request().
   * permissions.request() needs a live user gesture; the first `await` spends
   * it, and Chrome then rejects with "may only be called from a user
   * gesture" — which looks like a permissions bug and is actually a timing
   * bug. Same trap as sidePanel.open().
   */
  grant = (): void => {
    // Silently returning here is what made "Grant this origin" look broken on
    // Chrome: with no host access, tabs.query cannot report a URL, so there
    // was no origin to request and the button did nothing at all. The
    // chicken-and-egg is worth stating rather than swallowing — you cannot
    // ask for permission to a page you are not allowed to identify.
    if (!this.origin) {
      const at = new Date().toLocaleTimeString();
      this.append({
        ok: false,
        at,
        url: '(unknown)',
        error:
          'Cannot request access: this tab\'s URL is not visible, which means there is no host access at all. Reopen the panel from the extension icon.',
      });
      return;
    }
    void chrome.permissions
      .request({ origins: [this.origin] })
      .then(() => this.refresh());
  };

  private append(entry: ProbeEntry): void {
    // A NEW array, not push(). Autotracking fires on the property being
    // reassigned; mutating the existing array in place changes no property,
    // so nothing would re-render. Same rule as Vue's reactivity on arrays,
    // arrived at from a different direction.
    this.log = [entry, ...this.log].slice(0, 12);
  }

  <template>
    <details class="probe" open>
      <summary class="probe__summary">Phase 0 — permission probe</summary>

      <p class="probe__url">{{this.url}}</p>
      <p class="probe__grant">
        durable grant for this origin:
        <strong>{{if this.hasOrigin "yes" "no (activeTab only)"}}</strong>
      </p>

      <div class="probe__actions">
        <button type="button" class="probe__btn" {{on "click" this.probe}}>
          Probe this tab
        </button>
        {{#unless this.hasOrigin}}
          <button type="button" class="probe__btn" {{on "click" this.grant}}>
            Grant this origin
          </button>
        {{/unless}}
      </div>

      <ol class="probe__log">
        {{#each this.log as |entry|}}
          <li class="probe__entry {{if entry.ok 'is-ok' 'is-err'}}">
            <span class="probe__at">{{entry.at}}</span>
            <span class="probe__where">{{entry.url}}</span>
            {{#if entry.ok}}
              <span class="probe__ok">✓ {{entry.title}}</span>
            {{else}}
              <span class="probe__err">✗ {{entry.error}}</span>
            {{/if}}
          </li>
        {{else}}
          <li class="probe__empty">
            Probe, then navigate, then switch tabs and probe again.
          </li>
        {{/each}}
      </ol>
    </details>
  </template>
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function short(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname.length > 1 ? u.pathname.slice(0, 18) : '');
  } catch {
    return url.slice(0, 30);
  }
}
