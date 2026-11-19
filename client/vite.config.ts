import react from '@vitejs/plugin-react';
import type { AtRule, Plugin, Rule } from 'postcss';
import { defineConfig } from 'vite';

const target = process.env.RANCHCORD_SERVER ?? 'http://localhost:6420';

/**
 * Phone styles are written for narrow screens, `@media (max-width: 760px)`. Phones held sideways
 * are wider than that but keep the phone layout (src/lib/viewport.ts), so every such rule is also
 * copied for `html.is-phone`.
 */
function phoneLayoutRules(): Plugin {
  const scope = (selector: string) =>
    /^(html|:root)(?![\w-])/.test(selector) ? selector.replace(/^(html|:root)/, 'html.is-phone') : `html.is-phone ${selector}`;
  return {
    postcssPlugin: 'ranchcord-phone-layout',
    AtRule: {
      media(media: AtRule) {
        if (media.params.replace(/\s+/g, '') !== '(max-width:760px)') return;
        const copies: Rule[] = [];
        media.each((node) => {
          if (node.type === 'rule') copies.push(node.clone({ selectors: node.selectors.map(scope) }));
        });
        if (copies.length) media.after(copies);
      },
    },
  };
}

/**
 * Hover effects only where there's a mouse. On touch screens a tap counts as hovering, and iPhones
 * treat the first tap on anything that reveals a hidden button on hover as "just hovering", so that
 * tap did nothing.
 */
function hoverOnlyWithMouse(): Plugin {
  return {
    postcssPlugin: 'ranchcord-hover-media',
    Rule(rule: Rule, { AtRule }) {
      if (!rule.selector.includes(':hover')) return;
      for (let p = rule.parent; p; p = p.parent) {
        if (p.type === 'atrule' && /hover/.test((p as AtRule).params)) return;
      }
      const hover = rule.selectors.filter((s) => s.includes(':hover'));
      const rest = rule.selectors.filter((s) => !s.includes(':hover'));
      const media = new AtRule({ name: 'media', params: '(hover: hover)' });
      media.append(rule.clone({ selectors: hover }));
      rule.after(media);
      if (rest.length) rule.selectors = rest;
      else rule.remove();
    },
  };
}

export default defineConfig({
  plugins: [react()],
  base: '/',
  css: {
    postcss: { plugins: [phoneLayoutRules(), hoverOnlyWithMouse()] },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': target,
      '/files': target,
      '/downloads': target,
      '/socket.io': { target, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
