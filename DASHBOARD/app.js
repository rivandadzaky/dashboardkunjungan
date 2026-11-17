/**
 * Dashboard Kunjungan Pasien — Puskesmas Bulusan
 * Logika aplikasi: filter, KPI, grafik, tabel, admin, upload, export.
 */

import {
  initDataLayer,
  fetchRows,
  fetchOnlineRows,
  upsertRows,
  updateRow,
  deleteRow,
  deletePeriod,
  saveOnlineRow,
  deleteOnlineRow,
  resetDemoData,
  getMode,
  getSession,
  getInitWarning,
  onAuthChange,
  signOut,
  isAuthenticated,
} from './supabase-client.js';

import { parseSimpusFile } from './parser.js';

import {
  MONTHS_ID,
  MONTHS_SHORT_ID,
  POLI_MASTER,
  canonicalPoliName,
  normalizePoliName,
  periodLabelFrom,
} from './data/poli.js';

/* -------------------------------------------------------------------------- */
/* Utilitas                                                                   */
/* -------------------------------------------------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const numberFormatter = new Intl.NumberFormat('id-ID');
const compactFormatter = new Intl.NumberFormat('id-ID', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Asia/Jakarta',
});

const BANNER_KEY = 'puskesmas-bulusan:banner-dismissed';
const EMPTY_TOTALS = () => ({
  baru_l: 0,
  baru_p: 0,
  lama_l: 0,
  lama_p: 0,
  jumlah_l: 0,
  jumlah_p: 0,
});

const state = {
  rows: [],
  onlineRows: [],
  mode: 'demo',
  session: null,
  error: null,
  tahun: null,
  bulan: 'all',
  poli: 'all',
  search: '',
  charts: { trend: null, status: null, gender: null, poli: null, online: null },
  editing: null,
  upload: { file: null, parsed: null, rows: [], duplicates: [] },
  chartsAvailable: true,
  busy: false,
  loaded: false,
};

let confirmResolver = null;

const formatNumber = (value) => numberFormatter.format(Number(value) || 0);
const compactNumber = (value) => compactFormatter.format(Number(value) || 0);
const formatPercent = (value, digits = 1) => {
  const number = Number(value) || 0;
  const formatted = number.toLocaleString('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
  return `${formatted}%`;
};
const formatFileSize = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toLocaleString('id-ID', { maximumFractionDigits: 1 })} ${units[index]}`;
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });

const totalOf = (row) => (Number(row.jumlah_l) || 0) + (Number(row.jumlah_p) || 0);
const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

function sumRows(rows) {
  const totals = EMPTY_TOTALS();
  rows.forEach((row) => {
    totals.baru_l += Number(row.baru_l) || 0;
    totals.baru_p += Number(row.baru_p) || 0;
    totals.lama_l += Number(row.lama_l) || 0;
    totals.lama_p += Number(row.lama_p) || 0;
    totals.jumlah_l += Number(row.jumlah_l) || 0;
    totals.jumlah_p += Number(row.jumlah_p) || 0;
  });
  return totals;
}

function monthName(month) {
  return MONTHS_ID[Number(month) - 1] || '';
}

function initialsOf(name) {
  const cleaned = String(name || '').replace(/^poli\s+/i, '').trim();
  const words = cleaned.split(/[\s/]+/).filter(Boolean);
  if (!words.length) return '—';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function getAvailableYears() {
  return [...new Set(state.rows.map((row) => Number(row.tahun)))].sort((a, b) => b - a);
}

function getAvailableMonths(year) {
  return [
    ...new Set(
      state.rows
        .filter((row) => Number(row.tahun) === Number(year))
        .map((row) => Number(row.bulan))
    ),
  ].sort((a, b) => a - b);
}

function latestMonthForYear(year) {
  const months = getAvailableMonths(year);
  return months.length ? months[months.length - 1] : null;
}

function getPoliNames() {
  const extras = new Set();
  state.rows.forEach((row) => {
    const name = normalizePoliName(row.nama_poli);
    if (name) extras.add(name);
  });
  [...extras].forEach((name) => {
    if (!POLI_MASTER.some((poli) => poli.toLowerCase() === name.toLowerCase())) {
      // tambahan poli di luar daftar baku tetap ditampilkan
    }
  });
  const extrasSorted = [...extras]
    .filter((name) => !POLI_MASTER.some((poli) => poli.toLowerCase() === name.toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'id'));
  return [...POLI_MASTER, ...extrasSorted];
}

function getPeriodRows() {
  if (!state.tahun) return [];
  return state.rows.filter(
    (row) =>
      Number(row.tahun) === Number(state.tahun) &&
      (state.bulan === 'all' || Number(row.bulan) === Number(state.bulan))
  );
}

function getScopedRows() {
  return getPeriodRows().filter(
    (row) => state.poli === 'all' || row.nama_poli === state.poli
  );
}

/** Total kunjungan online untuk tahun/bulan terpilih. */
function getOnlineTotal(year = state.tahun, month = state.bulan) {
  if (!year) return 0;
  return state.onlineRows
    .filter(
      (row) =>
        Number(row.tahun) === Number(year) &&
        (month === 'all' || Number(row.bulan) === Number(month))
    )
    .reduce((sum, row) => sum + (Number(row.jumlah_online) || 0), 0);
}

/** Baris online untuk satu periode tertentu. */
function getOnlineRow(year, month) {
  return (
    state.onlineRows.find(
      (row) =>
        Number(row.tahun) === Number(year) && Number(row.bulan) === Number(month)
    ) || null
  );
}

function aggregateByPoli(rows) {
  const map = new Map();
  const names = new Set([...getPoliNames(), ...rows.map((row) => row.nama_poli)]);

  names.forEach((name) => {
    map.set(name, { ...EMPTY_TOTALS(), nama_poli: name, count: 0, ids: [] });
  });

  rows.forEach((row) => {
    const name = row.nama_poli;
    if (!map.has(name)) {
      map.set(name, { ...EMPTY_TOTALS(), nama_poli: name, count: 0, ids: [] });
    }
    const entry = map.get(name);
    entry.baru_l += Number(row.baru_l) || 0;
    entry.baru_p += Number(row.baru_p) || 0;
    entry.lama_l += Number(row.lama_l) || 0;
    entry.lama_p += Number(row.lama_p) || 0;
    entry.jumlah_l += Number(row.jumlah_l) || 0;
    entry.jumlah_p += Number(row.jumlah_p) || 0;
    entry.count += 1;
    if (row.id) entry.ids.push(row.id);
  });

  return [...map.values()]
    .map((entry) => ({
      ...entry,
      total: entry.jumlah_l + entry.jumlah_p,
      detailTotal: entry.baru_l + entry.baru_p + entry.lama_l + entry.lama_p,
      id: entry.ids.length === 1 ? entry.ids[0] : null,
    }))
    .sort((a, b) => b.total - a.total || a.nama_poli.localeCompare(b.nama_poli, 'id'));
}

function currentPeriodLabel() {
  if (!state.tahun) return 'Belum ada periode';
  if (state.bulan !== 'all') return `${monthName(state.bulan)} ${state.tahun}`;
  const months = getAvailableMonths(state.tahun);
  if (!months.length) return String(state.tahun);
  const first = months[0];
  const last = months[months.length - 1];
  if (first === last) return `${monthName(first)} ${state.tahun}`;
  return `${monthName(first)} – ${monthName(last)} ${state.tahun}`;
}

/* -------------------------------------------------------------------------- */
/* Inisialisasi                                                               */
/* -------------------------------------------------------------------------- */

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;

  populateStaticSelects();
  bindEvents();

  try {
    await initDataLayer();
  } catch (error) {
    console.error('Gagal inisialisasi lapisan data:', error);
  }

  state.mode = getMode();
  state.session = getSession();

  onAuthChange((session, mode) => {
    state.session = session;
    state.mode = mode;
    renderAuth();
    renderMode();
    renderTable();
    renderDataAlert();
  });

  renderAuth();
  renderMode();

  state.chartsAvailable = await ensureChartLib();
  if (!state.chartsAvailable) {
    showToast(
      'Chart.js tidak dapat dimuat. Grafik tidak tersedia, tetapi tabel dan data tetap dapat digunakan.',
      'warning',
      7000
    );
  }

  await loadData({ initial: true });

  if (getInitWarning()) {
    showToast(getInitWarning(), 'warning', 6500);
  }

  hideLoading();
}

function hideLoading() {
  const screen = $('#loading-screen');
  if (!screen) return;
  screen.classList.add('is-hidden');
  window.setTimeout(() => screen.remove(), 450);
}

function populateStaticSelects() {
  const monthOptions = MONTHS_ID.map(
    (name, index) => `<option value="${index + 1}">${name}</option>`
  ).join('');

  const uploadMonth = $('#upload-month');
  const dataMonth = $('#data-month');
  const onlineMonth = $('#online-month');
  if (uploadMonth) uploadMonth.innerHTML = monthOptions;
  if (dataMonth) dataMonth.innerHTML = monthOptions;
  if (onlineMonth) onlineMonth.innerHTML = monthOptions;

  const datalist = $('#poli-options');
  if (datalist) {
    datalist.innerHTML = POLI_MASTER.map(
      (name) => `<option value="${escapeHtml(name)}"></option>`
    ).join('');
  }

  const yearNow = new Date().getFullYear();
  $('#upload-year').value = yearNow;
  $('#data-year').value = yearNow;
  $('#online-year').value = yearNow;
}

async function loadData({ initial = false, silent = false, preferPeriod = null } = {}) {
  if (state.busy) return;
  state.busy = true;
  const refreshButton = $('#btn-refresh');
  if (!silent) refreshButton?.classList.add('is-busy');

  try {
    const [rows, onlineRows] = await Promise.all([
      fetchRows(),
      fetchOnlineRows().catch((error) => {
        console.warn('Data kunjungan online tidak dapat dimuat:', error);
        return [];
      }),
    ]);
    state.rows = Array.isArray(rows) ? rows : [];
    state.onlineRows = Array.isArray(onlineRows) ? onlineRows : [];
    state.error = null;
    choosePeriod(preferPeriod, initial);
  } catch (error) {
    console.error(error);
    state.error = error.message || 'Gagal memuat data.';
  } finally {
    state.busy = false;
    state.loaded = true;
    refreshButton?.classList.remove('is-busy');
    renderAll();
    if (initial) hideLoading();
  }
}

function choosePeriod(preferPeriod = null, initial = false) {
  const years = getAvailableYears();

  if (!years.length) {
    state.tahun = null;
    state.bulan = 'all';
    state.poli = 'all';
    return;
  }

  const hadYear = state.tahun !== null;

  if (preferPeriod && years.includes(Number(preferPeriod.tahun))) {
    state.tahun = Number(preferPeriod.tahun);
  } else if (!state.tahun || !years.includes(Number(state.tahun))) {
    state.tahun = years[0];
  }

  const months = getAvailableMonths(state.tahun);

  if (preferPeriod && months.includes(Number(preferPeriod.bulan))) {
    state.bulan = Number(preferPeriod.bulan);
  } else if (!hadYear || initial) {
    state.bulan = months.length ? months[months.length - 1] : 'all';
  } else if (state.bulan !== 'all' && !months.includes(Number(state.bulan))) {
    state.bulan = months.length ? months[months.length - 1] : 'all';
  }

  if (state.poli !== 'all') {
    const poliExists = state.rows.some(
      (row) => Number(row.tahun) === Number(state.tahun) && row.nama_poli === state.poli
    );
    if (!poliExists) state.poli = 'all';
  }
}

/* -------------------------------------------------------------------------- */
/* Render utama                                                               */
/* -------------------------------------------------------------------------- */

function renderAll() {
  renderMode();
  renderAuth();
  renderFilterOptions();
  renderPeriod();
  renderDataAlert();
  renderKPI();
  renderCharts();
  renderTable();
  renderFooter();
}

