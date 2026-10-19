// Display vocabulary only. Source IDs, frozen text and evidence hashes stay intact.
// CN agent names: official account's 2023-06-15 announcement and CN agent directory.
// https://voice.hupu.com/bbs/60726544
// https://wiki.biligame.com/valorant/Portal:%E8%8B%B1%E9%9B%84
export const CN_AGENTS: Readonly<Record<string, string>> = {
  astra: '星礈',
  breach: '铁臂',
  brimstone: '炼狱',
  chamber: '尚勃勒',
  clove: '暮蝶',
  cypher: '零',
  deadlock: '钢锁',
  fade: '黑梦',
  gekko: '盖可',
  harbor: '海神',
  iso: '壹决',
  jett: '捷风',
  kayo: 'K/O',
  killjoy: '奇乐',
  miks: '迷核',
  neon: '霓虹',
  omen: '幽影',
  phoenix: '不死鸟',
  raze: '雷兹',
  reyna: '芮娜',
  sage: '贤者',
  skye: '斯凯',
  sova: '猎枭',
  tejo: '钛狐',
  viper: '蝰蛇',
  veto: '禁灭',
  vyse: '维斯',
  waylay: '幻棱',
  yoru: '夜露',
};

export function cnAgentName(id: string, includeNickname = true): string {
  const key = id.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'chamber' && includeNickname) return '尚勃勒（钱包）';
  return CN_AGENTS[key] ?? id;
}

export const CN_MAPS: Readonly<Record<string, string>> = {
  summit: '天枢云阙',
  abyss: '幽邃地窟',
  ascent: '升天之境',
  bind: '源工重镇',
  breeze: '微风岛屿',
  corrode: '盐海矿镇',
  fracture: '裂变峡谷',
  haven: '隐世修所',
  icebox: '森寒冬港',
  lotus: '莲华古城',
  pearl: '深海明珠',
  split: '霓虹町',
  sunset: '日落之城',
};

// Only unambiguous regional Chinese aliases are changed in prose. Do not replace
// arbitrary English words: a player/team can legitimately be named Phoenix etc.
export function localizeValorantText(text: string): string {
  return text
    .replace(/钱博尔|錢博爾/g, '尚勃勒')
    .replace(/丝凯|絲凱/g, '斯凯')
    .replace(/妮虹/g, '霓虹')
    .replace(/亞星卓|亚星卓/g, '星礈');
}

export const VALORANT_GLOSSARY_INSTRUCTION =
  `国服术语统一表（结构化agent/map ID原样保留；只规范正文）：${JSON.stringify(CN_AGENTS)}。` +
  'Chamber正文首次写尚勃勒（钱包）；Skye写斯凯，不写钱博尔、丝凯。地图沿用证据中的中文名。' +
  '首杀=该回合第一个击杀，首死=该回合第一个阵亡；二者不是进攻/防守得分。' +
  '同英雄不等于相同职责或直接对决，不把英雄选择本身当作战术已执行的证据。';
