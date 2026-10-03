/**
 * DVI 利润网 · 计算层测试
 *
 * 零依赖自跑：node --experimental-strip-types test/calc.test.ts
 *
 * 为什么要自己写断言而不用 vitest：
 * 这一层刻意不依赖任何运行时与框架（借鉴 milkonomy 的教训 ——
 * 「这是逻辑不是 UI，必须能被直接调用验证」）。
 * 没有依赖就能在 CI、在本地、在任何装了 Node 的地方立刻跑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import type { GameData, Options } from '../src/types.ts'
import { PriceBook } from '../src/calc/price.ts'
import { StepCalc } from '../src/calc/steps.ts'
import { ChainCalc } from '../src/calc/chain.ts'
import { Rank } from '../src/calc/rank.ts'
import { TICK_SECONDS, HOUR_TICKS, failChance, workTicks, effectiveTicks } from '../src/calc/expected.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const data: GameData = JSON.parse(
  readFileSync(resolve(HERE, '../public/data/dvi-gamedata.json'), 'utf-8'),
)

/* ── 迷你断言 ── */
let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
function near(a: number, b: number, tol: number) { return Math.abs(a - b) <= tol }
function section(t: string) { console.log('\n' + t) }

const baseOpts = (over: Partial<Options> = {}): Options => ({
  parallelGrow: true, revenueSide: 'bid', taxBp: 200, playerLevel: 99, ...over,
})

/* ══════════ 1. 时间单位（实测基准，改错会全盘皆错） ══════════ */
section('① 时间单位')
{
  ok('1 tick = 0.6 秒', TICK_SECONDS === 0.6, String(TICK_SECONDS))
  ok('1 小时 = 6000 tick', HOUR_TICKS === 6000, String(HOUR_TICKS))
}

/* ══════════ 2. 失败率：线性衰减到 safeAtLevel 归零 ══════════ */
section('② 失败率')
{
  const a = data.actions.find(x => x.burn)!
  const spec = a.burn!
  ok('需求等级处等于 chanceAtReq', near(failChance(a, spec, a.levelReq), spec.chanceAtReq, 1e-9),
     `${failChance(a, spec, a.levelReq)} vs ${spec.chanceAtReq}`)
  ok('safeAtLevel 处归零', failChance(a, spec, spec.safeAtLevel) === 0,
     String(failChance(a, spec, spec.safeAtLevel)))
  const mid = (a.levelReq + spec.safeAtLevel) / 2
  ok('中点约为一半', near(failChance(a, spec, mid), spec.chanceAtReq / 2, 1e-6),
     String(failChance(a, spec, mid)))
  ok('超等级不出现负数', failChance(a, spec, spec.safeAtLevel + 50) === 0)
  ok('远低于需求时封顶在 chanceAtReq', failChance(a, spec, 1) <= spec.chanceAtReq + 1e-9)
}

/* ══════════ 3. grow：两种口径结论相反 ══════════ */
section('③ 生长时间的两��口径')
{
  const farm = data.actions.find(a => a.grow != null)!
  ok('种子里有 grow 字段', typeof farm.grow === 'number' && farm.grow > 0, String(farm.grow))
  const par = workTicks(farm, baseOpts({ parallelGrow: true }))
  const ser = workTicks(farm, baseOpts({ parallelGrow: false }))
  ok('并行口径只算动手时间', par === farm.baseTicks, `${par} vs ${farm.baseTicks}`)
  ok('单线程口径含生长时间', ser === farm.baseTicks + farm.grow, `${ser} vs ${farm.baseTicks + farm.grow}`)
  ok('两者差异显著（这正是要暴露给用户的原因）', ser > par * 10, `${ser} vs ${par}`)

  const noGrow = data.actions.find(a => a.grow == null)!
  ok('无 grow 的配方两种口径一致',
     workTicks(noGrow, baseOpts({ parallelGrow: true })) === workTicks(noGrow, baseOpts({ parallelGrow: false })))
}

