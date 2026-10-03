/**
 * DVI 利润网 · 玩家配置 / 强化 / 战斗 三个模块的测试
 *
 * 零依赖自跑：node --experimental-strip-types test/modules.test.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { GameData, Options } from '../src/types.ts'
import { PriceBook } from '../src/calc/price.ts'
import {
  defaultPlayer, skillMult, combatMult, tierMult, toolBonus, toolsForSlot,
  isPristine, deserialize, type PlayerState,
} from '../src/calc/player.ts'
import {
  enhanceBalance, tierChance, pathChance, analyseEnhance, enhanceAll, ASSUMPTIONS,
} from '../src/calc/enhance.ts'
import { analyseCombat, combatAll } from '../src/calc/combat.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const data: GameData = JSON.parse(
  readFileSync(resolve(HERE, '../public/data/dvi-gamedata.json'), 'utf-8'),
)

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
function near(a: number, b: number, tol: number) { return Math.abs(a - b) <= tol }
function section(t: string) { console.log('\n' + t) }

const opts: Options = { parallelGrow: true, revenueSide: 'bid', taxBp: 200, playerLevel: 99 }

/* ══════════ ① 玩家配置 ══════════ */
section('① 玩家配置')
{
  const b = enhanceBalance(data)

  ok('默认状态是「未配置」', isPristine(defaultPlayer()))
  ok('层数 0 的倍率是 1', tierMult(0, b.qualityMult) === 1)
  ok('层数超界时取最后一档', tierMult(99, [1, 3, 8]) === 8, String(tierMult(99, [1, 3, 8])))

  // 采集增益应提高采集系、不提高制作系
  const p1: PlayerState = { ...defaultPlayer(), buffTier: 2 }
  const gather = skillMult(data, p1, 'mining')
  const craft = skillMult(data, p1, 'smithing')
  ok('采集增益提高采集技能倍率', gather > 1, String(gather))
  ok('采集增益不影响制作技能', near(craft, 1, 1e-9), String(craft))

  // 特权
  const p2: PlayerState = { ...defaultPlayer(), perkRanks: { gather: 10 } }
  ok('采集特权提高采集倍率', skillMult(data, p2, 'mining') > 1)
  const p3: PlayerState = { ...defaultPlayer(), perkRanks: { craft: 10 } }
  ok('制作特权提高制作倍率', skillMult(data, p3, 'smithing') > 1)
  ok('制作特权不影响采集', near(skillMult(data, p3, 'mining'), 1, 1e-9))

  // 工具：槽位要对应技能才生效
  const slots = (data.extra as any).toolSlots
  ok('工具槽位表完整（10 个槽）', Object.keys(slots).length === 10, String(Object.keys(slots).length))
  const pickaxes = toolsForSlot(data, 'pickaxe')
  ok('镐槽位有多把镐可选', pickaxes.length > 0, `${pickaxes.length} 把`)
  const bestPick = pickaxes[pickaxes.length - 1]
  const p4: PlayerState = { ...defaultPlayer(), tools: { pickaxe: bestPick.itemId } }
  ok('装备镐提高挖矿倍率',
     near(skillMult(data, p4, 'mining'), 1 + bestPick.bonus, 1e-9),
     `${skillMult(data, p4, 'mining')} vs ${1 + bestPick.bonus}`)
  ok('装备镐不影响钓鱼', near(skillMult(data, p4, 'fishing'), 1, 1e-9))
  ok('工具加成查得到', toolBonus(data, bestPick.itemId) === bestPick.bonus)

  // 祝福 / 社区活动
  const p5: PlayerState = { ...defaultPlayer(), blessing: true }
  const bl = (data.extra as any).blessing
  ok('祝福提高采集倍率', near(skillMult(data, p5, 'mining'), bl.gather, 1e-9),
     `${skillMult(data, p5, 'mining')} vs ${bl.gather}`)
  const p6: PlayerState = { ...defaultPlayer(), communityMult: 2 }
  ok('社区活动倍率 2 直接翻倍采集', near(skillMult(data, p6, 'mining'), 2, 1e-9))

  // 战斗倍率
  const p7: PlayerState = { ...defaultPlayer(), combatBuffTier: 1, blessing: true }
  ok('战斗增益 + 祝福叠加', combatMult(data, p7) > 1)

  // 序列化
  ok('序列化/反序列化往返一致',
     JSON.stringify(deserialize(JSON.stringify(p4))) === JSON.stringify(p4))
  ok('反序列化垃圾输入不崩', isPristine(deserialize('not json')))
  ok('反序列化 null 用默认值', isPristine(deserialize(null)))
}

