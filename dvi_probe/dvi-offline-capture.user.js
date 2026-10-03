// ==UserScript==
// @name         DVI 离线收益报告抓取
// @namespace    dvi.tools
// @version      1.0.0
// @description  捕获 Deep Vein Idle 登录时的离线收益报告，一键复制/下载 JSON。只读，不发送任何游戏指令。
// @author       -
// @match        https://deepveinidle.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * 为什么不共享 cookie：这个脚本在你自己的浏览器里跑，报告由你导出后随意处置。
 * 另一个办法是直接连一次服务端（DVI 强制单会话，会把你踢下线），见 README。
 *
 * 注意：浏览器已经帮你处理了 WebSocket 分片，所以这里拿到的 data 总是完整消息，
 * 不需要做分片重组（那是裸 socket 实现才要操心的事）。
 */

(function () {
  'use strict';

  if (window.__dviOfflineCapture) return;
  window.__dviOfflineCapture = true;

  const captured = [];

  /* ---------- 劫持收包：不动游戏代码，也不替换 window.WebSocket ---------- */
  const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
  const origGet = desc.get;

  desc.get = function hookedGet() {
    const socket = this.currentTarget;
    if (!(socket instanceof WebSocket) || !socket.url) return origGet.call(this);
    if (!socket.url.includes('deepveinidle.com')) return origGet.call(this);

    const raw = origGet.call(this);
    // 同一条消息可能被多个 onmessage 监听器读取，用定值防止重复解析/重复派发
    try { Object.defineProperty(this, 'data', { value: raw, configurable: true }); } catch (e) {}

    try { inspect(raw); } catch (e) { console.warn('[DVI离线] 解析失败', e); }
    return raw;
  };
  Object.defineProperty(MessageEvent.prototype, 'data', desc);

  /* ---------- 从帧里找 welcome.offline ---------- */
  function inspect(raw) {
    if (typeof raw !== 'string' || raw.charCodeAt(0) !== 123 /* { */) return;
    let frame;
    try { frame = JSON.parse(raw); } catch (e) { return; }
    if (!frame || !Array.isArray(frame.m)) return;

    for (const msg of frame.m) {
      if (msg && msg.t === 'welcome' && msg.offline) {
        record(msg.offline, msg.you || {});
      }
    }
  }

  function record(offline, you) {
    captured.push({ at: new Date().toISOString(), character: you.name, id: you.id, offline });
    const meaningful = (offline.ticksElapsed || 0) > 30;
    console.log('[DVI离线] 捕获到报告', offline);
    panel(offline, you, meaningful);
  }

  /* ---------- 物品名翻译（懒加载本地游戏数据） ---------- */
  let NAMES = null;
  function names() { return NAMES; }

  /* ---------- 悬浮面板 ---------- */
  let box = null;

  function panel(offline, you, meaningful) {
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => panel(offline, you, meaningful)); return; }
    if (box) box.remove();

    const secs = offline.ticksElapsed || 0;
    const dur = secs < 90 ? secs + ' 秒'
              : secs < 5400 ? (secs / 60).toFixed(1) + ' 分钟'
              : (secs / 3600).toFixed(1) + ' 小时';

    box = document.createElement('div');
    box.setAttribute('data-dvi-offline-panel', '');
    box.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:320px', 'max-height:60vh', 'overflow:auto',
      'background:#fff', 'color:#1c1f23', 'border:1px solid #d8dce1',
      'border-radius:10px', 'box-shadow:0 6px 24px rgba(0,0,0,.16)',
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'padding:14px 16px'
    ].join(';');

    const sk = Object.entries(offline.skills || {})
      .map(([k, v]) => {
        const up = v.levelAfter !== v.levelBefore
          ? ` <b style="color:#1a9e6a">${v.levelBefore}→${v.levelAfter}</b>` : '';
        return `<div>${k} &nbsp;+${v.xp} xp${up}</div>`;
      }).join('') || '<div style="color:#8b96a3">无</div>';

    const ig = Object.entries(offline.itemsGained || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([id, q]) => `<div>物品 #${id} &nbsp;×${q}</div>`).join('')
      || '<div style="color:#8b96a3">无</div>';

    box.innerHTML = `
      <div style="font-weight:600;font-size:14px;margin-bottom:2px">离线收益报告</div>
      <div style="color:#5f6b76;font-size:12px;margin-bottom:10px">
        ${you.name || ''} · 离线 ${dur}
        ${offline.ticksSkipped ? `<br><span style="color:#c8791a">超出上限跳过 ${offline.ticksSkipped} tick</span>` : ''}
        ${offline.stoppedEarly ? `<br><span style="color:#c8791a">提前停止（背包满/无材料）</span>` : ''}
      </div>
      <div style="font-weight:600;margin-bottom:4px">技能</div>${sk}
      <div style="font-weight:600;margin:10px 0 4px">获得物品</div>${ig}
      <div style="color:#5f6b76;font-size:12px;margin-top:10px">
        击杀 ${offline.kills || 0} · 死亡 ${offline.deaths || 0} ·
        存入仓库 ${offline.deposits || 0} · 金币 ${offline.coins || 0}
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button data-copy style="flex:1;padding:6px 0;border:1px solid #2f6fed;background:#2f6fed;color:#fff;border-radius:6px;cursor:pointer;font-size:12.5px">复制 JSON</button>
        <button data-dl style="flex:1;padding:6px 0;border:1px solid #d8dce1;background:#fff;color:#1c1f23;border-radius:6px;cursor:pointer;font-size:12.5px">下载 JSON</button>
        <button data-x style="padding:6px 10px;border:1px solid #d8dce1;background:#fff;border-radius:6px;cursor:pointer;font-size:12.5px">×</button>
      </div>
      ${meaningful ? '' : '<div style="color:#8b96a3;font-size:11.5px;margin-top:8px">离线时间很短，报告内容有限</div>'}
    `;

    document.body.appendChild(box);

    const payload = () => JSON.stringify(
      captured.length === 1 ? captured[0] : captured, null, 1);

    box.querySelector('[data-copy]').onclick = () => {
      navigator.clipboard.writeText(payload())
        .then(() => flash(box, '已复制到剪贴板'))
        .catch(() => flash(box, '复制失败，请用「下载」'));
    };
    box.querySelector('[data-dl]').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload()], { type: 'application/json' }));
      a.download = 'dvi-offline-report.json';
      a.click();
      URL.revokeObjectURL(a.href);
    };
    box.querySelector('[data-x]').onclick = () => box.remove();

    // 报告就是要给人看的：立刻把 JSON 也打到控制台，方便直接复制
    console.log('[DVI离线] JSON ↓\n' + payload());
  }

  function flash(el, text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:absolute;left:16px;bottom:8px;color:#1a9e6a;font-size:12px';
    el.appendChild(t);
    setTimeout(() => t.remove(), 1600);
  }

  console.log('[DVI离线] 已就绪：下次登录 / 刷新页面时会自动捕获离线报告。');
})();
