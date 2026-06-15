'use strict';

function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString('ja-JP') : '-'; }
function fmtJPY(n) {
  if (typeof n !== 'number') return '-';
  if (n >= 1000000) return '¥' + (n / 1000000).toFixed(1) + 'M';
  if (n >= 10000)   return '¥' + Math.round(n / 1000) + 'K';
  return '¥' + n.toLocaleString('ja-JP');
}
function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/item_manager.html') });
  window.close();
}
function openSettings() {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/settings.html') });
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  const d = await storageGet([
    'lensQsmApiKey', 'lensQsmUserId',
    'lensAnalyticsSnapshots', 'lensAnalyticsProductCache', 'lensAnalyticsOrderCache'
  ]);

  const hasKey = !!(d.lensQsmApiKey && d.lensQsmUserId);
  document.getElementById('statsGrid').style.display = hasKey ? 'grid' : 'none';
  document.getElementById('actionArea').style.display = hasKey ? 'flex' : 'none';
  document.getElementById('noKeyArea').style.display  = hasKey ? 'none'  : 'block';

  if (!hasKey) {
    document.getElementById('statusDot').classList.remove('on');
    document.getElementById('btnGoSettings').addEventListener('click', openSettings);
    document.getElementById('footerDash').style.display = 'none';
    return;
  }

  // 스냅샷 데이터
  const snaps = Array.isArray(d.lensAnalyticsSnapshots) ? d.lensAnalyticsSnapshots : [];
  document.getElementById('qSnaps').textContent = snaps.length + '개';

  // 캐시에서 퀵 스탯 표시
  const CACHE_TTL = 60 * 60 * 1000;
  const now = Date.now();
  const pc  = d.lensAnalyticsProductCache;
  const oc  = d.lensAnalyticsOrderCache;

  if (pc && (now - pc.ts) < CACHE_TTL) {
    const items   = pc.items || [];
    const onSale  = items.filter(p => ['S2','onsale','1'].includes(String(p.Status || p.ItemStatus || ''))).length;
    document.getElementById('qOnSale').textContent = fmtNum(onSale);
    document.getElementById('statusDot').classList.add('on');
  } else {
    document.getElementById('qOnSale').innerHTML = '<span style="font-size:12px;color:#94a3b8">미조회</span>';
  }

  if (oc && (now - oc.ts) < CACHE_TTL) {
    const orders  = oc.orders || [];
    const newOrd  = orders.filter(o =>
      ['1','11','new','NEW','OrderNew'].includes(String(o.OrderStatus || o.StatusCode || ''))
    ).length;
    const revenue = orders.reduce((s, o) => s + parseFloat(o.OrderPrice || o.Price || 0), 0);
    document.getElementById('qOrders').textContent  = fmtNum(newOrd);
    document.getElementById('qRevenue').textContent = fmtJPY(Math.round(revenue));

    const fetchTime = new Date(oc.ts);
    document.getElementById('lastUpdate').textContent =
      '업데이트 ' + fetchTime.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } else {
    document.getElementById('qOrders').innerHTML  = '<span style="font-size:12px;color:#94a3b8">미조회</span>';
    document.getElementById('qRevenue').innerHTML = '<span style="font-size:12px;color:#94a3b8">미조회</span>';
    document.getElementById('lastUpdate').textContent = '새로고침 필요';
  }

  // 버튼
  document.getElementById('btnDashboard').addEventListener('click', openDashboard);
  document.getElementById('footerDash').addEventListener('click', openDashboard);
  document.getElementById('btnSettings').addEventListener('click', openSettings);

  document.getElementById('btnRefresh').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/item_manager.html?refresh=1') });
    window.close();
  });
});
