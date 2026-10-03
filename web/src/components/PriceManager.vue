<script setup lang="ts">
import { ref } from 'vue'
import type { PriceBook } from '../calc/price'
import {
  priceState, applyManualText, clearManual, exportJson, importJson,
} from '../stores/prices'

defineProps<{ book: PriceBook }>()
const emit = defineEmits<{ close: [] }>()

const tab = ref<'manual' | 'io'>('manual')
const text = ref('')
const msg = ref('')

function saveManual() {
  const r = applyManualText(text.value)
  msg.value = r.bad.length
    ? `已写入 ${r.ok} 条，${r.bad.length} 条无法识别：${r.bad.slice(0, 3).join('、')}`
    : `已写入 ${r.ok} 条`
  if (!r.bad.length) text.value = ''
}

function doExport() {
  const blob = new Blob([exportJson()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `dvi-prices-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  msg.value = '已导出'
}

function doImport(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  const rd = new FileReader()
  rd.onload = () => {
    const r = importJson(String(rd.result))
    msg.value = `导入完成：手动价 ${r.manual} 条、市场快照 ${r.market} 个`
  }
  rd.readAsText(f)
}

function doClear() {
  clearManual()
  text.value = ''
  msg.value = '已清空手动价'
}
</script>

<template>
  <div class="card" style="margin-top:12px">
    <h3 style="margin:0 0 6px;font-size:15px">价格管理</h3>

    <div class="bar" style="margin:0 0 8px">
      <div class="grp">
        <button :class="{on: tab==='manual'}" @click="tab='manual'">手动填价</button>
        <button :class="{on: tab==='io'}" @click="tab='io'">导入 / 导出</button>
      </div>
      <span class="spacer"></span>
      <span style="font-size:12px;color:var(--fg2)">
        当前：{{ Object.keys(priceState.manual).length }} 条手动价 ·
        {{ Object.keys(priceState.market).length }} 个市场快照
      </span>
    </div>

    <template v-if="tab === 'manual'">
      <div style="font-size:12px;color:var(--fg2);margin-bottom:6px">
        格式 <code>物品ID=价格</code>，逗号或换行分隔 —— 例如
        <code>170=45, 171=120</code>。物品 ID 可在排行表里点开链路后看到。
        手动价优先级最高，会覆盖市场价与兜底价。
      </div>
      <textarea v-model="text" rows="4" placeholder="170=45&#10;171=120"
        style="width:100%;font-family:var(--mono);font-size:12.5px;
               border:1px solid var(--line);border-radius:6px;padding:8px;resize:vertical"></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="primary" @click="saveManual">保存</button>
        <button @click="doClear">清空手动价</button>
        <button @click="emit('close')">关闭</button>
        <span style="font-size:12px;color:var(--fg2)">{{ msg }}</span>
      </div>
    </template>

    <template v-else>
      <div style="font-size:12px;color:var(--fg2);margin-bottom:6px">
        静态页面拿不到游戏内实时行情。可以从 dvi-tools 导出价格快照后导入，
        利润就会接近真实。没有快照时全部使用兜底价（物品基础价值）。
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="primary" @click="doExport">导出价格 JSON</button>
        <label style="cursor:pointer">
          <input type="file" accept="application/json,.json" style="display:none" @change="doImport">
          <span class="btnlike">导入 JSON</span>
        </label>
        <button @click="emit('close')">关闭</button>
        <span style="font-size:12px;color:var(--fg2)">{{ msg }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.btnlike{
  display:inline-block;font-size:13px;padding:4px 11px;border:1px solid var(--line);
  border-radius:6px;background:#fff;cursor:pointer;
}
.btnlike:hover{border-color:var(--accent);color:var(--accent)}
code{font-family:var(--mono);background:#eceff3;padding:1px 4px;border-radius:3px}
</style>
