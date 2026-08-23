import { tracked } from '@glimmer/tracking';

/**
 * Light / dark / system, and the accent palette.
 *
 * These drive the `data-theme` and `data-palette` attributes that the sourced
 * token layer keys off — so without this the panel is permanently light no
 * matter what the tokens define. The CSS and this file are two halves of one
 * mechanism.
 *
 * `ccTheme` and `ccPalette` are DEVICE preferences and stay out of the
 * sign-out wipe list, alongside `ccLayoutMode`. Resetting someone's theme as a
 * side effect of logging out is a regression dressed as tidiness.
 */

export type ThemeMode = 'system' | 'light' | 'dark';
export type Palette = 'indigo' | 'jade' | 'rose' | 'amber' | 'violet' | 'blue';

const MODES = new Set<ThemeMode>(['system', 'light', 'dark']);
const PALETTES = new Set<Palette>(['indigo', 'jade', 'rose', 'amber', 'violet', 'blue']);

const KEYS = { mode: 'ccTheme', palette: 'ccPalette' } as const;

class ThemeState {
  @tracked mode: ThemeMode = 'system';
  @tracked palette: Palette = 'indigo';
  /** Resolved: what is actually on screen right now. */
  @tracked isDark = false;

  private media: MediaQueryList | undefined;

  async load(): Promise<void> {
    try {
      this.media = window.matchMedia('(prefers-color-scheme: dark)');
      // Follow the OS while the mode is 'system'. A panel is long-lived, so
      // it can outlast a sunset — a popup never had to care.
      this.media.addEventListener('change', () => this.apply());
    } catch {
      this.media = undefined;
    }

    try {
      const saved = await chrome.storage.local.get([KEYS.mode, KEYS.palette]);
      const mode = saved[KEYS.mode] as ThemeMode;
      const palette = saved[KEYS.palette] as Palette;
      if (MODES.has(mode)) this.mode = mode;
      if (PALETTES.has(palette)) this.palette = palette;
    } catch {
      /* defaults are fine; this is a preference, not data */
    }
    this.apply();
  }

  /**
   * `indigo` and light mode are the DEFAULTS, expressed as an absent
   * attribute rather than a named one — which is why the token layer writes
   * `:root { … }` for indigo/light and only adds selectors for the variants.
   * Setting `data-palette="indigo"` would match no rule and quietly fall back
   * to the base, which happens to be right but for the wrong reason.
   */
  apply(): void {
    const root = document.documentElement;
    this.isDark = this.mode === 'dark' || (this.mode === 'system' && !!this.media?.matches);
    root.dataset['theme'] = this.isDark ? 'dark' : '';
    root.dataset['palette'] = this.palette === 'indigo' ? '' : this.palette;
  }

  /**
   * Three states, not two.
   *
   * A binary toggle can never get you BACK to 'system' — once you touch it
   * you are pinned to an explicit choice forever, and the panel stops
   * following the OS at sunset. light / dark / system is the pattern people
   * already recognise, and it is the only one where every state is reachable.
   */
  setMode = (mode: string): void => {
    if (!MODES.has(mode as ThemeMode)) return;
    this.mode = mode as ThemeMode;
    this.apply();
    void this.persist();
  };

  setPalette(palette: Palette): void {
    if (!PALETTES.has(palette)) return;
    this.palette = palette;
    this.apply();
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [KEYS.mode]: this.mode,
        [KEYS.palette]: this.palette,
      });
    } catch {
      /* not in an extension context */
    }
  }
}

export const theme = new ThemeState();