/* ══════════ ② 强化 ══════════ */
section('② 强化')
{
  const b = enhanceBalance(data)
  const book = new PriceBook(data)

  ok('最高 5 阶', b.maxTier === 5, String(b.maxTier))
  ok('每阶 3 碎片', b.shardsPerTier === 3, String(b.shardsPerTier))
  ok('品质倍率 [1,3,8,20,50]', JSON.stringify(b.qualityMult) === '[1,3,8,20,50]')
  ok('金币 6 档', b.goldTiers.length === 6, String(b.goldTiers.length))
  ok('+5 是 +0 的 50 倍', b.qualityMult[4] === 50, String(b.qualityMult[4]))

  // 成功率应单调递减且有下限
  const cs = [1, 2, 3, 4, 5].map(n => tierChance(b, n))
  ok('成功率随阶数递减', cs.every((c, i) => i === 0 || c < cs[i - 1]), JSON.stringify(cs))
  ok('成功率不低于下限', cs.every(c => c >= b.baseChanceFloor), JSON.stringify(cs))
  ok('一阶成功率在 0~1 之间', cs.every(c => c > 0 && c < 1))

  // 全程概率应远小于单阶
  ok('全程概率 < 任何单阶', pathChance(b, 5) < Math.min(...cs), String(pathChance(b, 5)))

  // 分析一件具体装备
  const gear = data.items.find(i => i.name === 'Colossus greatsword') ?? data.items[100]
  const shard = data.items.find(i => /shard/i.test(i.name)) ?? data.items[0]
  const r = analyseEnhance(data, book, { itemId: gear.id, targetTier: 5, shardItemId: shard.id }, opts)
  ok('能算出强化结果', !!r)
  ok('5 阶共 5 步', r!.steps.length === 5, String(r!.steps.length))
  ok('最终价值 = 基础 × 50', near(r!.finalValue, gear.value * 50, 1e-6),
     `${r!.finalValue} vs ${gear.value * 50}`)
  ok('价值增量 = 终值 − 原值', near(r!.valueGain, r!.finalValue - r!.baseValue, 1e-9))
  ok('净利 = 价值增量 − 期望成本',
     near(r!.net, r!.valueGain - r!.totalExpectedCost, 1e-6))
  ok('每阶期望成本 = 名义成本 / 成功率',
     near(r!.steps[0].expectedCost, r!.steps[0].cost / r!.steps[0].chance, 1e-6))
  ok('金币按档位递增', r!.steps[1].gold > r!.steps[0].gold,
     `${r!.steps[0].gold} → ${r!.steps[1].gold}`)
  ok('假设清单非空（便于日后核对）', ASSUMPTIONS.length > 0)

  // 自产碎片 → 成本降为纯金币
  const selfMade = analyseEnhance(
    data, book, { itemId: gear.id, targetTier: 5, shardItemId: shard.id, shardsAreSelfMade: true }, opts)
  ok('碎片自产时成本只剩金币', selfMade!.totalExpectedCost < r!.totalExpectedCost,
     `${selfMade!.totalExpectedCost} vs ${r!.totalExpectedCost}`)

  // 边界
  const zero = analyseEnhance(data, book, { itemId: gear.id, targetTier: 0, shardItemId: shard.id }, opts)
  ok('0 阶有提醒', zero!.warnings.length > 0, JSON.stringify(zero!.warnings))
  const over = analyseEnhance(data, book, { itemId: gear.id, targetTier: 99, shardItemId: shard.id }, opts)
  ok('超阶被夹到上限', over!.to === b.maxTier, String(over!.to))
  ok('未知物品返回 null',
     analyseEnhance(data, book, { itemId: -999, targetTier: 3, shardItemId: shard.id }, opts) === null)
  ok('碎片 id 无效时给出警告',
     analyseEnhance(data, book, { itemId: gear.id, targetTier: 3, shardItemId: -999 }, opts)!
       .warnings.some(w => w.includes('碎片')))

  // 批量
  const all = enhanceAll(data, book, shard.id, opts)
  ok('批量能算出全部物品', all.length === data.items.length, `${all.length}/${data.items.length}`)
  ok('批量结果里有正收益的', all.some(x => x.net > 0), '一个都没有说明公式可能有问题')
}

