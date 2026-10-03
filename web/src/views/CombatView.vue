<script setup lang="ts">
import { t } from '../i18n'
import { computed, ref } from 'vue'
import type { GameData, Options } from '../types'
import type { PriceBook } from '../calc/price'
import { analyseCombat, combatAll } from '../calc/combat'
import { player } from '../stores/player'
import { combatMult } from '../calc/player'

const props = defineProps<{ data: GameData; book: PriceBook; opts: Options }>()

/**
 * 击杀频率只能由玩家填 —— 算「每小时打多少只」需要玩家自己的攻击力，
 * 静态页拿不到存档。与其编一个公式给个看似精确的假数，不如让用户直接填。
 */
const mode = ref<'rate' | 'time'>('rate')
const killsPerHour = ref(300)
const secondsPerKill = ref(12)
const extraDrop = ref(0)
const maxLevel = ref(0)
const sortKey = ref<'total' | 'xp' | 'gold'>('total')

const freq = computed(() => (mode.value === 'rate'
  ? { killsPerHour: Math.max(0, killsPerHour.value) }
  : { secondsPerKill: Math.max(0.1, secondsPerKill.value) }))

const rows = computed(() => {
  let list = combatAll(props.data, props.book, props.opts, freq.value, player)
  if (maxLevel.value > 0) list = list.filter(r => r.level <= maxLevel.value)
  const k = sortKey.value
  return [...list].sort((a, b) =>
    k === 'xp' ? b.xpPerHour - a.xpPerHour
    : k === 'gold' ? b.goldPerHour - a.goldPerHour
    : b.totalPerHour - a.totalPerHour)
})

const selected = ref<number>(0)
const detail = computed(() => (selected.value
  ? analyseCombat(props.data, props.book,
      { monsterId: selected.value, ...freq.value, extraDropChance: extraDrop.value },
      props.opts, player)
  : null))

const fmt = (n: number, d = 0) =>
  !Number.isFinite(n) ? '—'
  : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n.toLocaleString('zh-CN', { maximumFractionDigits: d })
</script>

<template>
  <div class="view">
    <div class="vhead">
      <h2>战斗收益</h2>
      <p>20 个怪物的掉落、金币与经验。这些掉落物往往本身就是别处配方的原料 —— 打怪是整条产业链的<b>上游</b>。</p>
    </div>

    <div class="note">
      <b>击杀频率由你填。</b>「每小时打多少只」取决于你自己的攻击力，
      静态页读不到存档。与其编一个公式给个看起来精确的假数，不如让你直接填。
    </div>

    <div class="card">
      <div class="ctrl">
        <div class="row">
          <label>频率口径</label>
          <select v-model="mode">
            <option value="rate">每小时击杀数</option>
            <option value="time">每只耗时（秒）</option>
          </select>
          <input v-if="mode === 'rate'" type="number" v-model.number="killsPerHour" min="0" step="10">
          <input v-else type="number" v-model.number="secondsPerKill" min="0.1" step="0.5">
          <span class="hint">→ {{ mode === 'rate' ? killsPerHour : (3600 / Math.max(0.1, secondsPerKill)).toFixed(0) }} 只/时</span>
        </div>
        <div class="row">
          <label>额外掉落加成</label>
          <input type="number" v-model.number="extraDrop" min="0" max="1" step="0.001">
          <span class="hint">装备/特权带来的，叠加在怪物自带概率上</span>
        </div>
        <div class="row">
          <label>最高等级</label>
          <input type="number" v-model.number="maxLevel" min="0" max="99" step="5">
          <span class="hint">0 = 不限</span>
        </div>
        <div class="row">
          <label>排序</label>
          <select v-model="sortKey">
            <option value="total">合计收益</option>
            <option value="xp">经验</option>
            <option value="gold">金币</option>
          </select>
          <span class="hint">战斗倍率 ×{{ combatMult(props.data, player).toFixed(2) }}（在「玩家配置」里改）</span>
        </div>
      </div>
    </div>

    <div class="cols">
      <div class="card">
        <h3>怪物收益排行</h3>
        <div class="tw">
          <table>
            <thead>
              <tr><th class="l">怪物</th><th>等级</th><th>金币/时</th><th>掉落/时</th><th>经验/时</th><th>合计/时</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.monster.id"
                  :class="{ sel: selected === r.monster.id }" @click="selected = r.monster.id">
                <td class="l">{{ t(r.name) }}</td>
                <td class="num">{{ r.level }}</td>
                <td class="num">{{ fmt(r.goldPerHour) }}</td>
                <td class="num">{{ fmt(r.dropPerHour) }}</td>
                <td class="num">{{ fmt(r.xpPerHour) }}</td>
                <td class="num pos">{{ fmt(r.totalPerHour) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h3>明细</h3>
        <template v-if="detail">
          <div class="kv"><span>怪物</span><span>{{ t(detail.name) }}（Lv{{ detail.level }}）</span></div>
          <div class="kv"><span>击杀频率</span><span>{{ detail.killsPerHour.toFixed(0) }} 只/时</span></div>
          <div class="kv sum"><span>合计收益 / 小时</span>
            <span style="color:var(--up)">{{ fmt(detail.totalPerHour) }}</span></div>
          <h4>掉落</h4>
          <div class="kv"><span>固定掉落</span>
            <span>{{ book.itemName(detail.monster.drop) }} × {{ detail.dropPerKill.toFixed(4) }}</span></div>
          <div class="kv"><span>每只数量</span><span>{{ detail.dropPerKill.toFixed(4) }}</span></div>
          <div class="kv"><span>掉落价值 / 小时</span><span>{{ fmt(detail.dropValuePerHour) }}</span></div>
          <h4>金币与经验</h4>
          <div class="kv"><span>金币 / 只</span><span>{{ detail.goldPerKill.toFixed(1) }}</span></div>
          <div class="kv"><span>金币 / 小时</span><span>{{ fmt(detail.goldPerHour) }}</span></div>
          <div class="kv"><span>经验 / 只</span><span>{{ detail.xpPerKill.toFixed(1) }}</span></div>
          <div class="kv"><span>经验 / 小时</span><span>{{ fmt(detail.xpPerHour) }}</span></div>
          <div class="kv"><span>战斗倍率</span><span>×{{ detail.mult.toFixed(2) }}</span></div>
          <div class="kv"><span>风险</span><span class="muted">{{ detail.riskNote }}</span></div>
          <div v-for="(w, i) in detail.warnings" :key="i" class="warn-line">⚠ {{ w }}</div>
        </template>
        <p v-else class="hint">点左边任意一行看明细。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint{font-size:12px;color:var(--fg2)}
.cols{display:grid;grid-template-columns:1fr minmax(300px,400px);gap:12px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.ctrl{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:4px 18px}
.row{display:flex;align-items:center;gap:8px;padding:3px 0}
.row label{flex:0 0 90px;font-size:13px}
.row select,.row input{flex:1;min-width:0}
.tw{max-height:560px;overflow:auto;border:1px solid var(--line);border-radius:7px}
.kv{display:flex;justify-content:space-between;font-size:12.5px;padding:2px 0;gap:12px}
.kv span:last-child{font-family:var(--mono);text-align:right}
.kv.sum{border-top:1px solid var(--line);margin-top:4px;padding-top:5px;font-weight:600}
.kv .muted{font-family:inherit;color:var(--fg3);font-size:12px}
h4{margin:12px 0 4px;font-size:12px;color:var(--fg2)}
.warn-line{font-size:12px;color:var(--warn);margin-top:4px}
</style>
