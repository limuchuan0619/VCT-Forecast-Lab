import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { teamLogo } from '../lib/team-logos.ts';
import manifest from '../public/team-logos/manifest.json' with { type: 'json' };

test('verified logos cover displayed teams with stable source IDs and original bytes', () => {
  const displayed = [
    '100 Thieves',
    'EDward Gaming',
    'FUT Esports',
    'G2 Esports',
    'Global Esports',
    'JD Gaming',
    'Karmine Corp',
    'LOUD',
    'MIBR',
    'NRG',
    'Nongshim RedForce',
    'Paper Rex',
    'T1',
    'TYLOO',
    'Team Liquid',
    'Team Vitality',
    'VARREL',
    'Xi Lai Gaming',
  ];
  for (const name of displayed) assert.ok(teamLogo(name), name);
  for (const team of manifest.teams) {
    const id = team.id.replace('vlr_team_', '');
    const source = new URL(team.source);
    assert.equal(source.origin, 'https://www.vlr.gg');
    assert.equal(source.pathname.split('/')[1], 'team');
    assert.equal(source.pathname.split('/')[2], id);
    assert.match(team.sourceImage, /^https:\/\/owcdn\.net\/img\//);
    assert.match(team.src, /^\/team-logos\/[a-z0-9-]+\.png$/);
    const bytes = readFileSync(
      new URL(`../public${team.src}`, import.meta.url),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), team.sha256);
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), 200);
    assert.equal(bytes.readUInt32BE(20), 200);
  }
});

test('unknown or ambiguous teams do not borrow another team logo', () => {
  assert.equal(teamLogo('Unknown Esports'), null);
  assert.equal(teamLogo('Team'), null);
  assert.equal(teamLogo('__proto__'), null);
  assert.equal(teamLogo('LOUD academy'), null);
  assert.deepEqual(teamLogo(' loud '), teamLogo('LOUD'));
  assert.notEqual(teamLogo('LOUD')?.src, teamLogo('MIBR')?.src);
});

test('two primary destinations keep all original home tabs and routes', () => {
  const chrome = readFileSync(
    new URL('../components/site-chrome.tsx', import.meta.url),
    'utf8',
  );
  assert.match(chrome, /href:\s*'\/',\s*label:\s*'首页'/);
  assert.match(chrome, /href:\s*'\/matches',\s*label:\s*'模型实验室'/);
  for (const label of ['最新预测', '预测历史', '赛后复盘'])
    assert.ok(chrome.includes(label));
  for (const route of ["href: '/'", "href: '/predictions'", "href: '/reviews'"])
    assert.ok(chrome.includes(route));
  assert.match(chrome, /aria-label="首页分类"/);
  assert.match(chrome, /aria-current=/);
});

test('filters, metrics and missing-data semantics remain presentation only', () => {
  const home = readFileSync(
    new URL('../app/page.tsx', import.meta.url),
    'utf8',
  );
  assert.match(home, /predictionsForDay\(day, region\)/);
  assert.match(home, /type="date"\s+name="date"/);
  assert.match(home, /name="region" value=\{region\}/);
  assert.match(home, /INTERNATIONAL/);
  const models = readFileSync(
    new URL('../app/matches/page.tsx', import.meta.url),
    'utf8',
  );
  for (const metric of [
    'm.accuracy',
    'm.brier.toFixed',
    'm.logLoss.toFixed',
    '.bins.map',
  ])
    assert.ok(models.includes(metric));
  assert.match(models, /Elo[\s\S]*?没有可核验的真实赛前对照记录/);
  const card = readFileSync(
    new URL('../components/match-list-card.tsx', import.meta.url),
    'utf8',
  );
  assert.match(card, /Number.isFinite\(value\)/);
  assert.match(card, /暂无胜率/);
  const css = readFileSync(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(css, /gradient\(|backdrop-filter|feTurbulence/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /\.match-list-card\.featured-match/);
});
