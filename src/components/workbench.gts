import Component from '@glimmer/component';
import type Owner from '@ember/owner';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import AnswerDeskCard from './answer-desk.gts';
import PermissionProbe from './permission-probe.gts';
import ErrorLog from './error-log.gts';
import DevHints from './dev-hints.gts';
import SectionSet from './section-set.gts';
import Segmented from './segmented.gts';
import Section from './section.gts';
import ConnectCard from './connect-card.gts';
import SendCard from './send-card.gts';
import TrackedCard from './tracked-card.gts';
import LinkCard from './link-card.gts';
import QuickCopyCard from './quick-copy-card.gts';
import ApplicationCard from './application-card.gts';
import LadderOffer from './ladder-offer.gts';
import MatchAppCard from './match-app-card.gts';
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
import { ladder } from '../state/ladder.ts';
import { applyBackfill } from '../state/apply-backfill.ts';
import { answerDesk } from '../state/answer-desk.ts';
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
    // The desk registers its OWN page.onChange reset (state/answer-desk.ts).
    // This only picks up the drafts already on disk, so a panel reload lands
    // on the answers it was in the middle of.
    void answerDesk.load();
    page.start();
    // Re-evaluate access on every page change — a grant is per-origin, so
    // switching tabs can move between granted and ungranted sites.
    page.onChange(() => {
      void access.refresh();
      // "Do we already know this page?" is asked on every navigation, not
      // once at open — a panel outlives many pages.
      // The ladder only runs when the by-link lookup came back empty, so it
      // is chained behind it rather than raced against it.
      void trackedPost.refresh().then(() => {
        void ladder.run();
        void applyBackfill.maybeBackfill();
      });
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
    void trackedPost.refresh().then(() => {
        void ladder.run();
        void applyBackfill.maybeBackfill();
      });
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

  /**
   * Minutes accumulated forever, so a panel left open overnight read
   * "901m 40s" (CCEXT-90). Past an hour the seconds stop being information —
   * nobody reads the units digit on a 15-hour counter — so they are dropped
   * rather than carried into a third field nobody scans.
   */
  get uptimeLabel(): string {
    const h = Math.floor(this.uptime / 3600);
    const m = Math.floor((this.uptime % 3600) / 60);
    const s = this.uptime % 60;
    if (h > 0) return `${h}h ${m}m`;
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
      { id: 'answers', title: 'Answer desk', summary: this.answerSummary },
      { id: 'diagnostics', title: 'Diagnostics', summary: `up ${this.uptimeLabel}` },
    ];
  }

  /**
   * What a COLLAPSED answer desk still tells you.
   *
   * "2 generating" is the line that matters: several questions can be in
   * flight at once, and a shut section that hid that would make the panel look
   * idle while it was working.
   */
  private get answerSummary(): string {
    const busy = answerDesk.generatingCount;
    if (busy) return busy === 1 ? '1 generating' : `${busy} generating`;
    const found = answerDesk.entries.length;
    if (!found) return 'no questions found yet';
    const answered = answerDesk.entries.filter((e) => !!e.draft?.content).length;
    return `${answered}/${found} answered`;
  }

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
        {{! The offer sits ABOVE the card it would populate — accepting it is
            what turns "no post linked" into a trackable application. }}
        <LadderOffer />
        <ApplicationCard />
        <MatchAppCard />
      </Section>

      {{! CCEXT-90: the hint that used to sit here explained the panel's
          persistence to the people who built it. It shipped to every user and
          would have been read by a store reviewer. A claim about the
          architecture belongs in the listing copy, not in the workspace. }}
      <Section @id="answers" @sections={{this.sections}}>
        <AnswerDeskCard />
      </Section>

      <Section @id="diagnostics" @sections={{this.sections}}>
        <p class="wb__uptime">
          Panel alive for <strong>{{this.uptimeLabel}}</strong>
        </p>
        <ErrorLog />
        <DevHints />
        <PermissionProbe />
      </Section>
  </template>
}
