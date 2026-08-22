import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import DraftBox from './draft-box.gts';
import PermissionProbe from './permission-probe.gts';
import SectionSet from './section-set.gts';
import Section from './section.gts';
import ConnectCard from './connect-card.gts';
import SendCard from './send-card.gts';
import AccessGate from './access-gate.gts';
import type { SectionSpec } from './section.gts';
import { layout } from '../state/layout.ts';
import { session } from '../state/session.ts';
import { page } from '../state/page.ts';
import { access } from '../state/access.ts';

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

  constructor(owner: unknown, args: object) {
    super(owner, args);
    this.ticker = setInterval(() => (this.uptime += 1), 1000);
    void layout.load();
    void session.load();
    page.start();
    // Re-evaluate access on every page change — a grant is per-origin, so
    // switching tabs can move between granted and ungranted sites.
    page.onChange(() => void access.refresh());
    void access.refresh();
  }

  /** A panel is long-lived, not immortal. An interval outliving it is a leak. */
  willDestroy(): void {
    super.willDestroy();
    if (this.ticker !== undefined) clearInterval(this.ticker);
  }

  /** So "did my reload actually take?" is answerable at a glance. */
  get build(): string {
    return __BUILD__;
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

    <SectionSet @sections={{this.sections}} />

      <Section @id="page" @sections={{this.sections}}>
        <AccessGate />
        <SendCard />
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