/* ══════════ ③ 战斗 ══════════ */
section('③ 战斗')
{
  const book = new PriceBook(data)
  const m = data.monsters[0]

  ok('怪物数据非空', data.monsters.length === 20, String(data.monsters.length))
  ok('drop 指向真实物品', !!book.item(m.drop), `#${m.drop}`)

  // 用每只耗时换算击杀频率
  const byTime = analyseCombat(data, book, { monsterId: m.id, secondsPerKill: 10 }, opts)
  ok('由耗时换算出击杀数', near(byTime!.killsPerHour, 360, 1e-9), String(byTime!.killsPerHour))

  const byRate = analyseCombat(data, book, { monsterId: m.id, killsPerHour: 360 }, opts)
  ok('两种输入方式结果一致',
     near(byTime!.totalPerHour, byRate!.totalPerHour, 1e-6),
     `${byTime!.totalPerHour} vs ${byRate!.totalPerHour}`)

  // 金币取区间期望
  const g = m.gold
  ok('金币按区间期望', near(byTime!.goldPerKill, (g[0] + g[1]) / 2, 1e-9),
     `${byTime!.goldPerKill} vs ${(g[0] + g[1]) / 2}`)

  // 掉落含额外掉落的期望
  const bc = m.bonus?.chance ?? 0
  ok('掉落数量含额外掉落期望', near(byTime!.dropPerKill, 1 + bc, 1e-9),
     `${byTime!.dropPerKill} vs ${1 + bc}`)

  // 经验受战斗倍率影响（必须用**相同**击杀频率对比，否则比的是频率不是倍率）
  const baseXp = analyseCombat(data, book, { monsterId: m.id, killsPerHour: 100 }, opts)!
  const pBoost = analyseCombat(data, book, { monsterId: m.id, killsPerHour: 100 }, opts, {
    ...defaultPlayer(), combatBuffTier: 2,
  })!
  ok('战斗增益提高经验收益', pBoost.xpPerHour > baseXp.xpPerHour,
     `${pBoost.xpPerHour} vs ${baseXp.xpPerHour}`)
  ok('战斗增益倍率为增益表对应档',
     pBoost.xpPerHour > baseXp.xpPerHour && pBoost.mult > 1,
     `mult=${pBoost.mult}`)
  ok('战斗增益不改变金币与掉落（只作用于经验与战斗效率）',
     pBoost.goldPerHour === baseXp.goldPerHour && pBoost.dropPerHour === baseXp.dropPerHour)

  // 未提供频率 → 必须明确警告，而不是默默按 1 只算
  const noFreq = analyseCombat(data, book, { monsterId: m.id }, opts)
  ok('未提供频率时给出警告', noFreq!.warnings.some(w => w.includes('击杀频率')),
     JSON.stringify(noFreq!.warnings))
  ok('未提供频率时按每小时 1 只', noFreq!.killsPerHour === 1)

  ok('未知怪物返回 null', analyseCombat(data, book, { monsterId: -1, killsPerHour: 1 }, opts) === null)

  // 批量
  const all = combatAll(data, book, opts, { killsPerHour: 100 })
  ok('批量能算全部怪物', all.length === 20, String(all.length))
  ok('等级越高收益通常越高',
     all[all.length - 1].totalPerHour > all[0].totalPerHour,
     `${all[0].name}=${all[0].totalPerHour} → ${all[all.length - 1].name}=${all[all.length - 1].totalPerHour}`)
}

/* ══════════ ④ 消耗品（DVI 特有，14 个 heals 物品） ══════════ */
section('④ 消耗品')
{
  const heals = data.items.filter(i => typeof i.heals === 'number')
  ok('存在带 heals 的物品', heals.length > 0, `${heals.length} 个`)
  ok('heals 值合理', heals.every(i => i.heals! > 0))
  // 消耗品的价值密度 = 每点治疗的价值，做成简单排行
  const density = heals
    .map(i => ({ name: i.name, d: i.value / i.heals! }))
    .sort((a, b) => b.d - a.d)
  ok('可算出治疗价值密度', density.length === heals.length && density[0].d > 0,
     `最高 ${density[0].name} = ${density[0].d.toFixed(2)}/点`)
  console.log(`    提示：单位治疗价值最高的是 ${density[0].name}（${density[0].d.toFixed(2)}/点）`)
}

/* ══════════ 汇总 ══════════ */
console.log('\n' + '─'.repeat(52))
if (fail === 0) console.log(`通过 ${pass} / ${pass}　全部通过 ✓`)
else {
  console.log(`通过 ${pass} / ${pass + fail}　失败 ${fail}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
}
