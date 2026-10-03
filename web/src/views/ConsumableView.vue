<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed } from 'vue'
import type { GameData, Options } from '../types'
import type { PriceBook } from '../calc/price'

const props = defineProps<{ data: GameData; book: PriceBook; opts: Options }>()

/**
 * 消耗品（食物 / 药膏）。
 *
 * DVI 特有的一类利润来源：14 个物品带 heals 字段。
 * 治疗量与售价不成正比 —— 有的便宜但治得多，有的正好相反。
 * 玩家真正该看的是「单位治疗价值」：每点治疗能换到多少价值。
 */
const rows = computed(() =>
  props.data.items
    .filter(i => typeof i.heals === 'number' && i.heals > 0)
    .map(i => {
      const price = props.book.revenue(i.id, props.opts)
      const perHeal = price.value / i.heals!
      return {
        id: i.id,
        name: i.name,
        heals: i.heals!,
        baseValue: i.value,
        price: price.value,
        source: price.source,
        perHeal,
      }
    })
    .sort((a, b) => b.perHeal - a.perHeal),
)

/** 做这个要花多久（同名配方）；用于算每小时能产多少份 */
const recipeOf = computed(() => {
  const m = new Map<number, { ticks: number; name: string; skill: string }>()
  for (const a of props.data.actions) {
    if (!a.output) continue
    const cur = m.get(a.output.itemId)
    if (!cur) m.set(a.output.itemId, { ticks: a.baseTicks, name: a.name, skill: a.skill })
  }
  return m
})

const withRate = computed(() =>
  rows.value.map(r => {
    const rec = recipeOf.value.get(r.id)
    // 生产耗时 0 → 采集类，耗时不可控，不参与每小时产出的计算
    const perHour = rec && rec.ticks > 0 ? 3600 / (rec.ticks * 0.6) : null
    return { ...r, rec, perHour, perHourValue: perHour == null ? null : perHour * r.price }
  }),
)

const fmt = (n: number, d = 2) =>
  !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: d })
</script>

<template>
  <div class="view">
    <div class="vhead">
      <h2>消耗品</h2>
      <p>
        {{ rows.length }} 个带治疗效果的物品。关键不是绝对价值，
        而是 <b>单位治疗价值</b> —— 每点治疗能换到多少。治得多但便宜的才是好货。
      </p>
    </div>

    <div class="tw">
      <table>
        <thead>
          <tr>
            <th class="l">物品</th>
            <th>治疗量</th>
            <th>基础价值</th>
            <th>市场价</th>
            <th class="l">价来源</th>
            <th>单位治疗价值</th>
            <th class="l">配方</th>
            <th>产量/时</th>
            <th>价值/时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in withRate" :key="r.id">
            <td class="l">{{ t(r.name) }}</td>
            <td class="num">{{ r.heals }}</td>
            <td class="num">{{ r.baseValue }}</td>
            <td class="num">{{ fmt(r.price) }}</td>
            <td class="l">
              <span class="dot" :class="r.source"></span>{{ r.source === 'market' ? '市场' : r.source === 'manual' ? '手动' : '兜底' }}
            </td>
            <td class="num pos">{{ fmt(r.perHeal) }}</td>
            <td class="l muted">{{ r.rec ? `${r.rec.name}（${r.rec.skill}）` : '无直接配方' }}</td>
            <td class="num">{{ r.perHour == null ? '—' : fmt(r.perHour, 0) }}</td>
            <td class="num">{{ r.perHourValue == null ? '—' : fmt(r.perHourValue, 0) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card" style="margin-top:12px">
      <h3>怎么读这张表</h3>
      <p style="font-size:12.5px;color:var(--fg2);margin:0">
        <b>单位治疗价值</b> = 市场价 ÷ 治疗量 —— 这一列排序就是「谁更划算」。
        <b>产量/时</b> 只对有固定耗时的配方有效（采集类耗时不可控，显示为 —）。
        当前若没有市场价，全部用兜底价（基础价值），排序只反映游戏自身的定价逻辑；
        导入真实行情后这张表才真正有用。
      </p>
    </div>
  </div>
</template>
