/**
 * Raffinerie IoT Dashboard — client
 */
(function () {
  'use strict';

  const app = document.getElementById('dashboard-app');
  if (!app) return;

  const csrfEl = document.querySelector('[name=csrfmiddlewaretoken]');
  const CSRF = csrfEl ? csrfEl.value : '';

  const LED_ON =
    'status-led w-3 h-3 rounded-full shrink-0 bg-brand-500 led-green';
  const LED_OFF =
    'status-led w-3 h-3 rounded-full shrink-0 bg-gray-700 led-gray';
  const LBL_ON =
    'status-label text-sm font-semibold text-brand-400 font-mono mt-0.5';
  const LBL_OFF =
    'status-label text-sm font-semibold text-gray-600 font-mono mt-0.5';

  const CHART_DEFS = {
    temperature: {
      id: 'chart-temperature',
      label: 'Température',
      color: '#fb923c',
    },
    vibration: {
      id: 'chart-vibration',
      label: 'Vibration',
      color: '#facc15',
    },
    pression: {
      id: 'chart-pression',
      label: 'Pression',
      color: '#60a5fa',
    },
    debit: { id: 'chart-debit', label: 'Débit', color: '#22c55e' },
  };

  const charts = {};
  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f1a14',
        borderColor: 'rgba(34,197,94,0.2)',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono' },
        bodyFont: { family: 'JetBrains Mono' },
      },
    },
    scales: {
      x: {
        ticks: { color: '#6b7280', maxTicksLimit: 5, font: { size: 10 } },
        grid: { color: 'rgba(34,197,94,0.06)' },
      },
      y: {
        ticks: { color: '#6b7280', font: { size: 10 } },
        grid: { color: 'rgba(34,197,94,0.06)' },
      },
    },
  };

  const $ = (id) => document.getElementById(id);

  let sessionSince = null;
  let pollIntervalMs = 5000;
  let pollTimer = null;

  // ── Toasts ──────────────────────────────────────────────

  function showToast(message, type = 'info', durationMs = 4500) {
    const root = $('toast-root');
    if (!root) return;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    root.appendChild(toast);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.remove('toast--hide'));
    });

    setTimeout(() => {
      toast.classList.add('toast--hide');
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  // ── Logs (texte sûr) ──────────────────────────────────

  function log(msg, tone = 'neutral') {
    const box = $('log-box');
    if (!box) return;
    const colors = {
      neutral: 'text-gray-400',
      success: 'text-brand-400',
      error: 'text-red-400',
      info: 'text-blue-400',
    };
    const line = document.createElement('p');
    line.className = `font-mono text-xs ${colors[tone] || colors.neutral}`;
    const time = document.createElement('span');
    time.className = 'text-gray-600';
    time.textContent = `[${new Date().toLocaleTimeString('fr-FR')}] `;
    line.appendChild(time);
    line.appendChild(document.createTextNode(msg));
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('log-box');
    if (box) box.replaceChildren();
  }

  // ── API ─────────────────────────────────────────────────

  async function apiCall(url, body = {}) {
    if (!CSRF) {
      throw new Error('Jeton CSRF absent — rechargez la page (F5)');
    }
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': CSRF,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (r.status === 403) {
        throw new Error('Session CSRF expirée — rechargez la page (F5)');
      }
      throw new Error(`Réponse serveur invalide (HTTP ${r.status})`);
    }
    if (!r.ok) {
      const err = new Error(data.error || `Erreur HTTP ${r.status}`);
      err.data = data;
      throw err;
    }
    return data;
  }

  function readSeuilVib() {
    const v = parseFloat($('seuil-vib')?.value);
    if (!Number.isFinite(v) || v < 0.5 || v > 10) {
      throw new Error('Seuil vibration : entre 0,5 et 10 mm/s');
    }
    return v;
  }

  function readSeuilTemp() {
    const v = parseFloat($('seuil-temp')?.value);
    if (!Number.isFinite(v) || v < 50 || v > 400) {
      throw new Error('Seuil température : entre 50 et 400 °C');
    }
    return v;
  }

  // ── Charts ──────────────────────────────────────────────

  function formatChartTime(ts, kpiMode) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) {
      const opts = kpiMode
        ? { hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
      return d.toLocaleTimeString('fr-FR', opts);
    }
    const s = String(ts);
    return s.length >= 8 ? s.slice(-8) : s;
  }

  function initCharts() {
    if (typeof Chart === 'undefined') return;
    for (const [key, def] of Object.entries(CHART_DEFS)) {
      const ctx = $(def.id);
      if (!ctx) continue;
      charts[key] = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              label: def.label,
              data: [],
              borderColor: def.color,
              backgroundColor: def.color + '22',
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              tension: 0.35,
              fill: true,
            },
          ],
        },
        options: chartOptions,
      });
    }
  }

  function updateCharts(payload) {
    const kpiMode = payload.source === 'kpi_indicateurs';
    const machine = payload.machine;

    for (const [key, def] of Object.entries(CHART_DEFS)) {
      const chart = charts[key];
      if (!chart) continue;
      const points = payload[key] || [];
      chart.data.labels = points.map((p) => formatChartTime(p.time, kpiMode));
      chart.data.datasets[0].label = machine
        ? `${def.label} (${machine})`
        : `${def.label} (KPI 1 min)`;
      chart.data.datasets[0].data = points.map((p) => p.value);
      chart.update('none');
    }

    const sourceLabel = $('charts-source-label');
    if (sourceLabel) {
      let label = machine
        ? `mesures_filtrees · ${machine}`
        : 'kpi_indicateurs · moyenne 1 min';
      if (payload.session_filter) label += ' · session en cours';
      sourceLabel.textContent = label;
    }

    const sessionHint = $('charts-session-hint');
    if (sessionHint) {
      if (payload.session_filter && !machine) {
        sessionHint.textContent =
          'Mode KPI : les nouveaux points apparaissent environ toutes les minutes. Pour le direct (~2 s), choisissez une machine ci-dessus.';
        sessionHint.classList.remove('hidden');
      } else if (payload.session_filter && machine) {
        sessionHint.textContent =
          'Affichage des mesures depuis le dernier démarrage de la pipeline.';
        sessionHint.classList.remove('hidden');
      } else {
        sessionHint.classList.add('hidden');
      }
    }

    const latestEl = $('charts-latest-db');
    if (latestEl && payload.latest_in_db) {
      const d = new Date(payload.latest_in_db);
      latestEl.textContent = !isNaN(d.getTime())
        ? 'dernière mesure en base : ' + d.toLocaleString('fr-FR')
        : '';
    }

    const hasData = Object.keys(CHART_DEFS).some(
      (k) => (payload[k] || []).length > 0
    );
    const offline = $('charts-offline');
    if (offline) {
      if (!hasData && payload.session_filter) {
        offline.textContent =
          'Pipeline démarrée — en attente des premières mesures (simulateur → Kafka → Spark → base). Choisissez une machine pour le suivi rapide.';
        offline.classList.remove('hidden');
      } else {
        offline.classList.toggle('hidden', hasData);
        if (hasData) {
          offline.textContent =
            'Aucune donnée — lancez la pipeline ou vérifiez TimescaleDB.';
        }
      }
    }
    $('charts-grid')?.classList.toggle('opacity-50', !hasData);
    if (hasData && $('charts-updated')) {
      $('charts-updated').textContent =
        'mis à jour ' + new Date().toLocaleTimeString('fr-FR');
    }
  }

  function applySessionFromConfig(config) {
    if (config?.started_at) {
      sessionSince = config.started_at;
    } else if (!config?.running) {
      sessionSince = null;
    }
  }

  function setPollInterval(running) {
    const next = running ? 2000 : 5000;
    if (next === pollIntervalMs && pollTimer) return;
    pollIntervalMs = next;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(runPollCycle, pollIntervalMs);
  }

  async function refreshCharts() {
    try {
      const machine = $('chart-machine')?.value || '';
      const limit = machine ? 180 : 60;
      const qs = new URLSearchParams({ limit: String(limit) });
      if (machine) qs.set('machine', machine);
      if (sessionSince) qs.set('since', sessionSince);
      const data = await fetch('/api/donnees/?' + qs.toString()).then((r) => {
        if (!r.ok) return r.json().then((j) => Promise.reject(j));
        return r.json();
      });
      updateCharts(data);
    } catch (e) {
      console.warn('Charts refresh failed', e);
      $('charts-offline')?.classList.remove('hidden');
      $('charts-grid')?.classList.add('opacity-50');
      if (e?.error) showToast(e.error, 'error');
    }
  }

  async function runPollCycle() {
    try {
      const statusData = await fetch('/api/status/').then((r) => r.json());
      applySessionFromConfig(statusData.config);
      setPollInterval(statusData.running);
      updateUI(statusData.status);
      renderAlertes(statusData.alertes);
      if ($('config-display')) {
        $('config-display').textContent = JSON.stringify(
          statusData.config,
          null,
          2
        );
      }
      await refreshCharts();
    } catch (e) {
      console.warn('Polling failed', e);
    }
  }

  // ── Alertes ML ──────────────────────────────────────────

  function renderAlertes(alertes) {
    const box = $('alertes-list');
    const countEl = $('alertes-count');
    if (!box) return;

    const list = alertes || [];
    if (countEl) countEl.textContent = String(list.length);
    box.replaceChildren();

    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-gray-500 font-mono text-xs';
      empty.textContent =
        'Aucune alerte ML récente — les anomalies apparaîtront ici depuis spark_logs.txt.';
      box.appendChild(empty);
      return;
    }

    list.forEach((a) => {
      const card = document.createElement('article');
      card.className =
        'border-l-2 border-red-500 bg-red-950/20 rounded-r-lg px-3 py-2.5 font-mono text-xs';

      const head = document.createElement('div');
      head.className = 'flex flex-wrap items-center gap-2 mb-1';

      const type = document.createElement('span');
      type.className = 'text-red-400 font-semibold uppercase tracking-wider';
      type.textContent = a.type || 'ANOMALIE';
      head.appendChild(type);

      if (a.proba) {
        const sep = document.createElement('span');
        sep.className = 'text-gray-500';
        sep.textContent = '·';
        head.appendChild(sep);

        const proba = document.createElement('span');
        proba.className = 'text-red-300';
        proba.appendChild(document.createTextNode('Proba '));
        const bold = document.createElement('span');
        bold.className = 'text-red-400 font-bold';
        bold.textContent = a.proba;
        proba.appendChild(bold);
        if (a.seuil) {
          proba.appendChild(
            document.createTextNode(' (seuil ' + a.seuil + ')')
          );
        }
        head.appendChild(proba);
      }
      card.appendChild(head);

      const metrics = document.createElement('div');
      metrics.className = 'flex flex-wrap gap-x-4 gap-y-1 text-gray-400';
      if (a.vibration) {
        const v = document.createElement('span');
        v.appendChild(document.createTextNode('Vibration '));
        const val = document.createElement('span');
        val.className = 'text-yellow-400';
        val.textContent = a.vibration + ' mm/s';
        v.appendChild(val);
        metrics.appendChild(v);
      }
      if (a.pression) {
        const p = document.createElement('span');
        p.appendChild(document.createTextNode('Pression '));
        const val = document.createElement('span');
        val.className = 'text-blue-400';
        val.textContent = a.pression + ' bar';
        p.appendChild(val);
        metrics.appendChild(p);
      }
      if (metrics.childNodes.length) card.appendChild(metrics);
      box.appendChild(card);
    });
  }

  // ── Statut pipeline ─────────────────────────────────────

  function updateStatusCards(status) {
    document.querySelectorAll('.status-card[data-service]').forEach((card) => {
      const active = !!status[card.dataset.service];
      const led = card.querySelector('.status-led');
      const lbl = card.querySelector('.status-label');
      if (!led || !lbl) return;
      led.className = active ? LED_ON : LED_OFF;
      lbl.className = active ? LBL_ON : LBL_OFF;
      lbl.textContent = active ? 'ACTIF' : 'INACTIF';
      card.setAttribute('aria-label', `${card.dataset.service} : ${active ? 'actif' : 'inactif'}`);
    });
  }

  function updateUI(status) {
    updateStatusCards(status || {});

    const running = Object.values(status || {}).some(Boolean);
    const btnStart = $('btn-start');
    const btnStop = $('btn-stop');
    if (btnStart) btnStart.disabled = running;
    if (btnStop) btnStop.disabled = !running;

    const dot = $('live-dot');
    const label = $('live-label');
    const badge = $('live-badge');
    if (running) {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-brand-500 animate-pulse';
      if (label) {
        label.className = 'text-brand-400 font-mono text-xs font-semibold';
        label.textContent = 'LIVE';
      }
      if (badge) badge.setAttribute('aria-label', 'Pipeline en cours d\'exécution');
    } else {
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-gray-600';
      if (label) {
        label.className = 'text-gray-500 font-mono text-xs';
        label.textContent = 'OFFLINE';
      }
      if (badge) badge.setAttribute('aria-label', 'Pipeline arrêtée');
    }
  }

  // ── Actions ─────────────────────────────────────────────

  async function startPipeline() {
    clearLog();
    log('Démarrage de la pipeline...', 'success');
    showToast('Démarrage de la pipeline…', 'info');
    const btnStart = $('btn-start');
    if (btnStart) btnStart.disabled = true;

    try {
      const data = await apiCall('/api/start/');
      if (data.success) {
        data.messages.forEach((m) => log('✓ ' + m, 'success'));
        applySessionFromConfig(data.config);
        updateUI(data.status);
        setPollInterval(true);
        const sel = $('chart-machine');
        if (sel && sel.options.length > 1 && !sel.value) {
          sel.selectedIndex = 1;
        }
        await refreshCharts();
        showToast('Pipeline démarrée — graphes filtrés sur cette session', 'success');
      } else {
        const err = data.error || 'inconnue';
        log('Erreur : ' + err, 'error');
        showToast('Échec du démarrage : ' + err, 'error');
        if (btnStart) btnStart.disabled = false;
      }
    } catch (e) {
      const msg = e?.message || 'Erreur réseau';
      log(msg, 'error');
      showToast(msg, 'error');
      if (btnStart) btnStart.disabled = false;
    }
  }

  async function stopPipeline() {
    clearLog();
    log('Arrêt de la pipeline...', 'error');
    showToast('Arrêt de la pipeline…', 'info');
    const btnStop = $('btn-stop');
    if (btnStop) btnStop.disabled = true;

    try {
      const data = await apiCall('/api/stop/');
      if (data.success) {
        data.messages.forEach((m) => log('✗ ' + m, 'neutral'));
        sessionSince = null;
        applySessionFromConfig(data.config);
        updateUI(data.status || {});
        setPollInterval(false);
        await refreshCharts();
        showToast('Pipeline arrêtée', 'success');
      } else {
        showToast('Échec de l\'arrêt', 'error');
        if (btnStop) btnStop.disabled = false;
      }
    } catch (e) {
      showToast(e?.message || 'Erreur réseau à l\'arrêt', 'error');
      if (btnStop) btnStop.disabled = false;
    }
  }

  async function applyConfig(fields) {
    let body = fields;
    if (!body) {
      try {
        body = {
          seuil_vibration: readSeuilVib(),
          seuil_temperature: readSeuilTemp(),
          nb_capteurs: parseInt($('nb-capteurs').value, 10),
          demo_rapide: $('demo-rapide')?.checked ?? false,
        };
      } catch (e) {
        showToast(e.message, 'error');
        return;
      }
    } else if ('seuil_vibration' in body) {
      try {
        body = { seuil_vibration: readSeuilVib() };
      } catch (e) {
        showToast(e.message, 'error');
        return;
      }
    } else if ('seuil_temperature' in body) {
      try {
        body = { seuil_temperature: readSeuilTemp() };
      } catch (e) {
        showToast(e.message, 'error');
        return;
      }
    }
    try {
      const data = await apiCall('/api/config/', body);
      if (data.success) {
        log('Configuration mise à jour', 'info');
        $('config-display').textContent = JSON.stringify(data.config, null, 2);
        if (data.config?.seuil_alerte_vibration != null) {
          const vib = $('seuil-vib');
          if (vib) vib.value = data.config.seuil_alerte_vibration;
        }
        if (data.config?.seuil_alerte_temperature != null) {
          const temp = $('seuil-temp');
          if (temp) temp.value = data.config.seuil_alerte_temperature;
        }
        showToast('Configuration enregistrée', 'success');
      } else {
        showToast(data.error || 'Configuration refusée', 'error');
      }
    } catch (e) {
      showToast(e?.message || 'Erreur lors de la sauvegarde', 'error');
      if (e?.data?.config && $('config-display')) {
        $('config-display').textContent = JSON.stringify(e.data.config, null, 2);
      }
    }
  }

  async function applyNbCapteurs() {
    const nb = parseInt($('nb-capteurs').value, 10);
    try {
      const cfgData = await apiCall('/api/config/', { nb_capteurs: nb });
      if (!cfgData.success) {
        showToast('Configuration refusée', 'error');
        return;
      }
      const data = await apiCall('/api/restart-sim/');
      const msg = data.message || `Simulateur relancé (${nb} capteurs)`;
      log(msg, 'info');
      $('config-display').textContent = JSON.stringify(cfgData.config, null, 2);
      showToast(msg, 'success');
    } catch (e) {
      showToast('Erreur au redémarrage du simulateur', 'error');
    }
  }

  // ── Grafana iframe ──────────────────────────────────────

  function initGrafana() {
    const iframe = $('grafana-iframe');
    const fallback = $('grafana-fallback');
    if (!iframe || !fallback) return;

    const timer = setTimeout(() => {
      fallback.classList.remove('hidden');
      fallback.setAttribute('role', 'alert');
    }, 8000);

    iframe.addEventListener('load', () => clearTimeout(timer));
    iframe.addEventListener('error', () => {
      clearTimeout(timer);
      fallback.classList.remove('hidden');
    });
  }

  // ── Événements ──────────────────────────────────────────

  function bindEvents() {
    $('btn-start')?.addEventListener('click', startPipeline);
    $('btn-stop')?.addEventListener('click', stopPipeline);
    $('btn-apply-config')?.addEventListener('click', applyConfig);
    $('btn-apply-vib')?.addEventListener('click', () =>
      applyConfig({ seuil_vibration: null })
    );
    $('btn-apply-temp')?.addEventListener('click', () =>
      applyConfig({ seuil_temperature: null })
    );
    $('demo-rapide')?.addEventListener('change', () =>
      applyConfig({ demo_rapide: $('demo-rapide').checked })
    );
    $('btn-apply-nb')?.addEventListener('click', applyNbCapteurs);

    $('chart-machine')?.addEventListener('change', () => {
      refreshCharts();
    });

    $('nb-capteurs')?.addEventListener('input', (e) => {
      const display = $('nb-display');
      if (display) display.textContent = e.target.value;
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.toast').forEach((t) => t.remove());
      }
    });
  }

  // ── Init ────────────────────────────────────────────────

  function init() {
    bindEvents();
    initGrafana();

    const statusEl = $('initial-status');
    if (statusEl) {
      updateUI(JSON.parse(statusEl.textContent));
    }

    initCharts();
    fetch('/api/status/')
      .then((r) => r.json())
      .then((data) => {
        applySessionFromConfig(data.config);
        setPollInterval(data.running);
        if ($('config-display')) {
          $('config-display').textContent = JSON.stringify(data.config, null, 2);
        }
        return refreshCharts();
      })
      .catch(() => refreshCharts());

    pollTimer = setInterval(runPollCycle, pollIntervalMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
