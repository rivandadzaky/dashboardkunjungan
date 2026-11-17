/** Konstanta bersama: bulan dan daftar unit layanan Puskesmas Bulusan. */

export const MONTHS_ID = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

export const MONTHS_SHORT_ID = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'Mei',
  'Jun',
  'Jul',
  'Agu',
  'Sep',
  'Okt',
  'Nov',
  'Des',
];

/** 14 unit layanan sesuai PRD. */
export const POLI_MASTER = [
  'Poli Umum',
  'Poli Gigi',
  'Poli KIA',
  'Poli MTBS',
  'Poli Lansia',
  'Poli IGD/Tindakan',
  'Poli TB',
  'Poli MSN',
  'Poli ILP',
  'Poli Imunisasi',
  'Poli Gizi',
  'Poli Sanitasi',
  'Poli CKG',
  'Poli Prolanis',
];

const ALIASES = {
  umum: 'Poli Umum',
  gigi: 'Poli Gigi',
  kia: 'Poli KIA',
  mtbs: 'Poli MTBS',
  lansia: 'Poli Lansia',
  igd: 'Poli IGD/Tindakan',
  tindakan: 'Poli IGD/Tindakan',
  'igd/tindakan': 'Poli IGD/Tindakan',
  tb: 'Poli TB',
  msn: 'Poli MSN',
  ilp: 'Poli ILP',
  imunisasi: 'Poli Imunisasi',
  gizi: 'Poli Gizi',
  sanitasi: 'Poli Sanitasi',
  ckg: 'Poli CKG',
  prolanis: 'Poli Prolanis',
};

export function normalizePoliName(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .trim();
}

/** Samakan variasi nama poli dari SIMPUS dengan nama baku. */
export function canonicalPoliName(raw) {
  const name = normalizePoliName(raw);
  if (!name) return '';
  const lower = name.toLowerCase();

  const exact = POLI_MASTER.find((poli) => poli.toLowerCase() === lower);
  if (exact) return exact;

  const withoutPrefix = lower.replace(/^poli\s+/, '');
  const byAlias = ALIASES[withoutPrefix];
  if (byAlias) return byAlias;

  const matchedMaster = POLI_MASTER.find(
    (poli) =>
      poli.toLowerCase() === `poli ${lower}` ||
      poli.toLowerCase().replace(/^poli\s+/, '') === withoutPrefix
  );

  return matchedMaster || name;
}

export function lastDayOfMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

export function periodLabelFrom(year, month) {
  const monthName = MONTHS_ID[Number(month) - 1] || '';
  return `01 ${monthName} ${year} s/d ${lastDayOfMonth(year, month)} ${monthName} ${year}`;
}
