/* ==========================================================================
   旅遊行程規劃 — app.js
   ========================================================================== */

// ===== Constants =====

const DAY_COLORS = [
  '#4F46E5', '#7C3AED', '#DB2777', '#DC2626',
  '#D97706', '#059669', '#0891B2', '#0284C7',
  '#9333EA', '#BE185D',
];

const STORAGE_KEY = 'travelPlan_v2';

// ===== State =====

let state = {
  trip: {
    title: '我的旅遊計畫',
    startDate: null,
    endDate: null,
    days: {},           // { 'YYYY-MM-DD': [attraction, ...] }
  },
  currentDay:            null,
  editingId:             null,   // attraction id being edited
  pendingLocation:       null,   // { lat, lng, name }
  map:                   null,
  markers:               [],
  routeLine:             null,
  sortable:              null,
  flatpickrInstance:     null,

  // Collaboration
  collab: {
    enabled:    false,   // Firebase is configured and valid
    roomId:     null,    // current room ID
    dbRef:      null,    // Firebase DatabaseReference
    listener:   null,    // unsubscribe handle
    isSyncing:  false,   // prevent echo when we receive remote update
  },
};

// ===== Utility =====

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 'YYYY-MM-DD' → Date object (local timezone) */
function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date object → 'YYYY-MM-DD' (uses local timezone, not UTC) */
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Returns array of 'YYYY-MM-DD' strings from start to end inclusive */
function daysInRange(start, end) {
  const result = [];
  const cur = parseDate(start);
  const last = parseDate(end);
  while (cur <= last) {
    result.push(toDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

/** Short formatted date: '3月15日 (週六)' */
function fmtDate(str) {
  return parseDate(str).toLocaleDateString('zh-TW', {
    month: 'short', day: 'numeric', weekday: 'short',
  });
}

function showToast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function getDayColor(dayStr) {
  if (!state.trip.startDate) return DAY_COLORS[0];
  const days = daysInRange(state.trip.startDate, state.trip.endDate);
  const i = days.indexOf(dayStr);
  return DAY_COLORS[i >= 0 ? i % DAY_COLORS.length : 0];
}

function currentAttractions() {
  if (!state.currentDay) return [];
  if (!state.trip.days) return [];
  return state.trip.days[state.currentDay] || [];
}

// ===== Storage =====

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.trip));
  syncToFirebase();
}

