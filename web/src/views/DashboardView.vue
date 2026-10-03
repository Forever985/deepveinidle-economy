<script setup lang="ts">
import { t, laneLabel } from '../i18n'
import { computed } from 'vue'
import { player, resetPlayer } from '../stores/player'
import { PriceBook } from '../calc/price'
import type { GameData } from '../types'
import {
  perksOf, buffTierMults, blessingMults, toolSlots, toolsForSlot,
  skillMult, combatMult, isPristine, GATHER_SKILLS,
} from '../calc/player'

const props = defineProps<{ data: GameData; book: PriceBook }>()

const skills = computed(() => {
  const s = new Set<string>()
  for (const a of props.data.actions) s.add(a.skill)
  return [...s]
})

const perks = computed(() => perksOf(props.data))
const buffs = computed(() => buffTierMults(props.data))
const blessing = computed(() => blessingMults(props.data))
const slots = computed(() => toolSlots(props.data))

const itemName = (id: number) => props.book.itemName(id)

/** 每个技能在当前配置下的倍率 —— 让玩家看到自己的配置到底带来了多少 */
const skillMults = computed(() =>
  skills.value.map(s => ({ skill: s, mult: skillMult(props.data, player, s) }))
    .sort((a, b) => b.mult - a.mult),
)

const isGather = (s: string) => GATHER_SKILLS.includes(s)
</script>

<template>
  <div class="view">
    <div class="vhead">
      <h2>玩家配置</h2>
      <p>这里的每一项都会改变<b>全部</b>利润结果。默认是「什么都没配」，所以算出来的是裸数值。</p>
    </div>

    <div v-if="isPristine(player)" class="note warn">
      还没配置任何玩家数据 —— 当前显示的是<b>不含增益、不含工具、不含特权</b>的裸利润。
      填完之后数字会明显变化。
    </div>

    <div class="grid2">
      <!-- 技能等级 -->
      <div class="card">
        <h3>技能等级</h3>
        <p class="hint">决定「你能做哪些配方」，也决定失败的期望次数。</p>
        <div v-for="s in skills" :key="s" class="row">
          <label>{{ s }}<span v-if="isGather(s)" class="tag">采集</span></label>
          <input type="number" v-model.number="player.levels[s]" min="0" max="99" step="1">
          <span class="mult">×{{ skillMult(props.data, player, s).toFixed(2) }}</span>
        </div>
      </div>

      <!-- 增益与祝福 -->
      <div class="card">
        <h3>增益与活动</h3>
        <div class="row">
          <label>采集增益层数</label>
          <select v-model.number="player.buffTier">
            <option v-for="(m, i) in buffs" :key="i" :value="i">
              {{ i === 0 ? '无' : `${i} 层（×${m}）` }}
            </option>
          </select>
        </div>
        <div class="row">
          <label>战斗增益层数</label>
          <select v-model.number="player.combatBuffTier">
            <option v-for="(m, i) in buffs" :key="i" :value="i">
              {{ i === 0 ? '无' : `${i} 层（×${m}）` }}
            </option>
          </select>
        </div>
        <div class="row">
          <label>祝福</label>
          <label class="chk">
            <input type="checkbox" v-model="player.blessing">
            生效中（采集 ×{{ blessing.gather }} / 战斗 ×{{ blessing.combat }}）
          </label>
        </div>
        <div class="row">
          <label>社区活动倍率</label>
          <input type="number" v-model.number="player.communityMult" min="0" step="0.1">
        </div>
        <div class="row">
          <label>精通等级</label>
          <input type="number" v-model.number="player.mastery" min="0" max="99">
        </div>
      </div>

      <!-- 特权 -->
      <div class="card">
        <h3>特权</h3>
        <p class="hint">每级 <code>perRank</code> 加成，累乘。</p>
        <div v-for="p in perks" :key="p.id" class="row">
          <label>{{ t(p.name) }}<span class="tag">{{ laneLabel(p.lane) }}</span></label>
          <input type="number" v-model.number="player.perkRanks[p.id]" min="0" max="999" step="1">
          <span class="mult">×{{ (1 + p.perRank * (player.perkRanks[p.id] ?? 0)).toFixed(3) }}</span>
        </div>
      </div>

      <!-- 工具 -->
      <div class="card">
        <h3>工具</h3>
        <p class="hint">每个槽位对应一个技能，只影响那个技能。</p>
        <div v-for="(skill, slot) in slots" :key="slot" class="row">
          <label>{{ slot }}<span class="tag">{{ skill }}</span></label>
          <select v-model.number="player.tools[slot]">
            <option :value="0">未装备</option>
            <option v-for="t in toolsForSlot(props.data, slot)" :key="t.itemId" :value="t.itemId">
              {{ itemName(t.itemId) }} （+{{ (t.bonus * 100).toFixed(0) }}%）
            </option>
          </select>
        </div>
      </div>
    </div>

    <!-- 当前配置汇总 -->
    <div class="card">
      <h3>当前配置汇总</h3>
      <p class="hint">这是你的配置在各个技能上的实际倍率 —— 排行页的数字已经按它算过了。</p>
      <div class="mults">
        <span v-for="s in skillMults" :key="s.skill" class="chip">
          {{ s.skill }} <b>×{{ s.mult.toFixed(2) }}</b>
        </span>
        <span class="chip">战斗 <b>×{{ combatMult(props.data, player).toFixed(2) }}</b></span>
      </div>
      <div style="margin-top:10px">
        <button @click="resetPlayer">清空配置</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hint{font-size:12px;color:var(--fg2);margin:2px 0 10px}
code{font-family:var(--mono);background:#eceff3;padding:1px 4px;border-radius:3px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px;margin-bottom:12px}
.row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--line2)}
.row:last-child{border-bottom:0}
.row label{flex:1;font-size:13px;display:flex;align-items:center;gap:6px}
.row input[type=number]{width:76px}
.row select{flex:1;min-width:0}
.row .chk{flex:1;font-size:12px;color:var(--fg2);display:flex;align-items:center;gap:5px}
.mult{font:12px var(--mono);color:var(--fg2);min-width:52px;text-align:right}
.tag{font-size:10px;background:#eef1f5;color:var(--fg3);padding:1px 5px;border-radius:3px}
.mults{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;background:#eef1f5;border-radius:5px;padding:3px 8px;font-family:var(--mono)}
</style>
