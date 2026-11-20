// Entry Radar page. Reads window.RADAR (data.js, written by main.ts from board.json's own rows),
// renders the ranked board, filters, a per-protocol detail with the value breakdown and farm plan,
// and a live-token view that sits traded protocols apart. No network, no framework.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };
  var state = { q: '', cat: 'all', chain: 'all', tvl: '0', wl: false, sort: 'rank', dir: -1, tab: 'pre', p: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n) { return n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 730) return Math.round(d / 365 * 10) / 10 + 'y';
    if (d >= 60) return Math.round(d / 30.4) + 'mo';
    return d + 'd';
  }

  function impliedOf(row) {
    var m = D.model;
    var g = row.change_7d === null || row.change_7d === undefined ? null : Math.min(m.growth_cap, Math.max(m.growth_floor, row.change_7d));
    var growthMult = g === null ? 1 : 1 + (g / 100) * m.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var ageMult = m.age_floor + (Math.min(Math.max(age, 0), m.age_cap_days) / m.age_cap_days) * m.age_range;
    var breadth = 1 + m.breadth_weight * Math.min(row.chains.length, m.breadth_cap_chains);
    return Math.max(1, Math.round(row.tvl_usd * row.factors.sector_multiple * growthMult * ageMult * breadth));
  }

  var maxTvl = 1;
  D.rows.forEach(function (r) { if (r.tvl_usd > maxTvl) maxTvl = r.tvl_usd; });

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  function chainChains(r, cap) {
    var chips = r.chains.slice(0, cap).map(function (c) { return el('span', { class: 'chain-chip', title: c, text: c }); });
    if (r.chains.length > cap) chips.push(el('span', { class: 'more', text: '+' + (r.chains.length - cap) }));
    return chips.length ? chips : [el('span', { class: 'more', text: '—' })];
  }

  function sparkBars(r) {
    var g = r.change_7d === null ? 0 : Math.min(D.model.growth_cap, Math.max(D.model.growth_floor, r.change_7d));
    var bars = [
      r.tvl_usd / maxTvl,
      (g - D.model.growth_floor) / (D.model.growth_cap - D.model.growth_floor),
      Math.min(r.age_days === null ? D.model.unknown_age_days : r.age_days, D.model.age_cap_days) / D.model.age_cap_days,
      Math.min(r.chains.length, D.model.breadth_cap_chains) / D.model.breadth_cap_chains
    ];
    return el('span', { class: 'spark', title: 'Signal: TVL, 7d momentum, no-token age, chain reach', 'aria-hidden': 'true' },
      bars.map(function (b) { return el('i', { style: 'height:' + Math.max(3, Math.round(b * 22)) + 'px' }); }));
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var min = Number(state.tvl) || 0;
    return D.rows.filter(function (r) {
      if (state.wl && !r.on_watchlist) return false;
      if (state.cat !== 'all' && (r.category || 'Unclassified') !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < min) return false;
      if (!q) return true;
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function sorted(list) {
    var k = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'sector') { av = a.factors.sector_label + a.category; bv = b.factors.sector_label + b.category; }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'growth') { av = a.change_7d === null ? -1e9 : a.change_7d; bv = b.change_7d === null ? -1e9 : b.change_7d; }
      else if (k === 'age') { av = a.age_days === null ? -1 : a.age_days; bv = b.age_days === null ? -1 : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function maxImpliedOf(list) {
    var m = 1;
    list.forEach(function (r) { if (r.implied_value_usd > m) m = r.implied_value_usd; });
    return m;
  }

  function renderRows() {
    var tbody = $('rows');
    tbody.textContent = '';
    var list = sorted(filtered());
    $('count').textContent = state.tab === 'pre'
      ? list.length + ' of ' + D.rows.length + ' protocols shown'
      : D.live.length + ' protocols already trade';
    $('board-panel').hidden = state.tab !== 'pre';
    $('live-panel').hidden = state.tab !== 'live';
    $('model-panel').hidden = state.tab !== 'pre';
    if (state.tab !== 'pre') return;
    var max = maxImpliedOf(list);
    if (list.length === 0) { $('empty').hidden = false; return; }
    $('empty').hidden = true;
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var growth = r.change_7d;
      frag.appendChild(el('tr', {
        tabindex: '0',
        'data-open': state.p === r.slug ? 'true' : null,
        'data-top': r.rank <= 10 ? '1' : null,
        title: r.name + ' — open the breakdown and farm plan',
        onclick: function () { location.hash = 'p=' + encodeURIComponent(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'p=' + encodeURIComponent(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', { class: 'proto' }, el('b', { text: r.name }), el('span', { class: 'slug', text: r.slug })),
        el('td', null, el('span', { class: 'chip', text: r.factors.sector_label })),
        el('td', null, chainChains(r, 2)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (growth === null ? '' : growth >= 0 ? 'pos' : 'neg'), text: fmtPct(growth) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })),
          el('span', { class: 'v', text: fmtUsd(r.implied_value_usd) }))),
        el('td', null, sparkBars(r)),
        el('td', null, r.on_watchlist ? el('span', { class: 'wl-pill', text: 'WATCHLIST' }) : el('span', { class: 'more', text: 'radar' }))
      ));
    });
    tbody.appendChild(frag);
  }

  function renderLive() {
    var tbody = $('live-rows');
    tbody.textContent = '';
    D.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'proto' }, el('b', { text: r.name }), el('span', { class: 'slug', text: r.slug })),
        el('td', null, el('span', { class: 'chip', text: r.category || 'Unclassified' })),
        el('td', null, chainChains(r, 2)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'live-pill', text: 'TOKEN LIVE' }))
      ));
    });
  }

  function renderChrome() {
    $('meta').textContent = '';
    $('meta').appendChild(el('span', null, 'Snapshot ', el('b', { text: D.as_of }), ' · fetched ', el('b', { text: (D.fetched || '').replace('T', ' ').slice(0, 16) + 'Z' })));
    $('meta').appendChild(el('span', null, 'Model ', el('b', { text: D.model_version }), ' · ', el('b', { text: D.model_name })));
    $('meta').appendChild(el('span', { text: 'Sealed DefiLlama input — the page makes no network request' }));

    var stats = $('stats');
    stats.textContent = '';
    var mid = D.rows[Math.floor(D.rows.length / 2) - 1];
    var ages = D.rows.map(function (r) { return r.age_days === null ? D.model.unknown_age_days : r.age_days; }).sort(function (a, b) { return a - b; });
    var covered = D.rows.filter(function (r) { return r.on_watchlist; }).length;
    stats.appendChild(el('div', { class: 'stat' }, el('div', { class: 'k', text: 'Protocols ranked' }), el('div', { class: 'v', text: String(D.rows.length) }), el('div', { class: 's', text: 'every pre-token protocol on record' })));
    stats.appendChild(el('div', { class: 'stat' }, el('div', { class: 'k', text: 'Watchlist covered' }), el('div', { class: 'v pos', text: covered + ' / ' + D.watchlist_size }), el('div', { class: 's', text: 'floor $' + Math.round(D.floor_usd / 1e6) + 'M TVL, no token' })));
    stats.appendChild(el('div', { class: 'stat' }, el('div', { class: 'k', text: 'Top implied value' }), el('div', { class: 'v', text: fmtUsd(D.rows[0].implied_value_usd) }), el('div', { class: 's', text: D.rows[0].name + ', rank 1' })));
    stats.appendChild(el('div', { class: 'stat' }, el('div', { class: 'k', text: 'Median no-token age' }), el('div', { class: 'v', text: fmtAge(ages[Math.floor(ages.length / 2)]) }), el('div', { class: 's', text: 'mid-board: rank ' + mid.rank + ', ' + fmtUsd(mid.implied_value_usd) })));

    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Unclassified'; }))).sort();
    var chains = Array.from(new Set(D.rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
    var catSel = $('f-cat'), chainSel = $('f-chain');
    cats.forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
    chains.forEach(function (c) { chainSel.appendChild(el('option', { value: c, text: c })); });

    var f = $('formula');
    f.textContent = '';
    f.appendChild(document.createTextNode('implied_value_usd = tvl_usd × sector_multiple × ('));
    f.appendChild(el('b', { text: '1 + 0.4 × clamp(7d growth, −60%, +150%)' }));
    f.appendChild(document.createTextNode(') × ('));
    f.appendChild(el('b', { text: '0.85 + 0.4 × min(age, 3y)/3y' }));
    f.appendChild(document.createTextNode(') × ('));
    f.appendChild(el('b', { text: '1 + 0.025 × min(chains, 12)' }));
    f.appendChild(document.createTextNode(')'));

    var sec = $('sectors');
    sec.textContent = '';
    D.sectors.forEach(function (s) {
      sec.appendChild(el('div', { class: 'sector' },
        el('span', { text: s.label }),
        el('span', { class: 'm', text: '× ' + s.multiple.toFixed(2) }),
        el('span', { class: 'n', text: s.note })));
    });
    $('model-note').textContent = 'TVL, 7-day growth, listing age and chain count come from the sealed snapshot; the same function scores every protocol and no name is special-cased. Age unknown to DefiLlama scores as 365 days. Implied value is this entry\'s own claim about a launch that has not happened — it is not a price and not a prediction that a token comes.';
    $('foot').textContent = 'Entry Radar · board.json rows rendered verbatim · data: ' + D.source_note + ', fetched ' + (D.fetched || D.as_of) + ' · offline page, no network requests';
  }

  function splitStep(s) {
    var c = s.indexOf(' Cost: ');
    if (c < 0) return { act: s, cost: '', time: '' };
    var rest = s.slice(c + 7);
    var t = rest.indexOf('. Time: ');
    if (t < 0) return { act: s.slice(0, c), cost: rest, time: '' };
    return { act: s.slice(0, c), cost: rest.slice(0, t), time: rest.slice(t + 8).replace(/\.$/, '') };
  }

  function sigRow(label, frac, value) {
    return el('div', { class: 'sig' },
      el('span', { text: label }),
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(frac * 100)) + '%' })),
      el('b', { text: value }));
  }

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) return;
    var dlg = $('detail');
    dlg.textContent = '';
    var recomputed = impliedOf(r);
    var f = r.factors;
    dlg.appendChild(el('div', { class: 'detail-body' },
      el('div', { class: 'd-head' },
        el('div', null,
          el('div', { class: 'd-rank', text: 'RANK ' + r.rank + ' OF ' + D.rows.length }),
          el('h2', { id: 'd-title', text: r.name }),
          el('div', { class: 'd-sub' },
            el('span', { class: 'slug', text: r.slug }),
            el('span', { class: 'chip', text: r.category || 'Unclassified' }),
            r.on_watchlist ? el('span', { class: 'wl-pill', text: 'WATCHLIST' }) : el('span', { class: 'more', text: 'radar find' }),
            el('span', { text: r.chains.join(', ') || 'no chain on record' }))),
        el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dlg.close(); } })),
      el('section', { class: 'd-section d-value' },
        el('h3', { text: 'Implied value breakdown' }),
        el('div', { class: 'kv' }, el('span', { text: 'TVL on record' }), el('b', { text: fmtUsd(r.tvl_usd) })),
        el('div', { class: 'kv' }, el('span', { text: 'Sector — ' + f.sector_label }), el('b', { class: 'mul', text: '× ' + f.sector_multiple.toFixed(2) })),
        el('div', { class: 'why', text: f.sector_note }),
        el('div', { class: 'kv' }, el('span', { text: '7d momentum ' + fmtPct(f.growth_pct) }), el('b', { class: 'mul', text: '× ' + f.growth_mult.toFixed(3) })),
        el('div', { class: 'kv' }, el('span', { text: 'No-token age ' + fmtAge(r.age_days) + (r.listed_at ? ' (since ' + r.listed_at + ')' : ' (unlisted)') }), el('b', { class: 'mul', text: '× ' + f.age_mult.toFixed(3) })),
        el('div', { class: 'kv' }, el('span', { text: 'Chain reach × ' + Math.min(r.chains.length, D.model.breadth_cap_chains) }), el('b', { class: 'mul', text: '× ' + f.breadth_mult.toFixed(3) })),
        el('div', { class: 'kv total' }, el('span', { text: 'Implied value at launch' }), el('b', { text: fmtUsd(r.implied_value_usd) })),
        el('div', { class: 'why', text: 'The page recomputes this row from the same figures as ' + fmtUsd(recomputed) + (recomputed === r.implied_value_usd ? ' — the same number board.json carries.' : ', which differs from the board: the data is stale.') + ' An estimate of value if the record stays as it is, never a promise of a launch.' })),
      el('section', { class: 'd-section d-sigs' },
        el('h3', { text: 'Signal profile' }),
        el('div', { class: 'sigs' },
          sigRow('TVL depth', r.tvl_usd / maxTvl, fmtUsd(r.tvl_usd)),
          sigRow('7d momentum', (Math.min(f.growth_pct === null ? 0 : f.growth_pct, 150) + 60) / 210, fmtPct(f.growth_pct)),
          sigRow('No-token age', Math.min(r.age_days === null ? D.model.unknown_age_days : r.age_days, D.model.age_cap_days) / D.model.age_cap_days, fmtAge(r.age_days)),
          sigRow('Chain reach', Math.min(r.chains.length, D.model.breadth_cap_chains) / D.model.breadth_cap_chains, r.chains.length + (r.chains.length === 1 ? ' chain' : ' chains')))),
      el('section', { class: 'd-section d-plan' },
        el('h3', { text: 'Farm plan' }),
        el('ol', { class: 'steps' }, r.farm_steps.map(function (s) {
          var p = splitStep(s);
          return el('li', null, el('div', { text: p.act }),
            el('div', { class: 'meta-line' },
              p.cost ? el('span', { class: 'tag', text: 'Cost: ' + p.cost }) : null,
              p.time ? el('span', { class: 'tag amber', text: 'Time: ' + p.time }) : null));
        })),
        el('div', { class: 'why', text: 'Sized from the protocol\'s own TVL and age; the same derivation wrote these steps into board.json.' })),
      el('div', { class: 'd-foot', text: 'Model ' + D.model_version + ' (' + D.model_name + ') · snapshot ' + D.as_of + ' · figures are this entry\'s claim, not a market price.' })
    ));
    if (typeof dlg.showModal === 'function') { if (!dlg.open) dlg.showModal(); }
    else dlg.setAttribute('open', '');
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var p = new URLSearchParams(h);
    state.q = p.get('q') || '';
    state.cat = p.get('cat') || 'all';
    state.chain = p.get('chain') || 'all';
    state.tvl = p.get('tvl') || '0';
    state.wl = p.get('wl') === '1';
    state.sort = p.get('sort') || 'rank';
    if (['rank', 'name', 'sector', 'tvl', 'growth', 'age'].indexOf(state.sort) < 0) state.sort = 'rank';
    state.dir = p.get('dir') === '1' ? 1 : -1;
    state.tab = p.get('tab') === 'live' ? 'live' : 'pre';
    state.p = p.get('p');
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tvl !== '0') p.set('tvl', state.tvl);
    if (state.wl) p.set('wl', '1');
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir === 1) p.set('dir', '1');
    if (state.tab !== 'pre') p.set('tab', state.tab);
    if (state.p) p.set('p', state.p);
    var s = p.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }

  function syncControls() {
    $('f-q').value = state.q;
    $('f-cat').value = state.cat;
    $('f-chain').value = state.chain;
    $('f-tvl').value = state.tvl;
    $('f-wl').checked = state.wl;
    $('tab-pre').setAttribute('aria-selected', state.tab === 'pre' ? 'true' : 'false');
    $('tab-live').setAttribute('aria-selected', state.tab === 'live' ? 'true' : 'false');
    document.querySelectorAll('th[data-key]').forEach(function (th) {
      th.setAttribute('data-sorted', th.getAttribute('data-key') === state.sort ? '1' : '0');
      var b = th.querySelector('.th-sort');
      b.textContent = b.textContent.replace(/ [▲▼]$/, '');
      if (th.getAttribute('data-key') === state.sort) b.textContent += state.dir === 1 ? ' ▲' : ' ▼';
    });
  }

  function render() {
    syncControls();
    renderRows();
    if (!$('live-rows').childNodes.length) renderLive();
    if (state.p) openDetail(state.p);
    else { var d = $('detail'); if (d.open) d.close(); }
  }

  $('f-q').addEventListener('input', function () { state.q = this.value; writeHash(); renderRows(); });
  $('f-cat').addEventListener('change', function () { state.cat = this.value; writeHash(); renderRows(); });
  $('f-chain').addEventListener('change', function () { state.chain = this.value; writeHash(); renderRows(); });
  $('f-tvl').addEventListener('change', function () { state.tvl = this.value; writeHash(); renderRows(); });
  $('f-wl').addEventListener('change', function () { state.wl = this.checked; writeHash(); renderRows(); });
  function reset() {
    state.q = ''; state.cat = 'all'; state.chain = 'all'; state.tvl = '0'; state.wl = false;
    writeHash(); render();
  }
  $('f-clear').addEventListener('click', reset);
  $('empty-clear').addEventListener('click', reset);
  $('tab-pre').addEventListener('click', function () { state.tab = 'pre'; writeHash(); render(); });
  $('tab-live').addEventListener('click', function () { state.tab = 'live'; writeHash(); render(); });
  document.querySelectorAll('th[data-key]').forEach(function (th) {
    th.querySelector('.th-sort').addEventListener('click', function () {
      var k = th.getAttribute('data-key');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = k === 'name' ? 1 : -1; }
      writeHash(); render();
    });
  });
  $('detail').addEventListener('close', function () { if (state.p) { state.p = null; writeHash(); } renderRows(); });
  window.addEventListener('hashchange', function () { readHash(); render(); });

  readHash();
  renderChrome();
  render();
})();
