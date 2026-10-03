<script setup lang="ts">
import { t } from '../i18n'
import { computed } from 'vue'
import type { StepCalc } from '../calc/steps'
import type { ChainCalc } from '../calc/chain'
import type { Options } from '../types'

const props = defineProps<{
  ctx: { chain: ChainCalc; step: StepCalc; id: number }
  opts: Options
}>()
const emit = defineEmits<{ close: [] }>()

const result = computed(() => props.ctx.chain.runAuto(props.ctx.id, props.opts))

function name(id: number): string {
  // 名称走官方译文；查不到时回退英文原文，不显示空白
  return t(props.ctx.step.action(id)?.name || `#${id}`)
}
function fmt(n: number, d = 0): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + 'k'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: d })
}
function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  if (sec < 60) return sec.toFixed(1) + ' 秒'
  if (sec < 3600) return (sec / 60).toFixed(1) + ' 分'
  return (sec / 3600).toFixed(1) + ' 小时'
}
</script>

<template>
  <div v-if="result" class="chain">
    <h3>{{ t(result.steps[result.steps.length - 1]?.action.name) }} · 完整产业链</h3>
    <div class="meta">
      {{ result.steps.length }} 步 · 瓶颈在第 {{ (result.bottleneck ?? 0) + 1 }} 步 ·
      整链耗时 {{ dur(result.steps.reduce((s, r) => s + r.seconds, 0)) }}
    </div>

    <div v-if="result.warnings.length" class="note warn" style="margin:0 0 10px">
      <div v-for="(w, i) in result.warnings" :key="i">{{ w }}</div>
    </div>

    <div v-for="(s, i) in result.steps" :key="i" class="lvl">
      <div class="hd">
        第 {{ i + 1 }} 步 · {{ s.action.skill }} · 需 Lv{{ s.action.levelReq }}
        <span v-if="result.bottleneck === i" style="color:var(--warn)">（瓶颈）</span>
      </div>
      <div class="node" :class="{ sum: i === result.steps.length - 1 }">
        <div class="t">{{ t(s.action.name) }}</div>
        <div class="d">
          产出 {{ s.expectedOut }} 个
          <template v-if="s.action.inputs.length">
            · 原料 {{ s.action.inputs.map(x => name(x.itemId) + '×' + x.qty).join('、') }}
          </template>
          <template v-else> · 无原料（采集）</template>
          · 耗时 {{ dur(s.seconds) }}
        </div>
        <div v-for="(f, k) in s.factors" :key="k" class="d" style="color:var(--fg3)">
          ↳ {{ f.label }}：{{ f.detail }}
        </div>
      </div>
    </div>

    <div class="node sum" style="margin-top:10px">
      <div class="kv"><span>整链成本（买进来的第一批原料）</span><span>{{ fmt(result.cost) }}</span></div>
      <div class="kv"><span>整链收入（最后卖出去的成品）</span><span>{{ fmt(result.income) }}</span></div>
      <div class="kv">
        <span><b>整链净利 / 小时</b></span>
        <span :style="{ color: result.net > 0 ? 'var(--up)' : 'var(--down)', fontWeight: 700 }">
          {{ fmt(result.netPerHour) }}
        </span>
      </div>
    </div>

    <div style="margin-top:8px;font-size:12px;color:var(--fg3)">
      中间品按 0 价内部流转：既不计收入也不计成本，所以不会重复计价。
      <button style="margin-left:8px" @click="emit('close')">关闭</button>
    </div>
  </div>
</template>