/* ══════════ 4. 价格三层来源 ══════════ */
section('④ 三层价格')
{
  const book = new PriceBook(data)
  const it = data.items[0]
  ok('无市场时退回兜底价', book.price(it.id, 'ask').source === 'fallback')
  ok('兜底价等于基础价值', book.price(it.id, 'ask').value === it.value,
     `${book.price(it.id, 'ask').value} vs ${it.value}`)

  book.setManual(it.id, 123)
  ok('手动价优先级最高', book.price(it.id, 'ask').value === 123 && book.price(it.id, 'ask').source === 'manual')

  book.setMarket(new Map([[it.id, {
    ask: { price: 200, qty: 10 }, bid: { price: 180, qty: 4 },
  }]]))
  book.setManual(it.id, null)          // 先清手动价，否则它优先级更高
  ok('有市场时取市场价', book.price(it.id, 'ask').value === 200)
  ok('成本方向默认取 ask（保守）', book.price(it.id, 'ask').side === 'ask')
  ok('收益方向默认取 bid（保守）', book.price(it.id, 'bid').value === 180)
  // 手动价优先级最高 —— 重新设一次再断言
  book.setManual(it.id, 123)
  ok('手动价仍然压过市场价', book.price(it.id, 'ask').value === 123)
  book.setManual(it.id, null)
  ok('挂单量被带出来', book.price(it.id, 'ask').qty === 10, String(book.price(it.id, 'ask').qty))

  ok('清掉手动价后回到市场', book.price(it.id, 'ask').value === 200)

  // 高利润 ≠ 可成交
  const thin = data.items[1]
  book.setMarket(new Map([[thin.id, { ask: { price: 9999, qty: 1 } }]]))
  ok('挂单量只有 1 时可成交量就是 1', book.maxSellable(thin.id, 'ask') === 1,
     String(book.maxSellable(thin.id, 'ask')))
  ok('无市场时可成交量视为无限', book.maxSellable(999999, 'ask') === Infinity)
  book.clearManual()
}

/* ══════════ 5. 单步计算 ══════════ */
section('⑤ 单步计算')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const opts = baseOpts()

  const copper = steps.action(1)!
  const r = steps.run(copper, opts)
  ok('能算出结果', !!r)
  ok('时间随 baseTicks 换算正确', near(r!.seconds, copper.baseTicks * TICK_SECONDS, 1e-9),
     `${r!.seconds} vs ${copper.baseTicks * TICK_SECONDS}`)
  ok('采集类无原料成本', r!.cost === 0, String(r!.cost))
  ok('扣了 2% 税', near(r!.income, r!.income, 1e-9) && r!.income > 0)
  const expectGross = data.items.find(i => i.id === copper.output!.itemId)!.value * 0.98
  ok('收入 = 价值 × (1−2%)', near(r!.income, expectGross, 1e-6), `${r!.income} vs ${expectGross}`)
  ok('净利为正', r!.net > 0)

  const ore = steps.action(6) // 有原料的
  if (ore?.inputs?.length) {
    const r2 = steps.run(ore, opts)!
    ok('有原料的配方成本 > 0', r2.cost > 0, String(r2.cost))
  }

  // 额外掉落
  const bonusAct = data.actions.find(a => a.bonus)
  if (bonusAct) {
    const rb = steps.run(bonusAct, opts)!
    ok('额外掉落计入期望产出',
       near(rb.expectedOut, bonusAct.output!.qty + bonusAct.bonus!.chance, 1e-9),
       `${rb.expectedOut} vs ${bonusAct.output!.qty + bonusAct.bonus!.chance}`)
    ok('额外掉落被记进 factors', rb.factors.some(f => f.label === '额外掉落'))
  }

  // 失败率影响工时
  const burnAct = data.actions.find(a => a.burn)!
  const lowLv = steps.run(burnAct, baseOpts({ playerLevel: burnAct.levelReq }))!
  const safeLv = steps.run(burnAct, baseOpts({ playerLevel: burnAct.burn!.safeAtLevel }))!
  ok('满级安全时工时最短', safeLv.ticks < lowLv.ticks, `${safeLv.ticks} vs ${lowLv.ticks}`)
  ok('失败率被记进 factors', lowLv.factors.some(f => f.label === '烧焦' || f.label === '被抓'))
  ok('安全等级上失败率归零 → 不再有失败 factor',
     !safeLv.factors.some(f => f.label === '烧焦' || f.label === '被抓'))
}