function normalizeTripData(trip) {
  if (!trip.days || typeof trip.days !== 'object' || Array.isArray(trip.days)) {
    trip.days = {};
  }
  return trip;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state.trip = normalizeTripData(JSON.parse(raw)); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

// ===== Map =====

function initMap() {
  state.map = L.map('map', {
    center: [23.6, 121.0],
    zoom: 7,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(state.map);

  // Map click → open add modal with coords pre-filled
  state.map.on('click', (e) => {
    if (!state.currentDay) return;
    const { lat, lng } = e.latlng;
    openAddModal({ lat, lng, name: '' });
    // reverse geocode to get name
    reverseGeocode(lat, lng);
  });
}

function markerIcon(seq, color) {
  const size = 34;
  return L.divIcon({
    html: `<div class="map-pin" style="
        width:${size}px; height:${size}px;
        background:${color};
        border:3px solid #fff;
        border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        box-shadow:0 3px 10px rgba(0,0,0,.28);
        display:flex; align-items:center; justify-content:center;">
      <span style="transform:rotate(45deg);color:#fff;font-size:13px;font-weight:800;line-height:1">${seq}</span>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -(size + 4)],
    className: '',
  });
}

function updateMap() {
  // Remove old
  state.markers.forEach(m => m.remove());
  state.markers = [];
  if (state.routeLine) { state.routeLine.remove(); state.routeLine = null; }

  const attrs = currentAttractions();
  const color = getDayColor(state.currentDay);
  const latlngs = [];

  attrs.forEach((a, i) => {
    if (a.lat == null || a.lng == null) return;

    const duration = a.duration ? ` · ${a.duration}分鐘` : '';
    const popup = L.popup({ maxWidth: 260 }).setContent(`
      <div class="popup-inner">
        <div class="popup-seq">第 ${i + 1} 站</div>
        <div class="popup-name">${escHtml(a.name)}</div>
        ${a.time ? `<div class="popup-time">⏰ ${a.time}${duration}</div>` : ''}
        ${a.notes ? `<div class="popup-notes">📝 ${escHtml(a.notes)}</div>` : ''}
      </div>`);

    const m = L.marker([a.lat, a.lng], { icon: markerIcon(i + 1, color) })
      .addTo(state.map)
      .bindPopup(popup);

    // Highlight card when marker is clicked
    m.on('click', () => highlightCard(a.id));

    state.markers.push(m);
    latlngs.push([a.lat, a.lng]);
  });

  if (latlngs.length > 1) {
    state.routeLine = L.polyline(latlngs, {
      color,
      weight: 3,
      opacity: .65,
      dashArray: '9 9',
    }).addTo(state.map);
  }

  fitMapToBounds(latlngs);
}

function fitMapToBounds(latlngs) {
  if (!latlngs || latlngs.length === 0) return;
  if (latlngs.length === 1) {
    state.map.setView(latlngs[0], 14);
  } else {
    state.map.fitBounds(latlngs, { padding: [60, 60], maxZoom: 15 });
  }
}

function highlightCard(id) {
  document.querySelectorAll('.attraction-card').forEach(c => c.classList.remove('active-card'));
  const card = document.querySelector(`.attraction-card[data-id="${id}"]`);
  if (card) {
    card.classList.add('active-card');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== Render Day Tabs =====

function renderTabs() {
  const container = document.getElementById('day-tabs');

  if (!state.trip.startDate || !state.trip.endDate) {
    container.innerHTML = `<div class="empty-state" style="padding:12px 16px; font-size:13px; color:var(--text-light);">請先選擇旅遊日期</div>`;
    return;
  }

  if (!state.trip.days) state.trip.days = {};
  const days = daysInRange(state.trip.startDate, state.trip.endDate);
  container.innerHTML = days.map((day, i) => {
    const count = (state.trip.days[day] || []).length;
    const active = day === state.currentDay ? 'active' : '';
    return `
      <div class="day-tab ${active}" data-day="${day}" title="${fmtDate(day)}">
        <span>第 ${i + 1} 天</span>
        <span class="tab-date">${fmtDate(day).replace(/\(.+\)/, '').trim()}</span>
        ${count > 0 ? `<span class="tab-count">${count}</span>` : ''}
      </div>`;
  }).join('');

  container.querySelectorAll('.day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.currentDay = tab.dataset.day;
      renderTabs();
      renderAttractions();
      updateMap();
      rebindSortable();
    });
  });
}

// ===== Render Attractions =====

function renderAttractions() {
  const list     = document.getElementById('attractions-list');
  const header   = document.getElementById('day-header-title');
  const badge    = document.getElementById('day-header-count');
  const attrs    = currentAttractions();
  const color    = getDayColor(state.currentDay);

  if (!state.currentDay) {
    header.textContent = '選擇日期開始規劃';
    badge.classList.add('hidden');
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-text">請先選擇旅遊日期</div></div>`;
    return;
  }

  header.textContent = fmtDate(state.currentDay);
  if (attrs.length > 0) {
    badge.textContent = `${attrs.length} 個景點`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (attrs.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🗺️</div><div class="empty-text">今天還沒有景點<br>點擊「新增景點」或直接點地圖</div></div>`;
    return;
  }

  list.innerHTML = attrs.map((a, i) => {
    const timePart     = a.time ? `<span class="card-time">⏰ ${a.time}</span>` : '';
    const durPart      = a.duration ? `<span class="card-duration">${a.duration}分</span>` : '';
    const notesPart    = a.notes ? `<div class="card-notes">📝 ${escHtml(a.notes)}</div>` : '';
    return `
      <div class="attraction-card" data-id="${a.id}">
        <span class="drag-handle" title="拖拉排序">⠿⠿</span>
        <div class="seq-badge" style="background:${color}">${i + 1}</div>
        <div class="card-info">
          <div class="card-name">${escHtml(a.name)}</div>
          <div class="card-meta">${timePart}${durPart}</div>
          ${notesPart}
        </div>
        <button class="card-edit-btn" data-id="${a.id}" title="編輯">✏️</button>
      </div>`;
  }).join('');

  // Card click → highlight map marker & open edit
  list.querySelectorAll('.attraction-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.drag-handle')) return;
      if (e.target.closest('.card-edit-btn')) return;
      openEditModal(card.dataset.id);
      // also open popup on map
      const idx = attrs.findIndex(a => a.id === card.dataset.id);
      if (idx >= 0 && state.markers[idx]) {
        state.markers[idx].openPopup();
      }
    });
  });

  list.querySelectorAll('.card-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(btn.dataset.id);
    });
  });
}

// ===== Sortable =====

function rebindSortable() {
  if (state.sortable) { state.sortable.destroy(); state.sortable = null; }
  const list = document.getElementById('attractions-list');

  state.sortable = Sortable.create(list, {
    animation: 180,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    filter: '.empty-state',
    onEnd(evt) {
      const day = state.trip.days[state.currentDay];
      if (!day) return;
      const [item] = day.splice(evt.oldIndex, 1);
      day.splice(evt.newIndex, 0, item);
      save();
      renderAttractions();
      updateMap();
    },
  });
}

// ===== Modal: Add / Edit =====

function openAddModal(preLocation = null) {
  state.editingId       = null;
  state.pendingLocation = preLocation;

  document.getElementById('modal-title').textContent    = '新增景點';
  document.getElementById('attraction-name').value      = preLocation?.name || '';
  document.getElementById('attraction-time').value      = '09:00';
  document.getElementById('attraction-duration').value  = '60';
  document.getElementById('attraction-notes').value     = '';
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('btn-modal-delete').classList.add('hidden');

  if (preLocation?.lat != null) {
    showLocationChip(preLocation.name || '地圖選點', preLocation.lat, preLocation.lng);
  } else {
    document.getElementById('selected-location').classList.add('hidden');
  }

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('attraction-name').focus();
}

function openEditModal(id) {
  const a = currentAttractions().find(x => x.id === id);
  if (!a) return;

  state.editingId       = id;
  state.pendingLocation = a.lat != null ? { lat: a.lat, lng: a.lng, name: a.name } : null;

  document.getElementById('modal-title').textContent    = '編輯景點';
  document.getElementById('attraction-name').value      = a.name;
  document.getElementById('attraction-time').value      = a.time || '';
  document.getElementById('attraction-duration').value  = a.duration || '';
  document.getElementById('attraction-notes').value     = a.notes || '';
  document.getElementById('search-results').classList.add('hidden');
  document.getElementById('btn-modal-delete').classList.remove('hidden');

  if (a.lat != null) {
    showLocationChip(a.name, a.lat, a.lng);
  } else {
    document.getElementById('selected-location').classList.add('hidden');
  }

  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('search-results').classList.add('hidden');
  state.editingId       = null;
  state.pendingLocation = null;
}

function saveAttraction() {
  const name     = document.getElementById('attraction-name').value.trim();
  const time     = document.getElementById('attraction-time').value;
  const duration = parseInt(document.getElementById('attraction-duration').value) || null;
  const notes    = document.getElementById('attraction-notes').value.trim();

  if (!name) { showToast('請輸入景點名稱'); return; }

  if (!state.trip.days) state.trip.days = {};
  if (!state.trip.days[state.currentDay]) {
    state.trip.days[state.currentDay] = [];
  }

  if (state.editingId) {
    const list = state.trip.days[state.currentDay];
    const idx  = list.findIndex(x => x.id === state.editingId);
    if (idx !== -1) {
      list[idx] = {
        ...list[idx],
        name,
        time,
        duration,
        notes,
        ...(state.pendingLocation ? { lat: state.pendingLocation.lat, lng: state.pendingLocation.lng } : {}),
      };
    }
    showToast('景點已更新 ✓');
  } else {
    state.trip.days[state.currentDay].push({
      id:       uid(),
      name,
      time,
      duration,
      notes,
      lat:      state.pendingLocation?.lat ?? null,
      lng:      state.pendingLocation?.lng ?? null,
    });
    showToast('景點已新增 ✓');
  }

  save();
  closeModal();
  renderTabs();
  renderAttractions();
  updateMap();
  rebindSortable();
}

function deleteAttraction() {
  if (!state.editingId) return;
  const list = state.trip.days[state.currentDay];
  const idx  = list.findIndex(x => x.id === state.editingId);
  if (idx !== -1) list.splice(idx, 1);
  save();
  closeModal();
  renderTabs();
  renderAttractions();
  updateMap();
  rebindSortable();
  showToast('景點已刪除');
}

// ===== Geocoding (Nominatim) =====

async function searchLocation(query) {
  if (!query.trim()) return;
  const box = document.getElementById('search-results');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="search-empty">搜尋中…</div>';

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&addressdetails=1&accept-language=zh-TW,zh,en`;
    const res  = await fetch(url);
    const data = await res.json();

    if (!data.length) {
      box.innerHTML = '<div class="search-empty">找不到結果，請嘗試其他關鍵字</div>';
      return;
    }

    box.innerHTML = data.map((r, i) => {
      const parts  = r.display_name.split(',');
      const top    = parts.slice(0, 2).join(', ');
      const sub    = parts.slice(2, 4).join(', ');
      return `
        <div class="search-item" data-i="${i}" data-lat="${r.lat}" data-lng="${r.lon}" data-name="${escHtml(parts[0].trim())}">
          <div class="search-item-name">${escHtml(top)}</div>
          <div class="search-item-addr">${escHtml(sub)}</div>
        </div>`;
    }).join('');

    box.querySelectorAll('.search-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat  = parseFloat(item.dataset.lat);
        const lng  = parseFloat(item.dataset.lng);
        const name = item.dataset.name;
        selectLocation(lat, lng, name);
        box.classList.add('hidden');
        const nameField = document.getElementById('attraction-name');
        if (!nameField.value.trim()) nameField.value = name;
      });
    });
  } catch (_) {
    box.innerHTML = '<div class="search-empty">搜尋失敗，請檢查網路連線</div>';
  }
}

async function reverseGeocode(lat, lng) {
  try {
    const url  = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&accept-language=zh-TW,zh,en`;
    const res  = await fetch(url);
    const data = await res.json();
    const name = data.name || data.display_name?.split(',')[0] || '地圖選點';
    selectLocation(lat, lng, name);
    const field = document.getElementById('attraction-name');
    if (!field.value.trim()) field.value = name;
  } catch (_) {
    selectLocation(lat, lng, '地圖選點');
  }
}

function selectLocation(lat, lng, name) {
  state.pendingLocation = { lat, lng, name };
  showLocationChip(name, lat, lng);
  // Preview on map (don't zoom too far in)
  if (state.map.getZoom() < 13) {
    state.map.setView([lat, lng], 14);
  } else {
    state.map.panTo([lat, lng]);
  }
}

function showLocationChip(name, lat, lng) {
  document.getElementById('selected-location').classList.remove('hidden');
  document.getElementById('location-label').textContent = name || '已選擇位置';
  document.getElementById('location-coords').textContent = `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

// ===== Date Picker =====

function initDatePicker() {
  const opts = {
    mode:       'range',
    dateFormat: 'Y-m-d',
    locale:     'zh_tw',
    onChange(dates) {
      if (dates.length < 2) return;
      const start = toDateStr(dates[0]);
      const end   = toDateStr(dates[1]);
      state.trip.startDate = start;
      state.trip.endDate   = end;

      // Keep current day if still in range, else default to first day
      if (!state.currentDay || state.currentDay < start || state.currentDay > end) {
        state.currentDay = start;
      }

      save();
      renderTabs();
      renderAttractions();
      updateMap();
      rebindSortable();
    },
  };

  if (state.trip.startDate && state.trip.endDate) {
    opts.defaultDate = [state.trip.startDate, state.trip.endDate];
  }

  state.flatpickrInstance = flatpickr('#date-range', opts);
}

// ===== Share / Export / Import =====

function exportTrip() {
  const json = JSON.stringify(state.trip, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${state.trip.title || 'trip'}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('行程已匯出 ✓');
}

function importTrip(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      state.trip    = JSON.parse(e.target.result);
      state.currentDay = state.trip.startDate || null;
      save();
      reinit();
      showToast('行程已匯入 ✓');
    } catch (_) {
      showToast('檔案格式錯誤，請確認為 JSON 格式');
    }
  };
  reader.readAsText(file);
}

function openShareModal() {
  const json    = JSON.stringify(state.trip);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  const shareUrl = `${location.origin}${location.pathname}?trip=${encoded}`;
  document.getElementById('share-url').value = shareUrl;
  document.getElementById('share-overlay').classList.remove('hidden');
}

function checkUrlParams() {
  const params = new URLSearchParams(location.search);
  const tripParam = params.get('trip');
  if (!tripParam) return;
  try {
    state.trip = JSON.parse(decodeURIComponent(escape(atob(tripParam))));
    state.currentDay = state.trip.startDate || null;
    save();
    history.replaceState({}, '', location.pathname);
    showToast('已從分享連結載入行程 ✓');
  } catch (_) {
    console.warn('Invalid trip param');
  }
}

// ===== Event Binding =====

function bindEvents() {
  // Trip title
  document.getElementById('trip-title').addEventListener('input', e => {
    state.trip.title = e.target.value;
    save();
  });

  // Add attraction
  document.getElementById('btn-add-attraction').addEventListener('click', () => {
    if (!state.currentDay) { showToast('請先選擇旅遊日期'); return; }
    openAddModal();
  });

  // Modal close
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Search
  document.getElementById('btn-search').addEventListener('click', () => {
    searchLocation(document.getElementById('attraction-name').value);
  });
  document.getElementById('attraction-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchLocation(e.target.value);
    }
  });

  // Hide search results when clicking outside
  document.addEventListener('click', e => {
    const box = document.getElementById('search-results');
    if (!box.contains(e.target) && e.target.id !== 'attraction-name' && e.target.id !== 'btn-search') {
      box.classList.add('hidden');
    }
  });

  // Modal save/cancel/delete
  document.getElementById('btn-modal-save').addEventListener('click', saveAttraction);
  document.getElementById('btn-modal-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-modal-delete').addEventListener('click', deleteAttraction);

  // Fit bounds button
  document.getElementById('btn-fit-bounds').addEventListener('click', () => {
    const latlngs = currentAttractions()
      .filter(a => a.lat != null)
      .map(a => [a.lat, a.lng]);
    if (latlngs.length) fitMapToBounds(latlngs);
    else showToast('目前沒有已定位的景點');
  });

  // Export / Import
  document.getElementById('btn-export').addEventListener('click', exportTrip);
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importTrip(e.target.files[0]);
    e.target.value = '';
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      document.getElementById('collab-overlay').classList.add('hidden');
    }
    if (e.key === 'Enter' && e.metaKey) {
      // Cmd+Enter to save modal
      if (!document.getElementById('modal-overlay').classList.contains('hidden')) {
        saveAttraction();
      }
    }
  });
}

