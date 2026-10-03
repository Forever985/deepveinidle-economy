/**
 * 数据指纹 · 跨端一致性验证
 *
 * ## 为什么必须测这个
 *   整个「可核对凭证」机制的前提是：**dvi-tools 和利润网站算出的指纹必须相同**。
 *   两边算法哪怕差一个字符，用户拿着两串不同的值去对账，
 *   就会以为「数据没送到」——比没有这个机制更糟。
 *
 * 所以这里直接从**两边真实的源码**里抽出实现来跑，而不是照着算法重写一遍
 * ——重写一遍等于没测。
 *
 *   游戏侧：从构建产物 dvi-tools.user.js 里抽（确保测的是真正会跑的那份）
 *   网站侧：从 src/stores/market.ts 里 import
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { fingerprintOf } from '../src/stores/market.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')

let pass = 0, fail = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`) }
}
function section(t: string) { console.log('\n' + t) }

/** 按括号配平截出一个函数（比正则可靠：函数体里有字符串、嵌套大括号） */
function grabFn(src: string, head: string): string | null {
  const i = src.indexOf(head)
  if (i < 0) return null
  let depth = 0
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  return null
}

const built = readFileSync(resolve(ROOT, 'dvi-tools/dvi-tools.user.js'), 'utf8')
const gameSrc = grabFn(built, 'function fingerprint(market)')

section('① 游戏侧实现存在')
ok('构建产物里找得到 fingerprint()', !!gameSrc)
if (!gameSrc) { console.log('\n无法继续：游戏侧实现缺失'); process.exit(1) }

const gameFp = new Function(`${gameSrc}; return fingerprint;`)() as (m: unknown) => string

section('② 两端算法一致')
{
  const mk = (n: number) => {
    const m: Record<string, unknown> = {}
    for (let i = 1; i <= n; i++) m[i] = { a: { p: 100 + i, q: 5 }, b: { p: 90 + i, q: 3 } }
    return m
  }
  const market = mk(545)
  const a = gameFp(market)
  const b = fingerprintOf(market)
  ok('同一份数据两端算出同一个指纹', a === b, `${a} vs ${b}`)
  ok('格式是固定 6 位大写字母数字', /^[0-9A-Z]{6}$/.test(a), a)

  // 键序无关 —— 否则 JSON 序列化顺序一变就对不上
  const shuffled: Record<string, unknown> = {}
  for (const k of Object.keys(market).sort(() => Math.random() - 0.5)) shuffled[k] = market[k]
  ok('键序打乱后仍一致', gameFp(shuffled) === fingerprintOf(shuffled))

  // 数量不同也要能算
  ok('不同物品数也能算出一致结果', gameFp(mk(10)) === fingerprintOf(mk(10)))
}

section('③ 数据变了指纹必须变（否则对账无意义）')
{
  const base: Record<string, unknown> = {}
  for (let i = 1; i <= 50; i++) base[i] = { a: { p: 100 + i, q: 5 } }
  const f0 = fingerprintOf(base)

  const priceChanged = JSON.parse(JSON.stringify(base)) as Record<string, { a: { p: number } }>
  priceChanged[5].a.p = 999
  ok('改一个价格 → 指纹变化', fingerprintOf(priceChanged) !== f0)

  const qtyChanged = JSON.parse(JSON.stringify(base)) as Record<string, { a: { q: number } }>
  qtyChanged[5]!.a.q = 1
  ok('改一个挂单量 → 指纹变化', fingerprintOf(qtyChanged) !== f0)

  const removed = JSON.parse(JSON.stringify(base))
  delete removed[5]
  ok('少一个物品 → 指纹变化', fingerprintOf(removed) !== f0)

  const added = JSON.parse(JSON.stringify(base))
  added[999] = { a: { p: 1, q: 1 } }
  ok('多一个物品 → 指纹变化', fingerprintOf(added) !== f0)

  ok('空数据也能算出稳定值', /^[0-9A-Z]{6}$/.test(fingerprintOf({})))
  ok('空数据与一个条目不同', fingerprintOf({}) !== fingerprintOf({ 1: { a: { p: 1 } } }))
}

console.log('\n' + '─'.repeat(52))
if (fail === 0) console.log(`通过 ${pass} / ${pass}　全部通过 ✓`)
else {
  console.log(`通过 ${pass} / ${pass + fail}　失败 ${fail}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
}
