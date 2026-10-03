<script setup lang="ts">
import { t } from '../i18n'
import { computed, ref } from 'vue'
import type { GameData, Options } from '../types'
import type { PriceBook } from '../calc/price'
import { enhanceBalance, analyseEnhance, enhanceAll, ASSUMPTIONS } from '../calc/enhance'

const props = defineProps<{ data: GameData; book: PriceBook; opts: Options }>()

const bal = computed(() => enhanceBalance(props.data))

/** 碎片物品：数据里没写死哪个物品对应碎片，让玩家自己选 */
const shardId = ref<number>(0)
const shardCandidates = computed(() =>
  props.data.items
    .filter(i => /shard|fragment|piece/i.test(i.name) || i.stackable)
    .slice(0, 200),
)
const shardName = computed(() => (shardId.value ? props.book.itemName(shardId.value) : '未选择'))

const targetTier = ref(5)
const itemId = ref<number>(0)

/** 可强化的候选：非堆叠的成品（排除明显是原料的） */
const candidates = computed(() => {
  const rawIds = new Set<number>()
  for (const a of props.data.actions) {
    if (!a.inputs?.length && a.output) rawIds.add(a.output.itemId)   // 纯采集产出 = 原料
  }
  return props.data.items
    .filter(i => i.value > 0 && !rawIds.has(i.id))
    .sort((a, b) => b.value - a.value)
    .slice(0, 300)
})

const detail = computed(() => {
  if (!itemId.value) return null
  return analyseEnhance(props.data, props.book,
    { itemId: itemId.value, targetTier: targetTier.value, shardItemId: shardId.value }, props.opts)
})

/** 批量排行：强化到满阶谁最赚 */
const ranking = computed(() => {
  const rows = enhanceAll(props.data, props.book, shardId.value, props.opts)
  return rows
    .filter(r => r.net > 0)
    .sort((a, b) => b.net - a.net)
    .slice(0, 60)
})

const fmt = (n: number, d = 0) =>
  !Number.isFinite(n) ? '—'
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n.toLocaleString('zh-CN', { maximumFractionDigits: d })
</script>

