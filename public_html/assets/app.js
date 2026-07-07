/* Issue Kanban — client app.
 * Talks only to /api/*.php (the GitHub token stays server-side).
 */
(function () {
  'use strict';

  // ---- state ----
  const state = {
    me: null,            // { login, name, avatarUrl }
    board: null,         // { config, fields, items }
    view: 'board',       // 'board' | 'stats'
    filterMine: false,
    filterHelpWanted: false, // show only "help wanted" issues
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

  // Minimal, XSS-safe Markdown -> HTML for issue/comment bodies. All text is
  // HTML-escaped first and only http(s)/mailto links are emitted, so the result
  // is safe to inject. Supports links (markdown + bare URLs), bold, italic,
  // inline + fenced code, headings, bullet lists, and line breaks — enough to
  // read GitHub issue text comfortably without pulling in a markdown library.
  function mdToHtml(src) {
    src = String(src || '').replace(/\r\n?/g, '\n');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
    const safeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(u) ? u.replace(/&amp;/g, '&') : null;

    // pull fenced code blocks out first so their contents aren't reformatted
    const blocks = [];
    src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, code) => {
      blocks.push('<pre class="md-pre"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\n@@MDBLOCK' + (blocks.length - 1) + '@@\n';
    });

    let text = esc(src);
    text = text.replace(/`([^`\n]+)`/g, (m, c) => '<code class="md-code">' + c + '</code>');
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const safe = safeUrl(url);
      return safe ? '<a href="' + escAttr(safe) + '" target="_blank" rel="noopener">' + label + '</a>' : m;
    });
    text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) => {
      const safe = safeUrl(url);
      return safe ? pre + '<a href="' + escAttr(safe) + '" target="_blank" rel="noopener">' + url + '</a>' : m;
    });
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
               .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    const out = [];
    let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    text.split('\n').forEach((line) => {
      const ph = line.match(/^@@MDBLOCK(\d+)@@$/);
      if (ph) { closeList(); out.push(blocks[+ph[1]]); return; }
      let m;
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { closeList(); out.push('<div class="md-h md-h' + m[1].length + '">' + m[2] + '</div>'); return; }
      if ((m = line.match(/^\s*[-*]\s+(.*)$/)))  { if (!inList) { out.push('<ul class="md-ul">'); inList = true; } out.push('<li>' + m[1] + '</li>'); return; }
      if (line.trim() === '') { closeList(); return; }
      closeList();
      out.push('<div class="md-line">' + line + '</div>');
    });
    closeList();
    return out.join('');
  }
  // GitHub IssueFieldSingleSelectOptionColor enum -> hex
  const ISSUE_COLORS = { GRAY: '6e7681', BLUE: '1f6feb', GREEN: '238636', YELLOW: '9e6a03', ORANGE: 'bc4c00', RED: 'cf222e', PINK: 'bf3989', PURPLE: '8250df' };
  function issueColor(name) { if (!name) return null; const h = ISSUE_COLORS[String(name).toUpperCase()]; return h ? '#' + h : null; }
  function itemSprint(it) { return it.sprint || null; } // sprint name (from label) or null
  function isDone(it) { return (itemStatusName(it) || '').toLowerCase() === (cfg().statusDone || '').toLowerCase(); }
  // Cancelled / pushed work: counted separately (shown red) so it doesn't read as "done".
  function isCancelled(it) { const s = (itemStatusName(it) || '').toLowerCase(); return s.includes('cancel') || s.includes('push'); }
  // "help wanted" label match (configurable name; also tolerates the hyphenated form).
  function helpWantedName() { return (cfg().helpWantedLabel || 'help wanted').toLowerCase(); }
  function isHelpWantedLabel(name) {
    const n = String(name || '').toLowerCase();
    const want = helpWantedName();
    return n === want || n.replace(/-/g, ' ') === want.replace(/-/g, ' ');
  }
  function isHelpWanted(it) { return (it.labels || []).some((l) => isHelpWantedLabel(l.name)); }
  // The Status option that represents cancelled/pushed work (the column ghosts
  // live in, and where "leave cancelled" sends a real issue). null if none.
  function cancelledStatusOption() {
    return statusOptions().find((o) => { const s = (o.name || '').toLowerCase(); return s.includes('cancel') || s.includes('push'); }) || null;
  }
  function boardSnapshots() { return state.board.snapshots || []; }
  // Website-only snapshots visible in the current sprint scope.
  function visibleSnapshots() {
    return boardSnapshots().filter((s) => state.sprint === 'all' || s.sprint === state.sprint);
  }
  // stable "owner/repo#number" key for matching parent/child relationships
  function itemKey(it) { return (it.repo || '') + '#' + (it.number != null ? it.number : ''); }
  function parentKey(it) { return it.parent && it.parent.number != null ? (it.parent.repo || it.repo) + '#' + it.parent.number : null; }

  // team-label helpers (a label is a "team" if it starts with the configured prefix)
  function teamPrefix() { return cfg().teamPrefix || ''; }
  function isTeamLabel(name) { const p = teamPrefix(); return !!p && name.indexOf(p) === 0; }
  function teamDisplay(name) { const p = teamPrefix(); return isTeamLabel(name) ? name.slice(p.length) : name; }

  // ---- roster / capacity ----
  function roster() { const r = state.board && state.board.roster; return { people: (r && r.people) || {}, manual: (r && r.manual) || {} }; }
  function personWeeklyHours(login) { const h = roster().people[login]; return h ? Number(h) : 0; }
  function teamManualEntries(team) { const m = roster().manual[team]; return Array.isArray(m) ? m : []; }
  // Every team label present on the board (from issue labels), plus any team that
  // only has manual (non-git) members. Sorted by display name.
  function teamNames() {
    const set = new Set();
    (state.board.items || []).forEach((it) => it.labels.forEach((l) => { if (isTeamLabel(l.name)) set.add(l.name); }));
    Object.keys(roster().manual || {}).forEach((t) => { if (t) set.add(t); });
    return Array.from(set).sort((a, b) => teamDisplay(a).localeCompare(teamDisplay(b)));
  }
  // team label -> [{login,name,avatarUrl}] derived from assignees on that team's issues.
  function teamMembers(team) {
    const by = new Map();
    (state.board.items || []).forEach((it) => {
      if (!it.labels.some((l) => l.name === team)) return;
      (it.assignees || []).forEach((a) => { if (a.login && !by.has(a.login)) by.set(a.login, a); });
    });
    return Array.from(by.values()).sort((a, b) => personName(a).localeCompare(personName(b)));
  }
  // Weekly hours for a set of teams (null => all teams), git members counted once
  // across the set, plus each team's manual (non-git) hours.
  function weeklyCapacity(teams) {
    const list = teams && teams.length ? teams : teamNames();
    const logins = new Set();
    let hours = 0;
    list.forEach((t) => {
      teamMembers(t).forEach((m) => logins.add(m.login));
      teamManualEntries(t).forEach((e) => { hours += Number(e.hours) || 0; });
    });
    logins.forEach((login) => { hours += personWeeklyHours(login); });
    return hours;
  }
  // Number of weeks a sprint spans (from its dates); defaults to 1 when undated.
  function sprintWeeks(sprint) {
    if (!sprint || !sprint.startDate || !sprint.endDate) return 1;
    const ms = new Date(sprint.endDate + 'T00:00:00') - new Date(sprint.startDate + 'T00:00:00');
    const days = ms / 86400000 + 1; // inclusive
    return Math.max(1, Math.round(days / 7));
  }
  // Teams currently selected in the filter bar (empty => no team filter active).
  function activeTeams() { return Array.from(state.activeLabels).filter(isTeamLabel); }
  // Hours-per-point ratio (converts capacity hours -> velocity in points). 0 = unset.
  function hoursPerPoint() { const r = roster().hoursPerPoint; return r ? Number(r) : 0; }
  function hoursToPoints(hours) { const hpp = hoursPerPoint(); return hpp > 0 ? hours / hpp : null; }
  // Capacity hours for a sprint under the active team filter.
  function sprintTargetHours(sprint) {
    const teams = activeTeams();
    return weeklyCapacity(teams.length ? teams : null) * sprintWeeks(sprint);
  }
  // Target velocity in POINTS for a sprint (null when no hours-per-point set).
  function sprintTargetPoints(sprint) {
    const p = hoursToPoints(sprintTargetHours(sprint));
    return p == null ? null : Math.round(p);
  }

  // sprint-label helpers (hidden from the normal Labels filter; shown via sprint bar)
  function sprintPrefix() { return cfg().sprintPrefix || 'sprint:'; }
  function isSprintLabel(name) { const p = sprintPrefix(); return !!p && name.indexOf(p) === 0; }

  // Profile display name, falling back to the @login when a user has none set.
  function personName(p) { return (p && (p.name || p.login)) || ''; }

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
  // "In view" = every filter EXCEPT the label/team chips. The filter bar counts
  // are computed over this scope so team/label numbers track the current sprint
  // (and My-issues / Help-wanted) toggles.
  function inViewScope(it) {
    if (state.filterMine && state.me && !it.assignees.some((a) => a.login === state.me.login)) return false;
    if (state.filterHelpWanted && !isHelpWanted(it)) return false;
    if (state.sprint !== 'all' && itemSprint(it) !== state.sprint) return false;
    return true;
  }
  function visibleItems() {
    return state.board.items.filter((it) => {
      if (!inViewScope(it)) return false;
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
  // True unless label/team filters are active and this item matches none of them.
  function passesLabelFilter(it) {
    if (state.activeLabels.size === 0) return true;
    const names = new Set(it.labels.map((l) => l.name));
    for (const t of state.activeLabels) { if (names.has(t)) return true; }
    return false;
  }
  function sprintProgress(name) {
    let done = 0, total = 0, doneC = 0, totalC = 0, cancelled = 0, cancelledC = 0;
    state.board.items.forEach((it) => {
      if (itemSprint(it) !== name) return;
      if (!passesLabelFilter(it)) return; // header numbers track the active team/label filter
      const pts = itemPoints(it) || 0;
      total += pts; totalC++;
      if (isCancelled(it)) { cancelled += pts; cancelledC++; }
      else if (isDone(it)) { done += pts; doneC++; }
    });
    return { done, total, doneC, totalC, cancelled, cancelledC };
  }

  function renderSprintBar() {
    const bar = $('#sprint-bar');
    bar.innerHTML = '';
    bar.appendChild(el('span', { class: 'bar-label', text: 'Sprints' }));

    const sprints = allSprints().slice()
      .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')); // newest first

    // Target-velocity context: which team scope the header numbers reflect.
    const teams = activeTeams();
    const scopeNote = teams.length ? teams.map(teamDisplay).join(', ') : 'all teams';

    // individual sprints first, then "All sprints" last
    sprints.forEach((s) => {
      bar.appendChild(sprintPill(
        s.name, state.sprint === s.name,
        s.name + (s.closed ? ' ✓' : ''),
        fmtRange(s), sprintProgress(s.name), isCurrentSprint(s),
        { hours: sprintTargetHours(s), points: sprintTargetPoints(s), scope: scopeNote }
      ));
    });
    // "All sprints" pill shows weekly capacity rather than a per-sprint target.
    const weeklyHours = weeklyCapacity(teams.length ? teams : null);
    bar.appendChild(sprintPill('all', state.sprint === 'all', 'All sprints', '', null, false,
      { hours: weeklyHours, points: hoursToPoints(weeklyHours) == null ? null : Math.round(hoursToPoints(weeklyHours)), scope: scopeNote, weekly: true }));

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

  function sprintPill(value, active, label, range, prog, current, target) {
    const children = [];
    if (current) children.push(el('span', { class: 'pill-now', text: 'NOW' }));
    children.push(el('span', { class: 'pill-title', text: label }));
    if (range) children.push(el('span', { class: 'pill-range', text: range }));
    if (prog && prog.totalC > 0) {
      const donePct = prog.total > 0 ? (prog.done / prog.total) * 100 : 0;
      const cancPct = prog.total > 0 ? (prog.cancelled / prog.total) * 100 : 0;
      const segs = [el('span', { class: 'pill-bar-fill', style: `width:${donePct}%` })];
      if (cancPct > 0) segs.push(el('span', { class: 'pill-bar-cancelled', style: `width:${cancPct}%`,
        title: `${prog.cancelled} pts cancelled/pushed` }));
      children.push(el('span', { class: 'pill-prog' }, [
        el('span', { class: 'pill-bar' }, segs),
        el('span', { class: 'pill-prog-txt', text: `${prog.done}/${prog.total} pts` }),
      ]));
    }
    if (target && target.hours > 0) {
      // Velocity is in points; show that when an hours-per-point ratio is set,
      // otherwise fall back to raw capacity hours with a nudge to set the ratio.
      const per = target.weekly ? '/wk' : '';
      const txt = (target.points != null)
        ? `🎯 ${target.points} pts${per} · ${target.scope}`
        : `🎯 ${Math.round(target.hours)}h${per} · ${target.scope}`;
      const ttl = (target.points != null)
        ? `Target velocity — ${target.points} pts (${Math.round(target.hours)}h capacity from ${target.scope})`
        : `Capacity ${Math.round(target.hours)}h from ${target.scope} — set “hours per point” in the Roster tab to show this as velocity (points)`;
      children.push(el('span', { class: 'pill-target', title: ttl, text: txt }));
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
      const rollBtn = el('button', { class: 'btn', text: 'Close & roll over',
        title: 'Review unfinished issues one by one: push each to another sprint (leaving a website-only copy here) or cancel it',
        onclick: () => openRollover(s) });
      list.appendChild(el('div', { class: 'sprint-row' }, [
        el('div', { class: 'sprint-row-name' }, [
          isCurrentSprint(s) ? el('span', { class: 'pill-now', text: 'NOW' }) : null,
          el('strong', { text: s.name }),
          s.closed ? el('span', { class: 'sprint-closed-tag', text: 'closed' }) : null,
        ]),
        el('label', { class: 'sprint-row-field' }, ['Start', start]),
        el('label', { class: 'sprint-row-field' }, ['End', end]),
        el('label', { class: 'sprint-row-field check-row' }, [closed, 'Closed']),
        el('div', { class: 'sprint-row-actions' }, [rollBtn, saveBtn, delBtn]),
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

  // ---- sprint close & roll over ----
  // Real (non-draft), not-done, not-cancelled issues carrying this sprint's label.
  function unfinishedInSprint(name) {
    return (state.board.items || []).filter((it) =>
      it.number && it.repo && itemSprint(it) === name && !isDone(it) && !isCancelled(it));
  }
  // Best default "next" sprint: the earliest one starting after this one, else the newest other.
  function pickNextSprint(cur, others) {
    if (!others.length) return '';
    const start = cur.startDate || '';
    const after = others.filter((o) => (o.startDate || '') > start).sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
    if (after.length) return after[0].name;
    return others.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))[0].name;
  }
  // Swap an item's sprint label to `sprintName` (or clear with null), updating local state.
  async function assignSprintLabel(it, sprintName) {
    const res = await post('/api/sprint-assign.php', { repo: it.repo, number: it.number, labels: it.labels.map((l) => l.name), sprint: sprintName || null });
    const names = res.labels || [];
    const known = new Map(it.labels.map((l) => [l.name, l]));
    it.labels = names.map((n) => known.get(n) || { name: n, color: '5319e7' });
    it.sprint = sprintName || null;
  }

  function openRollover(sprint) {
    $('#modal').classList.remove('hidden');
    const body = $('#modal-body');
    const candidates = unfinishedInSprint(sprint.name);
    const cancelledOpt = cancelledStatusOption();
    const others = allSprints().filter((x) => x.name !== sprint.name);
    const nextDefault = pickNextSprint(sprint, others);
    const tally = { pushed: 0, cancelled: 0, skipped: 0 };
    let idx = 0;
    let busy = false;

    const backBtn = el('button', { class: 'btn btn-ghost', text: '‹ Sprints', onclick: renderSprintManager });

    async function advance() { idx++; render(); }

    async function guarded(fn) {
      if (busy) return;
      busy = true;
      try { await fn(); }
      catch (e) { showError(e.message); }
      finally { busy = false; }
    }

    async function finishClose(markClosed) {
      await guarded(async () => {
        if (markClosed) await sprintsApi({ op: 'update', name: sprint.name, startDate: sprint.startDate || null, endDate: sprint.endDate || null, closed: true });
        await refresh();
        renderSprintManager();
      });
    }

    function render() {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'modal-head' }, [
        el('strong', { text: `Close & roll over — ${sprint.name}` }),
        el('div', { class: 'modal-head-actions' }, [backBtn, el('button', { class: 'btn btn-ghost', text: '✕', onclick: closeModal })]),
      ]));

      if (!candidates.length) {
        body.appendChild(el('div', { class: 'bar-hint', text: 'No unfinished issues in this sprint. You can close it now.' }));
        body.appendChild(el('div', { class: 'rollover-actions' }, [
          el('button', { class: 'btn btn-primary', text: 'Mark sprint closed', onclick: () => finishClose(true) }),
        ]));
        return;
      }

      // progress
      body.appendChild(el('div', { class: 'rollover-progress' }, [
        el('span', { text: `Reviewing ${Math.min(idx + 1, candidates.length)} of ${candidates.length}` }),
        el('span', { class: 'bar-hint', text: `pushed ${tally.pushed} · cancelled ${tally.cancelled} · skipped ${tally.skipped}` }),
      ]));

      if (idx >= candidates.length) {
        body.appendChild(el('div', { class: 'rollover-done' }, [
          el('div', { text: `Reviewed all ${candidates.length} issue(s): ${tally.pushed} pushed, ${tally.cancelled} cancelled, ${tally.skipped} skipped.` }),
          el('div', { class: 'bar-hint', text: 'Pushed issues left a website-only copy in this sprint’s Cancelled/Pushed column.' }),
        ]));
        body.appendChild(el('div', { class: 'rollover-actions' }, [
          el('button', { class: 'btn btn-primary', text: 'Mark sprint closed & finish', onclick: () => finishClose(true) }),
          el('button', { class: 'btn', text: 'Finish (leave open)', onclick: () => finishClose(false) }),
        ]));
        return;
      }

      const it = candidates[idx];

      // target sprint + status controls for a push
      const targetSel = el('select', { class: 'inp' }, others.length
        ? others.map((o) => el('option', { value: o.name, text: o.name }))
        : [el('option', { value: '', text: '— no other sprint —' })]);
      if (nextDefault) targetSel.value = nextDefault;
      const statusSel = el('select', { class: 'inp' }, statusOptions().map((o) => el('option', { value: o.id, text: o.name })));
      // default the push status to the first (leftmost / Todo) column
      if (statusOptions()[0]) statusSel.value = statusOptions()[0].id;

      const pts = itemPoints(it);
      const card = el('div', { class: 'rollover-card' }, [
        el('div', { class: 'rollover-card-title', text: (it.number ? '#' + it.number + ' ' : '') + it.title }),
        el('div', { class: 'card-meta' }, [
          pts != null ? el('span', { class: 'pts-badge', text: pts + ' pts' }) : null,
          el('span', { class: 'card-status', text: itemStatusName(it) || '(no status)' }),
        ].filter(Boolean)),
        el('div', { class: 'card-assignees' }, it.assignees.map((a) => avatarEl(personName(a), a.avatarUrl))),
      ]);

      const pushRow = el('div', { class: 'rollover-push' }, [
        el('span', { class: 'field-label', text: 'Push to' }), targetSel,
        el('span', { class: 'field-label', text: 'as' }), statusSel,
        el('button', { class: 'btn btn-primary', text: 'Push →', disabled: others.length ? undefined : 'disabled',
          onclick: () => guarded(async () => {
            const target = targetSel.value;
            if (!target) { showError('No sprint to push to — create one first.'); return; }
            // 1) frozen website-only copy stays in this sprint's cancelled/pushed column
            const r = await post('/api/snapshot.php', { op: 'add', snapshot: {
              sprint: sprint.name, repo: it.repo, number: it.number, title: it.title,
              points: pts, url: it.url, assignees: it.assignees, pushedTo: target,
            } });
            state.board.snapshots = r.snapshots || [];
            // 2) move the real issue forward + reset its status
            await assignSprintLabel(it, target);
            if (statusSel.value) await moveCard(it.itemId, statusSel.value);
            tally.pushed++; advance();
          }) }),
      ]);

      const actions = el('div', { class: 'rollover-actions' }, [
        cancelledOpt
          ? el('button', { class: 'btn btn-danger', text: 'Leave cancelled',
              title: 'Set the real issue to ' + cancelledOpt.name + ' and keep it in this sprint',
              onclick: () => guarded(async () => { await moveCard(it.itemId, cancelledOpt.id); tally.cancelled++; advance(); }) })
          : el('span', { class: 'bar-hint', text: 'No Cancelled/Pushed status on the board — add one to enable cancelling.' }),
        el('button', { class: 'btn', text: 'Skip', onclick: () => { tally.skipped++; advance(); } }),
      ]);

      body.append(card, pushRow, actions);
    }

    render();
  }

  // ---- filter bar: Teams (prefix) vs Labels, visually separated ----
  function renderFilterBar() {
    const bar = $('#filter-bar');
    bar.innerHTML = '';
    // Counts reflect the current sprint / My-issues / Help-wanted scope so the
    // numbers next to each team & label track what you're actually viewing.
    const counts = new Map();
    state.board.items.filter(inViewScope).forEach((it) => it.labels.forEach((l) => {
      if (isSprintLabel(l.name)) return; // sprint labels are handled by the sprint bar
      counts.set(l.name, (counts.get(l.name) || 0) + 1);
    }));
    // Keep any active-but-now-zero label visible so you can still toggle it off.
    state.activeLabels.forEach((n) => { if (!counts.has(n)) counts.set(n, 0); });
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

  // ---- data-hygiene warnings (top-right ⚠ button) ----
  // Open, real issues missing a sprint, points, or a date. Done and cancelled
  // work is finished, so it's excluded. Each check is gated on the relevant
  // field actually existing on the board. Backlog items are unscheduled by
  // definition, so their missing start/due dates are not flagged.
  function isBacklog(it) { return (itemStatusName(it) || '').toLowerCase().includes('backlog'); }
  function itemMissing(it) {
    const miss = [];
    if (!itemSprint(it)) miss.push('no sprint');
    if (cfg().pointsField && !(itemPoints(it) > 0)) miss.push('no points');
    if (!isBacklog(it)) {
      if (cfg().startField && !itemStart(it)) miss.push('no start date');
      if (cfg().dueField && !itemDue(it)) miss.push('no due date');
    }
    return miss;
  }
  function warningItems() {
    return (state.board.items || []).filter((it) => {
      if (!it.number || !it.repo) return false;                 // skip drafts
      if (String(it.state || '').toUpperCase() === 'CLOSED') return false;
      if (isDone(it) || isCancelled(it)) return false;
      return itemMissing(it).length > 0;
    });
  }
  function renderWarnBtn() {
    const btn = $('#warn-btn');
    if (!btn) return;
    const items = warningItems();
    btn.classList.toggle('hidden', items.length === 0);
    btn.textContent = `⚠ ${items.length} need${items.length === 1 ? 's' : ''} attention`;
    btn.onclick = openWarningsModal;
  }
  function openWarningsModal() {
    const items = warningItems();
    $('#modal').classList.remove('hidden');
    const body = $('#modal-body');
    body.innerHTML = '';
    const rows = items.map((it) => el('div', { class: 'warn-row', onclick: () => openCardModal(it) }, [
      el('span', { class: 'warn-row-title', text: (it.number ? '#' + it.number + ' ' : '') + it.title }),
      el('span', { class: 'warn-row-tags', text: itemMissing(it).join(' · ') }),
    ]));
    body.append(...[
      modalHeader(el('strong', { text: `Needs attention — ${items.length} issue${items.length === 1 ? '' : 's'}` })),
      el('div', { class: 'bar-hint', text: 'Open issues missing a sprint, points, or a date. Click one to fix it.' }),
      el('div', { class: 'warn-list' }, rows),
    ]);
  }

  // ---- milestone backfill (top-right button, only when there's work to do) ----
  function missingMilestoneCount() {
    if (!cfg().defaultMilestone) return 0;
    return (state.board.items || []).filter((it) =>
      it.number && it.repo && String(it.state || '').toUpperCase() !== 'CLOSED' && !it.milestone).length;
  }
  function renderBackfillBtn() {
    const btn = $('#backfill-btn');
    if (!btn) return;
    const n = missingMilestoneCount();
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = `◎ Set ${cfg().defaultMilestone} (${n})`;
    btn.onclick = runBackfill;
  }
  async function runBackfill() {
    const ms = cfg().defaultMilestone;
    const n = missingMilestoneCount();
    if (!window.confirm(`Assign the "${ms}" milestone to ${n} issue(s) that currently have none?\n\nRepos without a "${ms}" milestone are skipped.`)) return;
    const btn = $('#backfill-btn');
    btn.disabled = true; const old = btn.textContent; btn.textContent = '◎ Working…';
    try {
      const res = await post('/api/milestone-backfill.php', {});
      let msg = `Assigned "${ms}" to ${res.updated} issue(s).`;
      if (res.skippedNoMilestone) msg += `\nSkipped ${res.skippedNoMilestone} (their repo has no "${ms}" milestone: ${(res.missingRepos || []).join(', ')}).`;
      await refresh();
      window.alert(msg);
    } catch (e) {
      showError(e.message);
    } finally { btn.disabled = false; btn.textContent = old; }
  }

  // ---- help-wanted toggle ----
  function renderHelpWantedBtn() {
    const btn = $('#help-wanted-btn');
    if (!btn) return;
    const n = (state.board.items || []).filter(isHelpWanted).length;
    btn.classList.toggle('on', state.filterHelpWanted);
    btn.setAttribute('aria-pressed', state.filterHelpWanted ? 'true' : 'false');
    btn.textContent = `🆘 Help wanted${n ? ' (' + n + ')' : ''}`;
  }

  // Update all top-bar status affordances at once.
  function renderTopControls() { renderWarnBtn(); renderBackfillBtn(); renderHelpWantedBtn(); }

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

    // Website-only snapshots (frozen copies of pushed issues) live in the
    // Cancelled/Pushed column for the sprint they were pushed out of.
    const cancelledOpt = cancelledStatusOption();
    if (cancelledOpt) {
      const col = columns.find((c) => c.optionId === cancelledOpt.id);
      if (col) col.ghosts = visibleSnapshots();
    }

    columns.forEach((col) => root.appendChild(renderColumn(col)));
  }

  function renderColumn(col) {
    const pts = col.items.reduce((s, it) => s + (itemPoints(it) || 0), 0);
    const body = el('div', { class: 'col-body', 'data-option': col.optionId || '' });

    // Sub-issues whose parent is also in this column are embedded as compact
    // rows INSIDE the parent card (no full card of their own). Children whose
    // parent is elsewhere render as normal cards (with a "↳ #parent" hint).
    const inCol = new Set(col.items.map(itemKey));
    const childrenOf = new Map();
    const nested = new Set(); // keys embedded inside a parent in this column
    col.items.forEach((it) => {
      const pk = parentKey(it);
      if (pk && pk !== itemKey(it) && inCol.has(pk)) {
        if (!childrenOf.has(pk)) childrenOf.set(pk, []);
        childrenOf.get(pk).push(it);
        nested.add(itemKey(it));
      }
    });

    const seen = new Set();
    const subList = (it) => {
      const kids = childrenOf.get(itemKey(it)) || [];
      const rows = [];
      kids.forEach((c) => {
        const k = itemKey(c);
        if (seen.has(k)) return; // cycle guard
        seen.add(k);
        const row = el('div', { class: 'subissue' + (isDone(c) ? ' subissue-done' : ''), title: c.title }, [
          el('span', { class: 'subissue-num', text: '#' + c.number }),
          el('span', { class: 'subissue-title', text: c.title }),
          c.blockedBy > 0 ? el('span', { class: 'subissue-flag', title: 'Blocked', text: '⛔' }) : null,
          c.blocking > 0 ? el('span', { class: 'subissue-flag', title: 'Blocking', text: '⚠' }) : null,
        ].filter(Boolean));
        row.addEventListener('click', (e) => { e.stopPropagation(); openCardModal(c); });
        rows.push(row);
        const deeper = subList(c); // grandchildren nest further inside
        if (deeper) rows.push(deeper);
      });
      return rows.length ? el('div', { class: 'card-subissues' }, rows) : null;
    };

    col.items.forEach((it) => {
      if (nested.has(itemKey(it)) || seen.has(itemKey(it))) return; // embedded in a parent
      seen.add(itemKey(it));
      const card = renderCard(it);
      const sub = subList(it);
      if (sub) card.appendChild(sub);
      body.appendChild(card);
    });
    // any items orphaned by a relationship cycle: render flat so nothing vanishes
    col.items.forEach((it) => { if (!seen.has(itemKey(it))) { seen.add(itemKey(it)); body.appendChild(renderCard(it)); } });

    // Website-only snapshots, rendered read-only below the real cards.
    const ghosts = col.ghosts || [];
    if (ghosts.length) {
      body.appendChild(el('div', { class: 'ghost-sep', text: 'Pushed out · website-only' }));
      ghosts.forEach((g) => body.appendChild(renderGhostCard(g)));
    }

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
        el('div', { class: 'col-head-right' }, [
          el('span', { class: 'col-count', text: `${col.items.length} · ${pts} pts` }),
          col.optionId ? el('button', { class: 'col-add', text: '+',
            title: 'New issue in ' + col.name + (state.sprint && state.sprint !== 'all' ? ' · ' + state.sprint : ''),
            onclick: (e) => { e.stopPropagation(); openCreateModal({ status: col.optionId }); } }) : null,
        ].filter(Boolean)),
      ]),
      body,
    ]);
  }

  function renderCard(it) {
    const card = el('div', { class: 'card', draggable: 'true' });
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
      it.assignees.map((a) => avatarEl(personName(a), a.avatarUrl))
    );

    card.appendChild(el('div', { class: 'card-title', text: it.title }));
    card.appendChild(meta);
    if (fieldChips) card.appendChild(fieldChips);
    if (sortedLabels.length) card.appendChild(labels);
    if (it.assignees.length) card.appendChild(avatars);
    return card;
  }

  // Read-only "ghost" card for a website-only snapshot of a pushed issue.
  function renderGhostCard(snap) {
    const card = el('div', { class: 'card ghost-card', title: 'Website-only snapshot (not on GitHub)' });
    card.appendChild(el('div', { class: 'card-title', text: (snap.number ? '#' + snap.number + ' ' : '') + snap.title }));
    card.appendChild(el('div', { class: 'card-meta' }, [
      el('span', { class: 'ghost-badge', text: '👻 pushed' + (snap.pushedTo ? ' → ' + snap.pushedTo : '') }),
      (snap.points != null) ? el('span', { class: 'pts-badge', text: snap.points + ' pts' }) : null,
    ].filter(Boolean)));
    const avatars = el('div', { class: 'card-assignees' }, (snap.assignees || []).map((a) => avatarEl(personName(a), a.avatarUrl)));
    const del = el('button', { class: 'ghost-del', title: 'Remove this website-only snapshot', text: '✕',
      onclick: async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this website-only snapshot? (The real issue is not affected.)')) return;
        try { const r = await post('/api/snapshot.php', { op: 'delete', id: snap.id }); state.board.snapshots = r.snapshots || []; renderBoard(); }
        catch (err) { showError(err.message); }
      } });
    card.appendChild(el('div', { class: 'ghost-foot' }, [avatars, del]));
    if (snap.url) card.addEventListener('click', () => window.open(snap.url, '_blank', 'noopener'));
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
  // reliable across boards. Excludes the given item, pull requests, and closed
  // issues. NOT sprint-filtered: blocked-by / blocking (and parent/sub-issue)
  // relationships routinely cross sprints, so the picker must offer every open
  // board issue regardless of which sprint is currently in view.
  function boardIssueOptions(it) {
    return (state.board.items || [])
      .filter((x) => x.number && x.repo && x.type !== 'PullRequest'
        && String(x.state || '').toUpperCase() !== 'CLOSED'
        && !(x.repo === it.repo && x.number === it.number))
      .map((x) => ({ repo: x.repo, number: x.number, title: x.title || '', sprint: itemSprint(x) }))
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
      return el('label', { class: 'check-row' }, [cb, avatarEl(personName(u), u.avatarUrl), el('span', { text: personName(u) })]);
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
        }
        // Date issue fields (Start date, Target date, …) are intentionally NOT
        // rendered here — the dedicated Start/Due rows above are the only date
        // editors, so the board shows exactly one start and one due date.
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
      }
      // DATE project fields are intentionally NOT rendered here — the dedicated
      // Start/Due rows are the only date editors (one start + one due date).
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
    // label = what the listed issues ARE relative to THIS issue. 'parent' shows
    // this issue's parent (this issue is the sub-issue); 'child' shows this
    // issue's sub-issues (this issue is the parent). Earlier wording ("Parent
    // of" / "Child of") read backwards and made it easy to create them inverted.
    const TYPES = [
      { type: 'parent',    label: 'Parent (this is a sub-issue of)', add: 'Set parent',  placeholder: 'parent #' },
      { type: 'child',     label: 'Sub-issues (nested under this)',  add: 'Add sub-issue', placeholder: 'sub-issue #' },
      { type: 'blockedBy', label: 'Blocked by',                      add: 'Add',           placeholder: 'issue #' },
      { type: 'blocking',  label: 'Blocking',                        add: 'Add',           placeholder: 'issue #' },
    ];
    const wrap = el('div', { class: 'rel-body' }, [el('span', { class: 'bar-hint', text: 'Loading…' })]);

    async function setRel(type, ref, op) {
      await post('/api/relation-set.php', {
        repo: it.repo, number: it.number, targetRepo: ref.repo, targetNumber: ref.number, type, op,
      });
      // The relationship is now saved on GitHub. Re-sync the board, but don't let
      // a refresh hiccup surface as if the relationship itself failed.
      try { await refresh(); } catch (e) { console.error('board refresh after relationship change failed', e); }
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
          .concat(opts.map((o) => el('option', { value: o.repo + '#' + o.number, text: '#' + o.number + ' ' + o.title + (o.sprint ? ' · ' + o.sprint : '') }))));
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
        el('div', { class: 'cmt-body md', html: mdToHtml(c.body || '') }),
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
        el('span', { class: 'view-person' }, [avatarEl(personName(a), a.avatarUrl, { size: 22 }), el('span', { text: personName(a) })])));
    }

    // labels (sprint labels are shown via the Sprint chip, not here)
    const labels = (it.labels || []).filter((l) => !isSprintLabel(l.name));
    const labelsRow = labels.length ? el('div', { class: 'view-labels' }, labels.map(labelPill)) : null;

    const desc = (it.body || '').trim();
    const descBox = desc
      ? el('div', { class: 'view-desc md', html: mdToHtml(desc) })
      : el('div', { class: 'view-desc view-desc-empty' }, ['No description.']);

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
    const delBtn = (it.issueId || it.itemId) ? el('button', { class: 'btn btn-ghost btn-danger', text: '🗑 Delete', title: 'Delete this card', onclick: async () => {
      const isDraft = it.type === 'DraftIssue';
      const label = it.number ? ('issue #' + it.number + ' on GitHub') : ('draft "' + (it.title || '') + '"');
      if (!confirm('Permanently delete ' + label + '? This cannot be undone.')) return;
      delBtn.disabled = true; delBtn.textContent = 'Deleting…';
      try { await post('/api/issue-delete.php', { issueId: it.issueId, itemId: it.itemId, type: it.type }); closeModal(); await refresh(); }
      catch (e) { delBtn.disabled = false; delBtn.textContent = '🗑 Delete'; showError(e.message); }
    } }) : null;
    const header = modalHeader(el('div', {}, [
      it.url ? el('a', { class: 'modal-num', href: it.url, target: '_blank', text: '#' + (it.number || '') }) : null,
      it.repo ? el('span', { class: 'modal-repo', text: ' ' + it.repo }) : null,
    ]), [delBtn, backBtn]);

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

    // Points (or a create-field prompt if the board has no points field)
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
      gridEntries.push({ label: cfg().pointsName, control: pointsInput });
    } else {
      const createBtn = el('button', { class: 'btn', text: `Create "${cfg().pointsName}" field`, onclick: async () => {
        createBtn.disabled = true; createBtn.textContent = 'Creating…';
        try { await post('/api/create-field.php', { name: cfg().pointsName, dataType: 'NUMBER' }); closeModal(); await refresh(); }
        catch (e) { createBtn.disabled = false; createBtn.textContent = `Create "${cfg().pointsName}" field`; showError(e.message); }
      } });
      gridEntries.push({ label: cfg().pointsName, control: el('div', { class: 'grid-create' }, [el('span', { class: 'bar-hint', text: 'No points field.' }), createBtn]) });
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

  // ---- create-mode helpers: same rich controls as the edit modal, but the
  // issue doesn't exist yet, so each returns an apply(res) that persists its
  // values once the issue has been created. ----

  // Issue fields (Priority/Effort/Size/…) + extra Projects v2 custom fields,
  // built empty from the board's field definitions.
  function buildCreateFieldEditors() {
    const entries = [];
    const setters = [];
    const skip = new Set([cfg().statusField, cfg().pointsField, cfg().startField, cfg().dueField].filter(Boolean));

    Object.entries(state.board.issueFields || {}).forEach(([name, def]) => {
      let control;
      if (def.type === 'select') {
        const opts = def.options || [];
        control = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })].concat(opts.map((o) => el('option', { value: o.id, text: o.name }))));
      } else if (def.type === 'number') { control = el('input', { class: 'inp', type: 'number', step: 'any' }); }
      else if (def.type === 'text')     { control = el('input', { class: 'inp', type: 'text' }); }
      // date issue fields are owned by the dedicated Start/Due rows — skip here
      else return;
      entries.push({ label: name, control });
      setters.push({ src: 'issue', kind: def.type, fieldId: def.id, get: () => control.value || null });
    });

    Object.entries(state.board.fields || {}).forEach(([name, meta]) => {
      if (skip.has(name) || (state.board.issueFields || {})[name]) return;
      const dt = String(meta.dataType || '').toUpperCase();
      let control, kind;
      if (dt === 'SINGLE_SELECT') {
        const opts = meta.options || [];
        control = el('select', { class: 'inp' }, [el('option', { value: '', text: '— none —' })].concat(opts.map((o) => el('option', { value: o.id, text: o.name }))));
        kind = 'singleSelect';
      } else if (dt === 'NUMBER') { control = el('input', { class: 'inp', type: 'number', step: 'any' }); kind = 'number'; }
      else if (dt === 'TEXT')     { control = el('input', { class: 'inp', type: 'text' }); kind = 'text'; }
      // DATE fields are owned by the dedicated Start/Due rows — skip here
      else return;
      entries.push({ label: name, control });
      setters.push({ src: 'pv2', kind, fieldId: meta.id, get: () => control.value || null });
    });

    async function apply(res) {
      for (const s of setters) {
        const v = s.get();
        if (v === null || v === '') continue;
        if (s.src === 'issue') await post('/api/issue-field-set.php', { issueId: res.issueId, fieldId: s.fieldId, kind: s.kind, value: v });
        else await post('/api/field.php', { itemId: res.itemId, fieldId: s.fieldId, kind: s.kind, value: v });
      }
    }
    return { entries, apply };
  }

  // Deferred relationship pickers: collect links to add, apply after creation.
  function buildCreateRelations(getRepo) {
    const TYPES = [
      { type: 'parent',    label: 'Parent (this is a sub-issue of)', add: 'Set parent' },
      { type: 'child',     label: 'Sub-issues (nested under this)',  add: 'Add sub-issue' },
      { type: 'blockedBy', label: 'Blocked by',                      add: 'Add' },
      { type: 'blocking',  label: 'Blocking',                        add: 'Add' },
    ];
    const pending = []; // { type, repo, number, title }
    const wrap = el('div', { class: 'rel-body' });
    function render() {
      wrap.innerHTML = '';
      const opts = boardIssueOptions({ repo: getRepo(), number: -1 });
      TYPES.forEach((t) => {
        const list = el('div', { class: 'rel-list' });
        pending.filter((p) => p.type === t.type).forEach((p) => {
          list.appendChild(el('span', { class: 'rel-chip' }, [
            el('span', { class: 'rel-link', text: ((p.repo !== getRepo() ? p.repo : '') + '#' + p.number + ' ' + (p.title || '')).trim() }),
            el('button', { class: 'rel-x', text: '✕', title: 'Remove', onclick: () => { pending.splice(pending.indexOf(p), 1); render(); } }),
          ]));
        });
        const controls = opts.length ? (() => {
          const sel = el('select', { class: 'inp rel-input' }, [el('option', { value: '', text: '— pick an issue —' })]
            .concat(opts.map((o) => el('option', { value: o.repo + '#' + o.number, text: '#' + o.number + ' ' + o.title + (o.sprint ? ' · ' + o.sprint : '') }))));
          const addBtn = el('button', { class: 'btn', text: t.add, onclick: () => {
            const ref = parseIssueRef(sel.value, getRepo());
            if (!ref) { showError('Pick an issue first'); return; }
            const o = opts.find((x) => x.repo === ref.repo && x.number === ref.number);
            pending.push({ type: t.type, repo: ref.repo, number: ref.number, title: o ? o.title : '' });
            render();
          } });
          return el('div', { class: 'field-controls' }, [sel, addBtn]);
        })() : el('span', { class: 'bar-hint', text: 'No other board issues to link.' });
        wrap.appendChild(el('div', { class: 'rel-group' }, [el('div', { class: 'rel-grouplabel', text: t.label }), list, controls]));
      });
    }
    render();
    async function apply(res) {
      for (const p of pending) {
        await post('/api/relation-set.php', { repo: res.repo, number: res.number, targetRepo: p.repo, targetNumber: p.number, type: p.type, op: 'add' });
      }
    }
    return { node: el('div', { class: 'rel-section' }, [el('div', { class: 'field-label', text: 'Relationships' }), wrap]), apply };
  }

  // Deferred "Closes" PR links: collect PR numbers, apply after creation.
  function buildCreatePrs() {
    const pending = [];
    const list = el('div', { class: 'pr-list' });
    const input = el('input', { class: 'inp', type: 'number', placeholder: 'PR #', style: 'width:90px' });
    function render() {
      list.innerHTML = '';
      if (!pending.length) { list.appendChild(el('span', { class: 'bar-hint', text: 'No PRs queued.' })); return; }
      pending.forEach((n) => list.appendChild(el('div', { class: 'pr-row' }, [
        el('span', { class: 'pr-link', text: '#' + n + ' (Closes)' }),
        el('button', { class: 'rel-x', text: '✕', title: 'Remove', onclick: () => { pending.splice(pending.indexOf(n), 1); render(); } }),
      ])));
    }
    const addBtn = el('button', { class: 'btn', text: 'Attach (Closes)', onclick: () => {
      const n = parseInt((input.value || '').trim(), 10);
      if (!n) return;
      if (!pending.includes(n)) pending.push(n);
      input.value = ''; render();
    } });
    render();
    async function apply(res) {
      for (const n of pending) await post('/api/pr-link.php', { repo: res.repo, issueNumber: res.number, prNumber: n, keyword: 'Closes' });
    }
    return { node: el('div', { class: 'pr-section' }, [el('div', { class: 'field-label', text: 'Pull requests' }), list, el('div', { class: 'field-controls' }, [input, addBtn])]), apply };
  }

  // ---- create-issue modal (same interface as edit) ----
  function boardRepos() {
    const set = new Set();
    state.board.items.forEach((it) => { if (it.repo) set.add(it.repo); });
    return Array.from(set).sort();
  }

  function openCreateModal(preset) {
    preset = preset || {};
    $('#modal').classList.remove('hidden');
    const body = $('#modal-body');
    body.innerHTML = '';

    const repos = boardRepos();
    const repoSel = repos.length ? el('select', { class: 'inp' }, repos.map((r) => el('option', { value: r, text: r })))
                                 : el('input', { class: 'inp', type: 'text', placeholder: 'owner/repo' });
    const repoVal = () => (repos.length ? repoSel.value : repoSel.value.trim());

    // Default the sprint to the one currently selected on the board (unless the
    // caller overrides it); default the status when launched from a column's +.
    const sprintDefault = preset.sprint != null ? preset.sprint : (state.sprint && state.sprint !== 'all' ? state.sprint : '');

    const titleInput = el('input', { class: 'modal-title-input', placeholder: 'Issue title' });
    const bodyInput = el('textarea', { class: 'modal-body-input', rows: '6', placeholder: 'Description (optional)' });
    const statusSel = buildStatusSelect(preset.status || '');
    const sprintSel = buildSprintSelect(sprintDefault);
    const pointsInput = cfg().pointsField ? el('input', { class: 'inp', type: 'number', step: '0.5', placeholder: 'pts' }) : null;
    const startInput = cfg().startField ? el('input', { class: 'inp', type: 'date' }) : null;
    const dueInput = cfg().dueField ? el('input', { class: 'inp', type: 'date' }) : null;

    // Rich controls matching the edit modal (applied right after creation).
    const fieldEditors = buildCreateFieldEditors();
    const createRels = buildCreateRelations(repoVal);
    const createPrs = buildCreatePrs();

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
      // Default the milestone to the configured phase (e.g. "Phase 1") when the
      // repo has a milestone with that title.
      const def = (cfg().defaultMilestone || '').toLowerCase();
      const defMs = def ? meta.milestones.find((m) => (m.title || '').toLowerCase() === def) : null;
      msSel = buildMilestoneSelect(meta.milestones, defMs || null);
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
        await fieldEditors.apply(res); // Priority/Effort/Size + custom fields
        await createRels.apply(res);   // relationships
        await createPrs.apply(res);    // linked PRs
      } catch (e) {
        // Issue is already created and on the board; a field-setting step failed.
        showError('Issue created, but some fields could not be set: ' + e.message);
      }
      closeModal();
      await refresh();
    } });

    const createGrid = el('div', { class: 'field-grid' }, [
      gridField('Status', statusSel),
      pointsInput ? gridField(cfg().pointsName, pointsInput) : null,
      startInput ? gridField('Start date', startInput) : null,
      dueInput ? gridField('Due date', dueInput) : null,
      gridField('Sprint', sprintSel),
    ].concat(fieldEditors.entries.map((e) => gridField(e.label, e.control))).filter(Boolean));

    body.append(...[
      modalHeader(el('strong', { text: 'New issue' })),
      fieldRow('Repo', repoSel),
      titleInput,
      createGrid,
      dyn,
      createRels.node,
      createPrs.node,
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
    const totalsCards = [
      statCard('Completed', `${t.doneCount} tasks`),
      statCard('Completed points', `${t.donePoints}`),
      statCard('Open', `${t.openCount} tasks`),
      statCard('Open points', `${t.openPoints}`),
    ];
    if (t.cancelledCount) {
      totalsCards.push(statCard('Cancelled/Pushed', `${t.cancelledCount} tasks`, 'stat-cancelled'));
      totalsCards.push(statCard('Cancelled points', `${t.cancelledPoints}`, 'stat-cancelled'));
    }
    root.appendChild(el('div', { class: 'stats-totals' }, totalsCards));

    // unassigned always sorted last
    const people = data.perPerson.slice().sort((a, b) => {
      const ua = a.login === '(unassigned)' ? 1 : 0;
      const ub = b.login === '(unassigned)' ? 1 : 0;
      return (ua - ub) || (b.donePoints - a.donePoints) || (b.doneCount - a.doneCount);
    });

    // Commits × points graph (commits fetched separately so the table shows fast).
    const chartHost = el('div', { class: 'stats-chart-host' }, [el('div', { class: 'loading', text: 'Loading commit activity…' })]);
    root.appendChild(el('div', { class: 'stats-section' }, [
      el('h3', { class: 'stats-h3', text: 'Commits & points per person' }),
      chartHost,
    ]));

    const anyCancelled = people.some((p) => p.cancelledCount);
    const table = el('table', { class: 'stats-table' });
    table.appendChild(el('tr', {}, [
      el('th', { text: 'Person' }), el('th', { text: 'Done' }), el('th', { text: 'Done pts' }),
      el('th', { text: 'Open' }), el('th', { text: 'Open pts' }),
      anyCancelled ? el('th', { text: 'Cancelled' }) : null,
      el('th', { text: 'Total pts' }),
    ].filter(Boolean)));
    people.forEach((p) => {
      const unassigned = p.login === '(unassigned)';
      table.appendChild(el('tr', { class: unassigned ? 'row-unassigned' : '' }, [
        el('td', {}, [avatarEl(unassigned ? 'unassigned' : personName(p), p.avatarUrl, { unassigned }),
          el('span', { text: ' ' + (unassigned ? 'Unassigned' : personName(p)) })]),
        el('td', { text: String(p.doneCount) }),
        el('td', { class: 'strong', text: String(p.donePoints) }),
        el('td', { text: String(p.openCount) }),
        el('td', { text: String(p.openPoints) }),
        anyCancelled ? el('td', { class: 'cell-cancelled', text: p.cancelledCount ? `${p.cancelledCount} · ${p.cancelledPoints} pts` : '—' }) : null,
        el('td', { text: String(p.totalPoints) }),
      ].filter(Boolean)));
    });
    root.appendChild(table);

    // Fetch commit activity and render the graph (points come from the stats we
    // already have; commits from the contributions endpoint). Done after the
    // table so a slow commit scan never blocks the numbers.
    const pointsByLogin = new Map(people.filter((p) => p.login !== '(unassigned)').map((p) => [p.login, p]));
    api('/api/contributions.php?sprint=' + encodeURIComponent(state.sprint))
      .then((c) => renderContribChart(chartHost, pointsByLogin, c))
      .catch((e) => { chartHost.innerHTML = ''; chartHost.appendChild(el('div', { class: 'bar-hint', text: 'Could not load commit activity: ' + e.message })); });
  }

  // Grouped horizontal bar chart: per person, a commits bar and a points bar.
  // Each series is scaled to its own max (commits and points aren't comparable
  // units) and labelled with the raw value.
  function renderContribChart(host, pointsByLogin, contrib) {
    host.innerHTML = '';
    const byLogin = new Map();
    const upsert = (login, name, avatarUrl) => {
      if (!byLogin.has(login)) byLogin.set(login, { login, name: name || login, avatarUrl: avatarUrl || null, commits: 0, points: 0 });
      return byLogin.get(login);
    };
    (contrib.perPerson || []).forEach((p) => { const r = upsert(p.login, p.name, p.avatarUrl); r.commits = p.commits || 0; });
    pointsByLogin.forEach((p, login) => { const r = upsert(login, personName(p), p.avatarUrl); r.points = p.totalPoints || 0; });

    const rows = Array.from(byLogin.values())
      .filter((r) => r.commits > 0 || r.points > 0)
      .sort((a, b) => (b.commits - a.commits) || (b.points - a.points));

    if (!rows.length) { host.appendChild(el('div', { class: 'bar-hint', text: 'No commits or points in this scope.' })); return; }

    const maxC = Math.max(1, ...rows.map((r) => r.commits));
    const maxP = Math.max(1, ...rows.map((r) => r.points));

    host.appendChild(el('div', { class: 'chart-legend' }, [
      el('span', { class: 'chart-key' }, [el('span', { class: 'chart-swatch swatch-commits' }), el('span', { text: 'Commits' })]),
      el('span', { class: 'chart-key' }, [el('span', { class: 'chart-swatch swatch-points' }), el('span', { text: 'Points' })]),
    ]));

    const chart = el('div', { class: 'contrib-chart' });
    rows.forEach((r) => {
      const bar = (val, max, cls) => el('div', { class: 'contrib-track' }, [
        el('div', { class: 'contrib-bar ' + cls, style: `width:${Math.round((val / max) * 100)}%` }),
        el('span', { class: 'contrib-val', text: String(val) }),
      ]);
      chart.appendChild(el('div', { class: 'contrib-row' }, [
        el('div', { class: 'contrib-name' }, [avatarEl(r.name, r.avatarUrl, { size: 18 }), el('span', { text: ' ' + r.name })]),
        el('div', { class: 'contrib-bars' }, [bar(r.commits, maxC, 'bar-commits'), bar(r.points, maxP, 'bar-points')]),
      ]));
    });
    host.appendChild(chart);

    if (contrib.truncated) host.appendChild(el('div', { class: 'bar-hint', text: 'Commit counts are a lower bound (very active repos are page-capped).' }));
    else if (contrib.range) host.appendChild(el('div', { class: 'bar-hint', text: 'Commits within the selected sprint’s dates.' }));
  }

  function statCard(label, value, extra) {
    return el('div', { class: 'stat-card' + (extra ? ' ' + extra : '') }, [el('div', { class: 'stat-value', text: value }), el('div', { class: 'stat-label', text: label })]);
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
      el('div', { class: 'tl-assignees' }, it.assignees.map((a) => avatarEl(personName(a), a.avatarUrl))),
    ]);
    return row;
  }

  // ---- roster view ----
  async function saveRoster(payload) {
    const res = await post('/api/roster.php', payload);
    if (res && res.roster) state.board.roster = res.roster;
    renderSprintBar(); // capacity changed -> target velocities change
  }
  // weekly hours for one team (git members counted once + manual hours)
  function teamWeeklyHours(team) {
    let h = 0;
    teamMembers(team).forEach((m) => { h += personWeeklyHours(m.login); });
    teamManualEntries(team).forEach((e) => { h += Number(e.hours) || 0; });
    return h;
  }

  function renderRoster() {
    const root = $('#roster-view');
    root.innerHTML = '';

    const teams = teamNames();
    const selSprint = state.sprint !== 'all' ? allSprints().find((s) => s.name === state.sprint) : null;
    const weeks = selSprint ? sprintWeeks(selSprint) : null;

    // Velocity = points. Convert capacity hours -> points via hours-per-point.
    const hpp = hoursPerPoint();
    const totalWeeklyHours = weeklyCapacity(null);
    const asPts = (hours) => hpp > 0 ? Math.round(hours / hpp) : null;
    const velText = (hours) => {
      const p = asPts(hours);
      return p != null ? `${p} pts` : `${Math.round(hours)}h`;
    };

    // hours-per-point control
    const hppInput = el('input', { class: 'inp roster-hrs', type: 'number', min: '0', step: '0.5', value: hpp || '', placeholder: '—' });
    hppInput.addEventListener('change', async () => {
      try { await saveRoster({ op: 'setHoursPerPoint', value: hppInput.value === '' ? 0 : parseFloat(hppInput.value) }); renderRoster(); }
      catch (e) { showError(e.message); }
    });

    const totalWeeklyPts = asPts(totalWeeklyHours);
    root.appendChild(el('div', { class: 'roster-head' }, [
      el('h2', { class: 'stats-scope', text: 'Roster' }),
      el('div', { class: 'roster-cap' }, [
        el('span', { class: 'roster-cap-val', text: totalWeeklyPts != null ? `${totalWeeklyPts} pts / wk` : `${Math.round(totalWeeklyHours)}h / wk` }),
        el('span', { class: 'bar-hint', text: 'total target velocity' + (selSprint ? ` (${state.sprint}: ${velText(totalWeeklyHours * weeks)})` : ' per week') }),
      ]),
      el('label', { class: 'roster-hpp' }, [
        el('span', { class: 'field-label', text: 'Hours per point' }),
        hppInput,
      ]),
    ]));
    root.appendChild(el('div', { class: 'bar-hint roster-note', text:
      (hpp > 0 ? '' : 'Set “hours per point” to convert capacity into velocity (points). ')
      + 'Weekly hours are per person and shared across every team they’re on. Use “+ add person” for teammates who aren’t on GitHub.' }));

    if (!teams.length) {
      root.appendChild(el('div', { class: 'loading', text: 'No teams found. Add a "' + teamPrefix() + '<name>" label to issues to define teams.' }));
      return;
    }

    teams.forEach((team) => {
      const members = teamMembers(team);
      const manual = teamManualEntries(team);
      const weekly = teamWeeklyHours(team);

      const card = el('div', { class: 'roster-team' });
      card.appendChild(el('div', { class: 'roster-team-head' }, [
        el('span', { class: 'roster-team-name', text: '👥 ' + teamDisplay(team) }),
        el('span', { class: 'roster-team-vel', title: `Team velocity — ${weekly}h/wk capacity`,
          text: velText(weekly) + '/wk' + (selSprint ? ` · ${velText(weekly * weeks)} in ${state.sprint}` : '') }),
      ]));

      const rows = el('div', { class: 'roster-rows' });

      // GitHub members
      members.forEach((m) => {
        const hrs = el('input', { class: 'inp roster-hrs', type: 'number', min: '0', step: '0.5', value: personWeeklyHours(m.login) || '' });
        hrs.addEventListener('change', async () => {
          try { await saveRoster({ op: 'setPersonHours', login: m.login, hours: hrs.value === '' ? 0 : parseFloat(hrs.value) }); renderRoster(); }
          catch (e) { showError(e.message); }
        });
        rows.appendChild(el('div', { class: 'roster-row' }, [
          el('div', { class: 'roster-person' }, [avatarEl(personName(m), m.avatarUrl, { size: 22 }), el('span', { text: ' ' + personName(m) })]),
          el('label', { class: 'roster-hrs-field' }, [hrs, el('span', { class: 'roster-hrs-unit', text: 'h/wk' })]),
        ]));
      });
      if (!members.length && !manual.length) rows.appendChild(el('div', { class: 'bar-hint', text: 'No one assigned to this team’s issues yet.' }));

      // Manual (non-git) members — editable list with add/remove.
      const commitManual = async (entries) => {
        try { await saveRoster({ op: 'setTeamExtra', team, entries }); renderRoster(); }
        catch (e) { showError(e.message); }
      };
      manual.forEach((e, i) => {
        const nameInp = el('input', { class: 'inp roster-name', type: 'text', value: e.name });
        const hrs = el('input', { class: 'inp roster-hrs', type: 'number', min: '0', step: '0.5', value: e.hours || '' });
        const save = () => { const next = manual.slice(); next[i] = { name: nameInp.value.trim(), hours: hrs.value === '' ? 0 : parseFloat(hrs.value) }; commitManual(next); };
        nameInp.addEventListener('change', save);
        hrs.addEventListener('change', save);
        const del = el('button', { class: 'ghost-del', text: '✕', title: 'Remove', onclick: () => { const next = manual.slice(); next.splice(i, 1); commitManual(next); } });
        rows.appendChild(el('div', { class: 'roster-row roster-manual' }, [
          el('div', { class: 'roster-person' }, [el('span', { class: 'roster-nongit', text: '○' }), nameInp]),
          el('label', { class: 'roster-hrs-field' }, [hrs, el('span', { class: 'roster-hrs-unit', text: 'h/wk' }), del]),
        ]));
      });

      // Add-person row
      const addName = el('input', { class: 'inp roster-name', type: 'text', placeholder: 'name (not on GitHub)' });
      const addHrs = el('input', { class: 'inp roster-hrs', type: 'number', min: '0', step: '0.5', placeholder: 'h' });
      const addBtn = el('button', { class: 'btn', text: '+ add person', onclick: () => {
        const name = addName.value.trim();
        if (!name) { showError('Enter a name'); return; }
        commitManual(manual.concat([{ name, hours: addHrs.value === '' ? 0 : parseFloat(addHrs.value) }]));
      } });
      rows.appendChild(el('div', { class: 'roster-row roster-add' }, [
        el('div', { class: 'roster-person' }, [addName]),
        el('div', { class: 'roster-hrs-field' }, [addHrs, addBtn]),
      ]));

      card.appendChild(rows);
      root.appendChild(card);
    });
  }

  // ---- view switching ----
  function setView(v) {
    state.view = v;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    $('#board-view').classList.toggle('hidden', v !== 'board');
    $('#timeline-view').classList.toggle('hidden', v !== 'timeline');
    $('#stats-view').classList.toggle('hidden', v !== 'stats');
    $('#roster-view').classList.toggle('hidden', v !== 'roster');
    if (v === 'stats') renderStats();
    if (v === 'timeline') renderTimeline();
    if (v === 'roster') renderRoster();
  }

  // re-render whichever view is active (used after filter/sprint changes)
  function rerender() {
    renderFilterBar();  // team/label counts track the current sprint & toggles
    renderSprintBar();  // sprint points + target velocity track the team filter
    renderBoard();
    if (state.view === 'timeline') renderTimeline();
    else if (state.view === 'stats') renderStats();
    else if (state.view === 'roster') renderRoster();
  }

  // ---- refresh from GitHub ----
  async function refresh() {
    const btn = $('#refresh-btn');
    const old = btn.textContent; btn.textContent = '↻ …'; btn.disabled = true;
    try {
      state.board = await api('/api/board.php');
      renderSprintBar(); renderFilterBar(); renderBoard(); renderTopControls();
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
      chip.appendChild(avatarEl(personName(state.me), state.me.avatarUrl));
      chip.appendChild(el('span', { text: ' ' + personName(state.me) }));

      state.board = await api('/api/board.php');
      $('#loading').classList.add('hidden');
      if (cfg().projectTitle) $('#project-title').textContent = cfg().projectTitle;

      // default the sprint filter to the current ("now") sprint, if any
      const now = currentSprintName();
      if (now) state.sprint = now;

      renderSprintBar();
      renderFilterBar();
      renderBoard();
      renderTopControls();
    } catch (e) {
      $('#loading').classList.add('hidden');
      showError('Failed to load: ' + e.message);
    }

    $('#filter-mine').addEventListener('change', (e) => { state.filterMine = e.target.checked; rerender(); });
    $('#help-wanted-btn').addEventListener('click', () => {
      state.filterHelpWanted = !state.filterHelpWanted;
      renderHelpWantedBtn();
      rerender();
    });
    $('#refresh-btn').addEventListener('click', refresh);
    $('#new-issue-btn').addEventListener('click', () => openCreateModal());
    $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
    $('#modal').addEventListener('click', (e) => { if (e.target.classList.contains('modal-backdrop')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
