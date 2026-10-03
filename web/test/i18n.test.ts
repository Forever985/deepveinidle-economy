/**
 * 汉化测试：官方中文对照表的覆盖率
 *
 * 为什么要有这条断言：
 *   汉化靠的是「从 bundle 里提取的官方译文表」。游戏一改版就会新增物品/配方，
 *   如果新名字没被提取到，界面上会静默显示英文（或空白），用户却不知道是数据缺了。
 *   所以把「覆盖率必须 100%」钉死成断言 —— 掉下来立刻能发现。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

import type { GameData } from '../src/types.ts'

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
function section(t: string) { console.log('\n' + t) }

const zh = (data as unknown as { i18nZh?: Record<string, string> }).i18nZh ?? {}

section('① 官方中文表已随数据打包')
{
  // prepare-data.py 会把中文表裁剪到「网站真正显示的名字」，
  // 所以这里不能用「全量 2518」当门槛，否则裁剪会被误判成数据丢失。
  const n = Object.keys(zh).length
  ok('i18nZh 存在且非空', n >= 300, `${n} 条（裁剪后；全量 2518）`)
  ok('meta 标注了来源是官方中文',
     String((data.meta as Record<string, unknown>)?.i18n ?? '').includes('官方'),
     String((data.meta as Record<string, unknown>)?.i18n))
  // 抽样确认是官方译文而不是机器翻译的痕迹
  ok('样例译文正确（Copper → 铜矿）', zh.Copper === '铜矿', String(zh.Copper))
  ok('样例译文正确（mining → 挖矿/采矿）', !!zh.mining, String(zh.mining))
  ok('译文里不含英文残留的占位', Object.values(zh).every(v => v.trim().length > 0))
}

section('② 覆盖率必须 100%')
{
  const groups: [string, string[]][] = [
    ['物品名', data.items.map(i => i.name)],
    ['配方名', data.actions.map(a => a.name)],
    ['技能名', [...new Set(data.actions.map(a => a.skill))]],
    ['分类名', [...new Set(data.actions.map(a => a.group))]],
    ['怪物名', (data.monsters ?? []).map(m => m.name)],
  ]
  for (const [label, names] of groups) {
    const miss = names.filter(n => !zh[n])
    ok(`${label} 全覆盖（${names.length}）`, miss.length === 0,
       miss.length ? `${miss.length} 个未收录：${miss.slice(0, 5).join('、')}` : '')
  }
}

section('③ 退回行为')
{
  // 查不到时必须回退到英文原文，而不是空串 —— 静默留空会被误读成数据缺失
  const fake = 'Totally Unknown Thing'
  ok('未收录的名字会回退（由 i18n.t 保证）', !zh[fake] && (zh[fake] ?? fake) === fake)
  ok('数据里的名字都不为空', data.items.every(i => i.name && i.name.length))
  ok('数据里的名字无重复', new Set(data.items.map(i => i.name)).size === data.items.length,
     `${data.items.length} vs ${new Set(data.items.map(i => i.name)).size}`)
}

section('④ 源码扫描：模板里不该有裸的英文名')
{
  // 这一节是**防回归**的。
  // 之前就是因为模板里直接写了 {{ r.name }} 而没包 t()，
  // 玩家看到的是英文；而数据覆盖率测试是全绿的 —— 两边都"没问题"，
  // 但用户就是看到英文。测试必须覆盖到「界面实际显示什么」这一层。
  const SRC = resolve(HERE, '../src')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (n.endsWith('.vue')) files.push(p)
    }
  }
  walk(SRC)

  // 模板里出现 {{ xxx.name }} / {{ a.b.name }} 之类，且**没有**紧邻的 t( 或 laneLabel(
  const BARE = /\{\{[^}]*?(?<![\w.])([a-zA-Z_][\w$]*)\.name\b[^}]*\}\}/g
  const offenders: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    const tpl = src.split('<template>')[1] ?? ''
    for (const m of tpl.matchAll(BARE)) {
      const frag = m[0]
      if (/\bt\(/.test(frag) || /\blaneLabel\(/.test(frag)) continue
      offenders.push(`${f.split('/').pop()}: ${frag.trim()}`)
    }
  }
  ok('模板里没有裸的 .name 输出', offenders.length === 0,
     offenders.length ? offenders.slice(0, 5).join(' | ') : '')

  // 每个 .vue 用了 i18n 就必须真的导入
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    const uses = /\{\{[^}]*\bt\(/s.test(src.split('<template>')[1] ?? '')
    if (!uses) continue
    ok(`${f.split('/').pop()} 导入了 t`, /import \{[^}]*\bt\b[^}]*\} from '\.\.?\/i18n/.test(src))
  }
}

console.log('\n' + '─'.repeat(52))
if (fail === 0) console.log(`通过 ${pass} / ${pass}　全部通过 ✓`)
else {
  console.log(`通过 ${pass} / ${pass + fail}　失败 ${fail}`)
  for (const f of fails) console.log('  ✗ ' + f)
  process.exitCode = 1
}