function renderMode() {
  const modePill = $('#mode-pill');
  const isLive = state.mode === 'supabase';
  if (modePill) {
    modePill.textContent = isLive ? 'Supabase Live' : 'Mode Demo';
    modePill.classList.toggle('live', isLive);
  }

  const footerSource = $('#footer-source');
  if (footerSource) {
    footerSource.textContent = isLive ? 'Supabase' : 'Mode Demo';
  }

  const banner = $('#demo-banner');
  if (!banner) return;
  const warning = getInitWarning();
  const shouldShow = state.mode === 'demo' || Boolean(warning);
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem(BANNER_KEY) === '1';
  } catch {
    dismissed = false;
  }

  banner.classList.toggle('hidden', !shouldShow || dismissed);

  const bannerText = $('#demo-banner-text');
  if (bannerText) {
    if (warning) {
      bannerText.innerHTML = `<strong>Perhatian.</strong> ${escapeHtml(warning)} Menampilkan data demo dari browser.`;
    } else {
      bannerText.innerHTML =
        '<strong>Mode Demo.</strong> Dashboard menampilkan data contoh yang tersimpan di browser. ' +
        'Isi <code>config.js</code> dengan URL &amp; anon key Supabase untuk menggunakan data produksi.';
    }
  }
}

function renderAuth() {
  const authenticated = isAuthenticated();
  const session = state.session || getSession();
  const user = session?.user;

  $('#user-menu')?.classList.toggle('hidden', !authenticated);
  $('#admin-bar')?.classList.toggle('hidden', !authenticated);

  const email = user?.email || '';
  const displayName =
    user?.user_metadata?.full_name || email.split('@')[0] || 'Admin';

  const userEmail = $('#user-email');
  if (userEmail) userEmail.textContent = email;
  const adminEmail = $('#admin-email');
  if (adminEmail) adminEmail.textContent = email || '—';
  const avatar = $('#user-avatar');
  if (avatar) avatar.textContent = (displayName || 'A').slice(0, 1).toUpperCase();

  $('#btn-reset-demo')?.classList.toggle(
    'hidden',
    state.mode !== 'demo' || !authenticated
  );

  const tableCard = $('.table-card');
  tableCard?.classList.toggle('is-admin', authenticated);
}

function renderFilterOptions() {
  const years = getAvailableYears();
  const yearSelect = $('#filter-year');
  const monthSelect = $('#filter-month');
  const poliSelect = $('#filter-poli');
  const resetButton = $('#btn-reset-filter');

  if (yearSelect) {
    yearSelect.innerHTML = years.length
      ? years.map((year) => `<option value="${year}">${year}</option>`).join('')
      : '<option value="">—</option>';
    yearSelect.value = state.tahun ? String(state.tahun) : '';
    yearSelect.disabled = !years.length;
  }

  const months = state.tahun ? getAvailableMonths(state.tahun) : [];

  if (monthSelect) {
    const options = [
      '<option value="all">Semua Bulan (Akumulasi)</option>',
      ...MONTHS_ID.map((name, index) => {
        const month = index + 1;
        const hasData = months.includes(month);
        return `<option value="${month}" ${hasData ? '' : 'disabled'}>${name}${
          hasData ? '' : ' (tanpa data)'
        }</option>`;
      }),
    ];
    monthSelect.innerHTML = options.join('');
    monthSelect.value = state.bulan === 'all' ? 'all' : String(state.bulan);
    monthSelect.disabled = !months.length;
  }

  if (poliSelect) {
    const names = getPoliNames();
    if (state.poli !== 'all' && !names.includes(state.poli)) state.poli = 'all';
    poliSelect.innerHTML = [
      '<option value="all">Semua Poli / Unit</option>',
      ...names.map(
        (name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
      ),
    ].join('');
    poliSelect.value = state.poli;
    poliSelect.disabled = !state.rows.length;
  }

  if (resetButton) resetButton.disabled = !state.rows.length;
}

function renderPeriod() {
  const label = currentPeriodLabel();
  const scoped = getScopedRows();
  const totals = sumRows(scoped);
  const periodRows = getPeriodRows();
  const totalKunjungan = totals.jumlah_l + totals.jumlah_p;
  const activePolis =
    state.poli !== 'all'
      ? totalKunjungan > 0
        ? 1
        : 0
      : aggregateByPoli(periodRows).filter((row) => row.total > 0).length;

  const printLabel = $('#print-period-label');
  if (printLabel) printLabel.textContent = label;

  const description = $('#period-description');
  if (description) {
    if (!state.rows.length) {
      description.textContent =
        'Belum ada data kunjungan yang dapat ditampilkan. Admin dapat mengunggah file SIMPUS.';
    } else if (!periodRows.length) {
      description.textContent = `Tidak ada data pada ${label}. Pilih periode lain atau unggah data baru.`;
    } else {
      const total = totals.jumlah_l + totals.jumlah_p;
      const online = getOnlineTotal();
      description.textContent =
        `${state.bulan === 'all' ? 'Akumulasi' : 'Data'} ${label} · ` +
        `${activePolis} unit layanan · ${formatNumber(total)} kunjungan` +
        (online > 0
          ? ` · ${formatNumber(online)} kunjungan online${
              state.poli !== 'all' ? ' (total periode)' : ''
            }`
          : '') +
        (state.poli !== 'all' ? ` · ${state.poli}` : '');
    }
  }

  const trendSubtitle = $('#trend-subtitle');
  if (trendSubtitle) {
    trendSubtitle.textContent = `${MONTHS_ID[0]} — ${MONTHS_ID[11]} ${
      state.tahun || ''
    }${state.poli !== 'all' ? ` · ${state.poli}` : ''}`;
  }

  const poliSubtitle = $('#poli-chart-subtitle');
  if (poliSubtitle) {
    poliSubtitle.textContent = periodRows.length
      ? `Periode ${label} · ${activePolis} poli dengan kunjungan`
      : 'Belum ada data untuk periode ini';
  }

  const onlineSubtitle = $('#online-chart-subtitle');
  if (onlineSubtitle) {
    onlineSubtitle.textContent = state.tahun
      ? `Perbandingan per bulan · ${state.tahun} · seluruh unit layanan${
          state.bulan !== 'all' ? ` · sorotan ${monthName(state.bulan)}` : ''
        }`
      : 'Perbandingan per bulan';
  }

  const activeFilter = $('#active-filter');
  const chip = $('#active-filter-chip');
  if (activeFilter && chip) {
    const active = state.poli !== 'all';
    activeFilter.classList.toggle('hidden', !active);
    chip.textContent = active ? `Poli: ${state.poli}` : '—';
  }

  const tableSubtitle = $('#table-subtitle');
  if (tableSubtitle) {
    const total = sumRows(getScopedRows());
    tableSubtitle.textContent = periodRows.length
      ? `${label} · ${
          state.poli === 'all'
            ? `${aggregateByPoli(getScopedRows()).length} poli`
            : state.poli
        } · ${formatNumber(total.jumlah_l + total.jumlah_p)} kunjungan`
      : 'Belum ada data pada periode ini';
  }

  const onlineChip = $('#table-online-chip');
  if (onlineChip) {
    const online = getOnlineTotal();
    onlineChip.classList.toggle('hidden', !(online > 0));
    onlineChip.textContent = online > 0
      ? `${formatNumber(online)} kunjungan online`
      : '';
  }
}

function renderDataAlert() {
  const alertBox = $('#data-alert');
  if (!alertBox) return;

  const show = (html, type = 'warning') => {
    alertBox.className = `data-alert ${type === 'error' ? 'is-error' : ''}`;
    alertBox.innerHTML = `<svg class="icon"><use href="#i-${
      type === 'error' ? 'alert' : 'info'
    }"></use></svg><div>${html}</div>`;
  };

  if (state.error) {
    show(
      `<strong>Data gagal dimuat.</strong> ${escapeHtml(state.error)} ` +
        '<button class="link-btn" type="button" data-alert-action="retry">Coba lagi</button>',
      'error'
    );
    return;
  }

  if (state.loaded && !state.rows.length) {
    show(
      '<strong>Belum ada data.</strong> ' +
        (isAuthenticated()
          ? state.mode === 'demo'
            ? 'Gunakan tombol <em>Reset Demo</em> atau unggah file SIMPUS.'
            : 'Unggah file ekspor SIMPUS untuk mulai menampilkan dashboard.'
          : 'Hubungi administrator untuk mengisi data kunjungan.')
    );
    return;
  }

  if (state.rows.length && !getPeriodRows().length && state.tahun) {
    show(
      `<strong>Tidak ada data pada ${escapeHtml(currentPeriodLabel())}.</strong> ` +
        'Pilih bulan/tahun lain melalui filter di atas.'
    );
    return;
  }

  if (state.rows.length && state.poli !== 'all' && !getScopedRows().length) {
    show(
      `<strong>Tidak ada data ${escapeHtml(state.poli)} pada periode ini.</strong> ` +
        'Hapus filter poli untuk melihat seluruh unit layanan.'
    );
    return;
  }

  alertBox.className = 'data-alert hidden';
  alertBox.innerHTML = '';
}

function renderKPI() {
  const scoped = getScopedRows();
  const totals = sumRows(scoped);
  const total = totals.jumlah_l + totals.jumlah_p;
  const periodRows = getPeriodRows();
  const periodTotals = sumRows(periodRows);

  // Total kunjungan
  const totalEl = $('#kpi-total');
  if (totalEl) totalEl.textContent = state.rows.length ? formatNumber(total) : '—';

  const totalSub = $('#kpi-total-sub');
  if (totalSub) {
    if (!state.rows.length) {
      totalSub.textContent = 'Belum ada data kunjungan';
    } else if (!scoped.length) {
      totalSub.textContent = `${currentPeriodLabel()} · tidak ada data`;
    } else {
      const online = getOnlineTotal();
      totalSub.textContent =
        `${currentPeriodLabel()} · ${formatNumber(total)} kunjungan tercatat` +
        (online > 0
          ? ` · ${formatNumber(online)} kunjungan online${
              state.poli !== 'all' ? ' (total periode)' : ''
            }`
          : '');
    }
  }

  const deltaEl = $('#kpi-total-delta');
  if (deltaEl) {
    const comparison = getComparison(total);
    if (!state.rows.length || !scoped.length) {
      deltaEl.className = 'kpi-delta is-neutral';
      deltaEl.textContent = 'Belum ada data pembanding';
    } else if (!comparison) {
      deltaEl.className = 'kpi-delta is-neutral';
      deltaEl.textContent = 'Tanpa pembanding';
    } else {
      const { previous, label } = comparison;
      if (previous === 0) {
        deltaEl.className = 'kpi-delta is-up';
        deltaEl.innerHTML = `<svg class="icon"><use href="#i-arrow-up"></use></svg>Baru · ${escapeHtml(
          label
        )}`;
      } else if (previous === total) {
        deltaEl.className = 'kpi-delta is-neutral';
        deltaEl.textContent = `Tetap · ${label}`;
      } else {
        const percent = ((total - previous) / previous) * 100;
        const up = percent > 0;
        deltaEl.className = `kpi-delta ${up ? 'is-up' : 'is-down'}`;
        deltaEl.innerHTML =
          `<svg class="icon"><use href="#i-${up ? 'arrow-up' : 'arrow-down'}"></use></svg>` +
          `${up ? '+' : '−'}${formatPercent(Math.abs(percent))} ${escapeHtml(label)}`;
      }
    }
  }

  // Poli terpadat (tidak terpengaruh filter poli)
  const poliAggregates = aggregateByPoli(periodRows).filter((row) => row.total > 0);
  const top = poliAggregates[0];
  const topTotal = top ? top.total : 0;
  const topShare = periodTotals.jumlah_l + periodTotals.jumlah_p > 0
    ? (topTotal / (periodTotals.jumlah_l + periodTotals.jumlah_p)) * 100
    : 0;

  const poliName = $('#kpi-poli-name');
  if (poliName) poliName.textContent = top ? top.nama_poli : '—';

  const poliDetail = $('#kpi-poli-detail');
  if (poliDetail) {
    if (top) {
      poliDetail.className = 'kpi-delta is-neutral';
      poliDetail.innerHTML = `${formatNumber(topTotal)} kunjungan · ${formatPercent(topShare)}`;
    } else {
      poliDetail.className = 'kpi-delta is-neutral';
      poliDetail.textContent = 'Belum ada kunjungan';
    }
  }

  const poliBar = $('#kpi-poli-bar');
  if (poliBar) poliBar.style.width = `${Math.max(0, Math.min(100, topShare))}%`;

  const poliSub = $('#kpi-poli-sub');
  if (poliSub) {
    poliSub.textContent = periodRows.length
      ? `dari ${formatNumber(periodTotals.jumlah_l + periodTotals.jumlah_p)} kunjungan periode`
      : 'Belum ada data pada periode ini';
  }

  // Baru vs lama
  const baru = totals.baru_l + totals.baru_p;
  const lama = totals.lama_l + totals.lama_p;
  const statusTotal = baru + lama;
  const baruPct = statusTotal ? (baru / statusTotal) * 100 : 0;
  const lamaPct = statusTotal ? (lama / statusTotal) * 100 : 0;

  const ratioEl = $('#kpi-new-ratio');
  if (ratioEl) {
    ratioEl.textContent = statusTotal
      ? `${Math.round(baruPct)} : ${Math.round(lamaPct)}`
      : '—';
  }

  const newBar = $('#kpi-new-bar');
  const lamaBar = $('#kpi-lama-bar');
  if (newBar) newBar.style.width = `${baruPct}%`;
  if (lamaBar) lamaBar.style.width = `${lamaPct}%`;

  const baruEl = $('#kpi-baru');
  if (baruEl) baruEl.textContent = formatNumber(baru);
  const lamaEl = $('#kpi-lama');
  if (lamaEl) lamaEl.textContent = formatNumber(lama);
  const baruPctEl = $('#kpi-baru-pct');
  if (baruPctEl) baruPctEl.textContent = formatPercent(baruPct);
  const lamaPctEl = $('#kpi-lama-pct');
  if (lamaPctEl) lamaPctEl.textContent = formatPercent(lamaPct);

  // Gender
  const male = totals.jumlah_l;
  const female = totals.jumlah_p;
  const genderTotal = male + female;
  const malePct = genderTotal ? (male / genderTotal) * 100 : 0;
  const femalePct = genderTotal ? (female / genderTotal) * 100 : 0;

  const genderRatio = $('#kpi-gender-ratio');
  if (genderRatio) {
    genderRatio.textContent = genderTotal
      ? `${Math.round(malePct)} : ${Math.round(femalePct)}`
      : '—';
  }

  const maleBar = $('#kpi-male-bar');
  const femaleBar = $('#kpi-female-bar');
  if (maleBar) maleBar.style.width = `${malePct}%`;
  if (femaleBar) femaleBar.style.width = `${femalePct}%`;

  const maleEl = $('#kpi-male');
  if (maleEl) maleEl.textContent = formatNumber(male);
  const femaleEl = $('#kpi-female');
  if (femaleEl) femaleEl.textContent = formatNumber(female);
  const malePctEl = $('#kpi-male-pct');
  if (malePctEl) malePctEl.textContent = formatPercent(malePct);
  const femalePctEl = $('#kpi-female-pct');
  if (femalePctEl) femalePctEl.textContent = formatPercent(femalePct);
}

function getComparison(currentTotal) {
  if (!state.tahun) return null;

  let previousRows = [];
  let label = '';

  if (state.bulan === 'all') {
    const previousYear = Number(state.tahun) - 1;
    previousRows = state.rows.filter(
      (row) =>
        Number(row.tahun) === previousYear &&
        (state.poli === 'all' || row.nama_poli === state.poli)
    );
    label = `vs ${previousYear}`;
  } else {
    const month = Number(state.bulan);
    const previousMonth = month === 1 ? 12 : month - 1;
    const previousYear = month === 1 ? Number(state.tahun) - 1 : Number(state.tahun);
    previousRows = state.rows.filter(
      (row) =>
        Number(row.tahun) === previousYear &&
        Number(row.bulan) === previousMonth &&
        (state.poli === 'all' || row.nama_poli === state.poli)
    );
    label = `vs ${monthName(previousMonth)} ${previousYear}`;
  }

  if (!previousRows.length) return null;
  const previous = sumRows(previousRows);
  return { previous: previous.jumlah_l + previous.jumlah_p, label, currentTotal };
}

/* -------------------------------------------------------------------------- */
/* Grafik                                                                     */
/* -------------------------------------------------------------------------- */

async function ensureChartLib() {
  if (window.Chart) return true;

  try {
    await new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-chart-fallback]');
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
      script.async = true;
      script.dataset.chartFallback = 'true';
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('Chart.js gagal dimuat')), {
        once: true,
      });
      document.head.appendChild(script);
      window.setTimeout(() => reject(new Error('Chart.js timeout')), 9000);
    });
    return Boolean(window.Chart);
  } catch (error) {
    console.warn(error);
    return false;
  }
}

