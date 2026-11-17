/**
 * Data contoh (MODE DEMO) untuk Dashboard Puskesmas Bulusan.
 * Dibuat deterministik agar tampilan konsisten setiap kali dimuat.
 * Angka-angka ini fiktif dan hanya untuk demonstrasi.
 */

import {
  MONTHS_ID,
  POLI_MASTER,
  periodLabelFrom,
} from './poli.js';

const POLI_PROFILE = {
  'Poli Umum': { base: 1480, newShare: 0.34, femaleShare: 0.56 },
  'Poli Gigi': { base: 430, newShare: 0.42, femaleShare: 0.58 },
  'Poli KIA': { base: 330, newShare: 0.28, femaleShare: 0.95 },
  'Poli MTBS': { base: 245, newShare: 0.48, femaleShare: 0.51 },
  'Poli Lansia': { base: 395, newShare: 0.19, femaleShare: 0.57 },
  'Poli IGD/Tindakan': { base: 545, newShare: 0.55, femaleShare: 0.49 },
  'Poli TB': { base: 138, newShare: 0.24, femaleShare: 0.42 },
  'Poli MSN': { base: 96, newShare: 0.31, femaleShare: 0.63 },
  'Poli ILP': { base: 118, newShare: 0.37, femaleShare: 0.6 },
  'Poli Imunisasi': { base: 275, newShare: 0.62, femaleShare: 0.52 },
  'Poli Gizi': { base: 185, newShare: 0.35, femaleShare: 0.64 },
  'Poli Sanitasi': { base: 72, newShare: 0.45, femaleShare: 0.5 },
  'Poli CKG': { base: 160, newShare: 0.58, femaleShare: 0.55 },
  'Poli Prolanis': { base: 215, newShare: 0.12, femaleShare: 0.59 },
};

/** Poli yang sengaja kosong pada bulan tertentu untuk demo zero-visit alert. */
const ZERO_MONTHS = {
  'Poli Sanitasi': [9],
  'Poli Prolanis': [1],
};

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const YEAR = 2026;
const LAST_MONTH = 10;

function generateRows() {
  const rows = [];
  const random = mulberry32(20261016);

  for (let month = 1; month <= LAST_MONTH; month += 1) {
    // Sedikit tren pertumbuhan sepanjang tahun + variasi musiman.
    const growth = 0.9 + (month - 1) * 0.022;
    const seasonal = 1 + Math.sin((month / 12) * Math.PI * 2) * 0.05;

    POLI_MASTER.forEach((poli) => {
      const profile = POLI_PROFILE[poli];
      const isZero = (ZERO_MONTHS[poli] || []).includes(month);

      let baruL = 0;
      let baruP = 0;
      let lamaL = 0;
      let lamaP = 0;

      if (!isZero) {
        const noise = 0.9 + random() * 0.2;
        const total = Math.max(
          1,
          Math.round(profile.base * growth * seasonal * noise)
        );

        const femaleShare = Math.min(
          0.92,
          Math.max(0.1, profile.femaleShare + (random() - 0.5) * 0.05)
        );
        const totalP = Math.round(total * femaleShare);
        const totalL = total - totalP;

        const newShare = Math.min(
          0.75,
          Math.max(0.08, profile.newShare + (random() - 0.5) * 0.06)
        );
        baruP = Math.round(totalP * newShare);
        baruL = Math.round(totalL * newShare);
        lamaP = totalP - baruP;
        lamaL = totalL - baruL;
      }

      rows.push({
        id: `demo-${YEAR}-${month}-${slugify(poli)}`,
        tahun: YEAR,
        bulan: month,
        periode_label: periodLabelFrom(YEAR, month),
        nama_poli: poli,
        baru_l: baruL,
        baru_p: baruP,
        lama_l: lamaL,
        lama_p: lamaP,
        jumlah_l: baruL + lamaL,
        jumlah_p: baruP + lamaP,
        updated_at: new Date(YEAR, month, 0, 16, 30).toISOString(),
        updated_by: null,
        _demo: true,
      });
    });
  }

  return rows;
}

export const SAMPLE_ROWS = generateRows();

/**
 * Total kunjungan online per periode (bukan per poli).
 * Dihitung dari total kunjungan bulanan dengan proporsi deterministik.
 */
function generateOnlineRows(rows) {
  const monthly = new Map();

  rows.forEach((row) => {
    const key = `${row.tahun}-${row.bulan}`;
    const total = (Number(row.jumlah_l) || 0) + (Number(row.jumlah_p) || 0);
    monthly.set(key, (monthly.get(key) || 0) + total);
  });

  return [...monthly.entries()]
    .map(([key, totalKunjungan]) => {
      const [tahun, bulan] = key.split('-').map(Number);
      const share = 0.24 + ((bulan * 5) % 9) / 100;
      return {
        id: `demo-online-${tahun}-${bulan}`,
        tahun,
        bulan,
        jumlah_online: Math.round(totalKunjungan * share),
        updated_at: new Date(tahun, bulan, 0, 16, 30).toISOString(),
        updated_by: null,
        _demo: true,
      };
    })
    .sort((a, b) => a.tahun - b.tahun || a.bulan - b.bulan);
}

export const SAMPLE_ONLINE_ROWS = generateOnlineRows(SAMPLE_ROWS);

export const SAMPLE_META = {
  year: YEAR,
  lastMonth: LAST_MONTH,
  lastMonthName: MONTHS_ID[LAST_MONTH - 1],
  generatedAt: new Date(YEAR, LAST_MONTH, 0, 16, 30).toISOString(),
  source: 'Data contoh (Mode Demo)',
};

export { MONTHS_ID };
