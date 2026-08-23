import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import DraftBox from './draft-box.gts';
import PermissionProbe from './permission-probe.gts';
import SectionSet from './section-set.gts';
import Segmented from './segmented.gts';
import Section from './section.gts';
import ConnectCard from './connect-card.gts';
import SendCard from './send-card.gts';
import TrackedCard from './tracked-card.gts';
import LinkCard from './link-card.gts';
import QuickCopyCard from './quick-copy-card.gts';
import ApplicationCard from './application-card.gts';
import AccessGate from './access-gate.gts';
import type { SectionSpec } from './section.gts';
import { layout } from '../state/layout.ts';
import { session } from '../state/session.ts';
import { page } from '../state/page.ts';
import { access } from '../state/access.ts';
import { trackedPost } from '../state/tracked.ts';
import { scoreRunner } from '../state/score.ts';
import { linkPicker } from '../state/link-picker.ts';
import { me } from '../state/me.ts';
import { theme } from '../state/theme.ts';

/**
 * The panel root.
 *
 * Sections are declared once, in workflow order, and rendered by <SectionSet>
 * as either an accordion or tabs. The legacy extension's three tabs
 * (Posts | Applications | Staff) existed because a 320×600 popup had no room;
 * whether the panel still wants them is a question to answer by using it,
 * which is why the switch is a runtime toggle rather than a code change.
 *
 * The uptime counter is the architectural claim made visible: in a panel,
 * component state is allowed to LIVE. Click into the page, fill a field,
 * switch tabs — it keeps counting and the draft keeps its text. A popup would
 * have been destroyed and rebuilt on every one of those.
 */
/**
 * Substituted at build time by Vite's `define` — a short git SHA, a `+` when
 * the tree is dirty, and the build clock time. `declare const` tells the
 * compiler it exists; nothing is emitted for this line.
 */
declare const __BUILD__: string;

export default class Workbench extends Component {
  @tracked uptime = 0;
  @tracked draft = '';

  /**
   * `number | undefined` because the field genuinely has no value until the
   * constructor runs. `ReturnType<typeof setInterval>` rather than `number`:
   * in a DOM context setInterval returns a number, under @types/node it
   * returns a Timeout object. Deriving the type from the function compiles
   * under either instead of picking one and being wrong somewhere.
   */
  private ticker: ReturnType<typeof setInterval> | undefined;

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
    this.ticker = setInterval(() => (this.uptime += 1), 1000);
    void theme.load();
    void layout.load();
    void session.load();
    void me.load();
    page.start();
    // Re-evaluate access on every page change — a grant is per-origin, so
    // switching tabs can move between granted and ungranted sites.
    page.onChange(() => {
      void access.refresh();
      // "Do we already know this page?" is asked on every navigation, not
      // once at open — a panel outlives many pages.
      void trackedPost.refresh();
      // A score run belongs to the post it was started on. Carrying its
      // state to the next page would narrate someone else's scoring.
      scoreRunner.reset();
      // An armed overwrite-confirm belongs to the page it was armed on. The
      // panel outlives navigation, so without this the second click could
      // land after a tab change and replace an apply link with a DIFFERENT
      // page's URL — the confirm protecting the wrong thing entirely.
      linkPicker.disarm();
    });
    access.listen();
    void access.refresh();
    void trackedPost.refresh();
  }

  /** A panel is long-lived, not immortal. An interval outliving it is a leak. */
  override willDestroy(): void {
    super.willDestroy();
    if (this.ticker !== undefined) clearInterval(this.ticker);
  }

  /**
   * So "did my reload actually take?" is answerable at a glance — and
   * answerable the SAME way here as on the chrome://extensions card, which
   * shows the manifest version and nothing else. Two surfaces, one answer.
   */
  get build(): string {
    return `v${this.manifestVersion} · ${__BUILD__}`;
  }

  get theme(): typeof theme {
    return theme;
  }

  themeOptions = [
    { value: 'light', label: 'Light', icon: 'sun' as const },
    { value: 'dark', label: 'Dark', icon: 'moon' as const },
    { value: 'system', label: 'System', icon: 'monitor' as const },
  ];

  setTheme = (mode: string): void => theme.setMode(mode);

  private get manifestVersion(): string {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return '?';
    }
  }

  get uptimeLabel(): string {
    const m = Math.floor(this.uptime / 60);
    const s = this.uptime % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  get host(): string {
    return page.host || '(no page)';
  }

  /**
   * A getter, so the collapsed summaries stay current: `host` and `uptimeLabel`
   * are tracked reads, so this recomputes and every section header updates
   * without anything explicitly telling it to.
   */
  get sections(): SectionSpec[] {
    return [
      { id: 'page', title: 'This page', summary: this.host },
      {
        id: 'applications',
        title: 'Applications',
        summary: `${me.items.length} snippets`,
      },
      { id: 'answers', title: 'Answer desk', summary: `${this.draft.length} chars` },
      { id: 'diagnostics', title: 'Diagnostics', summary: `up ${this.uptimeLabel}` },
    ];
  }

  updateDraft = (next: string): void => {
    this.draft = next;
  };

  <template>
    <header class="wb__head">
      <h1 class="wb__title">Career Caddy</h1>
      <p class="wb__sub">Glimmer · side panel · <code class="wb__build">{{this.build}}</code></p>
    </header>

    <ConnectCard />

    <div class="wb__prefs">
      <Segmented
        @label="Theme"
        @options={{this.themeOptions}}
        @value={{this.theme.mode}}
        @onSelect={{this.setTheme}}
      />
    </div>

    <SectionSet @sections={{this.sections}} />

      <Section @id="page" @sections={{this.sections}}>
        <AccessGate />
        <TrackedCard />
        <SendCard />
        <LinkCard />
      </Section>

      <Section @id="applications" @sections={{this.sections}}>
        {{! Quick copy first and unconditional: it is useful on every page,
            including the application form itself, where no post is matched. }}
        <QuickCopyCard />
        <ApplicationCard />
      </Section>

      <Section @id="answers" @sections={{this.sections}}>
        <DraftBox
          @label="Draft answer"
          @value={{this.draft}}
          @onInput={{this.updateDraft}}
        />
        <p class="wb__hint">
          Click into the page, type in a form, switch tabs — then look back.
          The draft is still here and the timer never restarted.
        </p>
      </Section>

      <Section @id="diagnostics" @sections={{this.sections}}>
        <p class="wb__uptime">
          Panel alive for <strong>{{this.uptimeLabel}}</strong>
        </p>
        <PermissionProbe />
      </Section>
  </template>
}
