/**
 * Lapisan data aplikasi.
 *
 * - Jika `config.js` sudah diisi URL + anon key Supabase, seluruh operasi
 *   memakai Supabase (PostgreSQL + Auth + RLS).
 * - Jika belum, aplikasi otomatis memakai MODE DEMO dengan penyimpanan
 *   localStorage, sehingga dashboard tetap bisa dicoba tanpa backend.
 */

import { CONFIG, isSupabaseConfigured } from './config.js';
import { SAMPLE_ROWS, SAMPLE_ONLINE_ROWS } from './data/sample-data.js';

let mode = 'demo';
let supabase = null;
let session = null;
let initWarning = null;
const authListeners = new Set();

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* -------------------------------------------------------------------------- */
/* Utilitas mode demo                                                         */
/* -------------------------------------------------------------------------- */

function loadDemoStore() {
  try {
    const raw = localStorage.getItem(CONFIG.demoStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn('Gagal membaca data demo dari localStorage:', error);
    return null;
  }
}

function saveDemoStore(rows) {
  try {
    localStorage.setItem(CONFIG.demoStorageKey, JSON.stringify(rows));
  } catch (error) {
    console.warn('Gagal menyimpan data demo:', error);
  }
}

function seedDemoStore() {
  const rows = SAMPLE_ROWS.map((row) => ({ ...row }));
  saveDemoStore(rows);
  return rows;
}

function loadDemoOnlineStore() {
  try {
    const raw = localStorage.getItem(CONFIG.demoOnlineStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    console.warn('Gagal membaca data online demo dari localStorage:', error);
    return null;
  }
}

function saveDemoOnlineStore(rows) {
  try {
    localStorage.setItem(CONFIG.demoOnlineStorageKey, JSON.stringify(rows));
  } catch (error) {
    console.warn('Gagal menyimpan data online demo:', error);
  }
}

function seedDemoOnlineStore() {
  const rows = SAMPLE_ONLINE_ROWS.map((row) => ({ ...row }));
  saveDemoOnlineStore(rows);
  return rows;
}

function demoOnlineSort(rows) {
  return [...rows].sort((a, b) => a.tahun - b.tahun || a.bulan - b.bulan);
}

function demoSort(rows) {
  return [...rows].sort(
    (a, b) =>
      a.tahun - b.tahun ||
      a.bulan - b.bulan ||
      a.nama_poli.localeCompare(b.nama_poli, 'id')
  );
}

function normalizeRow(row) {
  return {
    id: row.id,
    tahun: Number(row.tahun),
    bulan: Number(row.bulan),
    periode_label: row.periode_label,
    nama_poli: row.nama_poli,
    baru_l: Number(row.baru_l) || 0,
    baru_p: Number(row.baru_p) || 0,
    lama_l: Number(row.lama_l) || 0,
    lama_p: Number(row.lama_p) || 0,
    jumlah_l: Number(row.jumlah_l) || 0,
    jumlah_p: Number(row.jumlah_p) || 0,
    updated_at: row.updated_at || new Date().toISOString(),
    updated_by: row.updated_by || null,
    _demo: true,
  };
}

function normalizeOnlineRow(row) {
  return {
    id: row.id,
    tahun: Number(row.tahun),
    bulan: Number(row.bulan),
    jumlah_online: Number(row.jumlah_online) || 0,
    updated_at: row.updated_at || new Date().toISOString(),
    updated_by: row.updated_by || null,
    _demo: true,
  };
}

/** Hanya kolom yang ada di tabel Supabase. */
function toDbPayload(row) {
  const payload = {
    tahun: Number(row.tahun),
    bulan: Number(row.bulan),
    periode_label: row.periode_label,
    nama_poli: row.nama_poli,
    baru_l: Number(row.baru_l) || 0,
    baru_p: Number(row.baru_p) || 0,
    lama_l: Number(row.lama_l) || 0,
    lama_p: Number(row.lama_p) || 0,
    jumlah_l: Number(row.jumlah_l) || 0,
    jumlah_p: Number(row.jumlah_p) || 0,
    updated_at: new Date().toISOString(),
  };

  if (session?.user?.id && UUID_LIKE.test(session.user.id)) {
    payload.updated_by = session.user.id;
  }

  return payload;
}

function nextDemoId() {
  return `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* Inisialisasi                                                               */
/* -------------------------------------------------------------------------- */

export async function initDataLayer() {
  if (!isSupabaseConfigured()) {
    mode = 'demo';
    initWarning = null;
    restoreDemoSession();
    return { mode, warning: initWarning };
  }

  try {
    const importPromise = import(
      'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
    );
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Koneksi ke library Supabase melebihi batas waktu.')),
        12000
      )
    );
    const mod = await Promise.race([importPromise, timeout]);

    supabase = mod.createClient(
      CONFIG.supabaseUrl,
      CONFIG.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      }
    );

    const { data } = await supabase.auth.getSession();
    session = data.session || null;

    supabase.auth.onAuthStateChange((_event, nextSession) => {
      session = nextSession || null;
      emitAuth();
    });

    mode = 'supabase';
    return { mode, warning: null };
  } catch (error) {
    console.warn('Supabase tidak dapat dimuat, beralih ke mode demo:', error);
    mode = 'demo';
    initWarning =
      'Supabase tidak dapat dihubungi. Aplikasi berjalan dalam mode demo dengan data contoh.';
    restoreDemoSession();
    return { mode, warning: initWarning };
  }
}

/* -------------------------------------------------------------------------- */
/* Autentikasi                                                                */
/* -------------------------------------------------------------------------- */

function restoreDemoSession() {
  try {
    const raw = localStorage.getItem(CONFIG.demoSessionKey);
    session = raw ? JSON.parse(raw) : null;
  } catch {
    session = null;
  }
}

function emitAuth() {
  authListeners.forEach((listener) => {
    try {
      listener(session, mode);
    } catch (error) {
      console.error(error);
    }
  });
}

export function onAuthChange(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function getMode() {
  return mode;
}

export function getInitWarning() {
  return initWarning;
}

export function getSession() {
  return session;
}

export function isAuthenticated() {
  return Boolean(session && session.user);
}

export async function signIn(email, password) {
  const cleanEmail = String(email || '').trim();
  const cleanPassword = String(password || '');

  if (!cleanEmail || !cleanPassword) {
    throw new Error('Email dan kata sandi wajib diisi.');
  }

  if (mode === 'supabase') {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword,
    });

    if (error) {
      let message = error.message;
      if (/invalid login credentials/i.test(error.message)) {
        message = 'Email atau kata sandi salah.';
      } else if (/email not confirmed/i.test(error.message)) {
        message =
          'Email belum dikonfirmasi. Buka Supabase → Authentication → Users, lalu konfirmasi email pengguna tersebut.';
      } else if (/user not found/i.test(error.message)) {
        message = 'Akun dengan email tersebut tidak ditemukan di Supabase.';
      }
      throw new Error(message);
    }

    session = data.session;
    emitAuth();
    return session;
  }

  // Mode demo
  const demo = CONFIG.demoAdmin;
  const emailMatches =
    cleanEmail.toLowerCase() === demo.email.toLowerCase();
  if (!emailMatches || cleanPassword !== demo.password) {
    throw new Error(
      'Kredensial demo tidak cocok. Gunakan email admin@demo.local dan kata sandi demo123.'
    );
  }

  session = {
    access_token: 'demo-token',
    user: {
      id: 'demo-admin',
      email: demo.email,
      user_metadata: { full_name: 'Admin Demo' },
    },
  };
  localStorage.setItem(CONFIG.demoSessionKey, JSON.stringify(session));
  emitAuth();
  return session;
}

export async function signOut() {
  if (mode === 'supabase' && supabase) {
    await supabase.auth.signOut();
  } else {
    localStorage.removeItem(CONFIG.demoSessionKey);
  }
  session = null;
  emitAuth();
}

/* -------------------------------------------------------------------------- */
/* CRUD data kunjungan                                                        */
/* -------------------------------------------------------------------------- */

export async function fetchRows() {
  if (mode === 'supabase') {
    const { data, error } = await supabase
      .from(CONFIG.tableName)
      .select('*')
      .order('tahun', { ascending: true })
      .order('bulan', { ascending: true })
      .order('nama_poli', { ascending: true });

    if (error) {
      throw new Error(
        `Gagal mengambil data dari Supabase: ${error.message}. ` +
          'Pastikan tabel kunjungan_bulanan sudah dibuat dan RLS mengizinkan SELECT.'
      );
    }

    return (data || []).map((row) => ({
      ...row,
      baru_l: Number(row.baru_l) || 0,
      baru_p: Number(row.baru_p) || 0,
      lama_l: Number(row.lama_l) || 0,
      lama_p: Number(row.lama_p) || 0,
      jumlah_l: Number(row.jumlah_l) || 0,
      jumlah_p: Number(row.jumlah_p) || 0,
    }));
  }

  const stored = loadDemoStore();
  if (!stored) return seedDemoStore();
  return demoSort(stored.map(normalizeRow));
}

/**
 * Upsert berdasarkan kunci unik (tahun, bulan, nama_poli).
 * @param {Array<object>} rows
 */
export async function upsertRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('Tidak ada baris data untuk disimpan.');
  }

  if (mode === 'supabase') {
    const payload = rows.map(toDbPayload);
    const { data, error } = await supabase
      .from(CONFIG.tableName)
      .upsert(payload, { onConflict: 'tahun,bulan,nama_poli' })
      .select();

    if (error) {
      throw new Error(`Gagal menyimpan data: ${error.message}`);
    }
    return data || [];
  }

  const store = loadDemoStore() || seedDemoStore();
  const next = [...store];

  rows.forEach((row) => {
    const payload = normalizeRow({
      ...row,
      updated_at: new Date().toISOString(),
      updated_by: session?.user?.email || 'demo-admin',
    });
    const index = next.findIndex(
      (item) =>
        Number(item.tahun) === payload.tahun &&
        Number(item.bulan) === payload.bulan &&
        item.nama_poli.toLowerCase() === payload.nama_poli.toLowerCase()
    );

    if (index >= 0) {
      next[index] = { ...next[index], ...payload, id: next[index].id };
    } else {
      next.push({ ...payload, id: payload.id || nextDemoId() });
    }
  });

  saveDemoStore(next);
  return demoSort(next);
}

/** Perbarui satu baris berdasarkan id. */
export async function updateRow(id, patch) {
  if (!id) throw new Error('ID data tidak ditemukan.');

  if (mode === 'supabase') {
    const payload = {
      ...patch,
      updated_at: new Date().toISOString(),
    };
    delete payload.id;
    delete payload.total_kunjungan;

    if (session?.user?.id && UUID_LIKE.test(session.user.id)) {
      payload.updated_by = session.user.id;
    }

    const { data, error } = await supabase
      .from(CONFIG.tableName)
      .update(payload)
      .eq('id', id)
      .select();

    if (error) throw new Error(`Gagal memperbarui data: ${error.message}`);
    return (data || [])[0] || null;
  }

  const store = loadDemoStore() || seedDemoStore();
  const index = store.findIndex((item) => String(item.id) === String(id));
  if (index < 0) throw new Error('Data yang ingin diubah tidak ditemukan.');

  store[index] = normalizeRow({
    ...store[index],
    ...patch,
    id: store[index].id,
    updated_at: new Date().toISOString(),
    updated_by: session?.user?.email || 'demo-admin',
  });
  saveDemoStore(store);
  return store[index];
}

/** Hapus satu baris (satu poli pada satu periode). */
export async function deleteRow(id) {
  if (!id) throw new Error('ID data tidak ditemukan.');

  if (mode === 'supabase') {
    const { error } = await supabase
      .from(CONFIG.tableName)
      .delete()
      .eq('id', id);
    if (error) throw new Error(`Gagal menghapus data: ${error.message}`);
    return;
  }

  const store = loadDemoStore() || [];
  saveDemoStore(store.filter((item) => String(item.id) !== String(id)));
}

/** Hapus seluruh data pada satu periode bulan (kunjungan + online). */
export async function deletePeriod(tahun, bulan) {
  const year = Number(tahun);
  const month = Number(bulan);

  if (mode === 'supabase') {
    const { error } = await supabase
      .from(CONFIG.tableName)
      .delete()
      .eq('tahun', year)
      .eq('bulan', month);
    if (error) throw new Error(`Gagal menghapus periode: ${error.message}`);

    const { error: onlineError } = await supabase
      .from(CONFIG.onlineTableName)
      .delete()
      .eq('tahun', year)
      .eq('bulan', month);
    if (onlineError) {
      console.warn('Data online gagal dihapus:', onlineError.message);
    }
    return;
  }

  const store = loadDemoStore() || [];
  saveDemoStore(
    store.filter(
      (item) => !(Number(item.tahun) === year && Number(item.bulan) === month)
    )
  );

  const onlineStore = loadDemoOnlineStore() || [];
  saveDemoOnlineStore(
    onlineStore.filter(
      (item) => !(Number(item.tahun) === year && Number(item.bulan) === month)
    )
  );
}

/* -------------------------------------------------------------------------- */
/* CRUD kunjungan online per periode                                          */
/* -------------------------------------------------------------------------- */

export async function fetchOnlineRows() {
  if (mode === 'supabase') {
    const { data, error } = await supabase
      .from(CONFIG.onlineTableName)
      .select('*')
      .order('tahun', { ascending: true })
      .order('bulan', { ascending: true });

    if (error) {
      throw new Error(
        `Gagal mengambil data online dari Supabase: ${error.message}. ` +
          'Pastikan tabel kunjungan_online_bulanan sudah dibuat dan RLS mengizinkan SELECT.'
      );
    }

    return (data || []).map((row) => ({
      ...row,
      tahun: Number(row.tahun),
      bulan: Number(row.bulan),
      jumlah_online: Number(row.jumlah_online) || 0,
    }));
  }

  const stored = loadDemoOnlineStore();
  if (!stored) return seedDemoOnlineStore();
  return demoOnlineSort(stored.map(normalizeOnlineRow));
}

/**
 * Simpan satu total online untuk periode (tahun, bulan).
 * @param {{ tahun: number, bulan: number, jumlah_online: number }} entry
 */
export async function saveOnlineRow(entry) {
  const tahun = Number(entry.tahun);
  const bulan = Number(entry.bulan);
  const jumlah_online = Math.max(0, Math.round(Number(entry.jumlah_online) || 0));

  if (!Number.isInteger(tahun) || !Number.isInteger(bulan)) {
    throw new Error('Periode kunjungan online tidak valid.');
  }

  if (mode === 'supabase') {
    const payload = {
      tahun,
      bulan,
      jumlah_online,
      updated_at: new Date().toISOString(),
    };

    if (session?.user?.id && UUID_LIKE.test(session.user.id)) {
      payload.updated_by = session.user.id;
    }

    const { data, error } = await supabase
      .from(CONFIG.onlineTableName)
      .upsert(payload, { onConflict: 'tahun,bulan' })
      .select();

    if (error) {
      throw new Error(`Gagal menyimpan data online: ${error.message}`);
    }
    return (data || [])[0] || null;
  }

  const store = loadDemoOnlineStore() || seedDemoOnlineStore();
  const next = [...store];
  const index = next.findIndex(
    (item) => Number(item.tahun) === tahun && Number(item.bulan) === bulan
  );

  const payload = normalizeOnlineRow({
    tahun,
    bulan,
    jumlah_online,
    updated_at: new Date().toISOString(),
    updated_by: session?.user?.email || 'demo-admin',
  });

  if (index >= 0) {
    next[index] = { ...next[index], ...payload, id: next[index].id };
  } else {
    next.push({ ...payload, id: nextDemoId() });
  }

  saveDemoOnlineStore(next);
  return demoOnlineSort(next);
}

/** Hapus total online pada satu periode. */
export async function deleteOnlineRow(tahun, bulan) {
  const year = Number(tahun);
  const month = Number(bulan);

  if (mode === 'supabase') {
    const { error } = await supabase
      .from(CONFIG.onlineTableName)
      .delete()
      .eq('tahun', year)
      .eq('bulan', month);
    if (error) throw new Error(`Gagal menghapus data online: ${error.message}`);
    return;
  }

  const store = loadDemoOnlineStore() || [];
  saveDemoOnlineStore(
    store.filter(
      (item) => !(Number(item.tahun) === year && Number(item.bulan) === month)
    )
  );
}

/** Kembalikan data demo ke kondisi awal. */
export async function resetDemoData() {
  if (mode !== 'demo') {
    throw new Error('Reset data hanya tersedia dalam mode demo.');
  }
  seedDemoOnlineStore();
  return seedDemoStore();
}

export { UUID_LIKE };
