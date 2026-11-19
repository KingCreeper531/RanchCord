#!/usr/bin/env node
// Checks the link preview safety rules and page reader directly (no server needed).
//   node scripts/link-preview-test.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The module opens the database when it loads, so give it a throwaway one.
const dataDir = mkdtempSync(path.join(tmpdir(), 'rc-lp-'));
process.env.DATA_DIR = dataDir;
const { _test } = await import('../server/src/lib/linkPreview.ts');
const { allowedUrl, ipBlocked, metaTags } = _test;

let failures = 0;
const ok = (cond, label) => {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
};

const refused = [
  'http://127.0.0.1/',
  'http://localhost/',
  'http://192.168.1.1/',
  'http://10.0.0.1/',
  'http://100.100.100.100/',
  'http://169.254.169.254/',
  'http://0x7f.1/',
  'http://2130706433/',
  'http://[::1]/',
  'http://[::]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[::ffff:7f00:1]/',
  'http://[::ffff:192.168.1.1]/',
  'http://[::ffff:100.100.100.100]/',
  'http://[0:0:0:0:0:ffff:7f00:1]/',
  'http://[::127.0.0.1]/',
  'http://[::ffff:0:127.0.0.1]/',
  'http://[64:ff9b::7f00:1]/',
  'http://[2002:7f00:1::]/',
  'http://[fd7a:115c:a1e0::1]/',
  'http://[fe80::1]/',
  'http://example.com:8080/',
  'http://user:pw@example.com/',
  'ftp://example.com/',
  'http://pi.local/',
  'http://ranch.ts.net/',
];
for (const url of refused) ok(allowedUrl(url) === null, `refuses ${url}`);

const allowed = ['https://example.com/', 'http://example.com/page?x=1', 'https://93.184.215.14/', 'https://[2606:4700:4700::1111]/'];
for (const url of allowed) ok(allowedUrl(url) !== null, `allows ${url}`);

ok(ipBlocked('::ffff:10.1.2.3') && ipBlocked('::ffff:a01:203'), 'mapped private addresses are blocked in both spellings');
ok(!ipBlocked('::ffff:8.8.8.8') && !ipBlocked('2606:4700:4700::1111'), 'public addresses are fine');
ok(ipBlocked('not an ip') && ipBlocked('1.2.3'), 'anything unreadable is refused');

// The page reader takes the usual tags...
const page = `<html><head><title>Ranch &amp; more</title>
<meta property="og:title" content="Best ranch">
<META NAME='description' CONTENT='Creamy'>
<meta property=og:image content=https://example.com/a.png>
<metadata property="og:site_name" content="not a meta tag">
</head><body><meta property="og:title" content="ignored after head"></body></html>`;
const { meta, title } = metaTags(page);
ok(title === 'Ranch &amp; more', 'reads the title');
ok(meta.get('og:title') === 'Best ranch', 'reads quoted meta tags');
ok(meta.get('description') === 'Creamy', 'reads upper-case tags and single quotes');
ok(meta.get('og:image') === 'https://example.com/a.png', 'reads unquoted values');
ok(!meta.has('og:site_name'), "doesn't mistake <metadata> for a meta tag");

// ...and stays fast on pages built to make it slow.
const nasty = [
  '<meta '.repeat(130_000),
  '<title>'.repeat(110_000),
  `<meta content="${'x'.repeat(760_000)}`,
  `<meta ${'property="'.repeat(70_000)}>`,
];
for (const [i, html] of nasty.entries()) {
  const t0 = performance.now();
  metaTags(html);
  const ms = performance.now() - t0;
  ok(ms < 500, `hostile page ${i + 1} is read in ${Math.round(ms)} ms`);
}

try {
  rmSync(dataDir, { recursive: true, force: true });
} catch {
  // Windows keeps the database file locked while it's open; the temp folder gets cleaned up later.
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
