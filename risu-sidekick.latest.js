//@name risu_sidekick
//@display-name 리스 사이드킥 v0.2.7
//@author IBNT + Codex
//@api 3.0
//@version 0.2.7
//@changes 우상단 플로팅 버튼 제거, 미지원 사이드패널 리사이저 제거
//@update-url https://raw.githubusercontent.com/Lukaku-ai/risu-sidekick/refs/heads/main/risu-sidekick.latest.js

(async () => {
  const R = globalThis.risuai || globalThis.Risuai;
  if (!R) {
    console.error("[Risu Sidekick] RisuAI plugin API was not found.");
    return;
  }

  const PLUGIN_VERSION = "0.2.7";
  const SNAPSHOT_PREFIX = "risu_sidekick_snapshot_";
  const SFX_REGEX = /§[^§\r\n]{1,80}§/g;
  const MS_DAY = 24 * 60 * 60 * 1000;
  const OLD_3M = 90 * MS_DAY;
  const OLD_6M = 180 * MS_DAY;
  const OLD_1Y = 365 * MS_DAY;

  const FEATURES = [
    {
      id: "storage",
      title: "플러그인이 점점 무거워져",
      short: "스토리지 정리",
      desc: "플러그인 저장소 키, 추정 소유자, 크기를 확인하고 정리합니다.",
    },
    {
      id: "greetings",
      title: "소악마 프롬으로 퍼메 짜면 이거 좀 지워줘",
      short: "§...§ 청소",
      desc: "첫 메시지와 추가 첫 메시지의 짧은 §...§ 조각을 찾아 제거합니다.",
    },
    {
      id: "dormant",
      title: "우리 이젠 헤어지자 말해요",
      short: "잠든 봇 정리",
      desc: "대화가 없거나 오래 쉬고 있는 봇을 찾아 휴지통으로 보냅니다.",
    },
    {
      id: "tools",
      title: "작은 도구함",
      short: "도구",
      desc: "따로 플러그인으로 빼기엔 소소하지만 유용한 Risu UI 편의 기능을 모읍니다.",
    },
  ];

  const state = {
    tab: "storage",
    busy: false,
    status: "준비됨",
    progress: null,
    storageRows: [],
    storageSort: { key: "size", dir: "desc" },
    selectedStorage: new Set(),
    greetingGroups: [],
    expandedGreeting: new Set(),
    selectedGreeting: new Set(),
    dormantRows: [],
    dormantFilter: "all",
    dormantSort: { key: "lastTime", dir: "asc" },
    selectedDormant: new Set(),
    mobileOpen: false,
    dbPermissionChecked: false,
  };

  const imageCache = new Map();
  const assetSizeCache = new Map();

  const $ = (selector) => document.querySelector(selector);

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function estimateSize(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).length;
    } catch {
      return new TextEncoder().encode(String(value ?? "")).length;
    }
  }

  function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let value = Number(bytes) || 0;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  }

  function formatDate(time) {
    if (!time) return "날짜 없음";
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) return "날짜 없음";
    return date.toLocaleDateString();
  }

  function normalizeForSort(value) {
    return String(value ?? "").toLocaleLowerCase("ko-KR");
  }

  function normalizePluginName(value) {
    return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/[^a-z0-9가-힣_-]+/g, "");
  }

  function ownerRank(owner) {
    return owner === "알 수 없음" ? 1 : 0;
  }

  function guessStorageOwner(key, plugins) {
    const normalizedKey = normalizePluginName(key);
    for (const plugin of plugins || []) {
      for (const candidate of [plugin.name, plugin.displayName].filter(Boolean)) {
        const normalized = normalizePluginName(candidate);
        if (normalized && normalizedKey.includes(normalized)) {
          return plugin.displayName || plugin.name;
        }
      }
    }
    return "알 수 없음";
  }

  async function showPermissionOverlay(message, progress = null) {
    state.busy = true;
    state.progress = progress;
    setStatus(message);
    syncBusyLayer();
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  function clearBusy(message) {
    state.busy = false;
    state.progress = null;
    setStatus(message);
    syncBusyLayer();
    refreshPanel();
  }

  function setBusyProgress(message, current, total) {
    const safeTotal = Math.max(1, Number(total) || 1);
    const percent = Math.max(0, Math.min(100, Math.round((Number(current) || 0) / safeTotal * 100)));
    state.progress = percent;
    setStatus(`${message} ${percent}%`);
    syncBusyLayer();
  }

  async function getDb(keys) {
    if (!state.dbPermissionChecked) {
      setStatus("RisuAI DB 권한 확인창이 뜨면 허용해 주세요.");
      await R.hideContainer();
      const allowed = await R.requestPluginPermission("db");
      state.dbPermissionChecked = Boolean(allowed);
      await R.showContainer("fullscreen");
      render();
      if (!allowed) {
        setStatus("DB 권한이 필요합니다. 기능을 실행하려면 권한을 허용해 주세요.");
        return null;
      }
    }
    await showPermissionOverlay("스캔하는 중...");
    const db = await R.getDatabase(keys);
    if (!db) {
      clearBusy("DB 권한이 필요합니다. 다시 시도하고 권한 확인창에서 허용해 주세요.");
      return null;
    }
    return db;
  }

  function syncBusyLayer() {
    const shell = $(".rm-shell");
    if (!shell) return;
    let layer = $(".busy-layer");
    if (!state.busy) {
      if (layer) layer.remove();
      shell.classList.remove("permission-mode");
      return;
    }
    shell.classList.add("permission-mode");
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "busy-layer";
      shell.appendChild(layer);
    }
    const progress = Number.isFinite(state.progress) ? state.progress : null;
    layer.innerHTML = `
      <div class="loader ${progress === null ? "indeterminate" : ""}">
        <span style="width:${progress === null ? 42 : progress}%"></span>
      </div>
      <p>${escapeHtml(state.status)}</p>
      ${progress === null ? "" : `<strong>${progress}%</strong>`}
    `;
  }

  async function saveSnapshot(kind, payload) {
    const key = `${SNAPSHOT_PREFIX}${Date.now()}_${kind}`;
    await R.pluginStorage.setItem(key, {
      version: PLUGIN_VERSION,
      kind,
      createdAt: Date.now(),
      payload,
    });
    return key;
  }

  function setStatus(message) {
    state.status = message;
    const node = $("#status");
    if (node) node.textContent = message;
    const busyText = $(".busy-layer p");
    if (busyText) busyText.textContent = message;
  }

  async function openPanel() {
    await R.showContainer("fullscreen");
    render();
  }

  function currentFeature() {
    return FEATURES.find((feature) => feature.id === state.tab) || FEATURES[0];
  }

  function render() {
    const feature = currentFeature();
    document.body.innerHTML = `
      <main class="rm-shell ${state.mobileOpen ? "mobile-feature-open" : "mobile-feature-list"}">
        <aside class="rm-sidebar">
          <div class="brand">
            <div>
              <h1>리스 사이드킥</h1>
              <p>잔손 많이 가는 Risu 정리함</p>
            </div>
            <button class="icon-close" data-action="close" aria-label="닫기">×</button>
          </div>
          <nav class="feature-list">
            ${FEATURES.map(renderFeatureButton).join("")}
          </nav>
        </aside>
        <section class="rm-main">
          <header class="feature-head">
            <button class="mobile-back" data-action="mobile-back">‹ 기능 목록</button>
            <div>
              <p class="eyebrow">${escapeHtml(feature.short)}</p>
              <h2>${escapeHtml(feature.title)}</h2>
              <p>${escapeHtml(feature.desc)}</p>
            </div>
          </header>
          <section class="panel">${renderTab()}</section>
          <footer id="status">${escapeHtml(state.status)}</footer>
        </section>
        ${state.busy ? `<div class="busy-layer"><div class="loader"></div><p>${escapeHtml(state.status)}</p></div>` : ""}
      </main>
    `;
    injectStyle();
    bindEvents();
  }

  function renderFeatureButton(feature) {
    return `
      <button class="feature-card ${state.tab === feature.id ? "active" : ""}" data-tab="${feature.id}">
        <strong>${escapeHtml(feature.title)}</strong>
        <span>${escapeHtml(feature.desc)}</span>
      </button>
    `;
  }

  function refreshPanel() {
    const shell = $(".rm-shell");
    const panel = $(".panel");
    const head = $(".feature-head");
    const feature = currentFeature();
    if (!shell || !panel || !head) {
      render();
      return;
    }
    shell.classList.toggle("mobile-feature-open", state.mobileOpen);
    shell.classList.toggle("mobile-feature-list", !state.mobileOpen);
    document.querySelectorAll(".feature-card").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === state.tab);
    });
    head.innerHTML = `
      <button class="mobile-back" data-action="mobile-back">‹ 기능 목록</button>
      <div>
        <p class="eyebrow">${escapeHtml(feature.short)}</p>
        <h2>${escapeHtml(feature.title)}</h2>
        <p>${escapeHtml(feature.desc)}</p>
      </div>
    `;
    panel.innerHTML = renderTab();
    bindEvents();
    syncBusyLayer();
  }

  function renderTab() {
    if (state.tab === "storage") return renderStorage();
    if (state.tab === "greetings") return renderGreetings();
    if (state.tab === "tools") return renderTools();
    return renderDormant();
  }

  function renderTools() {
    return `
      <div class="tool-list">
        <article class="tool-empty">
          <span>
            <strong>준비 중</strong>
            <small>RisuAI v3 플러그인 환경에서 안정적으로 지원되는 작은 UI 편의 기능만 이곳에 추가합니다.</small>
          </span>
        </article>
      </div>
      <p class="hint">이 탭은 작지만 자주 쓰게 될 UI 편의 기능을 모아 두는 자리입니다.</p>
    `;
  }

  function totalGreetingCount() {
    return state.greetingGroups.reduce((sum, group) => sum + group.items.length, 0);
  }

  function selectedGreetingCount() {
    return state.greetingGroups.reduce((sum, group) => (
      sum + group.items.filter((item) => state.selectedGreeting.has(item.id)).length
    ), 0);
  }

  function renderSortHead(label, key, scope) {
    const sort = scope === "storage" ? state.storageSort : state.dormantSort;
    const mark = sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
    return `<button class="sort-head" data-sort-${scope}="${key}">${label}${mark}</button>`;
  }

  function sortedStorageRows() {
    const rows = [...state.storageRows];
    const { key, dir } = state.storageSort;
    rows.sort((a, b) => {
      let value = 0;
      if (key === "size") value = a.size - b.size;
      if (key === "key") value = normalizeForSort(a.key).localeCompare(normalizeForSort(b.key), "ko-KR");
      if (key === "owner") {
        value = ownerRank(a.owner) - ownerRank(b.owner);
        if (value === 0) value = normalizeForSort(a.owner).localeCompare(normalizeForSort(b.owner), "ko-KR");
      }
      return dir === "asc" ? value : -value;
    });
    return rows;
  }

  function renderStorage() {
    const rows = sortedStorageRows();
    const total = rows.reduce((sum, row) => sum + row.size, 0);
    return `
      <div class="toolbar">
        <button data-action="scan-storage">스캔</button>
        <button data-action="delete-storage" class="danger">선택 삭제</button>
        <button data-action="delete-all-storage" class="danger outline">전체 삭제</button>
        <span>${rows.length}개, ${formatBytes(total)}</span>
      </div>
      <p class="hint">소유자 표시는 저장소 키와 설치된 플러그인명을 비교한 추정값입니다. 확실하지 않은 항목은 최하단에 둡니다.</p>
      <div class="desktop-table">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>${renderSortHead("저장소 키", "key", "storage")}</th>
              <th>${renderSortHead("소유자 추정", "owner", "storage")}</th>
              <th>${renderSortHead("크기", "size", "storage")}</th>
            </tr>
          </thead>
          <tbody>${rows.map(renderStorageRow).join("") || `<tr><td colspan="4" class="empty">아직 스캔하지 않았습니다.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="mobile-list">${rows.map(renderStorageMobile).join("") || `<div class="empty-card">아직 스캔하지 않았습니다.</div>`}</div>
    `;
  }

  function renderStorageRow(row) {
    const selected = state.selectedStorage.has(row.key);
    return `
      <tr class="selectable-row ${selected ? "selected" : ""}" data-toggle-storage="${escapeHtml(row.key)}">
        <td class="select-mark">${selected ? "선택됨" : ""}</td>
        <td><code>${escapeHtml(row.key)}</code></td>
        <td>${escapeHtml(row.owner)}</td>
        <td>${formatBytes(row.size)}</td>
      </tr>
    `;
  }

  function renderStorageMobile(row) {
    const selected = state.selectedStorage.has(row.key);
    return `
      <article class="mobile-card selectable-card ${selected ? "selected" : ""}" data-toggle-storage="${escapeHtml(row.key)}">
        <dl>
          <dt>저장소 키</dt><dd><code>${escapeHtml(row.key)}</code></dd>
          <dt>소유자 추정</dt><dd>${escapeHtml(row.owner)}</dd>
          <dt>크기</dt><dd>${formatBytes(row.size)}</dd>
        </dl>
      </article>
    `;
  }

  function renderGreetings() {
    return `
      <div class="toolbar">
        <button data-action="scan-current-greetings">현재 봇 스캔</button>
        <button data-action="scan-all-greetings">전체 봇 스캔</button>
        <button data-action="select-all-greetings">전체 선택</button>
        <button data-action="clear-all-greetings">전체 해제</button>
        <button data-action="apply-greetings" class="primary">선택 삭제</button>
        <span>${selectedGreetingCount()} / ${totalGreetingCount()}개 선택</span>
      </div>
      <p class="hint">봇 이름을 누르면 첫 메시지와 추가 첫 메시지 후보가 펼쳐집니다. 기본 패턴은 짧은 <code>§...§</code> 조각만 제거합니다.</p>
      <div class="accordion">
        ${state.greetingGroups.map(renderGreetingGroup).join("") || `<div class="empty-card">스캔 결과가 없습니다.</div>`}
      </div>
    `;
  }

  function renderGreetingGroup(group) {
    const expanded = state.expandedGreeting.has(String(group.charIndex));
    const selectedCount = group.items.filter((item) => state.selectedGreeting.has(item.id)).length;
    return `
      <article class="fold-card greeting-group">
        <header>
          <button class="fold-title" data-toggle-greeting="${group.charIndex}">
            <span class="bot-cell">${renderBotImage(group)}<strong>${escapeHtml(group.charName)}</strong></span>
            <span>${selectedCount}/${group.items.length} 선택 ${expanded ? "접기" : "펼치기"}</span>
          </button>
          <div class="group-actions">
            <button data-greeting-select-group="${group.charIndex}">전체 선택</button>
            <button data-greeting-clear-group="${group.charIndex}">전체 해제</button>
          </div>
        </header>
        <div class="fold-body ${expanded ? "open" : ""}">
          ${group.items.map(renderGreetingItem).join("")}
        </div>
      </article>
    `;
  }

  function renderGreetingItem(item) {
    const selected = state.selectedGreeting.has(item.id);
    return `
      <div class="greeting-item ${selected ? "selected" : ""}" data-toggle-greeting-item="${item.id}">
        <strong>${escapeHtml(item.fieldLabel)}</strong>
        <span>${escapeHtml(item.matches.join(", "))}</span>
      </div>
    `;
  }

  function sortedDormantRows() {
    const rows = state.dormantRows.filter((row) => state.dormantFilter === "all" || row.category === state.dormantFilter);
    const { key, dir } = state.dormantSort;
    rows.sort((a, b) => {
      let value = 0;
      if (key === "name") value = normalizeForSort(a.name).localeCompare(normalizeForSort(b.name), "ko-KR");
      if (key === "category") value = normalizeForSort(categoryLabel(a.category)).localeCompare(normalizeForSort(categoryLabel(b.category)), "ko-KR");
      if (key === "lastTime") value = (a.lastTime || 0) - (b.lastTime || 0);
      if (key === "userMessages") value = a.userMessages - b.userMessages;
      if (key === "size") value = a.size - b.size;
      return dir === "asc" ? value : -value;
    });
    return rows;
  }

  function renderDormant() {
    const rows = sortedDormantRows();
    const totalSize = rows.reduce((sum, row) => sum + row.size, 0);
    return `
      <div class="toolbar">
        <button data-action="scan-dormant">스캔</button>
        <select id="dormant-filter">
          ${filterOption("all", "전체")}
          ${filterOption("no_chat", "대화 없음")}
          ${filterOption("old_3m", "3개월 이상")}
          ${filterOption("old_6m", "6개월 이상")}
          ${filterOption("old_1y", "1년 이상")}
          ${filterOption("unknown", "날짜 불명")}
        </select>
        <button data-action="trash-dormant" class="danger">선택 휴지통</button>
        <span>${rows.length}개 표시, ${formatBytes(totalSize)}</span>
      </div>
      <p class="hint">목록 스캔은 빠른 추정값을 먼저 표시합니다. 이미지가 많은 봇은 각 행의 정밀 계산 버튼으로 필요한 봇만 실제 에셋 용량까지 확인하세요.</p>
      <div class="desktop-table">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>${renderSortHead("봇", "name", "dormant")}</th>
              <th>${renderSortHead("분류", "category", "dormant")}</th>
              <th>${renderSortHead("마지막 대화", "lastTime", "dormant")}</th>
              <th>최근 열람/갱신 추정</th>
              <th>${renderSortHead("사용자 메시지", "userMessages", "dormant")}</th>
              <th>${renderSortHead("용량", "size", "dormant")}</th>
            </tr>
          </thead>
          <tbody>${rows.map(renderDormantRow).join("") || `<tr><td colspan="7" class="empty">스캔 결과가 없습니다.</td></tr>`}</tbody>
        </table>
      </div>
      <div class="mobile-list">${rows.map(renderDormantMobile).join("") || `<div class="empty-card">스캔 결과가 없습니다.</div>`}</div>
    `;
  }

  function renderDormantRow(row) {
    const selected = state.selectedDormant.has(row.index);
    return `
      <tr class="selectable-row ${selected ? "selected" : ""}" data-toggle-dormant="${row.index}">
        <td class="select-mark">${selected ? "선택됨" : ""}</td>
        <td><div class="bot-cell">${renderBotImage(row)}<span>${escapeHtml(row.name)}</span></div></td>
        <td>${escapeHtml(categoryLabel(row.category))}</td>
        <td>${formatDate(row.lastTime)}</td>
        <td>${formatDate(row.lastInteraction)}</td>
        <td>${row.userMessages}</td>
        <td>${renderDormantSize(row)}</td>
      </tr>
    `;
  }

  function renderDormantMobile(row) {
    const selected = state.selectedDormant.has(row.index);
    return `
      <article class="mobile-card selectable-card ${selected ? "selected" : ""}" data-toggle-dormant="${row.index}">
        <div class="mobile-bot-head">${renderBotImage(row)}<strong>${escapeHtml(row.name)}</strong></div>
        <dl>
          <dt>분류</dt><dd>${escapeHtml(categoryLabel(row.category))}</dd>
          <dt>마지막 대화</dt><dd>${formatDate(row.lastTime)}</dd>
          <dt>열람/갱신 추정</dt><dd>${formatDate(row.lastInteraction)}</dd>
          <dt>사용자 메시지</dt><dd>${row.userMessages}</dd>
          <dt>용량</dt><dd>${renderDormantSize(row)}</dd>
        </dl>
      </article>
    `;
  }

  function renderDormantSize(row) {
    const label = row.sizeMode === "exact" ? "정밀" : "빠른 추정";
    const pending = row.pendingAssetCount ? ` · 미확인 에셋 ${row.pendingAssetCount}개` : "";
    return `
      <div class="size-cell">
        <strong>${formatBytes(row.size)}</strong>
        <span>${label}${pending}</span>
        ${row.sizeMode === "exact" ? "" : `<button data-action="measure-dormant" data-index="${row.index}">정밀 계산</button>`}
      </div>
    `;
  }

  function renderBotImage(row) {
    if (row.imageSrc) {
      return `<img class="bot-image" src="${escapeHtml(row.imageSrc)}" alt="">`;
    }
    return `<div class="bot-image placeholder">${escapeHtml(String(row.name || "?").slice(0, 1))}</div>`;
  }

  function filterOption(value, label) {
    return `<option value="${value}" ${state.dormantFilter === value ? "selected" : ""}>${label}</option>`;
  }

  function categoryLabel(value) {
    return {
      no_chat: "대화 없음",
      old_3m: "3개월 이상",
      old_6m: "6개월 이상",
      old_1y: "1년 이상",
      unknown: "날짜 불명",
    }[value] || value;
  }

  function bindEvents() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.onclick = () => {
        state.tab = button.dataset.tab;
        state.mobileOpen = true;
        refreshPanel();
      };
    });

    document.querySelectorAll("[data-action]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        handleAction(button.dataset.action, button);
      };
    });

    document.querySelectorAll("[data-sort-storage]").forEach((button) => {
      button.onclick = () => setSort("storage", button.dataset.sortStorage);
    });
    document.querySelectorAll("[data-sort-dormant]").forEach((button) => {
      button.onclick = () => setSort("dormant", button.dataset.sortDormant);
    });

    document.querySelectorAll("[data-toggle-storage]").forEach((node) => {
      node.onclick = () => {
        const key = node.dataset.toggleStorage;
        toggleSet(state.selectedStorage, key, !state.selectedStorage.has(key));
        refreshPanel();
      };
    });
    document.querySelectorAll("[data-toggle-greeting-item]").forEach((node) => {
      node.onclick = () => {
        const id = node.dataset.toggleGreetingItem;
        toggleSet(state.selectedGreeting, id, !state.selectedGreeting.has(id));
        refreshPanel();
      };
    });
    document.querySelectorAll("[data-greeting-select-group]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        setGreetingGroupSelection(Number(button.dataset.greetingSelectGroup), true);
      };
    });
    document.querySelectorAll("[data-greeting-clear-group]").forEach((button) => {
      button.onclick = (event) => {
        event.stopPropagation();
        setGreetingGroupSelection(Number(button.dataset.greetingClearGroup), false);
      };
    });
    document.querySelectorAll("[data-toggle-greeting]").forEach((button) => {
      button.onclick = () => toggleExpanded(String(button.dataset.toggleGreeting));
    });
    document.querySelectorAll("[data-toggle-dormant]").forEach((node) => {
      node.onclick = () => {
        const index = Number(node.dataset.toggleDormant);
        toggleSet(state.selectedDormant, index, !state.selectedDormant.has(index));
        refreshPanel();
      };
    });
    const filter = $("#dormant-filter");
    if (filter) {
      filter.onchange = () => {
        state.dormantFilter = filter.value;
        refreshPanel();
      };
    }
  }

  async function handleAction(action, source) {
    try {
      if (action === "close") await R.hideContainer();
      if (action === "mobile-back") {
        state.mobileOpen = false;
        refreshPanel();
      }
      if (action === "scan-storage") await scanStorage();
      if (action === "delete-storage") await deleteSelectedStorage(false);
      if (action === "delete-all-storage") await deleteSelectedStorage(true);
      if (action === "scan-current-greetings") await scanGreetings("current");
      if (action === "scan-all-greetings") await scanGreetings("all");
      if (action === "select-all-greetings") setAllGreetings(true);
      if (action === "clear-all-greetings") setAllGreetings(false);
      if (action === "apply-greetings") await applyGreetingCleanup();
      if (action === "scan-dormant") await scanDormant();
      if (action === "measure-dormant") await measureDormantSize(Number(source.dataset.index));
      if (action === "trash-dormant") await trashDormant();
    } catch (error) {
      state.busy = false;
      console.error(error);
      clearBusy(`오류: ${error?.message || error}`);
    }
  }

  function setSort(scope, key) {
    const sort = scope === "storage" ? state.storageSort : state.dormantSort;
    if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc";
    else {
      sort.key = key;
      sort.dir = key === "size" ? "desc" : "asc";
    }
    refreshPanel();
  }

  function toggleSet(set, key, checked) {
    if (checked) set.add(key);
    else set.delete(key);
  }

  function toggleExpanded(key) {
    if (state.expandedGreeting.has(key)) state.expandedGreeting.delete(key);
    else state.expandedGreeting.add(key);
    refreshPanel();
  }

  function toggleGreetingGroup(charIndex, checked) {
    const group = state.greetingGroups.find((item) => item.charIndex === charIndex);
    if (!group) return;
    group.items.forEach((item) => toggleSet(state.selectedGreeting, item.id, checked));
    refreshPanel();
  }

  function setGreetingGroupSelection(charIndex, checked) {
    const group = state.greetingGroups.find((item) => item.charIndex === charIndex);
    if (!group) return;
    group.items.forEach((item) => toggleSet(state.selectedGreeting, item.id, checked));
    refreshPanel();
  }

  function setAllGreetings(checked) {
    state.greetingGroups.forEach((group) => {
      group.items.forEach((item) => toggleSet(state.selectedGreeting, item.id, checked));
    });
    refreshPanel();
  }

  async function scanStorage() {
    const db = await getDb(["pluginCustomStorage", "plugins"]);
    if (!db) return;
    const storage = db.pluginCustomStorage || {};
    state.storageRows = Object.keys(storage).map((key) => ({
      key,
      owner: guessStorageOwner(key, db.plugins || []),
      size: estimateSize(storage[key]),
    }));
    state.selectedStorage = new Set();
    clearBusy(`스토리지 ${state.storageRows.length}개를 찾았습니다.`);
  }

  async function deleteSelectedStorage(deleteAll) {
    const keys = deleteAll ? state.storageRows.map((row) => row.key) : Array.from(state.selectedStorage);
    if (keys.length === 0) {
      setStatus("삭제할 저장소 키가 없습니다.");
      return;
    }
    const message = deleteAll
      ? `정말 전체 저장소 항목 ${keys.length}개를 삭제할까요?\n\n이 작업은 플러그인 데이터 손실을 일으킬 수 있습니다. 적용 전 스냅샷은 저장됩니다.`
      : `${keys.length}개 저장소 항목을 삭제할까요? 적용 전 스냅샷을 저장합니다.`;
    if (!confirm(message)) return;
    if (deleteAll && !confirm("마지막 확인입니다. 전체 저장소 항목을 삭제합니다.")) return;

    const db = await getDb(["pluginCustomStorage"]);
    if (!db) return;
    const before = {};
    for (const key of keys) before[key] = db.pluginCustomStorage?.[key];
    await saveSnapshot(deleteAll ? "storage-delete-all" : "storage-delete", before);
    db.pluginCustomStorage ||= {};
    keys.forEach((key) => delete db.pluginCustomStorage[key]);
    await R.setDatabase(db);
    state.selectedStorage = new Set();
    await scanStorage();
  }

  async function scanGreetings(scope, options = {}) {
    const previousSelected = new Set(state.selectedGreeting);
    state.greetingGroups = [];
    state.selectedGreeting = new Set();
    state.expandedGreeting = new Set();

    if (scope === "current") {
      const index = await R.getCurrentCharacterIndex();
      const char = await R.getCharacter();
      const group = await collectGreetingGroup(char, index);
      if (group) state.greetingGroups.push(group);
    } else {
      const db = await getDb(["characters"]);
      if (!db) return;
      const groups = await Promise.all((db.characters || []).map((char, index) => collectGreetingGroup(char, index)));
      state.greetingGroups = groups.filter(Boolean);
    }

    for (const group of state.greetingGroups) {
      state.expandedGreeting.add(String(group.charIndex));
      group.items.forEach((item) => {
        if (options.preserveSelection) {
          if (previousSelected.has(item.id)) state.selectedGreeting.add(item.id);
        } else {
          state.selectedGreeting.add(item.id);
        }
      });
    }
    clearBusy(`첫 메시지 청소 후보 ${state.greetingGroups.reduce((sum, group) => sum + group.items.length, 0)}개를 찾았습니다.`);
  }

  async function collectGreetingGroup(char, charIndex) {
    if (!char || char.trashTime) return null;
    const items = [];
    collectGreetingItem(items, charIndex, -1, "첫 메시지", char.firstMessage || "");
    (char.alternateGreetings || []).forEach((text, index) => {
      collectGreetingItem(items, charIndex, index, `추가 첫 메시지 ${index + 1}`, text || "");
    });
    if (items.length > 0) {
      return {
        charIndex,
        charName: char.name || `(이름 없음 ${charIndex})`,
        name: char.name || `(이름 없음 ${charIndex})`,
        imageSrc: await getCharacterImageSource(char),
        items,
      };
    }
    return null;
  }

  function collectGreetingItem(items, charIndex, greetingIndex, fieldLabel, text) {
    const matches = Array.from(new Set(String(text).match(SFX_REGEX) || []));
    if (matches.length === 0) return;
    items.push({
      id: `${charIndex}:${greetingIndex}`,
      charIndex,
      greetingIndex,
      fieldLabel,
      matches,
    });
  }

  async function applyGreetingCleanup() {
    const rows = state.greetingGroups.flatMap((group) => group.items).filter((row) => state.selectedGreeting.has(row.id));
    if (rows.length === 0) {
      setStatus("삭제할 첫 메시지 항목을 선택해 주세요.");
      return;
    }
    if (!confirm(`${rows.length}개 첫 메시지 항목에서 §...§ 조각을 삭제할까요?`)) return;

    const db = await getDb(["characters"]);
    if (!db) return;
    const before = rows.map((row) => ({
      charIndex: row.charIndex,
      greetingIndex: row.greetingIndex,
      value: row.greetingIndex === -1
        ? db.characters?.[row.charIndex]?.firstMessage
        : db.characters?.[row.charIndex]?.alternateGreetings?.[row.greetingIndex],
    }));
    await saveSnapshot("greeting-cleanup", before);

    rows.forEach((row) => {
      const char = db.characters?.[row.charIndex];
      if (!char) return;
      if (row.greetingIndex === -1) {
        char.firstMessage = cleanGreetingText(char.firstMessage || "");
      } else if (Array.isArray(char.alternateGreetings)) {
        char.alternateGreetings[row.greetingIndex] = cleanGreetingText(char.alternateGreetings[row.greetingIndex] || "");
      }
    });
    await R.setDatabase(db);
    await scanGreetings("all", { preserveSelection: true });
  }

  function cleanGreetingText(text) {
    return String(text)
      .replace(SFX_REGEX, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async function scanDormant() {
    const db = await getDb(["characters"]);
    if (!db) return;
    const now = Date.now();
    const characters = db.characters || [];
    const rows = [];
    for (let index = 0; index < characters.length; index += 1) {
      setBusyProgress("잠든 봇 목록을 빠르게 스캔하는 중...", index, characters.length);
      rows.push(await analyzeDormantChar(characters[index], index, now));
      if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    setBusyProgress("잠든 봇 목록을 빠르게 스캔하는 중...", characters.length, characters.length);
    state.dormantRows = rows.filter(Boolean);
    state.selectedDormant = new Set();
    clearBusy(`정리 후보 봇 ${state.dormantRows.length}개를 찾았습니다.`);
  }

  async function analyzeDormantChar(char, index, now) {
    if (!char || char.trashTime) return null;
    const chats = Array.isArray(char.chats) ? char.chats : [];
    const userMessages = chats.reduce((sum, chat) => {
      const messages = Array.isArray(chat.message) ? chat.message : [];
      return sum + messages.filter((msg) => msg.role === "user").length;
    }, 0);
    const lastTime = getLastConversationTime(chats);
    let category = null;
    if (userMessages === 0) category = "no_chat";
    else if (!lastTime) category = "unknown";
    else if (now - lastTime >= OLD_1Y) category = "old_1y";
    else if (now - lastTime >= OLD_6M) category = "old_6m";
    else if (now - lastTime >= OLD_3M) category = "old_3m";
    if (!category) return null;
    return {
      index,
      name: char.name || `(이름 없음 ${index})`,
      imageSrc: await getCharacterImageSource(char),
      category,
      lastTime,
      lastInteraction: Number.isFinite(char.lastInteraction) ? char.lastInteraction : 0,
      userMessages,
      ...estimateCharacterQuickSize(char),
    };
  }

  function estimateCharacterQuickSize(char) {
    const assetRefs = collectCharacterAssetRefs(char);
    const inlineBytes = assetRefs.reduce((sum, ref) => sum + estimateInlineAssetSize(ref), 0);
    const pendingAssetCount = assetRefs.filter((ref) => estimateInlineAssetSize(ref) === 0).length;
    return {
      size: estimateSize(char) + inlineBytes,
      sizeMode: "quick",
      assetCount: assetRefs.length,
      pendingAssetCount,
    };
  }

  async function estimateCharacterTotalSize(char, onProgress) {
    const assetRefs = collectCharacterAssetRefs(char);
    const assetBytes = await estimateAssetRefsSize(assetRefs, onProgress);
    return {
      size: estimateSize(char) + assetBytes,
      assetCount: assetRefs.length,
    };
  }

  function collectCharacterAssetRefs(char) {
    const refs = new Set();
    addAssetRef(refs, char?.image);
    if (Array.isArray(char?.ccAssets)) {
      char.ccAssets.forEach((asset) => addAssetRef(refs, asset?.uri || asset?.name || asset?.path));
    }
    if (Array.isArray(char?.additionalAssets)) {
      char.additionalAssets.forEach((asset) => addAssetRef(refs, Array.isArray(asset) ? asset[1] : asset?.uri || asset?.path));
    }
    if (Array.isArray(char?.emotionImages)) {
      char.emotionImages.forEach((asset) => addAssetRef(refs, Array.isArray(asset) ? asset[1] : asset?.uri || asset?.path));
    }
    if (char?.vits?.files && typeof char.vits.files === "object") {
      Object.values(char.vits.files).forEach((value) => addAssetRef(refs, value));
    }
    if (char?.gptSoVitsConfig?.ref_audio_data?.assetId) {
      addAssetRef(refs, char.gptSoVitsConfig.ref_audio_data.assetId);
    }
    return Array.from(refs);
  }

  function addAssetRef(refs, value) {
    const ref = String(value || "").trim();
    if (!ref) return;
    if (/^https?:|^blob:|^tauri:/i.test(ref)) return;
    refs.add(ref);
  }

  async function estimateAssetRefsSize(refs, onProgress) {
    let total = 0;
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      if (onProgress) onProgress(index, refs.length, ref);
      const bytes = await readAssetSize(ref);
      total += bytes;
      if (index % 12 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return total;
  }

  async function readAssetSize(ref) {
    if (assetSizeCache.has(ref)) return assetSizeCache.get(ref);
    const inlineSize = estimateInlineAssetSize(ref);
    if (inlineSize > 0) {
      assetSizeCache.set(ref, inlineSize);
      return inlineSize;
    }
    const normalizedRef = ref.startsWith("__asset:") ? ref.slice("__asset:".length) : ref;
    const attempts = Array.from(new Set([
      normalizedRef,
      normalizedRef.replace(/^assets[\\/]/, ""),
      normalizedRef.split(/[\\/]/).pop(),
    ].filter(Boolean)));

    for (const path of attempts) {
      try {
        const data = await R.readImage(path);
        const size = getBinaryLikeSize(data);
        if (size > 0) {
          assetSizeCache.set(ref, size);
          return size;
        }
      } catch {
        // Some assets may be missing, remote-only, or not readable through readImage.
      }
    }
    assetSizeCache.set(ref, 0);
    return 0;
  }

  function estimateInlineAssetSize(ref) {
    const text = String(ref || "");
    if (!text) return 0;
    const comma = text.indexOf(",");
    if (text.startsWith("data:") && comma >= 0) {
      return Math.floor((text.length - comma - 1) * 3 / 4);
    }
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 256) {
      return Math.floor(text.replace(/\s/g, "").length * 3 / 4);
    }
    return 0;
  }

  async function measureDormantSize(index) {
    const row = state.dormantRows.find((item) => item.index === index);
    if (!row) return;
    const db = await getDb(["characters"]);
    if (!db) return;
    const char = db.characters?.[index];
    if (!char) {
      setStatus("봇 데이터를 찾지 못했습니다. 다시 스캔해 주세요.");
      return;
    }
    await showPermissionOverlay(`${row.name} 정밀 용량을 계산하는 중...`, 0);
    const result = await estimateCharacterTotalSize(char, (current, total) => {
      setBusyProgress(`${row.name} 에셋 용량을 계산하는 중...`, current, total);
    });
    row.size = result.size;
    row.sizeMode = "exact";
    row.assetCount = result.assetCount;
    row.pendingAssetCount = 0;
    setBusyProgress(`${row.name} 에셋 용량을 계산하는 중...`, result.assetCount, result.assetCount);
    clearBusy(`${row.name} 정밀 용량 계산 완료: ${formatBytes(row.size)}`);
  }

  function getBinaryLikeSize(data) {
    if (!data) return 0;
    if (typeof data === "string") {
      const comma = data.indexOf(",");
      if (data.startsWith("data:") && comma >= 0) {
        return Math.floor((data.length - comma - 1) * 3 / 4);
      }
      return new TextEncoder().encode(data).length;
    }
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (Array.isArray(data)) return data.length;
    if (data?.data && Array.isArray(data.data)) return data.data.length;
    if (Number.isFinite(data?.byteLength)) return data.byteLength;
    if (Number.isFinite(data?.size)) return data.size;
    return 0;
  }

  async function getCharacterImageSource(char) {
    const candidates = [
      char.image,
      Array.isArray(char.ccAssets) ? char.ccAssets.find((asset) => asset?.type === "icon")?.uri : "",
      Array.isArray(char.ccAssets) ? char.ccAssets[0]?.uri : "",
    ].filter(Boolean);
    const src = candidates[0] || "";
    if (!src) return "";
    if (/^(data:|https?:|blob:|\/)/i.test(src)) return src;
    if (imageCache.has(src)) return imageCache.get(src);

    const attempts = Array.from(new Set([
      src,
      src.replace(/^assets[\\/]/, ""),
      src.split(/[\\/]/).pop(),
    ].filter(Boolean)));

    for (const path of attempts) {
      try {
        const data = await R.readImage(path);
        const url = await imageDataToUrl(data, path);
        if (url) {
          imageCache.set(src, url);
          return url;
        }
      } catch {
        // Try the next likely asset name.
      }
    }
    imageCache.set(src, "");
    return "";
  }

  async function imageDataToUrl(data, path) {
    if (!data) return "";
    if (typeof data === "string") {
      if (/^(data:|https?:|blob:)/i.test(data)) return data;
      return "";
    }
    let bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else if (Array.isArray(data)) bytes = new Uint8Array(data);
    else if (data?.data && Array.isArray(data.data)) bytes = new Uint8Array(data.data);
    if (!bytes) return "";

    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const mime = guessImageMime(path, bytes);
    return `data:${mime};base64,${btoa(binary)}`;
  }

  function guessImageMime(path, bytes) {
    const lower = String(path || "").toLowerCase();
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (bytes?.[0] === 0x89 && bytes?.[1] === 0x50) return "image/png";
    if (bytes?.[0] === 0xff && bytes?.[1] === 0xd8) return "image/jpeg";
    return "image/png";
  }

  function getLastConversationTime(chats) {
    const messageTimes = [];
    const chatDates = [];
    for (const chat of chats) {
      if (Number.isFinite(chat.lastDate)) chatDates.push(chat.lastDate);
      const messages = Array.isArray(chat.message) ? chat.message : [];
      for (const msg of messages) {
        if ((msg.role === "user" || msg.role === "char") && Number.isFinite(msg.time)) {
          messageTimes.push(msg.time);
        }
      }
    }
    if (messageTimes.length) return Math.max(...messageTimes);
    return chatDates.length ? Math.max(...chatDates) : 0;
  }

  async function trashDormant() {
    const indexes = Array.from(state.selectedDormant);
    if (indexes.length === 0) {
      setStatus("휴지통으로 보낼 봇을 선택해 주세요.");
      return;
    }
    if (!confirm(`${indexes.length}개 봇을 휴지통으로 보낼까요? 영구 삭제는 하지 않습니다.`)) return;
    const db = await getDb(["characters"]);
    if (!db) return;
    const before = indexes.map((index) => ({ index, char: db.characters?.[index] })).filter((item) => item.char);
    await saveSnapshot("dormant-trash", before);
    const now = Date.now();
    indexes.forEach((index) => {
      if (db.characters?.[index]) db.characters[index].trashTime = now;
    });
    await R.setDatabase(db);
    await R.checkCharOrder();
    await scanDormant();
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = `
      :root {
        color-scheme: dark;
        font-family: Pretendard, Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #101216;
        color: #f5f2ea;
      }
      * { box-sizing: border-box; }
      body { margin: 0; background: #101216; }
      .rm-shell {
        position: relative;
        min-height: 100vh;
        display: grid;
        grid-template-columns: 340px minmax(0, 1fr);
        background: #101216;
      }
      .rm-sidebar {
        border-right: 1px solid #2d3440;
        background: #171a21;
        padding: 12px;
        overflow: auto;
      }
      .brand {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      h1, h2, p { margin: 0; letter-spacing: 0; }
      h1 { font-size: 20px; line-height: 1.25; }
      h2 { font-size: 26px; line-height: 1.28; margin-top: 4px; }
      .brand p, .feature-head p, .hint, footer { color: #aaa79f; }
      .icon-close {
        flex: 0 0 36px;
        width: 36px;
        height: 36px;
        padding: 0;
        border-radius: 8px;
        font-size: 24px;
        line-height: 1;
        white-space: nowrap;
      }
      .feature-list { display: grid; gap: 10px; }
      .feature-card {
        width: 100%;
        min-height: 66px;
        text-align: left;
        display: grid;
        gap: 3px;
        align-content: center;
        border: 1px solid #303744;
        background: #202631;
        border-radius: 8px;
        padding: 10px 12px;
      }
      .feature-card strong {
        font-size: 14px;
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .feature-card span {
        color: #aba69c;
        font-size: 12px;
        line-height: 1.35;
        white-space: normal;
        overflow-wrap: anywhere;
      }
      .feature-card.active {
        border-color: #a675ff;
        background: rgba(82, 58, 116, .34);
        box-shadow: 0 0 0 1px #a675ff inset, 0 0 0 3px rgba(166, 117, 255, .14);
      }
      .rm-main { min-width: 0; display: flex; flex-direction: column; }
      .feature-head {
        padding: 28px 32px 18px;
        border-bottom: 1px solid #2d3440;
        background: #13161c;
      }
      .mobile-back { display: none; }
      .eyebrow { color: #c4a6ff; font-weight: 700; margin-bottom: 4px; }
      .panel { flex: 1; padding: 22px 32px; overflow: auto; }
      button, select {
        border: 1px solid #3b4350;
        background: #232a36;
        color: #f5f2ea;
        border-radius: 8px;
        padding: 9px 12px;
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
      }
      button:hover, select:hover { background: #2b3342; }
      button.primary { border-color: #a675ff; background: rgba(82, 58, 116, .48); }
      button.danger { border-color: #bd6b6b; background: #572c2c; }
      button.outline { background: transparent; }
      .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
      .toolbar span { color: #d5cec1; }
      .hint { margin-bottom: 16px; font-size: 14px; line-height: 1.5; }
      .tool-list {
        display: grid;
        gap: 10px;
        margin-bottom: 14px;
      }
      .tool-empty {
        display: grid;
        gap: 12px;
        align-items: start;
        border: 1px solid #303744;
        background: #171b23;
        border-radius: 8px;
        padding: 14px;
      }
      .tool-empty span {
        display: grid;
        gap: 4px;
        min-width: 0;
      }
      .tool-empty strong {
        font-size: 15px;
        line-height: 1.35;
      }
      .tool-empty small {
        color: #aaa79f;
        font-size: 13px;
        line-height: 1.45;
      }
      .desktop-table { overflow: auto; border: 1px solid #303744; border-radius: 8px; background: #171b23; }
      table { width: 100%; border-collapse: collapse; min-width: 920px; }
      th, td { padding: 11px 12px; border-bottom: 1px solid #2b313b; text-align: left; vertical-align: middle; }
      th { background: #202631; }
      .selectable-row {
        cursor: pointer;
        box-shadow: inset 0 0 0 0 transparent;
        transition: background .14s ease, box-shadow .14s ease;
      }
      .selectable-row:hover { background: rgba(154, 111, 216, .08); }
      .selectable-row.selected {
        background: rgba(154, 111, 216, .12);
        box-shadow: inset 4px 0 0 #a675ff, inset -4px 0 0 #a675ff;
      }
      .select-mark {
        width: 72px;
        color: #b98cff;
        font-size: 12px;
        font-weight: 700;
      }
      .size-cell {
        display: grid;
        gap: 4px;
        min-width: 150px;
      }
      .size-cell strong {
        font-size: 14px;
      }
      .size-cell span {
        color: #aaa79f;
        font-size: 12px;
        line-height: 1.35;
      }
      .size-cell button {
        width: max-content;
        padding: 6px 9px;
        font-size: 12px;
      }
      code { color: #d7c2ff; word-break: break-all; }
      .sort-head {
        padding: 0;
        border: 0;
        background: transparent;
        color: #f5f2ea;
        font-weight: 700;
      }
      .mobile-list { display: none; }
      .mobile-card, .fold-card, .empty-card {
        border: 1px solid #303744;
        background: #171b23;
        border-radius: 8px;
        padding: 14px;
      }
      .selectable-card {
        cursor: pointer;
        transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
      }
      .selectable-card:hover {
        border-color: rgba(166, 117, 255, .65);
        background: #1a1f29;
      }
      .selectable-card.selected {
        border-color: #a675ff;
        box-shadow: 0 0 0 1px #a675ff inset, 0 0 0 3px rgba(166, 117, 255, .18);
        background: rgba(82, 58, 116, .28);
      }
      .mobile-card + .mobile-card, .fold-card + .fold-card { margin-top: 10px; }
      .bot-cell, .mobile-bot-head {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .mobile-bot-head {
        margin-bottom: 12px;
      }
      .mobile-bot-head strong {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .bot-image {
        width: 40px;
        height: 40px;
        flex: 0 0 40px;
        border-radius: 8px;
        object-fit: cover;
        background: #252c37;
        border: 1px solid #3a4350;
      }
      .bot-image.placeholder {
        display: grid;
        place-items: center;
        color: #d9d1c4;
        font-weight: 800;
      }
      dl { display: grid; grid-template-columns: 98px minmax(0, 1fr); gap: 8px 12px; margin: 0; }
      dt { color: #a8a39a; }
      dd { margin: 0; min-width: 0; word-break: break-word; }
      dt, dd { display: flex; align-items: center; min-height: 24px; }
      .fold-card {
        padding: 0;
        overflow: hidden;
      }
      .greeting-group.selected {
        border-color: #303744;
        box-shadow: none;
        background: #171b23;
      }
      .fold-card header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: #1b2029;
        border-bottom: 1px solid #2b313b;
      }
      .fold-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        text-align: left;
        background: transparent;
        min-height: 44px;
        min-width: 0;
        border: 0;
        padding: 0;
      }
      .group-actions { display: flex; gap: 6px; }
      .group-actions button { padding: 6px 9px; font-size: 12px; }
      .fold-title .bot-cell {
        color: #f5f2ea;
        font-size: 14px;
        min-width: 0;
      }
      .fold-title span { color: #c4a6ff; font-size: 13px; }
      .fold-title .bot-cell strong {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .fold-body { display: none; }
      .fold-body.open { display: grid; gap: 0; }
      .greeting-item {
        display: grid;
        grid-template-columns: minmax(150px, 220px) minmax(0, 1fr);
        align-items: center;
        gap: 12px;
        border: 0;
        border-top: 1px solid #2b313b;
        border-radius: 0;
        padding: 8px 12px;
        min-height: 42px;
        background: #171b23;
        cursor: pointer;
        transition: background .14s ease, box-shadow .14s ease;
      }
      .greeting-item:hover {
        background: #1d2330;
      }
      .greeting-item.selected {
        background: rgba(82, 58, 116, .22);
        box-shadow: inset 4px 0 0 #a675ff;
      }
      .greeting-item strong {
        font-size: 13px;
        line-height: 1.3;
      }
      .greeting-item span {
        color: #d5cec1;
        line-height: 1.35;
        word-break: break-word;
        font-size: 13px;
      }
      .empty, .empty-card { color: #a8a39a; text-align: center; padding: 32px; }
      footer {
        padding: 13px 32px;
        border-top: 1px solid #2d3440;
        background: #13161c;
      }
      .busy-layer {
        position: fixed;
        inset: auto 20px 20px auto;
        z-index: 900;
        width: min(360px, calc(100vw - 40px));
        border: 1px solid #4a5361;
        background: #202631;
        border-radius: 8px;
        padding: 14px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, .38);
      }
      .busy-layer strong {
        display: block;
        margin-top: 6px;
        color: #c4a6ff;
        font-size: 13px;
        text-align: right;
      }
      .permission-mode { pointer-events: none; }
      .permission-mode .busy-layer { pointer-events: auto; opacity: .92; }
      .loader {
        height: 6px;
        border-radius: 999px;
        overflow: hidden;
        background: #11151b;
        margin-bottom: 10px;
      }
      .loader span {
        display: block;
        height: 100%;
        background: #a675ff;
        transition: width .18s ease;
      }
      .loader.indeterminate span {
        animation: loading 1s infinite ease-in-out;
      }
      @keyframes loading {
        0% { transform: translateX(-110%); }
        100% { transform: translateX(260%); }
      }
      @media (max-width: 820px) {
        .rm-shell { display: block; overflow-x: hidden; }
        .rm-sidebar { border-right: 0; border-bottom: 1px solid #2d3440; padding: 14px; }
        .brand { align-items: center; }
        h1 { font-size: 20px; }
        h2 { font-size: 21px; }
        .feature-list { display: grid; gap: 10px; }
        .feature-card {
          min-height: 74px;
          width: 100%;
        }
        .rm-main {
          position: fixed;
          inset: 0;
          z-index: 20;
          background: #101216;
          transform: translateX(100%);
          transition: transform .22s ease;
        }
        .mobile-feature-open .rm-main { transform: translateX(0); }
        .mobile-back {
          display: inline-flex;
          width: max-content;
          margin-bottom: 12px;
          background: transparent;
        }
        .feature-head { padding: 20px 16px 14px; }
        .panel { padding: 16px; }
        .toolbar { align-items: stretch; }
        .toolbar button, .toolbar select { flex: 1 1 auto; }
        .fold-card header {
          grid-template-columns: 1fr;
        }
        .group-actions {
          justify-content: stretch;
        }
        .group-actions button {
          flex: 1;
        }
        .greeting-item {
          grid-template-columns: 1fr;
          gap: 4px;
        }
        .desktop-table { display: none; }
        .mobile-list { display: block; }
        footer { padding: 12px 16px; }
        .busy-layer { inset: auto 12px 12px 12px; width: auto; }
      }
    `;
    document.head.appendChild(style);
  }

  await R.registerSetting("리스 사이드킥", openPanel, "🛠️", "html", "risu-sidekick-settings");
  await R.registerButton({
    name: "리스 사이드킥",
    icon: "🛠️",
    iconType: "html",
    location: "hamburger",
    id: "risu-sidekick-button",
  }, openPanel);
  console.log(`[Risu Sidekick] Loaded v${PLUGIN_VERSION}`);
})();