<template>
  <div class="view">
    <div class="vhead">
      <h2>强化</h2>
      <p>
        最高 {{ bal.maxTier }} 阶 · 每阶 {{ bal.shardsPerTier }} 碎片 · 品质倍率
        <b>{{ bal.qualityMult.join(' → ') }}</b> —— <b>+{{ bal.maxTier }} 的价值是 +0 的 {{ bal.qualityMult[bal.maxTier - 1] }} 倍</b>。
        这大概是 DVI 里最赚钱的玩法之一。
      </p>
    </div>

    <div class="note warn">
      <b>公式待实测校验。</b>成功率递推、碎片来源、失败是否损失材料都是
      <b>从字段名与取值反推</b>的合理形式，不是从游戏代码读出的精确实现：
      <ul>
        <li v-for="(a, i) in ASSUMPTIONS" :key="i">{{ a }}</li>
      </ul>
      实测不符时只改 <code>src/calc/enhance.ts</code> 一个文件。
    </div>

    <div class="cols">
      <!-- 单件详算 -->
      <div class="card">
        <h3>单件强化学算</h3>
        <div class="row">
          <label>装备</label>
          <select v-model.number="itemId">
            <option :value="0">请选择</option>
            <option v-for="i in candidates" :key="i.id" :value="i.id">
              {{ t(i.name) }}（基础 {{ i.value }}）
            </option>
          </select>
        </div>
        <div class="row">
          <label>目标阶数</label>
          <select v-model.number="targetTier">
            <option v-for="n in bal.maxTier + 1" :key="n - 1" :value="n - 1">
              {{ n - 1 === 0 ? '不强化' : `+${n - 1}` }}
            </option>
          </select>
        </div>
        <div class="row">
          <label>碎片物品</label>
          <select v-model.number="shardId">
            <option :value="0">未选择（成本只算金币）</option>
            <option v-for="i in shardCandidates" :key="i.id" :value="i.id">
              {{ t(i.name) }}（{{ i.value }}）
            </option>
          </select>
        </div>

        <template v-if="detail">
          <div class="kv"><span>装备</span><span>{{ t(detail.itemName) }}</span></div>
          <div class="kv"><span>强化前价值</span><span>{{ fmt(detail.baseValue) }}</span></div>
          <div class="kv"><span>强化后价值（+{{ detail.to }}）</span><span>{{ fmt(detail.finalValue) }}</span></div>
          <div class="kv"><span>价值增量</span><span>{{ fmt(detail.valueGain) }}</span></div>
          <div class="kv"><span>总期望成本</span><span>{{ fmt(detail.totalExpectedCost) }}</span></div>
          <div class="kv sum">
            <span>净收益</span>
            <span :style="{ color: detail.net > 0 ? 'var(--up)' : 'var(--down)' }">
              {{ fmt(detail.net) }}
            </span>
          </div>
          <div class="kv"><span>回本倍数（增量/成本）</span><span>{{ detail.roi.toFixed(2) }}×</span></div>
          <div class="kv"><span>全程一次成功</span><span>{{ (detail.allOrNothing * 100).toFixed(1) }}%</span></div>
          <div class="kv"><span>每阶平均期望成本</span><span>{{ fmt(detail.costPerTier) }}</span></div>

          <h4 style="margin:12px 0 4px;font-size:13px">逐阶明细</h4>
          <table class="mini">
            <thead><tr><th>阶</th><th>成功率</th><th>金币</th><th>碎片</th><th>期望成本</th><th>价值</th></tr></thead>
            <tbody>
              <tr v-for="s in detail.steps" :key="s.tier">
                <td>+{{ s.tier }}</td>
                <td>{{ (s.chance * 100).toFixed(0) }}%</td>
                <td>{{ fmt(s.gold) }}</td>
                <td>{{ s.shards }}</td>
                <td>{{ fmt(s.expectedCost) }}</td>
                <td>{{ fmt(s.valueAfter) }}</td>
              </tr>
            </tbody>
          </table>

          <div v-for="(w, i) in detail.warnings" :key="i" class="warn-line">⚠ {{ w }}</div>
        </template>
        <p v-else class="hint">选一件装备开始。</p>
      </div>

      <!-- 批量排行 -->
      <div class="card">
        <h3>强化到 +{{ bal.maxTier }} 谁最赚</h3>
        <p class="hint">
          碎片按「{{ shardName }}」的市场价计算。换个碎片物品，上面的排行立刻重算。
        </p>
        <div class="tw">
          <table>
            <thead>
              <tr><th class="l">装备</th><th>基础价值</th><th>+{{ bal.maxTier }} 价值</th><th>期望成本</th><th>净收益</th><th>回本</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in ranking" :key="r.itemId">
                <td class="l">{{ t(r.name) }}</td>
                <td class="num">{{ fmt(r.baseValue) }}</td>
                <td class="num">{{ fmt(r.valueAtMax) }}</td>
                <td class="num">{{ fmt(r.totalCost) }}</td>
                <td class="num" :class="r.net > 0 ? 'pos' : 'neg'">{{ fmt(r.net) }}</td>
                <td class="num">{{ r.roi.toFixed(2) }}×</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!ranking.length" class="empty">
            没有正收益的装备 —— 换个碎片物品，或导入真实市场价后再看
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint{font-size:12px;color:var(--fg2);margin:2px 0 10px}
code{font-family:var(--mono);background:#eceff3;padding:1px 4px;border-radius:3px}
.cols{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:12px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.row{display:flex;align-items:center;gap:8px;padding:4px 0}
.row label{flex:0 0 78px;font-size:13px}
.row select{flex:1;min-width:0}
.kv{display:flex;justify-content:space-between;font-size:12.5px;padding:2px 0}
.kv span:last-child{font-family:var(--mono)}
.kv.sum{border-top:1px solid var(--line);margin-top:4px;padding-top:5px;font-weight:600}
.warn-line{font-size:12px;color:var(--warn);margin-top:4px}
.tw{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:7px}
table.mini{font-size:12px;margin-top:4px}
table.mini th,table.mini td{padding:3px 6px}
ul{margin:6px 0 0;padding-left:18px}
</style>