function showChartFallback() {
  state.chartsAvailable = false;
  $$('.chart-box').forEach((box) => {
    if (box.querySelector('.chart-fallback')) return;
    const note = document.createElement('div');
    note.className = 'chart-fallback';
    note.textContent =
      'Grafik tidak dapat dimuat. Periksa koneksi internet lalu muat ulang halaman.';
    box.appendChild(note);
  });
}

function clearChartFallback() {
  $$('.chart-fallback').forEach((node) => node.remove());
}

function buildTrendData() {
  const baru = [];
  const lama = [];
  const total = [];
  const counts = [];

  for (let month = 1; month <= 12; month += 1) {
    const rows = state.rows.filter(
      (row) =>
        Number(row.tahun) === Number(state.tahun) &&
        Number(row.bulan) === month &&
        (state.poli === 'all' || row.nama_poli === state.poli)
    );

    if (!rows.length) {
      baru.push(null);
      lama.push(null);
      total.push(null);
      counts.push(0);
      continue;
    }

    const sums = sumRows(rows);
    baru.push(sums.baru_l + sums.baru_p);
    lama.push(sums.lama_l + sums.lama_p);
    total.push(sums.jumlah_l + sums.jumlah_p);
    counts.push(rows.length);
  }

  return { labels: MONTHS_SHORT_ID, baru, lama, total, counts };
}

function buildPoliChartData() {
  const aggregates = aggregateByPoli(getPeriodRows());
  const labels = aggregates.map((row) => row.nama_poli);
  const values = aggregates.map((row) => row.total);
  const grandTotal = values.reduce((sum, value) => sum + value, 0);
  const shares = values.map((value) => (grandTotal ? (value / grandTotal) * 100 : 0));
  const colors = labels.map((label, index) => {
    if (label === state.poli) return '#f59e0b';
    if (index < 3) return '#0f766e';
    if (index < 7) return '#14b8a6';
    return '#99f6e4';
  });
  return { labels, values, shares, colors, grandTotal };
}

/**
 * Data kunjungan online vs datang langsung per bulan (seluruh unit layanan).
 * Datang langsung = total kunjungan bulan - kunjungan online bulan tersebut.
 * Angka online hanya tersedia sebagai total puskesmas, sehingga grafik ini
 * tidak mengikuti filter poli.
 */
function buildOnlineChartData() {
  const online = [];
  const direct = [];
  const total = [];
  const counts = [];

  for (let month = 1; month <= 12; month += 1) {
    const rows = state.rows.filter(
      (row) =>
        Number(row.tahun) === Number(state.tahun) && Number(row.bulan) === month
    );

    if (!rows.length) {
      online.push(null);
      direct.push(null);
      total.push(null);
      counts.push(0);
      continue;
    }

    const totalMonth = rows.reduce((sum, row) => sum + totalOf(row), 0);
    const onlineMonth = Math.min(
      totalMonth,
      Math.max(0, Number(getOnlineRow(state.tahun, month)?.jumlah_online) || 0)
    );

    online.push(onlineMonth);
    direct.push(Math.max(0, totalMonth - onlineMonth));
    total.push(totalMonth);
    counts.push(rows.length);
  }

  const hasOnline = state.onlineRows.some(
    (row) => Number(row.tahun) === Number(state.tahun)
  );

  return { labels: MONTHS_SHORT_ID, online, direct, total, counts, hasOnline };
}

function buildChartPayload() {
  const scoped = getScopedRows();
  const totals = sumRows(scoped);
  const baru = totals.baru_l + totals.baru_p;
  const lama = totals.lama_l + totals.lama_p;
  const male = totals.jumlah_l;
  const female = totals.jumlah_p;
  return {
    trend: buildTrendData(),
    poli: buildPoliChartData(),
    online: buildOnlineChartData(),
    status: { baru, lama, total: baru + lama, grandTotal: male + female },
    gender: { male, female, total: male + female },
  };
}

function renderCharts() {
  if (!state.chartsAvailable || !window.Chart) {
    showChartFallback();
    return;
  }

  clearChartFallback();
  const payload = buildChartPayload();

  if (!state.charts.trend) {
    createCharts(payload);
  } else {
    updateCharts(payload);
  }

  renderChartLegends(payload);
  renderTrendFoot(payload.trend);
  renderOnlineChartFoot(payload.online);
}

