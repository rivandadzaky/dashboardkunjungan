/**
 * Konfigurasi aplikasi Dashboard Kunjungan Pasien Puskesmas Bulusan.
 *
 * Cara mengaktifkan Supabase:
 * 1. Buat project di https://supabase.com
 * 2. Jalankan SQL pada file `supabase/schema.sql` di SQL Editor.
 * 3. Salin Project URL dan anon/public key dari Settings > API.
 * 4. Isi dua nilai di bawah ini, lalu simpan.
 *
 * Selama dua nilai di bawah masih kosong, aplikasi berjalan dalam
 * MODE DEMO: data contoh disimpan di localStorage browser sehingga
 * seluruh fitur (filter, chart, login admin, upload, edit, hapus)
 * tetap dapat dicoba tanpa backend.
 */
export const CONFIG = {
  supabaseUrl: 'https://rexmtikapdutepnjxncp.supabase.co',
  supabaseAnonKey: 'sb_publishable_-sh5IQgCB03hd9mzeOIEXw_1HqzRPBC',
  tableName: 'kunjungan_bulanan',
  onlineTableName: 'kunjungan_online_bulanan',

  // Kredensial untuk MODE DEMO saja (bukan akun Supabase).
  demoAdmin: {
    email: 'admin@demo.local',
    password: 'demo123',
  },
  demoStorageKey: 'puskesmas-bulusan:demo-data:v3',
  demoOnlineStorageKey: 'puskesmas-bulusan:demo-online:v1',
  demoSessionKey: 'puskesmas-bulusan:demo-session:v1',
};

export const isSupabaseConfigured = () =>
  Boolean(
    CONFIG.supabaseUrl &&
      CONFIG.supabaseAnonKey &&
      CONFIG.supabaseUrl.startsWith('http')
  );

export const APP_INFO = {
  name: 'Dashboard Kunjungan Pasien',
  facility: 'Puskesmas Bulusan',
  region: 'Kabupaten Banyuwangi',
};
