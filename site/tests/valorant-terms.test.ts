import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cnAgentName,
  CN_MAPS,
  localizeValorantText,
} from '../lib/valorant-terms.ts';
import { plainText } from '../lib/presentation.ts';

test('CN glossary covers reader agents and accepts source IDs without renaming them', () => {
  assert.equal(cnAgentName('chamber'), '尚勃勒（钱包）');
  assert.equal(cnAgentName('CHAMBER', false), '尚勃勒');
  assert.equal(cnAgentName('skye'), '斯凯');
  assert.equal(cnAgentName('KAY/O'), 'K/O');
  assert.equal(cnAgentName('miks'), '迷核');
  assert.equal(cnAgentName('veto'), '禁灭');
  for (const [id, name] of Object.entries({
    gekko: '盖可',
    deadlock: '钢锁',
    iso: '壹决',
    clove: '暮蝶',
    vyse: '维斯',
    tejo: '钛狐',
    waylay: '幻棱',
  }))
    assert.equal(cnAgentName(id), name);
  assert.equal(cnAgentName('unverified_new_agent'), 'unverified_new_agent');
  assert.equal(CN_MAPS.corrode, '盐海矿镇');
  assert.equal(CN_MAPS.summit, '天枢云阙');
});
test('old regional prose is localized at display time, not rewritten in storage', () => {
  const saved = {
    text: '钱博尔、錢博爾、丝凯、絲凱、妮虹、亞星卓；Phoenix玩家；首杀6，ADR 150。',
    agent: 'chamber',
  };
  const before = JSON.stringify(saved);
  const shown = plainText(saved.text);
  assert.match(shown, /尚勃勒/);
  assert.match(shown, /斯凯/);
  assert.doesNotMatch(shown, /钱博尔|錢博爾|丝凯|絲凱|妮虹|亞星卓/);
  assert.match(shown, /Phoenix玩家/);
  assert.equal(localizeValorantText(shown), shown);
  assert.equal(JSON.stringify(saved), before);
});
