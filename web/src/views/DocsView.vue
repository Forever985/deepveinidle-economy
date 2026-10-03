<script setup lang="ts">
import type { GameData } from '../types'
import { ASSUMPTIONS } from '../calc/enhance'
import { GATHER_SKILLS } from '../calc/player'

const props = defineProps<{ data: GameData }>()
const m = props.data.meta
</script>

<template>
  <div class="view">
    <div class="vhead">
      <h2>说明</h2>
      <p>这个工具怎么算的、哪些是确证的、哪些是猜的 —— 一次说清，免得你被我误导。</p>
    </div>

    <div class="card">
      <h3>数据来源</h3>
      <p>
        游戏数据 <b>{{ m.version }}</b>（commit <code>{{ m.commit }}</code>），
        于 {{ m.extractedAt }} 从<b>客户端 bundle</b> 提取。
        全程只读，<b>不调用任何服务端接口，不发送任何游戏指令</b>。
      </p>
      <p class="dim">
        物品 {{ data.items.length }} · 配方 {{ data.actions.length }} · 站点 {{ data.sites.length }} · 怪物 {{ data.monsters.length }}
      </p>
    </div>

    <div class="card">
      <h3>价格：三层来源，逐个标注</h3>
      <p>不纠结「按市场价还是按自产成本」——这两者常得出相反结论。所以三层并存，界面上用圆点标出来：</p>
      <ul>
        <li><span class="dot market"></span><b>市场价</b> —— 导入的价格快照</li>
        <li><span class="dot fallback"></span><b>兜底价</b> —— 物品基础价值（游戏里自带的兜底）</li>
        <li><span class="dot manual"></span><b>手动价</b> —— 你自己指定，优先级最高</li>
      </ul>
      <p><b>成本按 ask、收益按 bid</b>（挂出能拿到的价 / 直接卖给收购单的价）—— 保守口径，不虚高。</p>
    </div>

    <div class="card">
      <h3>中间品 0 价内部流转</h3>
      <p>
        整链核算时，上游产物与下游原料都按 0 价记账，于是只认两笔账：
        <b>买进来的第一批原料</b>、<b>最后卖出去的成品</b>。
      </p>
      <p class="dim">
        配方拓扑是<b>分叉</b>的（<code>Copper ─┐ / Tin ─┴→ Bronze bar</code>），
        必须扫全链判断哪些是中间品 —— 只看「紧邻的下一位」会漏判，
        导致中间品被卖一次又算一次成本，利润凭空蒸发。
      </p>
    </div>

    <div class="card">
      <h3>两种口径会显著改变排名</h3>
      <table class="mini">
        <tbody>
          <tr>
            <td><b>生长口径</b></td>
            <td>种地的 {{ GATHER_SKILLS.includes('farming') ? 'grow 800~9000 tick' : '等待时间' }} 往往才是时间瓶颈。
              <b>并行</b>=等待期去干别的（放置游戏常态，默认）；
              <b>单线程</b>=种下去就干等，全额计入。两者排名天差地别。</td>
          </tr>
          <tr>
            <td><b>收益口径</b></td>
            <td><b>保守</b>=按 bid（直接卖给收购单，默认）；<b>乐观</b>=按 ask（挂出去等成交）。</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card warncard">
      <h3>哪些是猜的（请重点核对）</h3>
      <p>下面这些<b>不是从游戏代码读出的精确实现</b>，而是从字段名与取值反推的合理形式：</p>
      <p><b>① 强化的成功率递推、碎片来源、失败是否损失材料</b></p>
      <ul>
        <li v-for="(a, i) in ASSUMPTIONS" :key="i">{{ a }}</li>
      </ul>
      <p><b>② 烧焦 / 被抓的失败率</b> —— 需求等级处为 <code>chanceAtReq</code>，随等级线性降到 <code>safeAtLevel</code> 的 0。</p>
      <p>
        改版或实测不符时，只改 <code>src/calc/enhance.ts</code> 与 <code>src/calc/expected.ts</code> 两个文件即可，其余不受影响。
      </p>
    </div>

    <div class="card">
      <h3>算不了的部分（诚实交代）</h3>
      <ul>
        <li><b>每小时打多少只怪</b> —— 取决于玩家自己的攻击力，静态页读不到存档。所以战斗页要你自己填击杀频率。</li>
        <li><b>强化材料从哪来</b> —— 数据里没写死哪个物品是哪个装备的碎片，强化页要你自己选。</li>
        <li><b>实时行情</b> —— 游戏的 WebSocket 只在游戏页面里，静态页拿不到。没有快照时全部用兜底价。</li>
        <li><b>赶路时间</b> —— 站点有坐标，理论上可算，但需要你的移动速度，暂未纳入。</li>
      </ul>
      <p class="dim">宁可让你填一个数，也不给一个看起来精确、实际是瞎编的公式。</p>
    </div>

    <div class="card">
      <h3>测试</h3>
      <p style="margin:0">
        计算层 <b>零依赖、128 项断言</b>，用 Node 原生类型剥离直接跑：
        <code>npm test</code>。逻辑与界面彻底分离，所以这些断言打的是真实计算结果。
      </p>
    </div>
  </div>
</template>

<style scoped>
code{font-family:var(--mono);background:#eceff3;padding:1px 4px;border-radius:3px}
ul{margin:6px 0;padding-left:20px;line-height:1.8}
.dim{color:var(--fg2);font-size:12.5px}
.warncard{border-left:3px solid var(--warn)}
table.mini{font-size:12.5px}
table.mini td{border:0;padding:5px 8px 5px 0;vertical-align:top;white-space:normal}
</style>