// ===== Init / Reinit =====

function reinit() {
  document.getElementById('trip-title').value = state.trip.title || '我的旅遊計畫';

  // Re-init date picker with current values
  if (state.flatpickrInstance) {
    state.flatpickrInstance.destroy();
  }
  initDatePicker();

  if (!state.currentDay && state.trip.startDate) {
    state.currentDay = state.trip.startDate;
  }

  renderTabs();
  renderAttractions();
  updateMap();
  rebindSortable();
}

// ===== Firebase / Collaboration =====

/**
 * Check if firebase-config.js provided a real (non-placeholder) config.
 */
function isFirebaseConfigured() {
  try {
    return (
      typeof FIREBASE_CONFIG !== 'undefined' &&
      FIREBASE_CONFIG.databaseURL &&
      !FIREBASE_CONFIG.databaseURL.includes('YOUR_')
    );
  } catch (_) { return false; }
}

function initFirebase() {
  if (!isFirebaseConfigured()) return;
  try {
    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }
    state.collab.enabled = true;
  } catch (e) {
    console.warn('Firebase init failed:', e);
    state.collab.enabled = false;
  }
}

/** Generate a random 6-char uppercase room code */
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

/** Upload current trip to Firebase and start listening */
function createRoom() {
  if (!state.collab.enabled) return;
  const roomId = genRoomCode();
  joinRoom(roomId, true);
}