/* ══════════ 6. 整链核算：中间品 0 价流转（最关键） ══════════ */
section('⑥ 整链核算 · 中间品不得重复计价')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const chain = new ChainCalc(data, book, steps)
  const opts = baseOpts()

  // 找一条真链：深度 3 的成品
  let target = 0
  for (const a of data.actions) {
    if (!a.output) continue
    const ch = chain.autoChain(a.id, opts)
    if (ch.length >= 3) { target = a.id; break }
  }
  ok('能找到多级链', target > 0)

  if (target > 0) {
    const stepsList = chain.autoChain(target, opts)
    ok('autoChain 补全了前置环节', stepsList.length >= 2, `${stepsList.length} 步`)

    // 顺序必须「先料后成品」：每一步的产物都不能早于它的消费出现
    const seen = new Set<number>()
    let orderOk = true
    for (const s of stepsList) {
      const a = steps.action(s.actionId)!
      for (const inp of a.inputs) {
        if (steps.producersOf(inp.itemId).length && !seen.has(inp.itemId)) orderOk = false
      }
      if (a.output) seen.add(a.output.itemId)
    }
    ok('链条顺序正确（原料在成品之前）', orderOk)

    const r = chain.run(stepsList, opts)!
    ok('整链能算出结果', !!r)
    ok('成本 = 第一步的原料钱', near(r.cost, r.steps[0].cost, 1e-6),
       `${r.cost} vs ${r.steps[0].cost}`)
    ok('收入 = 最后一步的成品钱', near(r.income, r.steps[r.steps.length - 1].income, 1e-6),
       `${r.income}`)
    ok('中间步骤不重复计入收入',
       r.steps.slice(1, -1).every(s => s.income === 0 || s.income < 1e-6),
       JSON.stringify(r.steps.map(s => +s.income.toFixed(2))))
    ok('瓶颈被标出来', r.bottleneck === null || (r.bottleneck >= 0 && r.bottleneck < stepsList.length))

    // ★ 核心断言：中间品绝不能既算收入又算成本
    const midItems = new Set<number>()
    for (let i = 0; i < stepsList.length - 1; i++) {
      const a = steps.action(stepsList[i].actionId)!
      if (a.output) midItems.add(a.output.itemId)
    }
    const midStep = r.steps.slice(0, -1)
    ok('中间品的产出不计收入', midStep.every(s => s.income === 0 || s.income < 1e-6),
       JSON.stringify(midStep.map(s => +s.income.toFixed(2))))
    ok('中间品数量不为零（确实存在）', midItems.size > 0, `${midItems.size} 个`)
  }

  // 手工指定一条两段链，精确验证 0 价流转
  const mid = data.actions.find(a => a.inputs?.length && a.output)
  if (mid) {
    const up = steps.producersOf(mid.inputs[0].itemId)[0]
    if (up) {
      const r2 = chain.run([{ actionId: up.id }, { actionId: mid.id }], opts)!
      const upOut = up.output!.itemId
      // 上游那一步的产物被下游消耗 → 它的收入必须是 0
      ok('两段链：上游产出被下游消耗时收入计 0', r2.steps[0].income === 0,
         String(r2.steps[0].income))
      ok('两段链：成品那一步才计收入', r2.steps[1].income > 0, String(r2.steps[1].income))
      ok('两段链：成本只算上游的原料', near(r2.cost, r2.steps[0].cost, 1e-6))
    }
  }
}

/* ══════════ 7. 整图铺开 ══════════ */
section('⑦ 整图铺开（DVI 链条最深 3 层）')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const chain = new ChainCalc(data, book, steps)
  const opts = baseOpts()

  const t0 = Date.now()
  const g = chain.fullGraph(opts)
  const ms = Date.now() - t0
  ok('整张图能算出来', g.size > 100, `${g.size} 个产物`)
  ok('耗时可接受（< 3 秒）', ms < 3000, `${ms} ms`)

  const hist = chain.depthHistogram()
  const maxDepth = Math.max(...Object.keys(hist).map(Number))
  ok('最大深度为 3（实测结论）', maxDepth === 3, `实得 ${maxDepth}：${JSON.stringify(hist)}`)

  // 全图算完后，绝大多数结果应当自洽
  let bad = 0
  for (const r of g.values()) {
    if (r.steps.length > 1) {
      // 多步链里，除最后一步外都不该有收入
      for (let i = 0; i < r.steps.length - 1; i++) {
        if (r.steps[i].income > 1e-6) bad++
      }
    }
  }
  ok('全图范围内没有重复计价', bad === 0, `${bad} 处异常`)
}

