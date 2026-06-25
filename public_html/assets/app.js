/* Issue Kanban — client app.
 * Talks only to /api/*.php (the GitHub token stays server-side).
 */
(function () {
  'use strict';

  // ---- state ----
  const state = {
    me: null,            // { login, avatarUrl }
    board: null,         // { config, fields, items }
    view: 'board',       // 'board' | 'stats'
    filterMine: false,
    activeLabels: new Set(), // label/team names toggled on (OR; empty => show all)
    sprint: 'all',       // iterationId | 'all'
    metaCache: {},       // repo -> { labels, milestones, assignees }
  };

  // ---- tiny DOM helpers ----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ---- API ----
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-json */ }
    if (res.status === 401) {
      location.href = '/'; // session gone -> back to login
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      let msg = (body && body.error) ? body.error : ('HTTP ' + res.status);
      // Surface the underlying detail (e.g. GitHub GraphQL errors) so the real
      // cause is visible instead of a generic "GitHub GraphQL error".
      const d = body && body.detail;
      if (d) {
        const extra = Array.isArray(d)
          ? d.map((x) => (x && x.message) ? x.message : JSON.stringify(x)).join('; ')
          : (typeof d === 'string' ? d : (d.message || JSON.stringify(d)));
        if (extra && extra !== msg) msg += ': ' + extra;
      }
      throw new Error(msg);
    }
    return body;
  }
  const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data) });

  // ---- config / field helpers ----
  function cfg() { return state.board.config; }
  function fieldMeta(name) { return state.board.fields[name] || null; }
  function statusOptions() {
    const f = fieldMeta(cfg().statusField);
    return (f && f.options) ? f.options : [];
  }
  // Sprints are tracked internally (state.board.sprints) and membership is a label.
  function sprintList() { return state.board.sprints || []; }
  function sprintByName(name) { return sprintList().find((s) => s.name === name) || null; }
  // Defined sprints (with dates) merged with any sprint names discovered on issue
  // labels — so sprints still appear even if the definitions file isn't present.
  function allSprints() {
    const byName = new Map();
    sprintList().forEach((s) => byName.set(s.name, Object.assign({}, s)));
    state.board.items.forEach((it) => {
      const n = itemSprint(it);
      if (n && !byName.has(n)) byName.set(n, { name: n });
    });
    return Array.from(byName.values());
  }
  function itemStatusName(it) { return (it.fields[cfg().statusField] || {}).name || null; }
  function itemPoints(it) { const f = cfg().pointsField; if (!f) return null; const v = it.fields[f]; return v ? v.number : null; }
  // start/due are computed server-side from issue fields OR project date fields
  function itemStart(it) { return it.start || null; }
  function itemDue(it) { return it.due || null; }
  function fmtDue(iso) { try { return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return iso; } }
  function fmtDateTime(iso) { try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return iso; } }
  // GitHub IssueFieldSingleSelectOptionColor enum -> hex
  const ISSUE_COLORS = { GRAY: '6e7681', BLUE: '1f6feb', GREEN: '238636', YELLOW: '9e6a03', ORANGE: 'bc4c00', RED: 'cf222e', PINK: 'bf3989', PURPLE: '8250df' };
  function issueColor(name) { if (!name) return null; const h = ISSUE_COLORS[String(name).toUpperCase()]; return h ? '#' + h : null; }
  function itemSprint(it) { return it.sprint || null; } // sprint name (from label) or null
  function isDone(it) { return (itemStatusName(it) || '').toLowerCase() === (cfg().statusDone || '').toLowerCase(); }
  // stable "owner/repo#number" key for matching parent/child relationships
  function itemKey(it) { return (it.repo || '') + '#' + (it.number != null ? it.number : ''); }
  function parentKey(it) { return it.parent && it.parent.number != null ? (it.parent.repo || it.repo) + '#' + it.parent.number : null; }

  // team-label helpers (a label is a "team" if it starts with the configured prefix)
  function teamPrefix() { return cfg().teamPrefix || ''; }
  function isTeamLabel(name) { const p = teamPrefix(); return !!p && name.indexOf(p) === 0; }
  function teamDisplay(name) { const p = teamPrefix(); return isTeamLabel(name) ? name.slice(p.length) : name; }

  // sprint-label helpers (hidden from the normal Labels filter; shown via sprint bar)
  function sprintPrefix() { return cfg().sprintPrefix || 'sprint:'; }
  function isSprintLabel(name) { const p = sprintPrefix(); return !!p && name.indexOf(p) === 0; }

  // ---- avatar (with graceful fallback so empty src never shows a broken icon) ----
  function avatarEl(login, url, opts = {}) {
    const size = opts.size || 20;
    const unassigned = !!opts.unassigned;
    if (url) {
      return el('img', { class: 'avatar', src: url, title: login || '', alt: login || '',
        style: `width:${size}px;height:${size}px` });
    }
    const initials = unassigned ? '∅'
      : ((login || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?');
    return el('span', {
      class: 'avatar avatar-fallback' + (unassigned ? ' avatar-unassigned' : ''),
      title: login || '',
      text: initials,
      style: `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`,
    });
  }

  // ---- filtering ----
  function visibleItems() {
    return state.board.items.filter((it) => {
      if (state.filterMine && state.me) {
        if (!it.assignees.some((a) => a.login === state.me.login)) return false;
      }
      if (state.sprint !== 'all') {
        if (itemSprint(it) !== state.sprint) return false;
      }
      if (state.activeLabels.size > 0) {
        const names = new Set(it.labels.map((l) => l.name));
        let any = false;
        for (const t of state.activeLabels) { if (names.has(t)) { any = true; break; } }
        if (!any) return false;
      }
      return true;
    });
  }

  // ---- sprint bar ----
  function isCurrentSprint(s) {
    if (s.closed || !s.startDate || !s.endDate) return false;
    const today = new Date().toISOString().slice(0, 10);
    return s.startDate <= today && today <= s.endDate;
  }
  function fmtRange(s) {
    if (!s.startDate && !s.endDate) return '';
    const f = (iso) => {
      if (!iso) return '?';
      const d = new Date(iso + 'T00:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };
    return f(s.startDate) + ' – ' + f(s.endDate);
  }
  function currentSprintName() {
    const s = allSprints().find((x) => isCurrentSprint(x));
    return s ? s.name : null;
  }
  function sprintProgress(name) {
    let done = 0, total = 0, doneC = 0, totalC = 0;
    state.board.items.forEach((it) => {
      if (itemSprint(it) !== name) return;
      const pts = itemPoints(it) || 0;
      total += pts; totalC++;
      if (isDone(it)) { done += pts; doneC++; }
    });
    return { done, total, doneC, totalC };
  }

  function renderSprintBar() {
    const bar = $('#sprint-bar');
    bar.innerHTML = '';
    bar.appendChild(el('span', { class: 'bar-label', text: 'Sprints' }));

    const sprints = allSprints().slice()
      .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')); // newest first

    // individual sprints first, then "All sprints" last
    sprints.forEach((s) => {
      bar.appendChild(sprintPill(
        s.name, state.sprint === s.name,
        s.name + (s.closed ? ' ✓' : ''),
        fmtRange(s), sprintProgress(s.name), isCurrentSprint(s)
      ));
    });
    bar.appendChild(sprintPill('all', state.sprint === 'all', 'All sprints', '', null, false));

    bar.appendChild(el('button', {
      class: 'btn btn-new-sprint', text: '+ New / manage sprints',
      title: 'Create, edit, or delete sprints',
      onclick: openSprintManager,
    }));

    if (sprints.length === 0) {
      bar.appendChild(el('span', { class: 'bar-hint',
        text: 'No sprints yet — click "+ New / manage sprints" to create one.' }));
    }
  }

  function sprintPill(value, active, label, range, prog, current) {
    const children = [];
    if (current) children.push(el('span', { class: 'pill-now', text: 'NOW' }));
    children.push(el('span', { class: 'pill-title', text: label }));
    if (range) children.push(el('span', { class: 'pill-range', text: range }));
    if (prog && prog.totalC > 0) {
      const pct = prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
      children.push(el('span', { class: 'pill-prog' }, [
        el('span', { class: 'pill-bar' }, [el('span', { class: 'pill-bar-fill', style: `width:${pct}%` })]),
        el('span', { class: 'pill-prog-txt', text: `${prog.done}/${prog.total} pts` }),
      ]));
    }
    return el('button', {
      class: 'sprint-pill' + (active ? ' active' : '') + (current ? ' current' : ''),
      onclick: () => {
        state.sprint = value;
        renderSprintBar();
        rerender();
      },
    }, children);
  }

  // ---- sprint manager (create / edit / delete) ----
  function openSprintManager() {
    $('#modal').classList.remove('hidden');
    renderSprintManager();
  }
  function renderSprintManager() {
    const body = $('#modal-body');
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'modal-head' }, [
      el('strong', { text: 'Sprints' }),
      el('button', { class: 'btn btn-ghost', text: '✕', onclick: closeModal }),
    ]));

    // existing sprints
    const list = el('div', { class: 'sprint-list' });
    const sprints = sprintList().slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    if (!sprints.length) {
      list.appendChild(el('div', { class: 'bar-hint', text: 'No sprints yet.' }));
    }
    sprints.forEach((s) => {
      const start = el('input', { class: 'inp', type: 'date', value: s.startDate || '' });
      const end = el('input', { class: 'inp', type: 'date', value: s.endDate || '' });
      const closed = el('input', { type: 'checkbox' }); closed.checked = !!s.closed;
      const saveBtn = el('button', { class: 'btn', text: 'Save', onclick: async () => {
        try {
          await sprintsApi({ op: 'update', name: s.name, startDate: start.value || null, endDate: end.value || null, closed: closed.checked });
          flash(saveBtn, '✓');
        } catch (e) { showError(e.message); }
      } });
      const delBtn = el('button', { class: 'btn chip-clear', text: 'Delete', onclick: async () => {
        if (!confirm(`Delete sprint "${s.name}"? Issues keep their sprint label until reassigned.`)) return;
        try {
          await sprintsApi({ op: 'delete', name: s.name });
          if (state.sprint === s.name) state.sprint = 'all';
          renderSprintManager();
        } catch (e) { showError(e.message); }
      } });
      list.appendChild(el('div', { class: 'sprint-row' }, [
        el('div', { class: 'sprint-row-name' }, [
          isCurrentSprint(s) ? el('span', { class: 'pill-now', text: 'NOW' }) : null,
          el('strong', { text: s.name }),
        ]),
        el('label', { class: 'sprint-row-field' }, ['Start', start]),
        el('label', { class: 'sprint-row-field' }, ['End', end]),
        el('label', { class: 'sprint-row-field check-row' }, [closed, 'Closed']),
        el('div', { class: 'sprint-row-actions' }, [saveBtn, delBtn]),
      ]));
    });
    body.appendChild(list);

    // create form
    const name = el('input', { class: 'inp', type: 'text', placeholder: 'e.g. Sprint 4' });
    const cStart = el('input', { class: 'inp', type: 'date' });
    const cEnd = el('input', { class: 'inp', type: 'date' });
    const addBtn = el('button', { class: 'btn btn-primary', text: 'Create sprint', onclick: async () => {
      if (!name.value.trim()) { showError('Sprint name is required'); return; }
      try {
        await sprintsApi({ op: 'create', name: name.value.trim(), startDate: cStart.value || null, endDate: cEnd.value || null });
        name.value = ''; cStart.value = ''; cEnd.value = '';
        renderSprintManager();
      } catch (e) { showError(e.message); }
    } });
    body.appendChild(el('div', { class: 'sprint-create' }, [
      el('div', { class: 'field-label', text: 'New sprint' }),
      el('div', { class: 'sprint-create-row' }, [name, cStart, cEnd, addBtn]),
    ]));
  }
  async function sprintsApi(payload) {
    const res = await post('/api/sprints.php', payload);
    state.board.sprints = res.sprints || [];
    renderSprintBar();
    if (state.view === 'stats') renderStats();
    return res;
  }

  // ---- filter bar: Teams (prefix) vs Labels, visually separated ----
  function renderFilterBar() {
    const bar = $('#filter-bar');
    bar.innerHTML = '';
    const counts = new Map();
    state.board.items.forEach((it) => it.labels.forEach((l) => {
      if (isSprintLabel(l.name)) return; // sprint labels are handled by the sprint bar
      counts.set(l.name, (counts.get(l.name) || 0) + 1);
    }));
    if (counts.size === 0) return;

    const names = Array.from(counts.keys());
    const teams = names.filter(isTeamLabel).sort();
    const labels = names.filter((n) => !isTeamLabel(n)).sort();

    if (teams.length) {
      const sec = el('div', { class: 'filter-section teams-section' });
      sec.appendChild(el('span', { class: 'section-label', text: 'Teams' }));
      teams.forEach((name) => sec.appendChild(filterChip(name, teamDisplay(name), counts.get(name), true)));
      bar.appendChild(sec);
    }
    if (labels.length) {
      const sec = el('div', { class: 'filter-section labels-section' });
      sec.appendChild(el('span', { class: 'section-label', text: 'Labels' }));
      labels.forEach((name) => sec.appendChild(filterChip(name, name, counts.get(name), false)));
      bar.appendChild(sec);
    }
    if (state.activeLabels.size) {
      bar.appendChild(el('button', {
        class: 'chip chip-clear', text: 'Clear filters',
        onclick: () => { state.activeLabels.clear(); renderFilterBar(); rerender(); },
      }));
    }
  }

  function filterChip(name, display, count, isTeam) {
    const on = state.activeLabels.has(name);
    return el('button', {
      class: 'chip' + (isTeam ? ' chip-team' : '') + (on ? ' chip-on' : ''),
      text: `${display} (${count})`,
      onclick: () => {
        if (state.activeLabels.has(name)) state.activeLabels.delete(name);
        else state.activeLabels.add(name);
        renderFilterBar();
        rerender();
      },
    });
  }

  // ---- board ----
  function renderBoard() {
    const root = $('#board-view');
    root.innerHTML = '';
    const opts = statusOptions();
    const items = visibleItems();

    const buckets = new Map();
    opts.forEach((o) => buckets.set(o.name, []));
    const noStatus = [];
    items.forEach((it) => {
      const s = itemStatusName(it);
      if (s && buckets.has(s)) buckets.get(s).push(it);
      else noStatus.push(it);
    });

    const columns = opts.map((o) => ({ name: o.name, optionId: o.id, items: buckets.get(o.name) }));
    if (noStatus.length) columns.push({ name: '(no status)', optionId: null, items: noStatus });

    columns.forEach((col) => root.appendChild(renderColumn(col)));
  }

  function renderColumn(col) {
    const pts = col.items.reduce((s, it) => s + (itemPoints(it) || 0), 0);
    const body = el('div', { class: 'col-body', 'data-option': col.optionId || '' });

    // Nest sub-issues under their parent when both sit in this column; children
    // whose parent is elsewhere render at the top level (with a "↳ #parent" hint).
    const inCol = new Set(col.items.map(itemKey));
    const childrenOf = new Map();
    const roots = [];
    col.items.forEach((it) => {
      const pk = parentKey(it);
      if (pk && pk !== itemKey(it) && inCol.has(pk)) {
        if (!childrenOf.has(pk)) childrenOf.set(pk, []);
        childrenOf.get(pk).push(it);
      } else {
        roots.push(it);
      }
    });
    const placed = new Set();
    const place = (it, depth) => {
      const k = itemKey(it);
      if (placed.has(k)) return; // guard against relationship cycles
      placed.add(k);
      body.appendChild(renderCard(it, depth));
      (childrenOf.get(k) || []).forEach((c) => place(c, depth + 1));
    };
    roots.forEach((it) => place(it, 0));
    col.items.forEach((it) => { if (!placed.has(itemKey(it))) place(it, 0); }); // any left by a cycle

    body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('drag-over'); });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const itemId = e.dataTransfer.getData('text/itemId');
      if (itemId && col.optionId) moveCard(itemId, col.optionId);
    });

    return el('div', { class: 'col' }, [
      el('div', { class: 'col-head' }, [
        el('span', { class: 'col-title', text: col.name }),
        el('span', { class: 'col-count', text: `${col.items.length} · ${pts} pts` }),
      ]),
      body,
    ]);
  }

  function renderCard(it, depth = 0) {
    const card = el('div', { class: 'card' + (depth > 0 ? ' card-child' : ''), draggable: 'true' });
    if (depth > 0) card.style.marginLeft = (depth * 18) + 'px';
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/itemId', it.itemId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openCardModal(it));

    const pts = itemPoints(it);
    const sprint = itemSprint(it);
    const due = itemDue(it);
    const overdue = due && !isDone(it) && due < new Date().toISOString().slice(0, 10);
    const meta = el('div', { class: 'card-meta' }, [
      it.number ? el('span', { class: 'card-num', text: '#' + it.number }) : null,
      (it.parent && it.parent.number != null) ? el('span', { class: 'parent-badge', title: 'Sub-issue of #' + it.parent.number, text: '↳ #' + it.parent.number }) : null,
      it.blockedBy > 0 ? el('span', { class: 'dep-badge dep-blocked', title: 'Blocked by ' + it.blockedBy + ' issue(s)', text: '⛔ blocked' }) : null,
      it.blocking > 0 ? el('span', { class: 'dep-badge dep-blocking', title: 'Blocking ' + it.blocking + ' issue(s)', text: '⚠ blocking' + (it.blocking > 1 ? ' ' + it.blocking : '') }) : null,
      pts != null ? el('span', { class: 'pts-badge', text: pts + ' pts' }) : null,
      sprint ? el('span', { class: 'sprint-badge', text: '⏱ ' + sprint }) : null,
      due ? el('span', { class: 'due-badge' + (overdue ? ' overdue' : ''), text: '📅 ' + fmtDue(due) }) : null,
      it.milestone ? el('span', { class: 'ms-badge', text: '◎ ' + it.milestone.title }) : null,
    ]);

    // single-select issue/project fields (Priority, Effort, Size, …) as mini badges,
    // each labelled with its field name and colour-coded to avoid ambiguity.
    const selBadges = [];
    Object.entries(it.issueFields || {}).forEach(([n, f]) => { if (f.type === 'select' && f.value) selBadges.push({ name: n, value: f.value, color: f.color }); });
    Object.entries(it.fields || {}).forEach(([n, f]) => { if (n !== cfg().statusField && f.type === 'single_select' && f.name) selBadges.push({ name: n, value: f.name }); });
    const fieldChips = selBadges.length ? el('div', { class: 'card-fields' },
      selBadges.map((b) => {
        const node = el('span', { class: 'mini-field', title: b.name + ': ' + b.value }, [
          el('span', { class: 'mini-name', text: b.name }),
          el('span', { class: 'mini-val', text: b.value }),
        ]);
        const hex = issueColor(b.color);
        if (hex) { node.style.borderColor = hex; node.style.background = hex + '22'; }
        return node;
      })) : null;

    // visible labels: hide sprint labels (shown as a badge); team labels first
    const visLabels = it.labels.filter((l) => !isSprintLabel(l.name));
    const sortedLabels = visLabels.slice().sort((a, b) => (isTeamLabel(b.name) ? 1 : 0) - (isTeamLabel(a.name) ? 1 : 0));
    const labels = el('div', { class: 'card-labels' },
      sortedLabels.map((l) => {
        const team = isTeamLabel(l.name);
        return el('span', {
          class: 'label' + (team ? ' label-team' : ''),
          style: `background:#${l.color}${team ? '' : '22'};border-color:#${l.color}`,
          text: team ? ('👥 ' + teamDisplay(l.name)) : l.name,
        });
      })
    );

    const avatars = el('div', { class: 'card-assignees' },
      it.assignees.map((a) => avatarEl(a.login, a.avatarUrl))
    );

    card.appendChild(el('div', { class: 'card-title', text: it.title }));
    card.appendChild(meta);
    if (fieldChips) card.appendChild(fieldChips);
    if (sortedLabels.length) card.appendChild(labels);
    if (it.assignees.length) card.appendChild(avatars);
    return card;
  }

  // ---- writes ----
  async function moveCard(itemId, optionId) {
    const item = state.board.items.find((i) => i.itemId === itemId);
    const statusField = fieldMeta(cfg().statusField);
    if (!item || !statusField) return;
    const opt = statusOptions().find((o) => o.id === optionId);
    const prev = item.fields[cfg().statusField];
    item.fields[cfg().statusField] = { type: 'single_select', name: opt ? opt.name : null, optionId };
    renderBoard();
    renderSprintBar(); // progress bars depend on done state
    try {
      await post('/api/move.php', { itemId, fieldId: statusField.id, optionId });
    } catch (e) {
      item.fields[cfg().statusField] = prev;
      renderBoard(); renderSprintBar();
      showError(e.message);
      return;
    }
    // Keep the issue's open/closed state in sync with the Done column. GitHub's
    // project workflow auto-closes an issue moved to Done but does NOT reopen it
    // when moved back out, so we reconcile both directions here.
    try {
      const done = (cfg().statusDone || '').toLowerCase();
      const intoDone = !!opt && !!done && (opt.name || '').toLowerCase() === done;
      const st = (item.state || '').toUpperCase();
      if (item.repo && item.number) {
        if (intoDone && st !== 'CLOSED') {
          await post('/api/issue.php', { repo: item.repo, number: item.number, state: 'closed' });
          item.state = 'CLOSED';
        } else if (!intoDone && st === 'CLOSED') {
          await post('/api/issue.php', { repo: item.repo, number: item.number, state: 'open' });
          item.state = 'OPEN';
        }
      }
    } catch (e) { showError(e.message); }
  }

  async function setField(item, fieldName, kind, value) {
    const f = fieldMeta(fieldName);
    if (!f) { showError('Unknown field: ' + fieldName); return; }
    await post('/api/field.php', { itemId: item.itemId, fieldId: f.id, kind, value });
  }

  // Write a date to the correct GitHub mutation. A GitHub *Issue* field must use
  // setIssueFieldValue (issue-field-set.php); a Projects v2 field uses
  // updateProjectV2ItemFieldValue (field.php). GitHub rejects the project
  // mutation for issue fields ("Issue field values cannot be updated using the
  // updateProjectV2ItemFieldValue mutation"), so we route by field kind. The
  // board exposes issue-field ids (stable per repo) in state.board.issueFields,
  // which works even when this issue's value is currently empty.
  // Returns 'issue' | 'project' | null (no such field).
  async function writeDate(itemId, issueId, fieldName, v) {
    const iss = (state.board.issueFields || {})[fieldName];
    if (iss && iss.id && issueId) {
      await post('/api/issue-field-set.php', { issueId, fieldId: iss.id, kind: 'date', value: v });
      return 'issue';
    }
    const pf = fieldMeta(fieldName);
    if (pf) { await post('/api/field.php', { itemId, fieldId: pf.id, kind: 'date', value: v }); return 'project'; }
    return null;
  }

  // Edit-modal helper: write a date and keep the in-memory item in sync.
  async function setDateField(item, fieldName, v) {
    const where = await writeDate(item.itemId, item.issueId, fieldName, v);
    if (where === 'issue') {
      const iss = state.board.issueFields[fieldName];
      item.issueFields = item.issueFields || {};
      item.issueFields[fieldName] = { type: 'date', value: v, fieldId: iss.id };
    } else if (where === 'project') {
      item.fields[fieldName] = v == null ? undefined : { type: 'date', date: v };
    }
    recomputeDates(item);
  }

  // ---- card modal (full read/write) ----
  async function openCardModal(it) {
    const modal = $('#modal');
    const body = $('#modal-body');
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="loading">Loading…</div>';

    // Issue-field options now come from the board (state.board.issueFields), so
    // we only need the repo's labels/milestones/assignees here.
    let meta = { labels: [], milestones: [], assignees: [] };
    if (it.repo) { try { meta = await loadMeta(it.repo); } catch (e) { /* limited */ } }
    renderViewModal(it, meta);
  }

  async function loadMeta(repo) {
    if (state.metaCache[repo]) return state.metaCache[repo];
    const m = await api('/api/meta.php?repo=' + encodeURIComponent(repo));
    state.metaCache[repo] = m;
    return m;
  }

  function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }

  // ---- shared field-control builders (used by edit + create modals) ----
  function fieldRow(label, ...controls) {
    return el('div', { class: 'field-row' }, [
      el('div', { class: 'field-label', text: label }),
      el('div', { class: 'field-controls' }, controls.filter(Boolean)),
    ]);
  }
  // A grid cell: label on top, a single full-width control below. Used to pack
  // the small scalar fields (Status, Points, Priority, …) into a 2-column grid.
  function gridField(label, control) {
    return el('div', { class: 'grid-field' }, [
      el('div', { class: 'field-label', text: label }),
      control,
    ]);
  }
  // Real issues currently on the board (for relationship dropdown pickers).
  // Identify issues by having both a number and a repo (draft issues have
  // neither); we deliberately don't gate on the `type` string, which isn't
  // reliable across boards. Excludes the given item and any pull requests.
  function boardIssueOptions(it) {
    return (state.board.items || [])
      .filter((x) => x.number && x.repo && x.type !== 'PullRequest' && !(x.repo === it.repo && x.number === it.number))
      .map((x) => ({ repo: x.repo, number: x.number, title: x.title || '' }))
      .sort((a, b) => (a.repo === b.repo ? a.number - b.number : a.repo.localeCompare(b.repo)));
  }
  function buildStatusSelect(currentOptionId) {
    const sel = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })]);
    statusOptions().forEach((o) => sel.appendChild(el('option', { value: o.id, text: o.name })));
    sel.value = currentOptionId || '';
    return sel;
  }
  function buildSprintSelect(currentName) {
    const sel = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })]);
    allSprints().forEach((s) => sel.appendChild(el('option', { value: s.name, text: s.name + (s.closed ? ' (closed)' : '') })));
    sel.value = currentName || '';
    return sel;
  }
  function buildMilestoneSelect(milestones, current) {
    const sel = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })]);
    milestones.forEach((m) => sel.appendChild(el('option', { value: m.number, text: m.title })));
    if (current) {
      if (!milestones.some((m) => m.number === current.number)) {
        sel.appendChild(el('option', { value: current.number, text: current.title }));
      }
      sel.value = current.number;
    }
    return sel;
  }
  // labels split into Teams + Labels (sprint labels excluded — managed separately)
  function buildLabelSections(source, currentNames) {
    const clean = source.filter((l) => !isSprintLabel(l.name));
    const teams = clean.filter((l) => isTeamLabel(l.name));
    const others = clean.filter((l) => !isTeamLabel(l.name));
    const chip = (l) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = currentNames.has(l.name); cb.dataset.name = l.name;
      const team = isTeamLabel(l.name);
      return el('label', { class: 'check-row' }, [cb, el('span', {
        class: 'label' + (team ? ' label-team' : ''),
        style: `background:#${l.color}${team ? '' : '22'};border-color:#${l.color}`,
        text: team ? ('👥 ' + teamDisplay(l.name)) : l.name,
      })]);
    };
    const wrap = el('div', { class: 'label-sections' });
    if (teams.length) wrap.append(el('div', { class: 'section-label', text: 'Teams' }), el('div', { class: 'check-grid' }, teams.map(chip)));
    if (others.length) wrap.append(el('div', { class: 'section-label', text: 'Labels' }), el('div', { class: 'check-grid' }, others.map(chip)));
    if (!teams.length && !others.length) wrap.append(el('div', { class: 'bar-hint', text: 'No labels in this repo.' }));
    const getChosen = () => $$('input[type=checkbox]', wrap).filter((c) => c.checked).map((c) => c.dataset.name);
    return { wrap, getChosen };
  }
  function buildAssigneeSection(source, currentLogins) {
    const wrap = el('div', { class: 'check-grid' }, source.map((u) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = currentLogins.has(u.login); cb.dataset.login = u.login;
      return el('label', { class: 'check-row' }, [cb, avatarEl(u.login, u.avatarUrl), el('span', { text: u.login })]);
    }));
    if (!source.length) wrap.append(el('div', { class: 'bar-hint', text: 'No assignable users.' }));
    const getChosen = () => $$('input[type=checkbox]', wrap).filter((c) => c.checked).map((c) => c.dataset.login);
    return { wrap, getChosen };
  }

  // ---- linked pull requests section ----
  function buildPrSection(it, readOnly) {
    const list = el('div', { class: 'pr-list' }, [el('span', { class: 'bar-hint', text: 'Loading…' })]);
    const prInput = el('input', { class: 'inp', type: 'number', placeholder: 'PR #', style: 'width:90px' });
    const attachBtn = el('button', { class: 'btn', text: 'Attach (Closes)', onclick: async () => {
      const n = (prInput.value || '').trim();
      if (!n) return;
      attachBtn.disabled = true;
      try {
        await post('/api/pr-link.php', { repo: it.repo, issueNumber: it.number, prNumber: parseInt(n, 10), keyword: 'Closes' });
        prInput.value = '';
        await loadPrs();
        await refresh(); // re-sync the board after linking a PR
      } catch (e) { showError(e.message); }
      finally { attachBtn.disabled = false; }
    } });
    async function loadPrs() {
      list.innerHTML = '';
      try {
        const res = await api(`/api/issue-links.php?repo=${encodeURIComponent(it.repo)}&number=${it.number}`);
        if (!res.prs || !res.prs.length) { list.appendChild(el('span', { class: 'bar-hint', text: 'No linked PRs.' })); return; }
        res.prs.forEach((p) => {
          const st = p.isDraft ? 'draft' : (p.state || '').toLowerCase();
          list.appendChild(el('div', { class: 'pr-row' }, [
            el('a', { class: 'pr-link', href: p.url, target: '_blank', text: `#${p.number} ${p.title || ''}` }),
            el('span', { class: 'pr-state pr-' + st, text: st }),
          ]));
        });
      } catch (e) { list.appendChild(el('span', { class: 'bar-hint', text: 'Could not load linked PRs.' })); }
    }
    loadPrs();
    return el('div', { class: 'pr-section' }, [
      el('div', { class: 'field-label', text: 'Pull requests' }),
      list,
      readOnly ? null : el('div', { class: 'field-controls' }, [prInput, attachBtn]),
    ].filter(Boolean));
  }

  // recompute item.start/item.due locally after a date edit (mirrors board.php)
  function pickDate(map, wanted, hints) {
    if (wanted) { for (const n in map) { if (n.toLowerCase() === String(wanted).toLowerCase()) return map[n]; } }
    for (const n in map) { const low = n.toLowerCase(); for (const h of hints) { if (low.indexOf(h.toLowerCase()) !== -1) return map[n]; } }
    return null;
  }
  function recomputeDates(it) {
    const map = {};
    Object.entries(it.issueFields || {}).forEach(([n, f]) => { if (f.type === 'date' && f.value) map[n] = f.value; });
    Object.entries(it.fields || {}).forEach(([n, f]) => { if (f.type === 'date' && f.date) map[n] = f.date; });
    it.start = pickDate(map, cfg().startName, ['start']);
    it.due = pickDate(map, cfg().dueName, ['due', 'target', 'end', 'deadline']);
  }

  // A saver knows whether its control differs from the saved value (dirty) and
  // how to persist it (apply). apply() self-guards on dirty so the Save loop can
  // call it unconditionally, and dirty() drives showing/hiding the Save button.
  function mkSaver(dirty, apply) {
    return { dirty, apply: async () => { if (dirty()) await apply(); } };
  }

  // Editable GitHub Issue fields + any extra Projects v2 fields. Returns an
  // array of { label, control } entries (the modal lays them out in a grid) and
  // registers a saver per control. Issue fields are read from the board-wide
  // definitions (state.board.issueFields) so fields like Priority/Effort/Size
  // are editable even when this issue hasn't set them yet. Dirty checks read the
  // live item state so the Save button clears correctly after a save.
  function buildEditableFields(it, savers) {
    const entries = [];
    it.issueFields = it.issueFields || {};
    const dateSkip = new Set([cfg().startField, cfg().dueField].filter(Boolean)); // dedicated Start/Due rows handle these

    if (it.issueId) {
      Object.entries(state.board.issueFields || {}).forEach(([name, def]) => {
        const cur = () => it.issueFields[name] || {};
        if (def.type === 'select') {
          const opts = def.options || [];
          const sel = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })].concat(opts.map((o) => el('option', { value: o.id, text: o.name }))));
          sel.value = cur().optionId || '';
          entries.push({ label: name, control: sel });
          savers.push(mkSaver(
            () => sel.value !== (cur().optionId || ''),
            async () => {
              const v = sel.value || null;
              await post('/api/issue-field-set.php', { issueId: it.issueId, fieldId: def.id, kind: 'select', value: v });
              const chosen = opts.find((o) => o.id === v);
              it.issueFields[name] = { type: 'select', value: chosen ? chosen.name : null, optionId: v, color: chosen ? chosen.color : null, fieldId: def.id, options: opts };
            }
          ));
        } else if (def.type === 'number') {
          const inp = el('input', { class: 'inp', type: 'number', step: 'any', value: cur().value ?? '' });
          entries.push({ label: name, control: inp });
          savers.push(mkSaver(
            () => (inp.value === '' ? null : parseFloat(inp.value)) !== (cur().value ?? null),
            async () => { const nv = inp.value === '' ? null : parseFloat(inp.value); await post('/api/issue-field-set.php', { issueId: it.issueId, fieldId: def.id, kind: 'number', value: inp.value === '' ? null : inp.value }); it.issueFields[name] = { type: 'number', value: nv, fieldId: def.id }; }
          ));
        } else if (def.type === 'text') {
          const inp = el('input', { class: 'inp', type: 'text', value: cur().value || '' });
          entries.push({ label: name, control: inp });
          savers.push(mkSaver(
            () => (inp.value || '') !== (cur().value || ''),
            async () => { const v = inp.value || null; await post('/api/issue-field-set.php', { issueId: it.issueId, fieldId: def.id, kind: 'text', value: v }); it.issueFields[name] = { type: 'text', value: v, fieldId: def.id }; }
          ));
        } else if (def.type === 'date' && !dateSkip.has(name)) {
          const inp = el('input', { class: 'inp', type: 'date', value: cur().value || '' });
          entries.push({ label: name, control: inp });
          savers.push(mkSaver(
            () => (inp.value || '') !== (cur().value || ''),
            async () => { const v = inp.value || null; await post('/api/issue-field-set.php', { issueId: it.issueId, fieldId: def.id, kind: 'date', value: v }); it.issueFields[name] = { type: 'date', value: v, fieldId: def.id }; recomputeDates(it); }
          ));
        }
      });
    }

    // extra Projects v2 fields (Size, etc.). Iterate the board's field
    // DEFINITIONS — not just this item's values — so empty custom fields are
    // still editable. Skip built-in/handled fields and any name already shown as
    // a GitHub Issue field above (avoids a duplicate editor).
    const skip = new Set([cfg().statusField, cfg().pointsField, cfg().startField, cfg().dueField].filter(Boolean));
    Object.entries(state.board.fields || {}).forEach(([name, meta]) => {
      if (skip.has(name)) return;
      if ((state.board.issueFields || {})[name]) return; // handled as an issue field
      const cur = () => it.fields[name] || {};
      const dt = String(meta.dataType || '').toUpperCase();
      if (dt === 'SINGLE_SELECT') {
        const opts = meta.options || [];
        const sel = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })].concat(opts.map((o) => el('option', { value: o.id, text: o.name }))));
        sel.value = cur().optionId || '';
        entries.push({ label: name, control: sel });
        savers.push(mkSaver(
          () => sel.value !== (cur().optionId || ''),
          async () => {
            const v = sel.value || null; await setField(it, name, 'singleSelect', v);
            const chosen = opts.find((o) => o.id === v); it.fields[name] = v ? { type: 'single_select', name: chosen ? chosen.name : null, optionId: v } : undefined;
          }
        ));
      } else if (dt === 'NUMBER') {
        const inp = el('input', { class: 'inp', type: 'number', step: 'any', value: cur().number ?? '' });
        entries.push({ label: name, control: inp });
        savers.push(mkSaver(
          () => (inp.value === '' ? null : parseFloat(inp.value)) !== (cur().number ?? null),
          async () => { const nv = inp.value === '' ? null : parseFloat(inp.value); await setField(it, name, 'number', inp.value === '' ? null : inp.value); it.fields[name] = nv === null ? undefined : { type: 'number', number: nv }; }
        ));
      } else if (dt === 'TEXT') {
        const inp = el('input', { class: 'inp', type: 'text', value: cur().text || '' });
        entries.push({ label: name, control: inp });
        savers.push(mkSaver(
          () => (inp.value || '') !== (cur().text || ''),
          async () => { const v = inp.value || null; await setField(it, name, 'text', v); it.fields[name] = v ? { type: 'text', text: v } : undefined; }
        ));
      } else if (dt === 'DATE') {
        const inp = el('input', { class: 'inp', type: 'date', value: cur().date || '' });
        entries.push({ label: name, control: inp });
        savers.push(mkSaver(
          () => (inp.value || '') !== (cur().date || ''),
          async () => { const v = inp.value || null; await setField(it, name, 'date', v); it.fields[name] = v ? { type: 'date', date: v } : undefined; recomputeDates(it); }
        ));
      }
      // ITERATION / TITLE / ASSIGNEES / LABELS / MILESTONE / etc. aren't edited here
    });

    return entries;
  }

  // parse an issue reference: "123", "#123", "owner/name#123", or an issue URL.
  function parseIssueRef(s, defaultRepo) {
    s = (s || '').trim();
    let m = s.match(/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i);
    if (m) return { repo: m[1], number: parseInt(m[2], 10) };
    m = s.match(/^([^/\s]+\/[^/\s]+)#(\d+)$/);
    if (m) return { repo: m[1], number: parseInt(m[2], 10) };
    m = s.match(/^#?(\d+)$/);
    if (m) return { repo: defaultRepo, number: parseInt(m[1], 10) };
    return null;
  }

  // ---- relationships section (native GitHub sub-issues + dependencies) ----
  function buildRelationsSection(it, readOnly) {
    const TYPES = [
      { type: 'parent',    label: 'Parent of',  add: 'Set',  placeholder: 'parent #' },
      { type: 'child',     label: 'Child of',   add: 'Add',  placeholder: 'sub-issue #' },
      { type: 'blockedBy', label: 'Blocked by', add: 'Add',  placeholder: 'issue #' },
      { type: 'blocking',  label: 'Blocking',   add: 'Add',  placeholder: 'issue #' },
    ];
    const wrap = el('div', { class: 'rel-body' }, [el('span', { class: 'bar-hint', text: 'Loading…' })]);

    async function setRel(type, ref, op) {
      await post('/api/relation-set.php', {
        repo: it.repo, number: it.number, targetRepo: ref.repo, targetNumber: ref.number, type, op,
      });
      await refresh(); // a relationship change is an edit too; re-sync the board
    }

    function chip(r, type) {
      const x = readOnly ? null : el('button', { class: 'rel-x', text: '✕', title: 'Remove', onclick: async () => {
        x.disabled = true;
        try { await setRel(type, r, 'remove'); await load(); }
        catch (e) { x.disabled = false; showError(e.message); }
      } });
      const ref = (r.repo && r.repo !== it.repo ? r.repo : '') + '#' + r.number;
      return el('span', { class: 'rel-chip' + (r.state === 'closed' ? ' rel-closed' : '') }, [
        el('a', { class: 'rel-link', href: r.url, target: '_blank', text: (ref + ' ' + (r.title || '')).trim() }),
        x,
      ].filter(Boolean));
    }

    function group(t, items) {
      const has = items && items.length;
      if (readOnly && !has) return null; // hide empty groups in the read-only view
      const list = el('div', { class: 'rel-list' });
      if (has) items.forEach((r) => list.appendChild(chip(r, t.type)));
      else list.appendChild(el('span', { class: 'bar-hint', text: '—' }));

      const controls = readOnly ? null : (() => {
        const opts = boardIssueOptions(it);
        if (!opts.length) return el('span', { class: 'bar-hint', text: 'No other board issues to link.' });
        const sel = el('select', { class: 'inp rel-input' }, [el('option', { value: '', text: '— pick an issue —' })]
          .concat(opts.map((o) => el('option', { value: o.repo + '#' + o.number, text: '#' + o.number + ' ' + o.title }))));
        const addBtn = el('button', { class: 'btn', text: t.add, onclick: async () => {
          const ref = parseIssueRef(sel.value, it.repo);
          if (!ref) { showError('Pick an issue first'); return; }
          addBtn.disabled = true;
          try { await setRel(t.type, ref, 'add'); sel.value = ''; await load(); }
          catch (e) { showError(e.message); }
          finally { addBtn.disabled = false; }
        } });
        return el('div', { class: 'field-controls' }, [sel, addBtn]);
      })();

      return el('div', { class: 'rel-group' }, [
        el('div', { class: 'rel-grouplabel', text: t.label }),
        list,
        controls,
      ].filter(Boolean));
    }

    async function load() {
      wrap.innerHTML = '';
      let data;
      try { data = await api('/api/relations.php?repo=' + encodeURIComponent(it.repo) + '&number=' + it.number); }
      catch (e) { wrap.appendChild(el('span', { class: 'bar-hint', text: 'Could not load relationships.' })); return; }
      const map = {
        parent: data.parent ? [data.parent] : [],
        child: data.children || [],
        blockedBy: data.blockedBy || [],
        blocking: data.blocking || [],
      };
      let shown = 0;
      TYPES.forEach((t) => { const g = group(t, map[t.type]); if (g) { wrap.appendChild(g); shown++; } });
      if (readOnly && !shown) wrap.appendChild(el('span', { class: 'bar-hint', text: 'No relationships.' }));
      if (data.warnings && data.warnings.length && !readOnly) {
        wrap.appendChild(el('div', { class: 'bar-hint', text: 'Unavailable on this repo: ' + data.warnings.join(', ') }));
      }
    }
    load();

    return el('div', { class: 'rel-section' }, [el('div', { class: 'field-label', text: 'Relationships' }), wrap]);
  }

  function modalHeader(titleNode, actions) {
    const right = [].concat(actions || []).filter(Boolean);
    right.push(el('button', { class: 'btn btn-ghost', text: '✕', onclick: closeModal }));
    return el('div', { class: 'modal-head' }, [titleNode, el('div', { class: 'modal-head-actions' }, right)]);
  }

  // ---- view modal (read-only, opened by clicking a card) ----
  function viewChip(label, value) {
    return el('span', { class: 'view-chip' }, [
      el('span', { class: 'view-chip-k', text: label }),
      el('span', { class: 'view-chip-v', text: value }),
    ]);
  }
  function labelPill(l) {
    const team = isTeamLabel(l.name);
    return el('span', {
      class: 'label' + (team ? ' label-team' : ''),
      style: `background:#${l.color}${team ? '' : '22'};border-color:#${l.color}`,
      text: team ? ('👥 ' + teamDisplay(l.name)) : l.name,
    });
  }

  // Read + add issue comments.
  function buildCommentsSection(it) {
    const list = el('div', { class: 'cmt-list' }, [el('span', { class: 'bar-hint', text: 'Loading…' })]);
    const input = el('textarea', { class: 'modal-body-input cmt-input', rows: '3', placeholder: 'Leave a comment…' });
    const addBtn = el('button', { class: 'btn btn-primary', text: 'Comment', onclick: async () => {
      const txt = input.value.trim();
      if (!txt) return;
      addBtn.disabled = true; addBtn.textContent = 'Posting…';
      try {
        const res = await post('/api/comments.php', { repo: it.repo, number: it.number, body: txt });
        input.value = '';
        const hint = list.querySelector('.bar-hint'); if (hint) list.innerHTML = '';
        list.appendChild(commentEl(res.comment));
      } catch (e) { showError(e.message); }
      finally { addBtn.disabled = false; addBtn.textContent = 'Comment'; }
    } });

    function commentEl(c) {
      return el('div', { class: 'cmt' }, [
        el('div', { class: 'cmt-head' }, [
          avatarEl(c.author, c.avatarUrl, { size: 20 }),
          el('a', { class: 'cmt-author', href: c.url || '#', target: '_blank', text: c.author || 'unknown' }),
          c.createdAt ? el('span', { class: 'cmt-date', text: fmtDateTime(c.createdAt) }) : null,
        ].filter(Boolean)),
        el('div', { class: 'cmt-body', text: c.body || '' }),
      ]);
    }

    async function load() {
      list.innerHTML = '';
      try {
        const res = await api('/api/comments.php?repo=' + encodeURIComponent(it.repo) + '&number=' + it.number);
        if (!res.comments || !res.comments.length) { list.appendChild(el('span', { class: 'bar-hint', text: 'No comments yet.' })); return; }
        res.comments.forEach((c) => list.appendChild(commentEl(c)));
      } catch (e) { list.appendChild(el('span', { class: 'bar-hint', text: 'Could not load comments.' })); }
    }
    load();

    return el('div', { class: 'cmt-section' }, [
      el('div', { class: 'field-label', text: 'Comments' }),
      list,
      el('div', { class: 'cmt-add' }, [input, addBtn]),
    ]);
  }

  // A clean read-only summary of an issue, with an Edit button to switch to the
  // field-editing form. Clicking a card lands here.
  function renderViewModal(it, meta) {
    meta = meta || { labels: [], milestones: [], assignees: [] };
    const body = $('#modal-body');
    body.innerHTML = '';

    const editBtn = el('button', { class: 'btn btn-primary', text: 'Edit', onclick: () => renderModal(it, meta) });
    const header = modalHeader(el('div', {}, [
      it.url ? el('a', { class: 'modal-num', href: it.url, target: '_blank', text: '#' + (it.number || '') }) : null,
      it.repo ? el('span', { class: 'modal-repo', text: ' ' + it.repo }) : null,
    ]), [editBtn]);

    const stateBadge = it.state
      ? el('span', { class: 'view-state view-state-' + String(it.state).toLowerCase(), text: String(it.state).toLowerCase() })
      : null;
    const titleRow = el('div', { class: 'view-titlerow' }, [stateBadge, el('h2', { class: 'view-title', text: it.title || '(untitled)' })].filter(Boolean));

    // key/value chips for the important fields
    const chips = [];
    const status = itemStatusName(it); if (status) chips.push(viewChip('Status', status));
    const sprint = itemSprint(it);     if (sprint) chips.push(viewChip('Sprint', sprint));
    const pts = itemPoints(it);         if (pts != null) chips.push(viewChip('Points', String(pts)));
    const start = itemStart(it);        if (start) chips.push(viewChip('Start', fmtDue(start)));
    const due = itemDue(it);            if (due) chips.push(viewChip('Due', fmtDue(due)));
    if (it.milestone) chips.push(viewChip('Milestone', it.milestone.title));
    const metaRow = chips.length ? el('div', { class: 'view-meta' }, chips) : null;

    // assignees
    let peopleRow = null;
    if (it.assignees && it.assignees.length) {
      peopleRow = el('div', { class: 'view-people' }, it.assignees.map((a) =>
        el('span', { class: 'view-person' }, [avatarEl(a.login, a.avatarUrl, { size: 22 }), el('span', { text: a.login })])));
    }

    // labels (sprint labels are shown via the Sprint chip, not here)
    const labels = (it.labels || []).filter((l) => !isSprintLabel(l.name));
    const labelsRow = labels.length ? el('div', { class: 'view-labels' }, labels.map(labelPill)) : null;

    const desc = (it.body || '').trim();
    const descBox = el('div', { class: 'view-desc' + (desc ? '' : ' view-desc-empty') }, [desc || 'No description.']);

    body.append(...[
      header,
      titleRow,
      metaRow,
      peopleRow,
      labelsRow,
      el('div', { class: 'field-label', text: 'Description' }),
      descBox,
      buildRelationsSection(it, true),
      buildPrSection(it, true),
      buildCommentsSection(it),
    ].filter(Boolean));
  }

  // ---- edit modal ----
  // Every editable control registers a "saver" on this list. The single Save
  // button at the bottom runs them all; each saver no-ops when its value is
  // unchanged, so only edited fields hit the API. (Relationships and linked PRs
  // are discrete add/remove actions and manage themselves outside this flow.)
  function renderModal(it, meta) {
    meta = meta || { labels: [], milestones: [], assignees: [] };
    const body = $('#modal-body');
    body.innerHTML = '';

    const savers = [];
    const gridEntries = []; // small scalar fields, packed into a 2-column grid

    const backBtn = el('button', { class: 'btn btn-ghost', text: '← Back', title: 'Back to view',
      onclick: () => renderViewModal(it, meta) });
    const header = modalHeader(el('div', {}, [
      it.url ? el('a', { class: 'modal-num', href: it.url, target: '_blank', text: '#' + (it.number || '') }) : null,
      it.repo ? el('span', { class: 'modal-repo', text: ' ' + it.repo }) : null,
    ]), [backBtn]);

    const titleInput = el('input', { class: 'modal-title-input', value: it.title });
    const bodyInput = el('textarea', { class: 'modal-body-input', rows: '6' }, [it.body || '']);
    savers.push(mkSaver(
      () => titleInput.value !== it.title || bodyInput.value !== (it.body || ''),
      async () => { await post('/api/issue.php', { repo: it.repo, number: it.number, title: titleInput.value, body: bodyInput.value }); it.title = titleInput.value; it.body = bodyInput.value; }
    ));

    // Status
    const statusSel = buildStatusSelect((it.fields[cfg().statusField] || {}).optionId || '');
    savers.push(mkSaver(
      () => !!statusSel.value && statusSel.value !== ((it.fields[cfg().statusField] || {}).optionId || ''),
      async () => { await moveCard(it.itemId, statusSel.value); }
    ));
    gridEntries.push({ label: 'Status', control: statusSel });

    // Story Points (or a create-field prompt if the board has no points field)
    if (cfg().pointsField) {
      const pointsInput = el('input', { class: 'inp', type: 'number', step: '0.5', value: itemPoints(it) ?? '' });
      savers.push(mkSaver(
        () => (pointsInput.value === '' ? null : parseFloat(pointsInput.value)) !== itemPoints(it),
        async () => {
          const nv = pointsInput.value === '' ? null : parseFloat(pointsInput.value);
          await setField(it, cfg().pointsField, 'number', pointsInput.value === '' ? null : pointsInput.value);
          it.fields[cfg().pointsField] = nv == null ? undefined : { type: 'number', number: nv };
        }
      ));
      gridEntries.push({ label: 'Story Points', control: pointsInput });
    } else {
      const createBtn = el('button', { class: 'btn', text: `Create "${cfg().pointsName}" field`, onclick: async () => {
        createBtn.disabled = true; createBtn.textContent = 'Creating…';
        try { await post('/api/create-field.php', { name: cfg().pointsName, dataType: 'NUMBER' }); closeModal(); await refresh(); }
        catch (e) { createBtn.disabled = false; createBtn.textContent = `Create "${cfg().pointsName}" field`; showError(e.message); }
      } });
      gridEntries.push({ label: 'Story Points', control: el('div', { class: 'grid-create' }, [el('span', { class: 'bar-hint', text: 'No points field.' }), createBtn]) });
    }

    // Start date (issue-backed or Projects v2 date field)
    if (cfg().startField) {
      const startInput = el('input', { class: 'inp', type: 'date', value: itemStart(it) || '' });
      savers.push(mkSaver(
        () => (startInput.value || '') !== (itemStart(it) || ''),
        async () => { await setDateField(it, cfg().startField, startInput.value === '' ? null : startInput.value); }
      ));
      gridEntries.push({ label: 'Start date', control: startInput });
    }

    // Due date
    if (cfg().dueField) {
      const dueInput = el('input', { class: 'inp', type: 'date', value: itemDue(it) || '' });
      savers.push(mkSaver(
        () => (dueInput.value || '') !== (itemDue(it) || ''),
        async () => { await setDateField(it, cfg().dueField, dueInput.value === '' ? null : dueInput.value); }
      ));
      gridEntries.push({ label: 'Due date', control: dueInput });
    }

    // Sprint (writes the sprint label)
    const sprintSel = buildSprintSelect(itemSprint(it) || '');
    savers.push(mkSaver(
      () => (sprintSel.value || '') !== (itemSprint(it) || ''),
      async () => {
        const v = sprintSel.value || '';
        const res = await post('/api/sprint-assign.php', { repo: it.repo, number: it.number, labels: it.labels.map((l) => l.name), sprint: v || null });
        const names = res.labels || [];
        const known = new Map(it.labels.map((l) => [l.name, l]));
        it.labels = names.map((n) => known.get(n) || { name: n, color: '5319e7' });
        it.sprint = v || null;
      }
    ));
    gridEntries.push({ label: 'Sprint', control: sprintSel });

    // Milestone
    const msSel = buildMilestoneSelect(meta.milestones, it.milestone);
    savers.push(mkSaver(
      () => (msSel.value === '' ? null : parseInt(msSel.value, 10)) !== (it.milestone ? it.milestone.number : null),
      async () => {
        const v = msSel.value === '' ? null : parseInt(msSel.value, 10);
        await post('/api/milestone.php', { repo: it.repo, number: it.number, milestone: v });
        const chosen = meta.milestones.find((m) => m.number === v);
        it.milestone = v == null ? null : { number: v, title: chosen ? chosen.title : ('#' + v) };
      }
    ));
    gridEntries.push({ label: 'Milestone', control: msSel });

    // GitHub Issue fields (Priority, Effort, Size, …) + extra Projects v2 fields.
    buildEditableFields(it, savers).forEach((e) => gridEntries.push(e));
    const fieldGrid = el('div', { class: 'field-grid' }, gridEntries.map((e) => gridField(e.label, e.control)));

    // Labels (Teams + Labels split); sprint labels are managed via the Sprint field.
    const labelSrc = meta.labels.length ? meta.labels : it.labels;
    const labelSecs = buildLabelSections(labelSrc, new Set(it.labels.map((l) => l.name)));
    const labelsDirty = () => {
      const cur = it.labels.filter((l) => !isSprintLabel(l.name)).map((l) => l.name).sort();
      return JSON.stringify(cur) !== JSON.stringify(labelSecs.getChosen().slice().sort());
    };
    savers.push(mkSaver(labelsDirty, async () => {
      const chosen = labelSecs.getChosen();
      const sprintLabels = it.labels.filter((l) => isSprintLabel(l.name)); // preserve sprint label
      const finalNames = chosen.concat(sprintLabels.map((l) => l.name));
      await post('/api/labels.php', { repo: it.repo, number: it.number, labels: finalNames });
      it.labels = labelSrc.filter((l) => chosen.includes(l.name)).concat(sprintLabels);
    }));

    // Assignees
    const asgSrc = meta.assignees.length ? meta.assignees : it.assignees;
    const asgSecs = buildAssigneeSection(asgSrc, new Set(it.assignees.map((a) => a.login)));
    const asgDirty = () => JSON.stringify(it.assignees.map((a) => a.login).sort()) !== JSON.stringify(asgSecs.getChosen().slice().sort());
    savers.push(mkSaver(asgDirty, async () => {
      const chosen = asgSecs.getChosen();
      await post('/api/assignees.php', { repo: it.repo, number: it.number, assignees: chosen });
      it.assignees = asgSrc.filter((u) => chosen.includes(u.login));
    }));

    // One Save button, shown only while there are unsaved changes.
    const saveBtn = el('button', { class: 'btn btn-primary btn-save hidden', text: 'Save', onclick: async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        for (const s of savers) await s.apply();
        await refresh(); // re-fetch the board so the viewer reflects server truth
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.disabled = false; saveBtn.textContent = 'Save'; refreshSaveBtn(); }, 1200);
      } catch (e) {
        saveBtn.disabled = false; saveBtn.textContent = 'Save'; refreshSaveBtn();
        showError(e.message);
      }
    } });
    // Show Save whenever any control differs from its saved value. Field inputs,
    // selects and checkboxes all bubble input/change, so one delegated listener
    // on the modal body covers the whole form.
    const refreshSaveBtn = () => { saveBtn.classList.toggle('hidden', !savers.some((s) => s.dirty())); };
    body.addEventListener('input', refreshSaveBtn);
    body.addEventListener('change', refreshSaveBtn);

    body.append(...[
      header,
      titleInput,
      fieldGrid,
      el('div', { class: 'field-row' }, [el('div', { class: 'field-label', text: 'Labels' }), labelSecs.wrap]),
      el('div', { class: 'field-row' }, [el('div', { class: 'field-label', text: 'Assignees' }), asgSecs.wrap]),
      buildRelationsSection(it),
      buildPrSection(it),
      el('div', { class: 'field-label', text: 'Description' }),
      bodyInput,
      saveBtn,
    ].filter(Boolean));
  }

  // ---- create-issue modal (same interface as edit) ----
  function boardRepos() {
    const set = new Set();
    state.board.items.forEach((it) => { if (it.repo) set.add(it.repo); });
    return Array.from(set).sort();
  }

  function openCreateModal() {
    $('#modal').classList.remove('hidden');
    const body = $('#modal-body');
    body.innerHTML = '';

    const repos = boardRepos();
    const repoSel = repos.length ? el('select', { class: 'inp' }, repos.map((r) => el('option', { value: r, text: r })))
                                 : el('input', { class: 'inp', type: 'text', placeholder: 'owner/repo' });
    const repoVal = () => (repos.length ? repoSel.value : repoSel.value.trim());

    const titleInput = el('input', { class: 'modal-title-input', placeholder: 'Issue title' });
    const bodyInput = el('textarea', { class: 'modal-body-input', rows: '6', placeholder: 'Description (optional)' });
    const statusSel = buildStatusSelect('');
    const sprintSel = buildSprintSelect('');
    const pointsInput = cfg().pointsField ? el('input', { class: 'inp', type: 'number', step: '0.5', placeholder: 'pts' }) : null;
    const startInput = cfg().startField ? el('input', { class: 'inp', type: 'date' }) : null;
    const dueInput = cfg().dueField ? el('input', { class: 'inp', type: 'date' }) : null;

    // repo-dependent controls (labels / assignees / milestone)
    const dyn = el('div', { class: 'create-dyn' });
    let labelSecs = null, asgSecs = null, msSel = null;
    async function loadRepoMeta() {
      const repo = repoVal();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { dyn.innerHTML = ''; return; }
      dyn.innerHTML = '<div class="loading">Loading repo options…</div>';
      let meta = { labels: [], milestones: [], assignees: [] };
      try { meta = await loadMeta(repo); } catch (e) { /* limited */ }
      dyn.innerHTML = '';
      labelSecs = buildLabelSections(meta.labels, new Set());
      asgSecs = buildAssigneeSection(meta.assignees, new Set());
      msSel = buildMilestoneSelect(meta.milestones, null);
      dyn.append(
        fieldRow('Milestone', msSel),
        el('div', { class: 'field-row' }, [el('div', { class: 'field-label', text: 'Labels' }), labelSecs.wrap]),
        el('div', { class: 'field-row' }, [el('div', { class: 'field-label', text: 'Assignees' }), asgSecs.wrap]),
      );
    }
    repoSel.addEventListener('change', loadRepoMeta);

    const createBtn = el('button', { class: 'btn btn-primary', text: 'Create issue', onclick: async () => {
      const repo = repoVal();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { showError('Choose a repo (owner/name)'); return; }
      if (!titleInput.value.trim()) { showError('Title is required'); return; }
      createBtn.disabled = true; createBtn.textContent = 'Creating…';
      const labels = labelSecs ? labelSecs.getChosen() : [];
      const assignees = asgSecs ? asgSecs.getChosen() : [];
      const milestone = (msSel && msSel.value) ? parseInt(msSel.value, 10) : null;

      // The issue is created first; only then is it added to the board and have
      // its fields set. If creation itself fails the issue may still exist on
      // GitHub, so we surface the error but always refresh + close so the board
      // reflects reality and the user isn't stuck on a stale modal.
      let res;
      try {
        res = await post('/api/issue-create.php', { repo, title: titleInput.value.trim(), body: bodyInput.value, labels, assignees, milestone });
      } catch (e) {
        showError(e.message);
        closeModal();
        await refresh();
        return;
      }

      try {
        if (statusSel.value) {
          const sf = fieldMeta(cfg().statusField);
          if (sf) await post('/api/move.php', { itemId: res.itemId, fieldId: sf.id, optionId: statusSel.value });
        }
        if (pointsInput && pointsInput.value !== '' && cfg().pointsField) {
          const pf = fieldMeta(cfg().pointsField);
          if (pf) await post('/api/field.php', { itemId: res.itemId, fieldId: pf.id, kind: 'number', value: pointsInput.value });
        }
        if (startInput && startInput.value !== '' && cfg().startField) {
          await writeDate(res.itemId, res.issueId, cfg().startField, startInput.value);
        }
        if (dueInput && dueInput.value !== '' && cfg().dueField) {
          await writeDate(res.itemId, res.issueId, cfg().dueField, dueInput.value);
        }
        if (sprintSel.value) {
          await post('/api/sprint-assign.php', { repo, number: res.number, labels, sprint: sprintSel.value });
        }
      } catch (e) {
        // Issue is already created and on the board; a field-setting step failed.
        showError('Issue created, but some fields could not be set: ' + e.message);
      }
      closeModal();
      await refresh();
    } });

    const createGrid = el('div', { class: 'field-grid' }, [
      gridField('Status', statusSel),
      pointsInput ? gridField('Story Points', pointsInput) : null,
      startInput ? gridField('Start date', startInput) : null,
      dueInput ? gridField('Due date', dueInput) : null,
      gridField('Sprint', sprintSel),
    ].filter(Boolean));

    body.append(...[
      modalHeader(el('strong', { text: 'New issue' })),
      fieldRow('Repo', repoSel),
      titleInput,
      createGrid,
      dyn,
      el('div', { class: 'field-label', text: 'Description' }),
      bodyInput,
      createBtn,
    ].filter(Boolean));

    loadRepoMeta();
  }

  // ---- stats view ----
  async function renderStats() {
    const root = $('#stats-view');
    root.innerHTML = '<div class="loading">Computing stats…</div>';
    let data;
    try { data = await api('/api/stats.php?sprint=' + encodeURIComponent(state.sprint)); }
    catch (e) { root.innerHTML = ''; showError(e.message); return; }

    root.innerHTML = '';

    // scope heading
    const scopeLabel = state.sprint === 'all' ? 'All sprints' : state.sprint;
    root.appendChild(el('h2', { class: 'stats-scope', text: 'Stats — ' + scopeLabel }));

    const t = data.totals;
    root.appendChild(el('div', { class: 'stats-totals' }, [
      statCard('Completed', `${t.doneCount} tasks`),
      statCard('Completed points', `${t.donePoints}`),
      statCard('Open', `${t.openCount} tasks`),
      statCard('Open points', `${t.openPoints}`),
    ]));

    // unassigned always sorted last
    const people = data.perPerson.slice().sort((a, b) => {
      const ua = a.login === '(unassigned)' ? 1 : 0;
      const ub = b.login === '(unassigned)' ? 1 : 0;
      return (ua - ub) || (b.donePoints - a.donePoints) || (b.doneCount - a.doneCount);
    });

    const table = el('table', { class: 'stats-table' });
    table.appendChild(el('tr', {}, [
      el('th', { text: 'Person' }), el('th', { text: 'Done' }), el('th', { text: 'Done pts' }),
      el('th', { text: 'Open' }), el('th', { text: 'Open pts' }), el('th', { text: 'Total pts' }),
    ]));
    people.forEach((p) => {
      const unassigned = p.login === '(unassigned)';
      table.appendChild(el('tr', { class: unassigned ? 'row-unassigned' : '' }, [
        el('td', {}, [avatarEl(unassigned ? 'unassigned' : p.login, p.avatarUrl, { unassigned }),
          el('span', { text: ' ' + (unassigned ? 'Unassigned' : p.login) })]),
        el('td', { text: String(p.doneCount) }),
        el('td', { class: 'strong', text: String(p.donePoints) }),
        el('td', { text: String(p.openCount) }),
        el('td', { text: String(p.openPoints) }),
        el('td', { text: String(p.totalPoints) }),
      ]));
    });
    root.appendChild(table);
  }
  function statCard(label, value) {
    return el('div', { class: 'stat-card' }, [el('div', { class: 'stat-value', text: value }), el('div', { class: 'stat-label', text: label })]);
  }

  // ---- timeline view (issues by due date) ----
  function renderTimeline() {
    const root = $('#timeline-view');
    root.innerHTML = '';

    if (!cfg().dueField) {
      const dateFields = Object.entries(state.board.fields)
        .filter(([, f]) => (f.dataType || '').toUpperCase() === 'DATE')
        .map(([n]) => n);
      root.appendChild(el('div', { class: 'loading',
        text: 'No due-date field is selected for this board.' }));
      if (dateFields.length) {
        root.appendChild(el('div', { class: 'bar-hint',
          text: 'Found date field(s): ' + dateFields.join(', ') + '. Set FIELD_DUE in config to the one you want (multiple date fields can\'t be auto-picked).' }));
      } else {
        root.appendChild(el('div', { class: 'bar-hint',
          text: 'No date fields exist — open any card and click "Create \"' + cfg().dueName + '\" field".' }));
      }
      return;
    }

    const all = visibleItems();
    const dated = all.filter((it) => itemDue(it)).sort((a, b) => itemDue(a).localeCompare(itemDue(b)));
    const noDue = all.length - dated.length;

    if (!dated.length) {
      root.appendChild(el('div', { class: 'loading', text: 'No issues with due dates in the current view.' }));
      if (noDue) root.appendChild(el('div', { class: 'bar-hint', text: `${noDue} issue(s) have no due date.` }));
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const addDays = (n) => { const x = new Date(today + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const weekEnd = addDays(7), monthEnd = addDays(30);

    const buckets = [
      { label: 'Overdue',     match: (d) => d < today },
      { label: 'Today',       match: (d) => d === today },
      { label: 'Next 7 days', match: (d) => d > today && d <= weekEnd },
      { label: 'This month',  match: (d) => d > weekEnd && d <= monthEnd },
      { label: 'Later',       match: (d) => d > monthEnd },
    ];

    buckets.forEach((b) => {
      const rows = dated.filter((it) => b.match(itemDue(it)));
      if (!rows.length) return;
      const pts = rows.reduce((s, it) => s + (itemPoints(it) || 0), 0);
      const head = el('div', { class: 'tl-bucket-head' }, [
        el('span', { class: 'tl-bucket-label', text: b.label }),
        el('span', { class: 'tl-bucket-meta', text: `${rows.length} · ${pts} pts` }),
      ]);
      const list = el('div', { class: 'tl-rows' }, rows.map((it) => timelineRow(it, today)));
      root.appendChild(el('div', { class: 'tl-bucket' }, [head, list]));
    });

    if (noDue) root.appendChild(el('div', { class: 'bar-hint', text: `${noDue} issue(s) in view have no due date.` }));
  }

  function timelineRow(it, today) {
    const due = itemDue(it);
    const start = itemStart(it);
    const overdue = due < today && !isDone(it);
    const status = itemStatusName(it);
    const pts = itemPoints(it);
    const sprint = itemSprint(it);
    const range = start ? (fmtDue(start) + ' → ' + fmtDue(due)) : null;
    const row = el('div', { class: 'tl-row' + (isDone(it) ? ' tl-done' : ''), onclick: () => openCardModal(it) }, [
      el('span', { class: 'tl-date' + (overdue ? ' overdue' : ''), text: fmtDue(due) }),
      el('div', { class: 'tl-main' }, [
        el('div', { class: 'tl-title', text: (it.number ? '#' + it.number + ' ' : '') + it.title }),
        el('div', { class: 'tl-sub' }, [
          range ? el('span', { class: 'tl-range', text: range }) : null,
          status ? el('span', { class: 'tl-status', text: status }) : null,
          sprint ? el('span', { class: 'sprint-badge', text: '⏱ ' + sprint }) : null,
          pts != null ? el('span', { class: 'pts-badge', text: pts + ' pts' }) : null,
        ].filter(Boolean)),
      ]),
      el('div', { class: 'tl-assignees' }, it.assignees.map((a) => avatarEl(a.login, a.avatarUrl))),
    ]);
    return row;
  }

  // ---- view switching ----
  function setView(v) {
    state.view = v;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $('#board-view').classList.toggle('hidden', v !== 'board');
    $('#timeline-view').classList.toggle('hidden', v !== 'timeline');
    $('#stats-view').classList.toggle('hidden', v !== 'stats');
    if (v === 'stats') renderStats();
    if (v === 'timeline') renderTimeline();
  }

  // re-render whichever view is active (used after filter/sprint changes)
  function rerender() {
    renderBoard();
    if (state.view === 'timeline') renderTimeline();
    else if (state.view === 'stats') renderStats();
  }

  // ---- refresh from GitHub ----
  async function refresh() {
    const btn = $('#refresh-btn');
    const old = btn.textContent; btn.textContent = '↻ …'; btn.disabled = true;
    try {
      state.board = await api('/api/board.php');
      renderSprintBar(); renderFilterBar(); renderBoard();
      if (state.view === 'stats') await renderStats();
    } catch (e) { showError(e.message); }
    finally { btn.textContent = old; btn.disabled = false; }
  }

  // ---- misc UI ----
  function showError(msg) {
    const e = $('#error');
    e.textContent = msg;
    e.classList.remove('hidden');
    setTimeout(() => e.classList.add('hidden'), 6000);
  }
  function flash(btn, text) {
    const old = btn.textContent; btn.textContent = text; btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  }

  // ---- boot ----
  async function boot() {
    try {
      state.me = await api('/api/me.php');
      if (!state.me.authenticated) { location.href = '/'; return; }
      const chip = $('#user-chip');
      chip.innerHTML = '';
      chip.appendChild(avatarEl(state.me.login, state.me.avatarUrl));
      chip.appendChild(el('span', { text: ' ' + state.me.login }));

      state.board = await api('/api/board.php');
      $('#loading').classList.add('hidden');
      if (cfg().projectTitle) $('#project-title').textContent = cfg().projectTitle;

      // default the sprint filter to the current ("now") sprint, if any
      const now = currentSprintName();
      if (now) state.sprint = now;

      renderSprintBar();
      renderFilterBar();
      renderBoard();
    } catch (e) {
      $('#loading').classList.add('hidden');
      showError('Failed to load: ' + e.message);
    }

    $('#filter-mine').addEventListener('change', (e) => { state.filterMine = e.target.checked; rerender(); });
    $('#refresh-btn').addEventListener('click', refresh);
    $('#new-issue-btn').addEventListener('click', openCreateModal);
    $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    $('#modal').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