function joinRoom(roomId, upload = false) {
  if (!state.collab.enabled || !roomId) return;

  // Leave any existing room first
  leaveRoom(false);

  state.collab.roomId = roomId.toUpperCase();
  const db  = firebase.database();
  const ref = db.ref(`rooms/${state.collab.roomId}/trip`);
  state.collab.dbRef = ref;

  if (upload) {
    // Push current trip to Firebase
    ref.set(state.trip)
      .then(() => {
        showToast(`房間已建立：${state.collab.roomId} ✓`);
        startListening(ref);
        updateCollabUI(true);
      })
      .catch(e => { showToast('建立房間失敗：' + e.message); });
  } else {
    // Load trip from Firebase then start listening
    ref.once('value')
      .then(snapshot => {
        const data = snapshot.val();
        if (!data) { showToast('找不到此房間，請確認房間碼'); return; }
        state.trip    = normalizeTripData(data);
        state.currentDay = state.trip.startDate || null;
        save();
        reinit();
        showToast(`已加入房間 ${state.collab.roomId} ✓`);
        startListening(ref);
        updateCollabUI(true);
      })
      .catch(e => { showToast('加入房間失敗：' + e.message); });
  }
}

function startListening(ref) {
  // Remove previous listener if any
  if (state.collab.listener) {
    state.collab.dbRef?.off('value', state.collab.listener);
  }

  state.collab.listener = ref.on('value', snapshot => {
    if (state.collab.isSyncing) return; // ignore echo from our own write
    const data = snapshot.val();
    if (!data) return;

    // Only update if data actually changed (simple check)
    const remote = JSON.stringify(data);
    const local  = JSON.stringify(state.trip);
    if (remote === local) return;

    state.trip = normalizeTripData(data);
    if (!state.currentDay && state.trip.startDate) {
      state.currentDay = state.trip.startDate;
    }
    save();
    reinit();
    showToast('行程已同步更新');
  });
}

