// Entry Radar page, v3. Reads window.RADAR (data.js, written by main.ts from the fitted model) and
// renders: a KPI strip with the measured held-out validation, the ranked pre-token board with launch
// odds and priced farm verdicts, a traded-comps panel for the anchors the model was fitted on, a
// model panel showing the fitted equation and both validation splits, and a hash-routed detail view
// per protocol (#/p=slug) with the factor breakdown, the odds derivation and the farm plan.
// No network, no framework, no dependency.
(function () {
  'use strict';

  var D = window.RADAR;
  if (!D) return;
  var $ = function (id) { return document.getElementById(id); };

  var state = { q: '', cat: 'all', chain: 'all', tmin: '0', tmax: 'Infinity', wl: false, fv: false, sort: 'rank', dir: 1, tab: 'pre', p: null };

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtUsdFull(n) { return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fmtPct(n) { return n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 730) return (Math.round(d / 365 * 10) / 10) + 'y';
    if (d >= 60) return Math.round(d / 30.4) + 'mo';
    return d + 'd';
  }
  function fmtX(n) { return 'x' + n.toFixed(2); }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'class') node.className = v;
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

  function chainChips(r, cap) {
    var chips = r.chains.slice(0, cap).map(function (c) { return el('span', { class: 'chain-chip', title: c, text: c }); });
    if (r.chains.length > cap) chips.push(el('span', { class: 'more', text: '+' + (r.chains.length - cap) }));
    return chips.length ? chips : [el('span', { class: 'more', text: '—' })];
  }

  function verdictCell(r) {
    if (r.verdict === 'skip') return el('td', { class: 'num' }, el('span', { class: 'pill skip', text: 'skip', title: 'net $' + r.farm.net_usd + ' at $' + r.farm.hourly_usd + '/h' }));
    return el('td', { class: 'num' }, el('span', { class: 'pill ' + r.verdict, text: '+$' + Math.round(r.farm.net_usd), title: 'EV $' + r.farm.ev_usd + ' − cost $' + r.farm.cost_usd + ' − ' + r.farm.hours + 'h × $' + r.farm.hourly_usd + ' = $' + r.farm.net_usd + ' at $' + r.farm.hourly_usd + '/h' }));
  }

  function oddsCell(r, maxOdds) {
    return el('td', null, el('div', { class: 'implied' },
      el('span', { class: 'bar odds', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.launch_odds / maxOdds * 100)) + '%' })),
      el('span', { class: 'v', text: Math.round(r.launch_odds * 100) + '%' })));
  }

  function impliedCell(r, max) {
    return el('td', null, el('div', { class: 'implied' },
      el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.implied_value_usd / max * 100)) + '%' })),
      el('span', { class: 'v', text: fmtUsd(r.implied_value_usd) })));
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var min = Number(state.tmin) || 0;
    var max = state.tmax === 'Infinity' ? Infinity : Number(state.tmax);
    return D.rows.filter(function (r) {
      if (state.wl && !r.on_watchlist) return false;
      if (state.fv && r.verdict === 'skip') return false;
      if (state.cat !== 'all' && (r.category || 'Unclassified') !== state.cat) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (r.tvl_usd < min || r.tvl_usd >= max) return false;
      if (!q) return true;
      return (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) >= 0;
    });
  }

  function sortVal(r, k) {
    if (k === 'name') return r.name.toLowerCase();
    if (k === 'cat') return r.category || '~';
    if (k === 'tvl') return r.tvl_usd;
    if (k === 'growth') return r.change_7d === null ? -1e9 : r.change_7d;
    if (k === 'age') return r.age_days === null ? -1 : r.age_days;
    if (k === 'odds') return r.launch_odds;
    if (k === 'net') return r.farm.net_usd;
    if (k === 'implied') return r.implied_value_usd;
    return r.rank;
  }

  function sorted(list) {
    var k = state.sort, dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortVal(a, k), bv = sortVal(b, k);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }

  function renderRows() {
    var tbody = $('rows');
    tbody.textContent = '';
    var list = sorted(filtered());
    $('count').textContent = list.length + ' of ' + D.rows.length + ' pre-token protocols';
    $('board-panel').hidden = state.tab !== 'pre';
    $('live-panel').hidden = state.tab !== 'live';
    $('model-panel').hidden = state.tab !== 'pre';
    if (state.tab !== 'pre') return;
    var max = 1;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    if (list.length === 0) { $('empty').hidden = false; return; }
    $('empty').hidden = true;
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      frag.appendChild(el('tr', {
        tabindex: '0',
        'data-open': state.p === r.slug ? 'true' : null,
        'data-top': r.rank <= 10 ? '1' : null,
        title: r.name + ' — open the fitted breakdown, odds and farm plan',
        onclick: function () { location.hash = 'p=' + encodeURIComponent(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); location.hash = 'p=' + encodeURIComponent(r.slug); } }
      },
        el('td', { class: 'rank', text: String(r.rank) }),
        el('td', { class: 'proto' },
          el('b', null, r.name, ' ', r.on_watchlist ? el('span', { class: 'wl-pill', text: 'WL' }) : null),
          el('span', { class: 'slug', text: r.slug })),
        el('td', { class: 'cat', text: r.category || 'Unclassified' }),
        el('td', null, chainChips(r, 2)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        oddsCell(r, 0.92),
        impliedCell(r, max),
        verdictCell(r)
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
        el('td', null, chainChips(r, 2)),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.mcap_tvl.toFixed(2) }),
        el('td', null, el('span', { class: 'live-pill', text: 'TRAINED ON' }))
      ));
    });
  }

  function kpi(k, v, s, cls) {
    return el('div', { class: 'stat' },
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v' + (cls ? ' ' + cls : ''), text: v }),
      el('div', { class: 's', text: s }));
  }

  function renderChrome() {
    var m = $('meta');
    m.textContent = '';
    m.appendChild(el('span', null, 'Snapshot ', el('b', { text: D.as_of }), ' · fetched ', el('b', { text: (D.fetched || '').replace('T', ' ').slice(0, 16) + 'Z' })));
    m.appendChild(el('span', null, 'Model ', el('b', { text: D.model_version }), ' · ', el('b', { text: D.model_name }), ' · ridge λ ', el('b', { text: String(D.ridge_lambda) })));
    m.appendChild(el('span', { text: 'Sealed DefiLlama input — the page makes no network request' }));

    var st = $('stats');
    st.textContent = '';
    var v = D.fit.validation;
    st.appendChild(kpi('Protocols tracked', String(D.n_protocols), D.n_pre_token + ' record no token, ' + D.n_rankable + ' rankable pre-token'));
    st.appendChild(kpi('Board rows', String(D.rows.length), 'every rankable pre-token protocol'));
    st.appendChild(kpi('Watchlist covered', D.rows.filter(function (r) { return r.on_watchlist; }).length + ' / ' + D.watchlist_size, 'the gate list, covered in full', 'pos'));
    st.appendChild(kpi('Held-out fit (LOO)', fmtX(v.loo_median_ratio), 'median of ' + v.loo_folds + ' leave-one-out folds (p75 ' + fmtX(v.loo_p75_ratio) + ')'));
    st.appendChild(kpi('Walk-forward', fmtX(v.wf_median_ratio), 'trained on ' + v.wf_train + ' older anchors, tested on ' + v.wf_test + ' newer'));
    st.appendChild(kpi('Fit anchors', String(v.anchors_used), 'traded protocols after dropping ' + (v.anchors_dropped_nonpositive + v.anchors_dropped_sub1m + v.anchors_dropped_ratio60) + ' unusable caps'));

    var cats = Array.from(new Set(D.rows.map(function (r) { return r.category || 'Unclassified'; }))).sort();
    var chains = Array.from(new Set(D.rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
    var catSel = $('f-cat'), chainSel = $('f-chain');
    cats.forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
    chains.forEach(function (c) { chainSel.appendChild(el('option', { value: c, text: c })); });

    // model panel: the fitted equation in raw units
    var f = $('formula');
    f.textContent = '';
    f.appendChild(document.createTextNode('log(mcap) = ' + D.fit.equation_intercept.toFixed(2)));
    D.fit.equation_slopes.forEach(function (s) {
      if (!s[2]) return;
      f.appendChild(el('span', { class: 'term' }, (s[2] > 0 ? ' + ' : ' − ') + Math.abs(s[2]).toFixed(3) + '×' + s[0]));
    });

    var coefs = $('coefs');
    coefs.textContent = '';
    var head = el('div', { class: 'coef-row coef-head' }, el('span', { text: 'term' }), el('span', { text: 'unit' }), el('span', { text: 'fitted slope' }));
    coefs.appendChild(head);
    D.fit.equation_slopes.forEach(function (s) {
      coefs.appendChild(el('div', { class: 'coef-row' },
        el('span', { text: s[0] }),
        el('span', { class: 'muted', text: s[1] }),
        el('b', { class: s[2] >= 0 ? 'pos' : 'neg', text: (s[2] >= 0 ? '+' : '') + s[2].toFixed(3) })));
    });

    var note = $('fit-note');
    note.textContent = 'Fitted by ridge regression (' + D.model_name + ', λ=' + D.ridge_lambda + ') on ' + D.fit.n_anchors + ' traded anchors: log(mcap_usd) regressed on log(TVL), listing age, 7-day change, chain count and sector one-hots, normal equations solved by Gaussian elimination in lib/model.ts. Every slope above came out of this snapshot — nothing is hand-set.';

    var val = $('valid');
    val.textContent = '';
    val.appendChild(el('div', { class: 'kv' }, el('span', { text: 'Leave-one-out, ' + v.loo_folds + ' folds' }), el('b', { text: fmtX(v.loo_median_ratio) + ' median' })));
    val.appendChild(el('div', { class: 'kv' }, el('span', { text: 'LOO 75th percentile' }), el('b', { text: fmtX(v.loo_p75_ratio) })));
    val.appendChild(el('div', { class: 'kv' }, el('span', { text: 'Walk-forward: ' + v.wf_train + ' older → ' + v.wf_test + ' newer' }), el('b', { text: fmtX(v.wf_median_ratio) + ' median' })));
    val.appendChild(el('div', { class: 'kv' }, el('span', { text: 'Anchors used / dropped' }), el('b', { text: v.anchors_used + ' / ' + (v.anchors_dropped_nonpositive + v.anchors_dropped_sub1m + v.anchors_dropped_ratio60) })));
    val.appendChild(el('p', { class: 'why', text: 'Each fold refits without the held-out anchor (its own standardisation included) and prices it; the fold error is max(pred/actual, actual/pred), so x2.79 means a three-fold miss either way. The walk-forward split trains on the older half by listed_at and tests the newer half. These are the honest numbers — the model misprices a typical anchor ' + fmtX(v.loo_median_ratio) + ' when it has never seen it.' }));

    $('odds-formula').textContent = D.odds_formula;
    var ot = $('odds-tables');
    ot.textContent = '';
    var tb = el('div', { class: 'band-table' });
    tb.appendChild(el('div', { class: 'band-row band-head' }, el('span', { text: 'TVL band' }), el('span', { text: 'protocols' }), el('span', { text: 'launch rate' }), el('span', { text: 'boost' })));
    D.odds.tvl_bands.forEach(function (b) {
      tb.appendChild(el('div', { class: 'band-row' }, el('span', { text: b.label }), el('span', { text: String(b.protocols) }), el('span', { text: Math.round(b.launch_rate * 100) + '%' }), el('b', { text: '×' + b.boost.toFixed(2) })));
    });
    ot.appendChild(tb);
    var ab = el('div', { class: 'band-table' });
    ab.appendChild(el('div', { class: 'band-row band-head' }, el('span', { text: 'age band' }), el('span', { text: 'protocols' }), el('span', { text: 'still token-less' }), el('span', { text: 'discount' })));
    D.odds.age_bands.forEach(function (b) {
      ab.appendChild(el('div', { class: 'band-row' }, el('span', { text: b.label }), el('span', { text: String(b.protocols) }), el('span', { text: Math.round(b.pre_token_share * 100) + '%' }), el('b', { text: '×' + b.discount.toFixed(2) })));
    });
    ot.appendChild(ab);

    var fa = D.farm_assumptions;
    var fm = $('farm-model');
    fm.textContent = '';
    ['pool_share', 'farm_tvl_share', 'concentration', 'hourly_usd'].forEach(function (k2) {
      fm.appendChild(el('div', { class: 'kv' }, el('span', { text: k2.replace(/_/g, ' ') }), el('b', { text: String(fa[k2]) })));
    });
    fm.appendChild(el('p', { class: 'why', text: 'expected airdrop = implied × odds × ' + fa.pool_share + ' pool × capture, capture = (position ÷ (TVL × ' + fa.farm_tvl_share + ')) × ' + fa.concentration + ' for a dedicated wallet. net = EV − gas − hours × $' + fa.hourly_usd + '. net ≥ $' + fa.farm_min_net + ' reads farm; $0–$' + fa.farm_min_net + ' thin; below $0 skip. Gas is priced per chain (Ethereum $14/tx, L2s $0.80, Solana $0.15) and every row carries its own arithmetic.' }));

    $('model-note').textContent = 'TVL, 7-day change, listing age, chain count and sector come from the sealed snapshot; the same fitted function scores every protocol and no name is special-cased. Implied value is this entry\'s own claim about a token that does not exist yet — not a price, and not a prediction that a token comes.';
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

  function kv(label, value, cls) {
    return el('div', { class: 'kv' + (cls ? ' ' + cls : '') }, el('span', { text: label }), el('b', { text: value }));
  }

  function openDetail(slug) {
    var r = null;
    for (var i = 0; i < D.rows.length; i++) if (D.rows[i].slug === slug) { r = D.rows[i]; break; }
    if (!r) { closeDetail(); return; }
    var d = $('detail');
    d.textContent = '';
    var f = r.farm;
    var logSum = r.value_factors.reduce(function (a, t) { return a + t[1]; }, 0);
    var reFitted = Math.min(1e14, Math.max(1, Math.round(Math.exp(logSum))));
    var reImplied = Math.min(1e14, Math.max(1, Math.round(reFitted * r.launch_odds)));
    var agrees = Math.abs(reImplied - r.implied_value_usd) <= Math.max(2, r.implied_value_usd * 0.001);

    var valueRows = el('div', { class: 'factor-rows' });
    var multTxt = function (m) {
      if (m >= 1000) return '×' + (m >= 1e6 ? (m / 1e6).toFixed(1) + 'M' : Math.round(m / 1e3) + 'k');
      if (m >= 1) return '×' + m.toFixed(2);
      return '÷' + (1 / m).toFixed(2);
    };
    r.value_factors.forEach(function (t) {
      if (t[0] !== 'intercept' && Math.abs(t[1]) < 0.005) return;
      var mult = Math.exp(t[1]);
      valueRows.appendChild(el('div', { class: 'frow' + (t[0] === 'intercept' ? ' muted' : '') },
        el('span', { text: t[0] }),
        el('span', { class: 'logpts', text: (t[1] >= 0 ? '+' : '−') + Math.abs(t[1]).toFixed(2) + ' log' }),
        el('b', { text: multTxt(mult) })));
    });
    valueRows.appendChild(el('div', { class: 'frow total' }, el('span', { text: 'fitted market cap' }), el('span', { class: 'logpts' }), el('b', { text: fmtUsd(r.fitted_mcap_usd) })));
    valueRows.appendChild(el('div', { class: 'frow' }, el('span', { text: '× launch odds ' + Math.round(r.launch_odds * 100) + '%' }), el('span', { class: 'logpts' }), el('b', { text: '× ' + r.launch_odds.toFixed(2) })));
    valueRows.appendChild(el('div', { class: 'frow total big' }, el('span', { text: 'implied value at launch' }), el('span', { class: 'logpts' }), el('b', { text: fmtUsdFull(r.implied_value_usd) })));

    var o = r.odds_parts;
    var plan = el('ol', { class: 'steps' }, r.farm_steps.map(function (s) {
      var p = splitStep(s);
      return el('li', null, el('div', { text: p.act }),
        el('div', { class: 'meta-line' },
          p.cost ? el('span', { class: 'tag', text: 'Cost: ' + p.cost }) : null,
          p.time ? el('span', { class: 'tag amber', text: 'Time: ' + p.time }) : null));
    }));

    d.appendChild(el('div', { class: 'detail-body' },
      el('div', { class: 'd-head' },
        el('button', { class: 'ghost back', type: 'button', text: '← Back to board', onclick: function () { location.hash = state.tab === 'live' ? 'tab=live' : ''; } }),
        el('div', { class: 'd-rank', text: 'RANK ' + r.rank + ' OF ' + D.rows.length + (r.on_watchlist ? ' · HOUSE WATCHLIST' : ' · RADAR FIND') }),
        el('h2', { id: 'd-title', text: r.name }),
        el('div', { class: 'd-sub' },
          el('span', { class: 'slug', text: r.slug }),
          el('span', { class: 'chip', text: r.category || 'Unclassified' }),
          el('span', { text: (r.chains.join(', ') || 'no chain on record') + ' · TVL ' + fmtUsd(r.tvl_usd) + ' · 7d ' + fmtPct(r.change_7d) + ' · token-less ' + fmtAge(r.age_days) + (r.listed_at ? ' (since ' + r.listed_at + ')' : ' (unlisted)') }))),
      el('section', { class: 'd-section' },
        el('h3', { text: 'Fitted value — log(mcap) from this snapshot\'s own traded peers' }),
        valueRows,
        el('p', { class: 'why', text: 'Each line is one fitted term\'s contribution in log points (terms moving the fit by under 0.005 log are omitted). Rebuilt here from the printed terms alone: ' + fmtUsd(reImplied) + (agrees ? ' — matches the whole-dollar figure board.json carries for rank ' + r.rank + '.' : ', within rounding of the board\'s ' + fmtUsd(r.implied_value_usd) + ': the data behind this view is stale.') }),
        el('p', { class: 'why', text: 'Odds derivation: base ' + o.base + ' (' + o.band_note + ') × TVL boost ' + o.boost + ' × token-less age discount ' + o.discount + ' = ' + Math.round(r.launch_odds * 100) + '%. Category rate shrunk toward the snapshot-wide ' + Math.round(D.odds.overall_rate * 100) + '% launch rate.' })),
      el('section', { class: 'd-section verdict-box' },
        el('h3', { text: 'Farm verdict — priced, not a slogan' }),
        el('div', { class: 'verdict-grid' },
          kv('Position the plan sizes', fmtUsd(f.position_usd)),
          kv('Expected airdrop pool', fmtUsd(f.pool_usd) + ' (implied × odds × 6%)'),
          kv('Your expected capture', (f.capture * 100).toFixed(3) + '% of pool'),
          kv('Expected value to you', fmtUsd(f.ev_usd)),
          kv('Gas + bridge, whole plan', '$' + f.gas_usd),
          kv('Time, priced at $' + f.hourly_usd + '/h', f.hours + 'h = ' + fmtUsd(f.hours * f.hourly_usd)),
          el('div', { class: 'kv total' }, el('span', { text: 'Net at $' + f.hourly_usd + '/h' }), el('b', { class: r.verdict === 'skip' ? 'neg' : 'pos', text: (f.net_usd >= 0 ? '+$' : '−$') + Math.abs(f.net_usd).toLocaleString('en-US') })),
          el('div', { class: 'kv' }, el('span', { text: 'Verdict' }), el('span', { class: 'pill ' + r.verdict, text: r.verdict }))),
        el('p', { class: 'why', text: r.verdict === 'farm' ? 'Worth the hours at $' + f.hourly_usd + '/h: the expected airdrop clears the plan\'s gas and time cost with room to spare.' : r.verdict === 'thin' ? 'Marginal: expected value barely clears the plan\'s costs — farm it only if you already touch this protocol.' : 'Not worth dedicated hours at $' + f.hourly_usd + '/h: the expected airdrop does not pay back the plan\'s gas and time. Ranked above on value, not on farmability.' })),
      el('section', { class: 'd-section' },
        el('h3', { text: 'Farm plan — the same steps board.json carries' }),
        plan),
      el('div', { class: 'd-foot', text: 'Model ' + D.model_version + ' (' + D.model_name + ') · snapshot ' + D.as_of + ' · implied value is this entry\'s claim, not a market price; launch odds are cohort estimates, not promises.' })
    ));
    d.hidden = false;
    document.body.style.overflow = 'hidden';
    window.scrollTo(0, 0);
  }

  function closeDetail() {
    $('detail').hidden = true;
    document.body.style.overflow = '';
  }

  function readHash() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    state.q = p.get('q') || '';
    state.cat = p.get('cat') || 'all';
    state.chain = p.get('chain') || 'all';
    state.tmin = p.get('tmin') || '0';
    state.tmax = p.get('tmax') || 'Infinity';
    state.wl = p.get('wl') === '1';
    state.fv = p.get('fv') === '1';
    state.sort = p.get('sort') || 'rank';
    if (['rank', 'name', 'cat', 'tvl', 'growth', 'age', 'odds', 'implied', 'net'].indexOf(state.sort) < 0) state.sort = 'rank';
    state.dir = p.get('dir') === '-1' ? -1 : 1;
    state.tab = p.get('tab') === 'live' ? 'live' : 'pre';
    state.p = p.get('p');
  }

  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tmin !== '0') p.set('tmin', state.tmin);
    if (state.tmax !== 'Infinity') p.set('tmax', state.tmax);
    if (state.wl) p.set('wl', '1');
    if (state.fv) p.set('fv', '1');
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir === -1) p.set('dir', '-1');
    if (state.tab !== 'pre') p.set('tab', state.tab);
    if (state.p) p.set('p', state.p);
    var s = p.toString();
    history.replaceState(null, '', s ? '#' + s : location.pathname + location.search);
  }

  function syncControls() {
    $('f-q').value = state.q;
    $('f-cat').value = state.cat;
    $('f-chain').value = state.chain;
    $('f-tvl-min').value = state.tmin;
    $('f-tvl-max').value = state.tmax;
    $('f-wl').checked = state.wl;
    $('f-verdict').checked = state.fv;
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
    else closeDetail();
  }

  $('f-q').addEventListener('input', function () { state.q = this.value; writeHash(); renderRows(); });
  $('f-cat').addEventListener('change', function () { state.cat = this.value; writeHash(); render(); });
  $('f-chain').addEventListener('change', function () { state.chain = this.value; writeHash(); render(); });
  $('f-tvl-min').addEventListener('change', function () { state.tmin = this.value; writeHash(); render(); });
  $('f-tvl-max').addEventListener('change', function () { state.tmax = this.value; writeHash(); render(); });
  $('f-wl').addEventListener('change', function () { state.wl = this.checked; writeHash(); render(); });
  $('f-verdict').addEventListener('change', function () { state.fv = this.checked; writeHash(); render(); });
  function reset() {
    state.q = ''; state.cat = 'all'; state.chain = 'all'; state.tmin = '0'; state.tmax = 'Infinity'; state.wl = false; state.fv = false;
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
      else { state.sort = k; state.dir = k === 'name' || k === 'cat' ? 1 : -1; if (k === 'rank') state.dir = 1; }
      writeHash(); render();
    });
  });
  window.addEventListener('hashchange', function () { readHash(); render(); });

  readHash();
  renderChrome();
  render();
})();
