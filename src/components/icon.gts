import Component from '@glimmer/component';

export type IconName =
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'rows'
  | 'columns'
  | 'linkedin'
  | 'github'
  | 'copy'
  | 'check';

export interface IconSignature {
  Args: { name: IconName };
  Element: SVGElement;
}

/**
 * Inline SVG icons, by name.
 *
 * Inline rather than unicode, and that is not a preference. `☾` and `☀` have
 * no glyph in the panel's font stack — a theme toggle drawn with them rendered
 * as an EMPTY SQUARE and went unnoticed until Doug said "I never saw the theme
 * toggle". The legacy extension uses inline SVG for exactly this reason.
 *
 * Inline rather than an image file, too: `stroke="currentColor"` means each
 * icon inherits its button's colour, so they theme themselves across
 * light/dark × six palettes without a second asset or a filter hack.
 *
 * `sun` and `moon` are carried over verbatim from the legacy's SUN_SVG and
 * MOON_SVG so the panel keeps the same icon language.
 */
export default class Icon extends Component<IconSignature> {
  get isSun(): boolean {
    return this.args.name === 'sun';
  }
  get isMoon(): boolean {
    return this.args.name === 'moon';
  }
  get isMonitor(): boolean {
    return this.args.name === 'monitor';
  }
  get isRows(): boolean {
    return this.args.name === 'rows';
  }
  get isColumns(): boolean {
    return this.args.name === 'columns';
  }
  get isLinkedin(): boolean {
    return this.args.name === 'linkedin';
  }
  get isGithub(): boolean {
    return this.args.name === 'github';
  }
  get isCopy(): boolean {
    return this.args.name === 'copy';
  }
  get isCheck(): boolean {
    return this.args.name === 'check';
  }

  <template>
    {{#if this.isSun}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>

    {{else if this.isMoon}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>

    {{else if this.isMonitor}}
      {{! "System" needs an icon meaning "whatever the machine says". A
          display is the convention every OS settings panel already uses. }}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>

    {{else if this.isRows}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <rect x="3" y="13" width="18" height="7" rx="1" />
      </svg>

    {{else if this.isLinkedin}}
      {{!-- Brand marks are FILLED, not stroked — a stroked wordmark is not
          the mark. fill="currentColor" still themes it. Paths carried over
          verbatim from the legacy so the icon language does not shift. --}}
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor"
           aria-hidden="true" ...attributes>
        <path d="M4.98 3.5a2.5 2.5 0 11-.02 5 2.5 2.5 0 01.02-5zM3 9h4v12H3V9zm7 0h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4.03 0 4.78 2.5 4.78 5.75V21H19v-5.5c0-1.3-.02-3-1.85-3-1.85 0-2.13 1.44-2.13 2.9V21H10V9z" />
      </svg>

    {{else if this.isGithub}}
      <svg class="icon" viewBox="0 0 24 24" fill="currentColor"
           aria-hidden="true" ...attributes>
        <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.49-1.11-1.49-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.32 9.32 0 015 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.6.69.49A10.02 10.02 0 0022 12.25C22 6.58 17.52 2 12 2z" />
      </svg>

    {{else if this.isCopy}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
      </svg>

    {{else if this.isCheck}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <path d="M20 6 9 17l-5-5" />
      </svg>

    {{else if this.isColumns}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <path d="M3 7h18M3 7v13h18V7" />
        <path d="M9 4v3M15 4v3" />
      </svg>
    {{/if}}
  </template>
}