function leaveRoom(notify = true) {
  if (state.collab.dbRef && state.collab.listener) {
    state.collab.dbRef.off('value', state.collab.listener);
  }
  state.collab.roomId   = null;
  state.collab.dbRef    = null;
  state.collab.listener = null;
  updateCollabUI(false);
  if (notify) showToast('已離開協作房間');
}

/** Push local trip to Firebase (called after every save) */
function syncToFirebase() {
  if (!state.collab.enabled || !state.collab.dbRef) return;
  state.collab.isSyncing = true;
  state.collab.dbRef.set(state.trip)
    .finally(() => { setTimeout(() => { state.collab.isSyncing = false; }, 200); });
}

function updateCollabUI(active) {
  const statusEl   = document.getElementById('collab-status');
  const roomLabel  = document.getElementById('collab-room-label');
  const activePane = document.getElementById('collab-active');
  const readyPane  = document.getElementById('collab-ready');
  const urlInput   = document.getElementById('collab-share-url');
  const codeEl     = document.getElementById('room-code-display');

  if (active && state.collab.roomId) {
    statusEl.classList.remove('hidden');
    roomLabel.textContent = `房間：${state.collab.roomId}`;

    if (activePane) {
      activePane.classList.remove('hidden');
      readyPane?.classList.add('hidden');
      if (codeEl) codeEl.textContent = state.collab.roomId;
      if (urlInput) {
        urlInput.value = `${location.origin}${location.pathname}?room=${state.collab.roomId}`;
      }
    }
  } else {
    statusEl.classList.add('hidden');
    activePane?.classList.add('hidden');
    readyPane?.classList.remove('hidden');
  }
}