function createCharts(payload) {
  Chart.defaults.font.family =
    "'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#64748b';
  Chart.defaults.borderColor = '#eef3f2';

  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15, 23, 42, 0.92)';
  Chart.defaults.plugins.tooltip.titleFont = { size: 11, weight: '700' };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 11, weight: '500' };
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.displayColors = true;
  Chart.defaults.plugins.tooltip.boxPadding = 4;

  state.charts.trend = new Chart($('#chart-trend'), {
    type: 'bar',
    data: {
      labels: payload.trend.labels,
      datasets: [
        {
          type: 'bar',
          label: 'Pasien Baru',
          data: payload.trend.baru,
          backgroundColor: '#0d9488',
          hoverBackgroundColor: '#0f766e',
          borderRadius: 5,
          borderSkipped: false,
          stack: 'kunjungan',
          maxBarThickness: 30,
          order: 2,
        },
        {
          type: 'bar',
          label: 'Pasien Lama',
          data: payload.trend.lama,
          backgroundColor: '#99f6e4',
          hoverBackgroundColor: '#5eead4',
          borderRadius: 5,
          borderSkipped: false,
          stack: 'kunjungan',
          maxBarThickness: 30,
          order: 2,
        },
        {
          type: 'line',
          label: 'Total Kunjungan',
          data: payload.trend.total,
          borderColor: '#0f172a',
          backgroundColor: 'rgba(15, 23, 42, 0.05)',
          borderWidth: 2,
          tension: 0.34,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#0f172a',
          pointBorderWidth: 2,
          spanGaps: true,
          fill: false,
          order: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 500 },
      layout: { padding: { top: 4, right: 4 } },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 10, weight: '600' },
            color: '#94a3b8',
            maxRotation: 0,
            autoSkip: true,
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#eef3f2', drawTicks: false },
          border: { display: false },
          ticks: {
            padding: 8,
            font: { size: 10 },
            color: '#94a3b8',
            callback: (value) => compactNumber(value),
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 7,
            boxHeight: 7,
            padding: 14,
            font: { size: 10, weight: '600' },
            color: '#475569',
          },
        },
        tooltip: {
          callbacks: {
            label: (context) =>
              context.parsed.y === null
                ? ''
                : `${context.dataset.label}: ${formatNumber(context.parsed.y)}`,
          },
        },
      },
    },
  });

  state.charts.status = new Chart($('#chart-status'), {
    type: 'doughnut',
    data: {
      labels: ['Pasien Baru', 'Pasien Lama'],
      datasets: [
        {
          data: [payload.status.baru, payload.status.lama],
          backgroundColor: ['#0d9488', '#fbbf24'],
          hoverBackgroundColor: ['#0f766e', '#f59e0b'],
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '71%',
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const value = Number(context.parsed) || 0;
              const total = (context.dataset.data || []).reduce(
                (sum, item) => sum + (Number(item) || 0),
                0
              );
              const percent = total ? (value / total) * 100 : 0;
              return `${context.label}: ${formatNumber(value)} (${formatPercent(percent)})`;
            },
          },
        },
      },
    },
  });

  state.charts.gender = new Chart($('#chart-gender'), {
    type: 'doughnut',
    data: {
      labels: ['Laki-laki', 'Perempuan'],
      datasets: [
        {
          data: [payload.gender.male, payload.gender.female],
          backgroundColor: ['#3b82f6', '#ec4899'],
          hoverBackgroundColor: ['#2563eb', '#db2777'],
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '71%',
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const value = Number(context.parsed) || 0;
              const total = (context.dataset.data || []).reduce(
                (sum, item) => sum + (Number(item) || 0),
                0
              );
              const percent = total ? (value / total) * 100 : 0;
              return `${context.label}: ${formatNumber(value)} (${formatPercent(percent)})`;
            },
          },
        },
      },
    },
  });

  const poliChart = new Chart($('#chart-poli'), {
    type: 'bar',
    data: {
      labels: payload.poli.labels,
      datasets: [
        {
          label: 'Kunjungan',
          data: payload.poli.values,
          backgroundColor: payload.poli.colors,
          hoverBackgroundColor: '#0f766e',
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.72,
          categoryPercentage: 0.85,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      layout: { padding: { right: 8 } },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: '#eef3f2', drawTicks: false },
          border: { display: false },
          ticks: {
            padding: 8,
            font: { size: 10 },
            color: '#94a3b8',
            callback: (value) => compactNumber(value),
          },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 10.5, weight: '600' },
            color: '#334155',
            padding: 6,
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(context) {
              const shares = context.chart.$shares || [];
              const share = shares[context.dataIndex];
              return `${formatNumber(context.parsed.x)} kunjungan${
                share !== undefined ? ` · ${formatPercent(share)}` : ''
              }`;
            },
          },
        },
      },
      onClick: (_event, elements) => {
        if (!elements.length) return;
        const chart = state.charts.poli;
        const label = chart?.data?.labels?.[elements[0].index];
        if (!label) return;
        state.poli = state.poli === label ? 'all' : label;
        state.editing = null;
        renderAll();
      },
    },
  });

  poliChart.$shares = payload.poli.shares;
  state.charts.poli = poliChart;

  const onlineChart = new Chart($('#chart-online'), {
    type: 'bar',
    data: {
      labels: payload.online.labels,
      datasets: [
        {
          label: 'Kunjungan Online',
          data: payload.online.online,
          backgroundColor: '#3b82f6',
          hoverBackgroundColor: '#2563eb',
          borderRadius: 4,
          borderSkipped: false,
          stack: 'sumber',
          maxBarThickness: 36,
        },
        {
          label: 'Datang Langsung',
          data: payload.online.direct,
          backgroundColor: '#0d9488',
          hoverBackgroundColor: '#0f766e',
          borderRadius: 4,
          borderSkipped: false,
          stack: 'sumber',
          maxBarThickness: 36,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 500 },
      layout: { padding: { top: 4, right: 4 } },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: { size: 10, weight: '600' },
            color: '#94a3b8',
            maxRotation: 0,
            autoSkip: true,
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: '#eef3f2', drawTicks: false },
          border: { display: false },
          ticks: {
            padding: 8,
            font: { size: 10 },
            color: '#94a3b8',
            callback: (value) => compactNumber(value),
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            boxWidth: 7,
            boxHeight: 7,
            padding: 14,
            font: { size: 10, weight: '600' },
            color: '#475569',
          },
        },
        tooltip: {
          filter: (item) => item.parsed.y !== null,
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${formatNumber(context.parsed.y)}`,
            footer: (items) => {
              if (!items.length) return '';
              const totals = items[0].chart.$totals || [];
              const total = totals[items[0].dataIndex];
              return total === null || total === undefined
                ? ''
                : `Total kunjungan: ${formatNumber(total)}`;
            },
          },
        },
      },
    },
  });

  onlineChart.$totals = payload.online.total;
  state.charts.online = onlineChart;
}

function updateCharts(payload) {
  const trend = state.charts.trend;
  trend.data.labels = payload.trend.labels;
  trend.data.datasets[0].data = payload.trend.baru;
  trend.data.datasets[1].data = payload.trend.lama;
  trend.data.datasets[2].data = payload.trend.total;
  trend.update();

  const status = state.charts.status;
  status.data.datasets[0].data = [payload.status.baru, payload.status.lama];
  status.update();

  const gender = state.charts.gender;
  gender.data.datasets[0].data = [payload.gender.male, payload.gender.female];
  gender.update();

  const poli = state.charts.poli;
  poli.data.labels = payload.poli.labels;
  poli.data.datasets[0].data = payload.poli.values;
  poli.data.datasets[0].backgroundColor = payload.poli.colors;
  poli.$shares = payload.poli.shares;
  poli.update();

  const online = state.charts.online;
  online.data.labels = payload.online.labels;
  online.data.datasets[0].data = payload.online.online;
  online.data.datasets[1].data = payload.online.direct;
  online.$totals = payload.online.total;
  online.update();
}

function renderChartLegends(payload) {
  const statusLegend = $('#legend-status');
  if (statusLegend) {
    const total = payload.status.total;
    const baruPct = total ? (payload.status.baru / total) * 100 : 0;
    const lamaPct = total ? (payload.status.lama / total) * 100 : 0;
    statusLegend.innerHTML = [
      `<div class="legend-row"><span class="dot" style="background:#0d9488"></span>Baru <strong>${formatNumber(
        payload.status.baru
      )}</strong><em>${formatPercent(baruPct)}</em></div>`,
      `<div class="legend-row"><span class="dot" style="background:#fbbf24"></span>Lama <strong>${formatNumber(
        payload.status.lama
      )}</strong><em>${formatPercent(lamaPct)}</em></div>`,
    ].join('');
  }

  const genderLegend = $('#legend-gender');
  if (genderLegend) {
    const total = payload.gender.total;
    const malePct = total ? (payload.gender.male / total) * 100 : 0;
    const femalePct = total ? (payload.gender.female / total) * 100 : 0;
    genderLegend.innerHTML = [
      `<div class="legend-row"><span class="dot" style="background:#3b82f6"></span>Laki-laki <strong>${formatNumber(
        payload.gender.male
      )}</strong><em>${formatPercent(malePct)}</em></div>`,
      `<div class="legend-row"><span class="dot" style="background:#ec4899"></span>Perempuan <strong>${formatNumber(
        payload.gender.female
      )}</strong><em>${formatPercent(femalePct)}</em></div>`,
    ].join('');
  }

  const statusTotal = $('#donut-status-total');
  if (statusTotal) statusTotal.textContent = formatNumber(payload.status.total);
  const genderTotal = $('#donut-gender-total');
  if (genderTotal) genderTotal.textContent = formatNumber(payload.gender.total);
}

function renderTrendFoot(trend) {
  const foot = $('#trend-foot');
  if (!foot) return;

  const months = [];
  let total = 0;

  trend.total.forEach((value, index) => {
    if (value !== null) {
      months.push({ index, value: Number(value) || 0 });
      total += Number(value) || 0;
    }
  });

  if (!months.length) {
    foot.innerHTML =
      '<span class="foot-stat text-muted">Belum ada data kunjungan pada tahun ini.</span>';
    return;
  }

  const best = months.reduce((top, item) => (item.value > top.value ? item : top), months[0]);
  const average = Math.round(total / months.length);

  foot.innerHTML = [
    `<span class="foot-stat"><span class="dot dot-teal"></span>Rata-rata/bulan <strong>${formatNumber(
      average
    )}</strong></span>`,
    `<span class="foot-stat"><span class="dot dot-amber"></span>Tertinggi <strong>${escapeHtml(
      monthName(best.index + 1)
    )} · ${formatNumber(best.value)}</strong></span>`,
    `<span class="foot-stat"><span class="dot dot-blue"></span>Total tahun <strong>${formatNumber(
      total
    )}</strong></span>`,
  ].join('');
}

function renderOnlineChartFoot(data) {
  const foot = $('#online-foot');
  if (!foot) return;

  const available = [];
  data.total.forEach((value, index) => {
    if (value !== null) available.push(index);
  });

  if (!available.length) {
    foot.innerHTML =
      '<span class="foot-stat text-muted">Belum ada data kunjungan pada tahun ini.</span>';
    return;
  }

  const monthIndex = state.bulan !== 'all' ? Number(state.bulan) - 1 : null;
  const useMonth = monthIndex !== null && available.includes(monthIndex);
  const indices = useMonth ? [monthIndex] : available;

  let online = 0;
  let direct = 0;
  let total = 0;
  indices.forEach((index) => {
    online += Number(data.online[index]) || 0;
    direct += Number(data.direct[index]) || 0;
    total += Number(data.total[index]) || 0;
  });

  const onlinePct = total ? (online / total) * 100 : 0;
  const directPct = total ? (direct / total) * 100 : 0;
  const periodLabel = useMonth
    ? `${monthName(monthIndex + 1)} ${state.tahun}`
    : `Tahun ${state.tahun}`;

  const parts = [
    `<span class="foot-stat"><span class="dot dot-blue"></span>Online · ${escapeHtml(
      periodLabel
    )} <strong>${formatNumber(online)}</strong> (${formatPercent(onlinePct)})</span>`,
    `<span class="foot-stat"><span class="dot dot-teal"></span>Datang langsung <strong>${formatNumber(
      direct
    )}</strong> (${formatPercent(directPct)})</span>`,
    `<span class="foot-stat"><span class="dot dot-amber"></span>Total <strong>${formatNumber(
      total
    )}</strong></span>`,
  ];

  if (!data.hasOnline) {
    parts.push(
      '<span class="foot-stat text-muted">Belum ada data online tahun ini</span>'
    );
  }

  foot.innerHTML = parts.join('');
}

/* -------------------------------------------------------------------------- */
/* Tabel                                                                      */
/* -------------------------------------------------------------------------- */

function renderTable() {
  const tbody = $('#table-body');
  const tfoot = $('#table-foot');
  if (!tbody || !tfoot) return;

  const scoped = getScopedRows();
  const aggregates = aggregateByPoli(scoped).filter(
    (row) => state.poli === 'all' || row.nama_poli === state.poli
  );
  const search = state.search.trim().toLowerCase();
  const visible = search
    ? aggregates.filter((row) => row.nama_poli.toLowerCase().includes(search))
    : aggregates;

  if (state.editing) {
    const stillVisible = visible.some(
      (row) => row.nama_poli === state.editing.nama_poli
    );
    if (!stillVisible || state.bulan === 'all') state.editing = null;
  }

  const hasData = state.rows.length > 0;
  const hasVisible = visible.length > 0;
  const tableWrap = $('.table-wrap');
  const emptyState = $('#table-empty');
  const emptyText = $('#table-empty p');
  const emptyAction = $('#btn-empty-action');

  tableWrap?.classList.toggle('hidden', !hasData || !hasVisible);
  emptyState?.classList.toggle('hidden', hasData && hasVisible);

  if (emptyText) {
    emptyText.textContent = !hasData
      ? isAuthenticated()
        ? 'Belum ada data kunjungan. Unggah file ekspor SIMPUS untuk mulai mengisi dashboard.'
        : 'Belum ada data kunjungan. Hubungi administrator untuk mengunggah data SIMPUS.'
      : search
        ? `Tidak ada poli yang cocok dengan “${state.search.trim()}”.`
        : 'Tidak ada data pada periode ini.';
  }

  if (emptyAction) {
    const canUpload = isAuthenticated();
    emptyAction.classList.toggle('hidden', !canUpload || hasData);
    emptyAction.textContent = 'Upload data SIMPUS';
  }

  if (!hasData || !hasVisible) {
    tbody.innerHTML = '';
    tfoot.innerHTML = '';
    const subtitle = $('#table-subtitle');
    if (subtitle) {
      subtitle.textContent = !hasData
        ? 'Belum ada data'
        : `Tidak ada hasil untuk “${state.search.trim()}”`;
    }
    return;
  }

  tbody.innerHTML = visible
    .map((row) => {
      const isEditing = state.editing?.nama_poli === row.nama_poli;
      const canEdit = state.bulan !== 'all';
      const grandTotal = sumRows(scoped).jumlah_l + sumRows(scoped).jumlah_p;
      const share = grandTotal ? (row.total / grandTotal) * 100 : 0;

      let badge = '<span class="badge badge-ok">Tercatat</span>';
      if (row.total === 0) {
        badge = '<span class="badge badge-zero">0 kunjungan</span>';
      } else if (row.detailTotal === 0) {
        badge = '<span class="badge badge-partial">Tanpa rincian</span>';
      }

      const numberCell = (field, value) =>
        isEditing
          ? `<td class="num"><input class="cell-input" type="number" min="0" step="1" inputmode="numeric" data-field="${field}" value="${Number(
              value
            ) || 0}" aria-label="${field}" /></td>`
          : `<td class="num">${formatNumber(value)}</td>`;

      const actionCell = isEditing
        ? `<td class="col-actions admin-only">
             <div class="row-actions">
               <button class="row-btn" type="button" data-action="save-inline" title="Simpan perubahan" aria-label="Simpan perubahan">
                 <svg class="icon"><use href="#i-check"></use></svg>
               </button>
               <button class="row-btn danger" type="button" data-action="cancel-inline" title="Batal" aria-label="Batal">
                 <svg class="icon"><use href="#i-x"></use></svg>
               </button>
             </div>
           </td>`
        : `<td class="col-actions admin-only">
             <div class="row-actions">
               <button class="row-btn" type="button" data-action="edit-row" data-poli="${escapeHtml(
                 row.nama_poli
               )}" ${canEdit ? '' : 'disabled'} title="${
                 canEdit ? 'Edit angka kunjungan' : 'Pilih bulan tertentu untuk mengedit'
               }" aria-label="Edit ${escapeHtml(row.nama_poli)}">
                 <svg class="icon"><use href="#i-edit"></use></svg>
               </button>
               <button class="row-btn danger" type="button" data-action="delete-row" data-id="${
                 row.id || ''
               }" data-poli="${escapeHtml(row.nama_poli)}" ${
                 canEdit && row.id ? '' : 'disabled'
               } title="${
                 canEdit ? 'Hapus data poli ini' : 'Pilih bulan tertentu untuk menghapus'
               }" aria-label="Hapus ${escapeHtml(row.nama_poli)}">
                 <svg class="icon"><use href="#i-trash"></use></svg>
               </button>
             </div>
           </td>`;

      return `
        <tr class="${isEditing ? 'is-editing' : ''}" data-poli="${escapeHtml(row.nama_poli)}">
          <td class="sticky-col">
            <div class="poli-cell">
              <span class="poli-avatar" aria-hidden="true">${escapeHtml(
                initialsOf(row.nama_poli)
              )}</span>
              <span class="poli-name">${escapeHtml(row.nama_poli)}</span>
            </div>
          </td>
          ${numberCell('baru_l', row.baru_l)}
          ${numberCell('baru_p', row.baru_p)}
          ${numberCell('lama_l', row.lama_l)}
          ${numberCell('lama_p', row.lama_p)}
          ${numberCell('jumlah_l', row.jumlah_l)}
          ${numberCell('jumlah_p', row.jumlah_p)}
          <td class="num num-total">${formatNumber(row.total)}</td>
          <td class="col-share">
            <div class="share-cell">
              <span class="share-track"><span class="share-fill" style="width:${Math.max(
                0,
                Math.min(100, share)
              )}%"></span></span>
              <span class="share-value">${formatPercent(share, 1)}</span>
            </div>
          </td>
          <td class="col-status">${badge}</td>
          ${actionCell}
        </tr>`;
    })
    .join('');

  const footTotals = sumRows(scoped);
  const footVisible = visible.reduce((totals, row) => {
    totals.baru_l += row.baru_l;
    totals.baru_p += row.baru_p;
    totals.lama_l += row.lama_l;
    totals.lama_p += row.lama_p;
    totals.jumlah_l += row.jumlah_l;
    totals.jumlah_p += row.jumlah_p;
    return totals;
  }, EMPTY_TOTALS());

  const footTotal = footVisible.jumlah_l + footVisible.jumlah_p;

  tfoot.innerHTML = `
    <tr>
      <td class="sticky-col">Total${search ? ' (hasil filter)' : ''}</td>
      <td class="num">${formatNumber(footVisible.baru_l)}</td>
      <td class="num">${formatNumber(footVisible.baru_p)}</td>
      <td class="num">${formatNumber(footVisible.lama_l)}</td>
      <td class="num">${formatNumber(footVisible.lama_p)}</td>
      <td class="num">${formatNumber(footVisible.jumlah_l)}</td>
      <td class="num">${formatNumber(footVisible.jumlah_p)}</td>
      <td class="num num-total">${formatNumber(footTotal)}</td>
      <td class="col-share"><span class="text-muted">${
        search ? formatPercent((footTotal / (footTotals.jumlah_l + footTotals.jumlah_p || 1)) * 100) : '100%'
      }</span></td>
      <td class="col-status"></td>
      <td class="col-actions admin-only"></td>
    </tr>`;

  if (state.editing) {
    window.requestAnimationFrame(() => {
      $('.cell-input')?.focus();
      $('.cell-input')?.select?.();
    });
  }

  if (search) {
    const subtitle = $('#table-subtitle');
    if (subtitle) {
      subtitle.textContent = `${visible.length} hasil untuk “${state.search.trim()}” · ${currentPeriodLabel()}`;
    }
  }

  renderFooter();
}