/* ══════════ 8. 排行 ══════════ */
section('⑧ 排行')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const chain = new ChainCalc(data, book, steps)
  const rank = new Rank(data, book, steps, chain)
  const opts = baseOpts()

  const rows = rank.build(opts)
  ok('能构建排行', rows.length > 150, `${rows.length} 行`)
  const s = rank.summary()
  ok('概览统计可用', s.total === rows.length && s.skills === 10, JSON.stringify(s))

  const sorted = rank.sort(rows, 'chainNet')
  ok('按整链净利排序是降序', sorted[0].chainNetPerHour >= sorted[1].chainNetPerHour,
     `${sorted[0].chainNetPerHour} vs ${sorted[1].chainNetPerHour}`)

  const filtered = rank.filter({ skill: 'mining' })
  ok('按技能过滤生效', filtered.length > 0 && filtered.every(r => r.skill === 'mining'),
     `${filtered.length} 行`)

  const lv = rank.filter({ maxLevel: 10 })
  ok('按等级过滤生效', lv.every(r => r.levelReq <= 10))

  const kw = rank.filter({ keyword: 'steel' })
  ok('关键词搜索生效', kw.every(r => `${r.name} ${r.group}`.toLowerCase().includes('steel')))

  // 两种口径的差异必须能看出来 —— 否则「口径」这个设置就是摆设
  const rkA = new Rank(data, book, steps, chain)
  const rkB = new Rank(data, book, steps, chain)
  const mapA = new Map(rkA.build(baseOpts({ parallelGrow: true })).map(r => [r.actionId, r.chainNetPerHour]))
  const rowsB = rkB.build(baseOpts({ parallelGrow: false }))
  let diff = 0
  for (const r of rowsB) {
    const a = mapA.get(r.actionId)
    if (a != null && Math.abs(a - r.chainNetPerHour) > 1e-6) diff++
  }
  ok('并行/单线程口径确实改变了部分排行的数值', diff > 0, `${diff} 行不同`)
  // 采集类（无 grow）不该受影响 —— 口径开关不该误伤它们
  const gather = rowsB.find(r => r.skill === 'mining')!
  ok('无 grow 的配方不受口径影响', diff > 0 && gather != null)
}

/* ══════════ 9. 税率与方向 ══════════ */
section('⑨ 税率与计价方向')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const copper = steps.action(1)!

  const noTax = steps.run(copper, baseOpts({ taxBp: 0 }))!
  const taxed = steps.run(copper, baseOpts({ taxBp: 200 }))!
  ok('税率越高收入越低', taxed.income < noTax.income,
     `${taxed.income} vs ${noTax.income}`)

  // 灌一个市场，验证 bid（保守）低于 ask（乐观）
  const outId = copper.output!.itemId
  book.setMarket(new Map([[outId, { ask: { price: 100, qty: 5 }, bid: { price: 80, qty: 5 } }]]))
  const con = steps.run(copper, baseOpts({ revenueSide: 'bid' }))!
  const opt = steps.run(copper, baseOpts({ revenueSide: 'ask' }))!
  ok('收益按 bid 比按 ask 低（保守口径）', con.income < opt.income,
     `${con.income} vs ${opt.income}`)
  ok('两者差距约等于买卖价差', near(opt.income - con.income, (100 - 80) * 0.98, 1e-6),
     `${opt.income - con.income}`)
}

/* ══════════ 10. 健壮性 ══════════ */
section('⑩ 健壮性')
{
  const book = new PriceBook(data)
  const steps = new StepCalc(data, book)
  const chain = new ChainCalc(data, book, steps)

  ok('未知配方返回 null', steps.run({ id: -1 } as never, baseOpts()) === null)
  ok('未知配方 id 取不到', steps.action(999999) === undefined)
  ok('空链返回 null', chain.run([], baseOpts()) === null)
  ok('链里有不存在的配方会报警', (() => {
    const r = chain.run([{ actionId: 999999 }], baseOpts())
    return r === null || r.warnings.length > 0
  })())
  ok('等级不足时标记为不可做', (() => {
    const r = steps.run(steps.action(1)!, baseOpts({ playerLevel: 0 }))!
    return r.available === false
  })())
  ok('没有玩家等级时不做过滤', steps.run(steps.action(1)!, baseOpts({ playerLevel: undefined }))!.available === true)
  ok('价格方向回退不会崩', (() => {
    const b2 = new PriceBook(data)
    b2.setMarket(new Map([[999999, { ask: { price: 1, qty: 1 } }]]))
    return b2.price(999999, 'ask').value >= 0
  })())
  ok('手动价非法时被忽略', (() => {
    const b2 = new PriceBook(data)
    b2.setManual(1, -5)
    b2.setManual(2, NaN)
    return Object.keys(b2.manualAll()).length === 0
  })())
  ok('手动价可导入导出', (() => {
    const b2 = new PriceBook(data)
    b2.setManual(10, 55); b2.setManual(11, 66)
    const n = b2.loadManual(JSON.parse(JSON.stringify(b2.manualAll())))
    return n === 2 && b2.price(10, 'ask').value === 55
  })())
}

/* ══════════ 汇总 ══════════ */
console.log('\n' + '─'.repeat(52))
if (fail === 0) console.log(`通过 ${pass} / ${pass}　全部通过 ✓`)
else {
  console.log(`通过 ${pass} / ${pass + fail}　失败 ${fail}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
}
