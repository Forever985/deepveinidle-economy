// ==UserScript==
// @name         DVI Tools · 示例插件
// @namespace    dvi.tools.examples
// @version      1.0.0
// @description  演示如何给 DVI Tools 主干挂一个功能插件。需要先安装 dvi-tools.user.js。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 这是一个最小可用插件，演示主干契约的全部要点：
 *   声明式设置 / 事件订阅 / 计算引擎调用 / 面板渲染 / 启停钩子
 *
 * 它做的事：在主干面板里显示「当前作业的每小时收益」。
 * 只读——不发送任何游戏指令。
 */

(function () {
  'use strict';

  const DVI = window.DVI;
  if (!DVI) {
    console.warn('[示例插件] 未找到 DVI Tools 主干，请先安装 dvi-tools.user.js');
    return;
  }

  DVI.plugin.register({
    id: 'example-networth-hourly',
    name: '当前作业收益',
    nameEn: 'Hourly job yield',
    description: '在主干面板里显示当前作业的每小时净收益与经验',
    api: 1,
    defaultEnabled: true,

    settings: [
      { key: 'tax', label: '市场税率 (%)', type: 'number', default: 2, min: 0, max: 100 },
      { key: 'includeCost', label: '扣除材料成本', type: 'bool', default: true },
    ],

    /* ── 注册时调用一次：适合挂事件监听 ── */
    setup(ctx) {
      this.box = null;

      // 切角色 / 换任务 / 有产出的时机会刷新
      ctx.bus.on(ctx.EVT.SNAPSHOT, () => this.render(ctx));
      ctx.bus.on(ctx.EVT.WORK, () => this.render(ctx));
      ctx.bus.on(ctx.EVT.BATCH, () => this.tick(ctx));

      // 插件自己的设置变了也要重算
      ctx.core.settings.onChange((key) => {
        if (key.startsWith(ctx.id + '.')) this.render(ctx);
      });

      ctx.log('已就绪');
    },

    enable(ctx) {
      this.render(ctx);
    },

    disable(ctx) {
      if (this.box) { this.box.textContent = ''; }
      ctx.ui.toast('已停用：当前作业收益');
    },

    /* 简单节流：产出事件很密集，不需要每次都重算 */
    tick(ctx) {
      const now = Date.now();
      if (now - (this.last || 0) < 1500) return;
      this.last = now;
      this.render(ctx);
    },

    render(ctx) {
      ctx.core.ui.ready(() => {
        const box = ctx.ui.panel('当前作业收益');
        this.box = box;

        const me = ctx.state.me;
        const job = ctx.state.job;
        if (!me || !job || !job.jobId) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, '未在作业中'));
          return;
        }

        const action = ctx.core.data.ACTION.get(job.jobId);
        if (!action) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, `未知配方 #${job.jobId}`));
          return;
        }

        const cx = ctx.core.calc;
        const level = cx.levelForXp(me.skills?.[action.skill] || 0);

        const res = cx.analyse(action, {
          level,
          quickPerk: me.perks?.quick || 0,
          priceOf: ctx.priceOf,
          taxBp: ctx.settings.get('tax') * 100,
        });
        if (!res) {
          box.appendChild(ctx.ui.el('div', { class: 'dvi-row' }, '无法计算'));
          return;
        }

        const net = ctx.settings.get('includeCost')
          ? res.netPerHour
          : res.grossPerHour * (1 - ctx.settings.get('tax') / 100);

        const row = (label, value) => {
          const r = ctx.ui.el('div', { class: 'dvi-row' });
          r.appendChild(ctx.ui.el('label', {}, label));
          r.appendChild(ctx.ui.el('span', {}, value));
          return r;
        };

        box.appendChild(row('配方', `${action.name}（${action.skill}）`));
        box.appendChild(row('等级', `${level} / 需求 ${action.levelReq}`));
        box.appendChild(row('单次耗时', `${res.ticks.toFixed(2)} 秒`));
        box.appendChild(row('产出', `${res.unitsPerHour.toFixed(0)} / 小时`));
        box.appendChild(row('净收益', `${Math.round(net).toLocaleString()} 金 / 小时`));
        box.appendChild(row('经验', `${Math.round(res.xpPerHour).toLocaleString()} / 小时`));
        box.appendChild(row('单价', `${ctx.priceOf(action.output.itemId).toLocaleString()} 金`));

        const prog = cx.levelProgress(me.skills?.[action.skill] || 0);
        box.appendChild(row('升级进度', `${(prog * 100).toFixed(1)}%`));

        const note = ctx.ui.el('div', { class: 'dvi-note' },
          '价格取自当前行情缓存，无行情时回退到物品基础价值。');
        box.appendChild(note);
      });
    },
  });
})();