function renderFooter() {
  const lastUpdated = $('#last-updated');
  if (!lastUpdated) return;

  const timestamps = [...state.rows, ...state.onlineRows]
    .map((row) => new Date(row.updated_at).getTime())
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) {
    lastUpdated.textContent = 'Belum ada data tersimpan';
    return;
  }

  const latest = new Date(Math.max(...timestamps));
  lastUpdated.textContent = `Data diperbarui ${dateFormatter.format(latest)} WIB`;
}

/* -------------------------------------------------------------------------- */
/* Modal, toast, konfirmasi                                                   */
/* -------------------------------------------------------------------------- */

function syncBodyLock() {
  const hasOpenModal = Boolean($('.modal.is-open'));
  document.body.classList.toggle('modal-open', hasOpenModal);
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('is-open');
  syncBodyLock();

  const focusTarget =
    id === 'upload-modal'
      ? '#dropzone'
      : id === 'data-modal'
        ? '#data-poli'
        : id === 'online-modal'
          ? '#online-jumlah'
          : id === 'confirm-modal'
            ? '#btn-confirm-cancel'
            : null;

  window.setTimeout(() => {
    const target = focusTarget ? $(focusTarget) : null;
    target?.focus?.();
  }, 80);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('is-open');

  if (id === 'confirm-modal' && confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  }

  syncBodyLock();
}

function showToast(message, type = 'success', timeout = 4200) {
  const stack = $('#toast-stack');
  if (!stack) return;

  const icons = {
    success: 'check',
    error: 'alert',
    warning: 'alert',
    info: 'info',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML =
    `<svg class="icon"><use href="#i-${icons[type] || 'info'}"></use></svg>` +
    '<div class="toast-message"></div>' +
    '<button class="toast-close" type="button" aria-label="Tutup notifikasi">×</button>';

  toast.querySelector('.toast-message').textContent = message;
  stack.appendChild(toast);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 220);
  };

  toast.querySelector('.toast-close')?.addEventListener('click', remove);
  window.setTimeout(remove, timeout);
}

function confirmAction({
  title = 'Konfirmasi',
  message = '',
  confirmLabel = 'Hapus',
  danger = true,
  icon = null,
} = {}) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#btn-confirm-ok').textContent = confirmLabel;
    $('#btn-confirm-ok').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;

    const iconBox = $('#confirm-icon');
    iconBox?.classList.toggle('is-info', !danger);
    iconBox?.querySelector('use')?.setAttribute(
      'href',
      `#i-${icon || (danger ? 'alert' : 'info')}`
    );

    if (confirmResolver) {
      const previous = confirmResolver;
      confirmResolver = null;
      previous(false);
    }

    confirmResolver = resolve;
    openModal('confirm-modal');
  });
}