function openCollabModal() {
  const overlay   = document.getElementById('collab-overlay');
  const noFb      = document.getElementById('collab-no-firebase');
  const ready     = document.getElementById('collab-ready');
  const active    = document.getElementById('collab-active');

  if (!state.collab.enabled) {
    noFb.classList.remove('hidden');
    ready.classList.add('hidden');
    active.classList.add('hidden');
  } else if (state.collab.roomId) {
    noFb.classList.add('hidden');
    ready.classList.add('hidden');
    active.classList.remove('hidden');
    updateCollabUI(true);
  } else {
    noFb.classList.add('hidden');
    ready.classList.remove('hidden');
    active.classList.add('hidden');
  }

  overlay.classList.remove('hidden');
}

function bindCollabEvents() {
  document.getElementById('btn-collab').addEventListener('click', openCollabModal);

  document.getElementById('collab-close').addEventListener('click', () => {
    document.getElementById('collab-overlay').classList.add('hidden');
  });
  document.getElementById('collab-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('collab-overlay')) {
      document.getElementById('collab-overlay').classList.add('hidden');
    }
  });

  document.getElementById('btn-create-room').addEventListener('click', () => {
    document.getElementById('collab-overlay').classList.add('hidden');
    createRoom();
  });

  document.getElementById('btn-join-room').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value.trim().toUpperCase();
    if (code.length !== 6) { showToast('請輸入 6 位房間碼'); return; }
    document.getElementById('collab-overlay').classList.add('hidden');
    joinRoom(code, false);
  });

  document.getElementById('room-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join-room').click();
  });

  document.getElementById('btn-leave-room').addEventListener('click', () => {
    document.getElementById('collab-overlay').classList.add('hidden');
    leaveRoom(true);
  });

  document.getElementById('btn-leave-collab').addEventListener('click', () => leaveRoom(true));

  document.getElementById('btn-copy-collab').addEventListener('click', () => {
    const url = document.getElementById('collab-share-url').value;
    navigator.clipboard.writeText(url)
      .then(() => showToast('協作連結已複製 ✓'))
      .catch(() => { document.getElementById('collab-share-url').select(); document.execCommand('copy'); showToast('協作連結已複製 ✓'); });
  });
}

// ===== Boot =====

document.addEventListener('DOMContentLoaded', () => {
  initFirebase();

  // Check for room param (?room=XXXXXX) in URL
  const urlParams = new URLSearchParams(location.search);
  const roomParam = urlParams.get('room');

  load();             // load from localStorage

  if (!state.currentDay && state.trip.startDate) {
    state.currentDay = state.trip.startDate;
  }

  initMap();
  initDatePicker();
  bindEvents();
  bindCollabEvents();

  document.getElementById('trip-title').value = state.trip.title || '我的旅遊計畫';

  renderTabs();
  renderAttractions();
  updateMap();
  rebindSortable();

  // Join room from URL after UI is ready
  if (roomParam && state.collab.enabled) {
    setTimeout(() => joinRoom(roomParam.toUpperCase(), false), 500);
  }
});