function setButtonLoading(button, loading, label = 'Memproses…') {
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner-light"></span>${escapeHtml(label)}`;
  } else {
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
    button.disabled = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Autentikasi                                                                */
/* -------------------------------------------------------------------------- */

function redirectToLogin() {
  const target = `${window.location.pathname.split('/').pop() || 'index.html'}${
    window.location.search
  }${window.location.hash}`;
  window.location.href = `login.html?next=${encodeURIComponent(target)}`;
}

async function handleLogout() {
  try {
    await signOut();
    state.session = getSession();
    renderAll();
    showToast('Anda telah keluar dari mode admin.', 'info');
  } catch (error) {
    showToast(error.message || 'Gagal keluar.', 'error');
  }
}

/* -------------------------------------------------------------------------- */
/* Upload SIMPUS                                                              */
/* -------------------------------------------------------------------------- */

function openUploadModal() {
  if (!isAuthenticated()) {
    redirectToLogin();
    showToast('Mengalihkan ke halaman login admin…', 'info');
    return;
  }
  resetUploadModal();
  openModal('upload-modal');
}

function resetUploadModal() {
  state.upload = { file: null, parsed: null, rows: [], duplicates: [] };

  const fileInput = $('#file-input');
  if (fileInput) fileInput.value = '';

  $('#dropzone')?.classList.remove('hidden', 'is-dragover');
  $('#upload-progress')?.classList.add('hidden');
  $('#upload-preview')?.classList.add('hidden');
  $('#upload-error')?.classList.add('hidden');
  $('#upload-conflict')?.classList.add('hidden');
  $('#upload-warnings')?.classList.add('hidden');

  const save = $('#btn-upload-save');
  if (save) {
    save.disabled = true;
    if (save.dataset.originalHtml) delete save.dataset.originalHtml;
    save.innerHTML =
      '<svg class="icon"><use href="#i-check"></use></svg>Simpan Data';
  }

  const years = getAvailableYears();
  const year = state.tahun || years[0] || new Date().getFullYear();
  const month =
    state.bulan !== 'all'
      ? state.bulan
      : latestMonthForYear(year) || new Date().getMonth() + 1;

  $('#upload-year').value = year;
  $('#upload-month').value = month;
}

function dedupeParsedRows(rows) {
  const map = new Map();
  const duplicates = [];

  rows.forEach((row) => {
    const name = canonicalPoliName(row.nama_poli);
    if (!name) return;
    const key = name.toLowerCase();
    if (map.has(key)) duplicates.push(name);
    map.set(key, { ...row, nama_poli: name });
  });

  return {
    rows: [...map.values()],
    duplicates: [...new Set(duplicates)],
  };
}

async function handleUploadFile(file) {
  if (!file) return;

  state.upload.file = file;
  state.upload.parsed = null;
  state.upload.rows = [];
  state.upload.duplicates = [];

  $('#upload-error')?.classList.add('hidden');
  $('#upload-preview')?.classList.add('hidden');
  $('#dropzone')?.classList.add('hidden');
  $('#upload-progress')?.classList.remove('hidden');

  const save = $('#btn-upload-save');
  if (save) save.disabled = true;

  try {
    const parsed = await parseSimpusFile(file);
    const deduped = dedupeParsedRows(parsed.rows || []);

    state.upload.parsed = parsed;
    state.upload.rows = deduped.rows;
    state.upload.duplicates = deduped.duplicates;

    const fallbackYear = state.tahun || new Date().getFullYear();
    const fallbackMonth =
      state.bulan !== 'all'
        ? state.bulan
        : latestMonthForYear(fallbackYear) || new Date().getMonth() + 1;

    const period = parsed.periode || {
      tahun: fallbackYear,
      bulan: fallbackMonth,
    };

    $('#upload-year').value = period.tahun;
    $('#upload-month').value = period.bulan;

    renderUploadPreview(parsed);

    if (!deduped.rows.length) {
      const message =
        parsed.warnings?.[0] ||
        'File berhasil dibaca tetapi tidak ada baris poli yang valid.';
      const errorBox = $('#upload-error');
      if (errorBox) {
        errorBox.textContent = message;
        errorBox.classList.remove('hidden');
      }
    }
  } catch (error) {
    console.error(error);
    $('#dropzone')?.classList.remove('hidden');
    const errorBox = $('#upload-error');
    if (errorBox) {
      errorBox.textContent = error.message || 'File gagal diproses.';
      errorBox.classList.remove('hidden');
    }
  } finally {
    $('#upload-progress')?.classList.add('hidden');
  }
}

function renderUploadPreview(parsed) {
  const rows = state.upload.rows;
  const period = parsed?.periode;

  $('#upload-file-name').textContent = state.upload.file?.name || '—';
  $('#upload-period-detected').textContent = period
    ? `${monthName(period.bulan)} ${period.tahun}`
    : 'Tidak terdeteksi';
  $('#upload-row-count').textContent = String(rows.length);

  const warnings = [...(parsed?.warnings || [])];
  if (state.upload.duplicates.length) {
    warnings.push(
      `Baris duplikat untuk poli berikut digabung (baris terakhir dipakai): ${state.upload.duplicates.join(
        ', '
      )}.`
    );
  }

  const warningsBox = $('#upload-warnings');
  if (warningsBox) {
    if (warnings.length) {
      warningsBox.innerHTML = `<ul>${warnings
        .map((warning) => `<li>${escapeHtml(warning)}</li>`)
        .join('')}</ul>`;
      warningsBox.classList.remove('hidden');
    } else {
      warningsBox.classList.add('hidden');
      warningsBox.innerHTML = '';
    }
  }

  const tbody = $('#upload-preview-body');
  if (tbody) {
    tbody.innerHTML = rows
      .slice(0, 30)
      .map((row) => {
        const total =
          (Number(row.jumlah_l) || 0) + (Number(row.jumlah_p) || 0);
        return `<tr>
          <td>${escapeHtml(row.nama_poli)}</td>
          <td class="num">${formatNumber(row.baru_l)}</td>
          <td class="num">${formatNumber(row.baru_p)}</td>
          <td class="num">${formatNumber(row.lama_l)}</td>
          <td class="num">${formatNumber(row.lama_p)}</td>
          <td class="num">${formatNumber(row.jumlah_l)}</td>
          <td class="num">${formatNumber(row.jumlah_p)}</td>
          <td class="num"><strong>${formatNumber(total)}</strong></td>
        </tr>`;
      })
      .join('');
  }

  const sum = rows.reduce(
    (accumulator, row) => {
      accumulator.total +=
        (Number(row.jumlah_l) || 0) + (Number(row.jumlah_p) || 0);
      return accumulator;
    },
    { total: 0 }
  );

  const note = $('#upload-preview-note');
  if (note) {
    note.textContent = rows.length
      ? `Menampilkan ${Math.min(rows.length, 30)} dari ${rows.length} baris · total ${formatNumber(
          sum.total
        )} kunjungan.`
      : 'Tidak ada baris data yang bisa disimpan.';
  }

  $('#dropzone')?.classList.add('hidden');
  $('#upload-preview')?.classList.remove('hidden');

  updateUploadConflict();
}

function updateUploadConflict() {
  const year = Number($('#upload-year').value);
  const month = Number($('#upload-month').value);
  const conflictBox = $('#upload-conflict');
  const save = $('#btn-upload-save');
  const validPeriod =
    Number.isInteger(year) && year >= 2000 && year <= 2100 && month >= 1 && month <= 12;

  if (!validPeriod) {
    if (conflictBox) {
      conflictBox.innerHTML =
        '<svg class="icon"><use href="#i-alert"></use></svg>Pilih bulan dan tahun yang valid.';
      conflictBox.className = 'inline-alert';
      conflictBox.classList.remove('hidden');
    }
    if (save) save.disabled = true;
    return;
  }

  if (!state.upload.rows.length) {
    if (save) save.disabled = true;
    conflictBox?.classList.add('hidden');
    return;
  }

  const existingRows = state.rows.filter(
    (row) => Number(row.tahun) === year && Number(row.bulan) === month
  );

  if (conflictBox) {
    conflictBox.classList.remove('hidden');
    if (existingRows.length) {
      conflictBox.className = 'inline-alert';
      conflictBox.innerHTML =
        `<svg class="icon"><use href="#i-alert"></use></svg>` +
        `<div><strong>Data ${escapeHtml(monthName(month))} ${year} sudah ada</strong> ` +
        `(${existingRows.length} baris). Menyimpan akan <strong>menimpa</strong> data lama untuk poli yang sama (upsert).</div>`;
    } else {
      conflictBox.className = 'inline-alert is-ok';
      conflictBox.innerHTML =
        `<svg class="icon"><use href="#i-check"></use></svg>` +
        `<div>Belum ada data untuk ${escapeHtml(monthName(month))} ${year}. ` +
        `${state.upload.rows.length} baris akan ditambahkan.</div>`;
    }
  }

  if (save) {
    save.disabled = false;
    save.innerHTML =
      `<svg class="icon"><use href="#i-check"></use></svg>${
        existingRows.length ? 'Perbarui Data' : 'Simpan Data'
      }`;
  }
}

async function saveUpload() {
  if (!state.upload.rows.length) {
    showToast('Tidak ada data untuk disimpan.', 'warning');
    return;
  }

  const year = Number($('#upload-year').value);
  const month = Number($('#upload-month').value);

  if (!Number.isInteger(year) || year < 2000 || year > 2100 || month < 1 || month > 12) {
    showToast('Bulan atau tahun tidak valid.', 'error');
    return;
  }

  const save = $('#btn-upload-save');
  setButtonLoading(save, true, 'Menyimpan…');

  try {
    const payload = state.upload.rows.map((row) => {
      const poli = canonicalPoliName(row.nama_poli);
      return {
        tahun: year,
        bulan: month,
        periode_label: periodLabelFrom(year, month),
        nama_poli: poli,
        baru_l: Number(row.baru_l) || 0,
        baru_p: Number(row.baru_p) || 0,
        lama_l: Number(row.lama_l) || 0,
        lama_p: Number(row.lama_p) || 0,
        jumlah_l: Number(row.jumlah_l) || 0,
        jumlah_p: Number(row.jumlah_p) || 0,
      };
    });

    const hasConflict = state.rows.some(
      (row) => Number(row.tahun) === year && Number(row.bulan) === month
    );

    await upsertRows(payload);

    closeModal('upload-modal');
    state.tahun = year;
    state.bulan = month;
    state.poli = 'all';
    state.search = '';
    await loadData({ silent: true, preferPeriod: { tahun: year, bulan: month } });

    showToast(
      `${payload.length} baris data ${hasConflict ? 'diperbarui' : 'disimpan'} untuk ${monthName(
        month
      )} ${year}.`,
      'success',
      5200
    );
  } catch (error) {
    const errorBox = $('#upload-error');
    if (errorBox) {
      errorBox.textContent = error.message || 'Gagal menyimpan data.';
      errorBox.classList.remove('hidden');
    }
    showToast(error.message || 'Gagal menyimpan data.', 'error');
  } finally {
    setButtonLoading(save, false);
    if (state.upload.rows.length) updateUploadConflict();
  }
}

/* -------------------------------------------------------------------------- */
/* Form tambah/edit manual                                                    */
/* -------------------------------------------------------------------------- */

function readInt(selector) {
  const value = Number($(selector)?.value);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function updateDataTotalPreview() {
  const baruL = readInt('#data-baru-l');
  const baruP = readInt('#data-baru-p');
  const lamaL = readInt('#data-lama-l');
  const lamaP = readInt('#data-lama-p');
  const jumlahL = readInt('#data-jumlah-l');
  const jumlahP = readInt('#data-jumlah-p');
  const total = jumlahL + jumlahP || baruL + baruP + lamaL + lamaP;
  const preview = $('#data-total-preview');
  if (preview) preview.textContent = formatNumber(total);
}

function openDataModal() {
  if (!isAuthenticated()) {
    redirectToLogin();
    showToast('Mengalihkan ke halaman login admin…', 'info');
    return;
  }

  const years = getAvailableYears();
  const year = state.tahun || years[0] || new Date().getFullYear();
  const month =
    state.bulan !== 'all'
      ? state.bulan
      : latestMonthForYear(year) || new Date().getMonth() + 1;

  $('#data-error')?.classList.add('hidden');
  $('#data-year').value = year;
  $('#data-month').value = month;
  $('#data-poli').value = '';
  $('#data-poli').readOnly = false;

  ['#data-baru-l', '#data-baru-p', '#data-lama-l', '#data-lama-p', '#data-jumlah-l', '#data-jumlah-p'].forEach(
    (selector) => {
      const input = $(selector);
      if (input) input.value = '0';
    }
  );

  updateDataTotalPreview();
  openModal('data-modal');
}

async function saveDataForm(event) {
  event.preventDefault();

  const errorBox = $('#data-error');
  const submit = $('#btn-data-save');
  errorBox?.classList.add('hidden');

  const year = Number($('#data-year').value);
  const month = Number($('#data-month').value);
  const rawPoli = $('#data-poli').value;
  const poli = canonicalPoliName(rawPoli);

  if (!poli) {
    if (errorBox) {
      errorBox.textContent = 'Nama poli wajib diisi.';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    if (errorBox) {
      errorBox.textContent = 'Tahun tidak valid (2000–2100).';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    if (errorBox) {
      errorBox.textContent = 'Bulan tidak valid.';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  const values = {
    baru_l: readInt('#data-baru-l'),
    baru_p: readInt('#data-baru-p'),
    lama_l: readInt('#data-lama-l'),
    lama_p: readInt('#data-lama-p'),
    jumlah_l: readInt('#data-jumlah-l'),
    jumlah_p: readInt('#data-jumlah-p'),
  };

  if (values.jumlah_l === 0) values.jumlah_l = values.baru_l + values.lama_l;
  if (values.jumlah_p === 0) values.jumlah_p = values.baru_p + values.lama_p;

  if (
    values.jumlah_l < values.baru_l + values.lama_l ||
    values.jumlah_p < values.baru_p + values.lama_p
  ) {
    if (errorBox) {
      errorBox.textContent =
        'Jumlah kunjungan tidak boleh lebih kecil dari angka baru + lama.';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  const existing = state.rows.find(
    (row) =>
      Number(row.tahun) === year &&
      Number(row.bulan) === month &&
      row.nama_poli.toLowerCase() === poli.toLowerCase()
  );

  if (existing) {
    const confirmed = await confirmAction({
      title: 'Timpa data yang sudah ada?',
      message: `Data ${poli} untuk ${monthName(month)} ${year} sudah tercatat. Simpan perubahan akan menimpa angka lama.`,
      confirmLabel: 'Ya, timpa',
      danger: false,
      icon: 'alert',
    });
    if (!confirmed) return;
  }

  setButtonLoading(submit, true, 'Menyimpan…');

  try {
    const payload = {
      tahun: year,
      bulan: month,
      periode_label: periodLabelFrom(year, month),
      nama_poli: poli,
      ...values,
    };

    if (existing?.id) {
      await updateRow(existing.id, payload);
    } else {
      await upsertRows([payload]);
    }

    closeModal('data-modal');
    state.tahun = year;
    state.bulan = month;
    state.poli = 'all';
    state.search = '';
    await loadData({ silent: true, preferPeriod: { tahun: year, bulan: month } });

    showToast(
      `Data ${poli} ${monthName(month)} ${year} berhasil disimpan.`,
      'success'
    );
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message || 'Gagal menyimpan data.';
      errorBox.classList.remove('hidden');
    }
  } finally {
    setButtonLoading(submit, false);
  }
}

/* -------------------------------------------------------------------------- */
/* Kunjungan online per periode                                               */
/* -------------------------------------------------------------------------- */

function openOnlineModal() {
  if (!isAuthenticated()) {
    redirectToLogin();
    showToast('Mengalihkan ke halaman login admin…', 'info');
    return;
  }

  const years = getAvailableYears();
  const year = state.tahun || years[0] || new Date().getFullYear();
  const month =
    state.bulan !== 'all'
      ? state.bulan
      : latestMonthForYear(year) || new Date().getMonth() + 1;

  $('#online-error')?.classList.add('hidden');
  $('#online-year').value = year;
  $('#online-month').value = month;

  const existing = getOnlineRow(year, month);
  $('#online-jumlah').value = existing ? Number(existing.jumlah_online) || 0 : 0;

  updateOnlineReference();
  openModal('online-modal');
}

function updateOnlineReference() {
  const year = Number($('#online-year')?.value);
  const month = Number($('#online-month')?.value);
  const validPeriod =
    Number.isInteger(year) && year >= 2000 && year <= 2100 && month >= 1 && month <= 12;

  const visitTotalEl = $('#online-visit-total');
  const noteEl = $('#online-note');
  const deleteButton = $('#btn-online-delete');

  if (!validPeriod) {
    if (visitTotalEl) visitTotalEl.textContent = '—';
    if (noteEl) noteEl.textContent = 'Pilih bulan dan tahun yang valid.';
    deleteButton?.classList.add('hidden');
    return;
  }

  const visitRows = state.rows.filter(
    (row) => Number(row.tahun) === year && Number(row.bulan) === month
  );
  const visitTotal = visitRows.reduce((sum, row) => sum + totalOf(row), 0);
  const existing = getOnlineRow(year, month);

  if (visitTotalEl) visitTotalEl.textContent = formatNumber(visitTotal);

  if (deleteButton) {
    deleteButton.classList.toggle('hidden', !existing);
  }

  if (noteEl) {
    if (existing) {
      noteEl.textContent = `Tersimpan: ${formatNumber(
        existing.jumlah_online
      )} kunjungan online untuk ${monthName(month)} ${year}.`;
    } else if (!visitRows.length) {
      noteEl.textContent = `Belum ada data kunjungan untuk ${monthName(
        month
      )} ${year}.`;
    } else {
      noteEl.textContent = `Maksimal ${formatNumber(
        visitTotal
      )} kunjungan online, sesuai total kunjungan periode.`;
    }
  }
}

async function saveOnlineForm(event) {
  event.preventDefault();

  const errorBox = $('#online-error');
  const submit = $('#btn-online-save');
  errorBox?.classList.add('hidden');

  const year = Number($('#online-year').value);
  const month = Number($('#online-month').value);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    if (errorBox) {
      errorBox.textContent = 'Tahun tidak valid (2000–2100).';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    if (errorBox) {
      errorBox.textContent = 'Bulan tidak valid.';
      errorBox.classList.remove('hidden');
    }
    return;
  }

  const jumlah = readInt('#online-jumlah');
  const visitTotal = state.rows
    .filter((row) => Number(row.tahun) === year && Number(row.bulan) === month)
    .reduce((sum, row) => sum + totalOf(row), 0);

  if (visitTotal > 0 && jumlah > visitTotal) {
    if (errorBox) {
      errorBox.textContent = `Kunjungan online tidak boleh melebihi total kunjungan periode (${formatNumber(
        visitTotal
      )}).`;
      errorBox.classList.remove('hidden');
    }
    return;
  }

  setButtonLoading(submit, true, 'Menyimpan…');

  try {
    const periodHasVisits = state.rows.some(
      (row) => Number(row.tahun) === year && Number(row.bulan) === month
    );

    await saveOnlineRow({ tahun: year, bulan: month, jumlah_online: jumlah });
    closeModal('online-modal');
    state.tahun = year;
    state.bulan = month;
    state.poli = 'all';
    state.search = '';
    await loadData({ silent: true, preferPeriod: { tahun: year, bulan: month } });

    showToast(
      periodHasVisits
        ? `Kunjungan online ${monthName(month)} ${year} berhasil disimpan.`
        : `Total online ${monthName(
            month
          )} ${year} disimpan. Belum ada data kunjungan pada periode ini.`,
      periodHasVisits ? 'success' : 'info',
      5200
    );
  } catch (error) {
    if (errorBox) {
      errorBox.textContent = error.message || 'Gagal menyimpan data online.';
      errorBox.classList.remove('hidden');
    }
  } finally {
    setButtonLoading(submit, false);
  }
}

async function deleteOnlineAction() {
  const year = Number($('#online-year').value);
  const month = Number($('#online-month').value);
  const existing = getOnlineRow(year, month);

  if (!existing) {
    showToast('Belum ada data online pada periode ini.', 'info');
    return;
  }

  const confirmed = await confirmAction({
    title: 'Hapus data online?',
    message: `Total kunjungan online ${monthName(
      month
    )} ${year} akan dihapus permanen. Data kunjungan per poli tidak terpengaruh.`,
    confirmLabel: 'Hapus online',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await deleteOnlineRow(year, month);
    closeModal('online-modal');
    state.tahun = year;
    state.bulan = month;
    await loadData({ silent: true, preferPeriod: { tahun: year, bulan: month } });
    showToast(`Data online ${monthName(month)} ${year} telah dihapus.`, 'success');
  } catch (error) {
    showToast(error.message || 'Gagal menghapus data online.', 'error');
  }
}

/* -------------------------------------------------------------------------- */
/* Edit / hapus data                                                          */
/* -------------------------------------------------------------------------- */

function startInlineEdit(poli) {
  if (state.bulan === 'all') {
    showToast('Pilih bulan tertentu terlebih dahulu untuk mengedit angka.', 'warning');
    return;
  }
  state.editing = { nama_poli: poli };
  renderTable();
}

function cancelInlineEdit() {
  state.editing = null;
  renderTable();
}

function collectInlineValues(rowElement) {
  const values = {};
  ['baru_l', 'baru_p', 'lama_l', 'lama_p', 'jumlah_l', 'jumlah_p'].forEach((field) => {
    const input = rowElement.querySelector(`[data-field="${field}"]`);
    const number = Number(input?.value);
    values[field] = Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  });

  if (values.jumlah_l === 0) values.jumlah_l = values.baru_l + values.lama_l;
  if (values.jumlah_p === 0) values.jumlah_p = values.baru_p + values.lama_p;

  if (
    values.jumlah_l < values.baru_l + values.lama_l ||
    values.jumlah_p < values.baru_p + values.lama_p
  ) {
    return {
      error: 'Jumlah L/P tidak boleh lebih kecil dari angka baru + lama.',
    };
  }

  return { values };
}

async function saveInlineEdit() {
  const rowElement = $('#table-body tr.is-editing');
  if (!rowElement || !state.editing) return;

  const collected = collectInlineValues(rowElement);
  if (collected.error) {
    showToast(collected.error, 'error');
    return;
  }

  if (state.bulan === 'all') {
    showToast('Pilih bulan tertentu terlebih dahulu.', 'warning');
    return;
  }

  const year = Number(state.tahun);
  const month = Number(state.bulan);
  const poli = state.editing.nama_poli;

  const rawRow = state.rows.find(
    (row) =>
      Number(row.tahun) === year &&
      Number(row.bulan) === month &&
      row.nama_poli === poli
  );

  rowElement.querySelectorAll('.cell-input').forEach((input) => {
    input.disabled = true;
  });

  try {
    const payload = {
      tahun: year,
      bulan: month,
      periode_label: periodLabelFrom(year, month),
      nama_poli: poli,
      ...collected.values,
    };

    if (rawRow?.id) {
      const patch = { ...collected.values, periode_label: payload.periode_label };
      await updateRow(rawRow.id, patch);
    } else {
      await upsertRows([payload]);
    }

    state.editing = null;
    await loadData({ silent: true, preferPeriod: { tahun: year, bulan: month } });
    showToast(`Data ${poli} berhasil diperbarui.`, 'success');
  } catch (error) {
    rowElement.querySelectorAll('.cell-input').forEach((input) => {
      input.disabled = false;
    });
    showToast(error.message || 'Gagal memperbarui data.', 'error');
  }
}

async function deleteRowAction(poli, id) {
  if (!id) {
    showToast('Data ini belum tersimpan sebagai baris tersendiri.', 'warning');
    return;
  }

  const confirmed = await confirmAction({
    title: 'Hapus data poli?',
    message: `Data ${poli} pada ${currentPeriodLabel()} akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.`,
    confirmLabel: 'Hapus data',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await deleteRow(id);
    state.editing = null;
    const period = {
      tahun: Number(state.tahun),
      bulan: Number(state.bulan),
    };
    await loadData({ silent: true, preferPeriod: period });
    showToast(`Data ${poli} telah dihapus.`, 'success');
  } catch (error) {
    showToast(error.message || 'Gagal menghapus data.', 'error');
  }
}

async function deletePeriodAction() {
  if (state.bulan === 'all') {
    showToast('Pilih bulan tertentu yang ingin dihapus.', 'warning');
    return;
  }

  const rows = getPeriodRows();
  if (!rows.length) {
    showToast('Tidak ada data pada periode ini.', 'info');
    return;
  }

  const label = `${monthName(state.bulan)} ${state.tahun}`;
  const online = getOnlineTotal(state.tahun, state.bulan);
  const confirmed = await confirmAction({
    title: 'Hapus satu periode?',
    message: `Seluruh ${rows.length} baris data kunjungan ${label}${
      online > 0 ? ` dan total kunjungan online (${formatNumber(online)})` : ''
    } akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.`,
    confirmLabel: 'Hapus periode',
    danger: true,
  });
  if (!confirmed) return;

  try {
    await deletePeriod(state.tahun, state.bulan);
    state.tahun = null;
    state.bulan = 'all';
    state.poli = 'all';
    state.editing = null;
    state.search = '';
    const searchInput = $('#table-search');
    if (searchInput) searchInput.value = '';
    await loadData({ silent: true });
    showToast(`Data periode ${label} telah dihapus.`, 'success');
  } catch (error) {
    showToast(error.message || 'Gagal menghapus periode.', 'error');
  }
}

async function resetDemoAction() {
  const confirmed = await confirmAction({
    title: 'Reset data demo?',
    message:
      'Seluruh perubahan lokal (upload, edit, hapus) akan dikembalikan ke data contoh awal. Tindakan ini tidak memengaruhi Supabase.',
    confirmLabel: 'Reset data',
    danger: true,
    icon: 'refresh',
  });
  if (!confirmed) return;

  try {
    await resetDemoData();
    state.tahun = null;
    state.bulan = 'all';
    state.poli = 'all';
    state.editing = null;
    state.search = '';
    const searchInput = $('#table-search');
    if (searchInput) searchInput.value = '';
    await loadData({ silent: true });
    showToast('Data demo telah dikembalikan ke kondisi awal.', 'success');
  } catch (error) {
    showToast(error.message || 'Gagal mereset data demo.', 'error');
  }
}

async function refreshData() {
  if (state.busy) return;
  await loadData({ silent: false });
  if (state.error) {
    showToast(state.error, 'error', 6000);
  } else {
    showToast('Data berhasil dimuat ulang.', 'success', 2800);
  }
}

/* -------------------------------------------------------------------------- */
/* Export PNG, cetak, layar penuh                                             */
/* -------------------------------------------------------------------------- */

function triggerDownload(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function drawContain(context, source, x, y, width, height) {
  if (!source?.width || !source?.height) return;
  const scale = Math.min(width / source.width, height / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  context.drawImage(
    source,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

function exportChartImage(chart, title, filename, subtitle = '') {
  if (!chart?.canvas) {
    showToast('Grafik belum siap untuk diunduh.', 'warning');
    return;
  }

  const source = chart.canvas;
  const width = Math.max(1400, source.width);
  const chartWidth = width - 100;
  const chartHeight = Math.round((source.height / source.width) * chartWidth);
  const headerHeight = 140;
  const footerHeight = 64;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = headerHeight + chartHeight + footerHeight;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#0f766e';
  context.font = '700 20px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText('PUSKESMAS BULUSAN', 50, 48);

  context.fillStyle = '#0f172a';
  context.font = '800 36px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(title, 50, 94);

  context.fillStyle = '#64748b';
  context.font = '500 18px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(
    subtitle ||
      `${currentPeriodLabel()} · ${state.poli === 'all' ? 'Semua poli' : state.poli}`,
    50,
    122
  );

  context.drawImage(source, 50, headerHeight, chartWidth, chartHeight);

  context.fillStyle = '#94a3b8';
  context.font = '500 14px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(
    'Sumber: SIMPUS Puskesmas Bulusan · Dashboard Kunjungan Pasien',
    50,
    canvas.height - 24
  );

  triggerDownload(canvas.toDataURL('image/png'), filename);
}

function exportComposite(items, { title, filename }) {
  const available = items.filter((item) => item.chart?.canvas);
  if (!available.length) {
    showToast('Grafik belum siap untuk diunduh.', 'warning');
    return;
  }

  const columns = available.length > 2 ? 2 : available.length;
  const rows = Math.ceil(available.length / columns);
  const padding = 50;
  const gap = 24;
  const cellWidth = 840;
  const cellHeight = 520;
  const headerHeight = 150;
  const footerHeight = 64;
  const width = padding * 2 + columns * cellWidth + (columns - 1) * gap;
  const height =
    headerHeight +
    rows * cellHeight +
    (rows - 1) * gap +
    footerHeight +
    padding;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  context.fillStyle = '#0f766e';
  context.font = '700 20px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText('PUSKESMAS BULUSAN', padding, 48);

  context.fillStyle = '#0f172a';
  context.font = '800 38px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(title, padding, 98);

  context.fillStyle = '#64748b';
  context.font = '500 18px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(
    `${currentPeriodLabel()} · ${state.poli === 'all' ? 'Semua poli' : state.poli}`,
    padding,
    126
  );

  available.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = padding + column * (cellWidth + gap);
    const y = headerHeight + row * (cellHeight + gap);

    context.fillStyle = '#0f172a';
    context.font = '700 19px "Plus Jakarta Sans", Arial, sans-serif';
    context.fillText(item.label, x + 10, y + 24);

    drawContain(
      context,
      item.chart.canvas,
      x + 10,
      y + 40,
      cellWidth - 20,
      cellHeight - 56
    );
  });

  context.fillStyle = '#94a3b8';
  context.font = '500 14px "Plus Jakarta Sans", Arial, sans-serif';
  context.fillText(
    'Sumber: SIMPUS Puskesmas Bulusan · Dashboard Kunjungan Pasien',
    padding,
    height - 28
  );

  triggerDownload(canvas.toDataURL('image/png'), filename);
}

function downloadTrend() {
  exportChartImage(
    state.charts.trend,
    'Tren Kunjungan Bulanan',
    `tren-kunjungan-${slugify(currentPeriodLabel())}.png`
  );
}

function downloadPoli() {
  exportChartImage(
    state.charts.poli,
    'Distribusi Kunjungan per Poli',
    `distribusi-poli-${slugify(currentPeriodLabel())}.png`
  );
}

function downloadOnline() {
  exportChartImage(
    state.charts.online,
    'Kunjungan Online vs Datang Langsung',
    `online-vs-langsung-${state.tahun || 'semua'}.png`,
    `${state.tahun || ''} · Seluruh unit layanan`
  );
}

function downloadComposition() {
  exportComposite(
    [
      { chart: state.charts.status, label: 'Status Pasien (Baru vs Lama)' },
      { chart: state.charts.gender, label: 'Jenis Kelamin' },
    ],
    {
      title: 'Komposisi Kunjungan',
      filename: `komposisi-kunjungan-${slugify(currentPeriodLabel())}.png`,
    }
  );
}

function downloadAllCharts() {
  exportComposite(
    [
      { chart: state.charts.trend, label: 'Tren Kunjungan Bulanan' },
      { chart: state.charts.online, label: 'Online vs Datang Langsung' },
      { chart: state.charts.poli, label: 'Distribusi per Poli' },
      { chart: state.charts.status, label: 'Status Pasien' },
      { chart: state.charts.gender, label: 'Jenis Kelamin' },
    ],
    {
      title: 'Ringkasan Grafik Kunjungan Pasien',
      filename: `grafik-kunjungan-${slugify(currentPeriodLabel())}.png`,
    }
  );
}

function handlePrint() {
  window.print();
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      await $('#dashboard-root')?.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    showToast('Mode layar penuh tidak didukung pada browser ini.', 'warning');
  }
}

function handleFullscreenChange() {
  const active = Boolean(document.fullscreenElement);
  document.body.classList.toggle('is-fullscreen', active);
  $('#btn-fullscreen use')?.setAttribute('href', active ? '#i-shrink' : '#i-expand');
  const button = $('#btn-fullscreen');
  if (button) {
    button.title = active ? 'Keluar dari layar penuh' : 'Tampilan layar penuh';
    button.setAttribute(
      'aria-label',
      active ? 'Keluar dari layar penuh' : 'Tampilan layar penuh'
    );
  }
  window.setTimeout(() => {
    Object.values(state.charts).forEach((chart) => chart?.resize?.());
  }, 260);
}

/* -------------------------------------------------------------------------- */
/* Event handler                                                              */
/* -------------------------------------------------------------------------- */

function bindEvents() {
  $$('[data-close-modal]').forEach((element) => {
    element.addEventListener('click', () => {
      closeModal(element.dataset.closeModal);
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const openModals = $$('.modal.is-open');
    if (!openModals.length) return;
    closeModal(openModals[openModals.length - 1].id);
  });

  $('#btn-logout')?.addEventListener('click', handleLogout);

  $('#btn-refresh')?.addEventListener('click', refreshData);

  $('#btn-fullscreen')?.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', handleFullscreenChange);

  $('#btn-print')?.addEventListener('click', handlePrint);
  $('#btn-download-all')?.addEventListener('click', downloadAllCharts);
  $('#btn-dl-trend')?.addEventListener('click', downloadTrend);
  $('#btn-dl-poli')?.addEventListener('click', downloadPoli);
  $('#btn-dl-composition')?.addEventListener('click', downloadComposition);
  $('#btn-dl-online')?.addEventListener('click', downloadOnline);

  $('#filter-year')?.addEventListener('change', (event) => {
    state.tahun = Number(event.target.value) || null;
    state.editing = null;

    if (state.tahun) {
      const months = getAvailableMonths(state.tahun);
      if (state.bulan !== 'all' && !months.includes(Number(state.bulan))) {
        state.bulan = months.length ? months[months.length - 1] : 'all';
      }
      if (
        state.poli !== 'all' &&
        !state.rows.some(
          (row) =>
            Number(row.tahun) === Number(state.tahun) && row.nama_poli === state.poli
        )
      ) {
        state.poli = 'all';
      }
    }

    renderAll();
  });

  $('#filter-month')?.addEventListener('change', (event) => {
    const value = event.target.value;
    state.bulan = value === 'all' ? 'all' : Number(value);
    state.editing = null;
    renderAll();
  });

  $('#filter-poli')?.addEventListener('change', (event) => {
    state.poli = event.target.value;
    state.editing = null;
    renderAll();
  });

  $('#btn-reset-filter')?.addEventListener('click', () => {
    const years = getAvailableYears();
    state.tahun = years[0] || null;
    const months = state.tahun ? getAvailableMonths(state.tahun) : [];
    state.bulan = months.length ? months[months.length - 1] : 'all';
    state.poli = 'all';
    state.search = '';
    state.editing = null;
    const searchInput = $('#table-search');
    if (searchInput) searchInput.value = '';
    renderAll();
  });

  $('#btn-clear-poli')?.addEventListener('click', () => {
    state.poli = 'all';
    state.editing = null;
    renderAll();
  });

  $('#table-search')?.addEventListener('input', (event) => {
    state.search = event.target.value;
    renderTable();
  });

  $('#table-body')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;

    if (action === 'edit-row') {
      startInlineEdit(button.dataset.poli);
    } else if (action === 'cancel-inline') {
      cancelInlineEdit();
    } else if (action === 'save-inline') {
      saveInlineEdit();
    } else if (action === 'delete-row') {
      deleteRowAction(button.dataset.poli, button.dataset.id);
    }
  });

  $('#data-alert')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-alert-action="retry"]');
    if (button) refreshData();
  });

  $('#btn-dismiss-banner')?.addEventListener('click', () => {
    try {
      sessionStorage.setItem(BANNER_KEY, '1');
    } catch {
      // abaikan bila storage tidak tersedia
    }
    $('#demo-banner')?.classList.add('hidden');
  });

  $('#btn-upload')?.addEventListener('click', openUploadModal);
  $('#btn-add-row')?.addEventListener('click', openDataModal);
  $('#btn-online')?.addEventListener('click', openOnlineModal);
  $('#btn-delete-period')?.addEventListener('click', deletePeriodAction);
  $('#btn-reset-demo')?.addEventListener('click', resetDemoAction);
  $('#btn-empty-action')?.addEventListener('click', openUploadModal);

  // Upload file
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  dropzone?.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    fileInput?.click();
  });

  dropzone?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput?.click();
    }
  });

  $('#btn-browse')?.addEventListener('click', (event) => {
    event.stopPropagation();
    fileInput?.click();
  });

  $('#btn-upload-replace')?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) handleUploadFile(file);
    event.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'dragend'].forEach((type) => {
    dropzone?.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dropzone.classList.remove('is-dragover');
    });
  });

  dropzone?.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) handleUploadFile(file);
  });

  $('#upload-year')?.addEventListener('input', updateUploadConflict);
  $('#upload-month')?.addEventListener('change', updateUploadConflict);
  $('#btn-upload-save')?.addEventListener('click', saveUpload);

  // Form manual
  $('#data-form')?.addEventListener('submit', saveDataForm);

  ['#data-baru-l', '#data-baru-p', '#data-lama-l', '#data-lama-p', '#data-jumlah-l', '#data-jumlah-p'].forEach(
    (selector) => {
      $(selector)?.addEventListener('input', updateDataTotalPreview);
    }
  );

  // Kunjungan online per periode
  $('#online-form')?.addEventListener('submit', saveOnlineForm);
  $('#online-year')?.addEventListener('input', updateOnlineReference);
  $('#online-month')?.addEventListener('change', updateOnlineReference);
  $('#btn-online-delete')?.addEventListener('click', deleteOnlineAction);

  // Konfirmasi
  $('#btn-confirm-cancel')?.addEventListener('click', () => {
    closeModal('confirm-modal');
  });

  $('#btn-confirm-ok')?.addEventListener('click', () => {
    const resolve = confirmResolver;
    confirmResolver = null;
    closeModal('confirm-modal');
    resolve?.(true);
  });
}

/* -------------------------------------------------------------------------- */
/* Mulai aplikasi                                                             */
/* -------------------------------------------------------------------------- */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}



