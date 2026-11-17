/**
 * Parser file ekspor SIMPUS Puskesmas Bulusan.
 *
 * Mendukung:
 * - `.xls` yang sebenarnya berupa dokumen HTML berisi <table> (format SIMPUS)
 * - `.csv` / `.txt` dengan pemisah koma, titik koma, atau tab
 * - `.xlsx` standar (memerlukan koneksi internet untuk memuat SheetJS)
 *
 * Hasil parser tidak langsung menyimpan data; UI menampilkan preview
 * terlebih dahulu agar admin dapat memeriksa periode dan angka.
 */

import {
  MONTHS_ID,
  canonicalPoliName,
  normalizePoliName,
  periodLabelFrom,
} from './data/poli.js';

/* -------------------------------------------------------------------------- */
/* Konstanta                                                                  */
/* -------------------------------------------------------------------------- */

const MONTH_LOOKUP = {
  jan: 1,
  januari: 1,
  january: 1,
  feb: 2,
  februari: 2,
  february: 2,
  mar: 3,
  maret: 3,
  march: 3,
  apr: 4,
  april: 4,
  mei: 5,
  may: 5,
  jun: 6,
  juni: 6,
  june: 6,
  jul: 7,
  juli: 7,
  july: 7,
  agu: 8,
  agt: 8,
  agus: 8,
  agustus: 8,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  okt: 10,
  oktober: 10,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  des: 12,
  desember: 12,
  dec: 12,
  december: 12,
};

const COLUMN_ORDER = [
  'baru_l',
  'baru_p',
  'lama_l',
  'lama_p',
  'jumlah_l',
  'jumlah_p',
];

const FOOTER_LABEL =
  /^(jumlah|total|grand\s*total|sub\s*total|jumlah\s*(total|keseluruhan)?|total\s*kunjungan)\b/i;

const HEADER_LABEL =
  /^(no|nomor|nama poli|nama layanan|poli|layanan|unit|klinik)$/i;

/* -------------------------------------------------------------------------- */
/* Utilitas teks & angka                                                      */
/* -------------------------------------------------------------------------- */

function cellText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** Ubah "1.234", "1,234", " 12 " atau "-" menjadi bilangan bulat. */
export function parseCount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  let text = String(value).trim();
  if (!text || /^[-–—]+$/.test(text)) return null;

  text = text.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(text)) return null;

  const negative = text.startsWith('-');
  text = text.replace(/-/g, '');

  if (text.includes(',') && text.includes('.')) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (text.includes(',')) {
    const parts = text.split(',');
    if (parts.length === 2 && parts[1].length !== 3) {
      text = text.replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (text.includes('.')) {
    const parts = text.split('.');
    if (parts.length > 2 || parts[parts.length - 1].length === 3) {
      text = text.replace(/\./g, '');
    }
  }

  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(Math.abs(number));
  return negative ? -rounded : rounded;
}

function isNumericCell(value) {
  return parseCount(value) !== null;
}

function isBlankRow(row) {
  return !row || row.every((cell) => cellText(cell) === '');
}

/* -------------------------------------------------------------------------- */
/* Deteksi periode                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Deteksi bulan & tahun dari metadata file.
 * Contoh: "01-October-2026 s/d 31-October-2026".
 * @returns {{tahun:number, bulan:number, label:string}|null}
 */
export function detectPeriod(source) {
  const raw = Array.isArray(source)
    ? source.flat().join(' ')
    : String(source || '');
  const text = decodeEntities(stripTags(raw)).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // 1) Rentang tanggal dengan nama bulan: 01-October-2026 s/d 31-October-2026
  const monthDatePattern =
    /(\d{1,2})\s*[-\s/.]\s*([a-z]{3,9})\s*[-\s/.]\s*(\d{4})/gi;
  const monthDates = [...lower.matchAll(monthDatePattern)].filter(
    (match) => MONTH_LOOKUP[match[2]]
  );

  if (monthDates.length > 0) {
    // Ambil tanggal terakhir dari rentang (bulan berjalan).
    const last = monthDates[monthDates.length - 1];
    const bulan = MONTH_LOOKUP[last[2]];
    const tahun = Number(last[3]);
    return {
      tahun,
      bulan,
      label: cellText(last[0]),
    };
  }

  // 2) Nama bulan + tahun tanpa tanggal: "Oktober 2026"
  const monthYearPattern = /\b([a-z]{3,9})\s*[-\s/.]?\s*(\d{4})\b/gi;
  const monthYears = [...lower.matchAll(monthYearPattern)].filter(
    (match) => MONTH_LOOKUP[match[1]]
  );

  if (monthYears.length > 0) {
    const last = monthYears[monthYears.length - 1];
    return {
      tahun: Number(last[2]),
      bulan: MONTH_LOOKUP[last[1]],
      label: cellText(last[0]),
    };
  }

  // 3) Tanggal numerik: 01/10/2026 atau 01-10-2026
  const numericDatePattern = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g;
  const numericDates = [...text.matchAll(numericDatePattern)];

  if (numericDates.length > 0) {
    const last = numericDates[numericDates.length - 1];
    const first = Number(last[1]);
    const second = Number(last[2]);
    const month = second >= 1 && second <= 12 ? second : first;
    if (month >= 1 && month <= 12) {
      return {
        tahun: Number(last[3]),
        bulan: month,
        label: cellText(last[0]),
      };
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* HTML table -> matrix                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ubah <table> menjadi array-of-array sambil memperhitungkan rowspan/colspan.
 */
function tableToMatrix(table) {
  const trs = Array.from(table.rows || table.querySelectorAll('tr'));
  const grid = [];
  let maxCols = 0;

  trs.forEach((tr, rowIndex) => {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    let col = 0;

    Array.from(tr.cells).forEach((cell) => {
      while (grid[rowIndex][col] !== undefined) col += 1;

      const text = cellText(cell.textContent);
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const colSpan = Math.max(1, cell.colSpan || 1);

      for (let dr = 0; dr < rowSpan; dr += 1) {
        const targetRow = rowIndex + dr;
        if (!grid[targetRow]) grid[targetRow] = [];
        for (let dc = 0; dc < colSpan; dc += 1) {
          grid[targetRow][col + dc] = text;
        }
      }

      col += colSpan;
      maxCols = Math.max(maxCols, col);
    });
  });

  return grid.map((row) => {
    const next = [...row];
    while (next.length < maxCols) next.push('');
    return next;
  });
}

function scoreTable(table, matrix) {
  if (!matrix.length) return -1;
  const text = matrix
    .slice(0, 30)
    .flat()
    .join(' ')
    .toLowerCase();

  let score = 0;
  if (/baru/.test(text)) score += 5;
  if (/lama/.test(text)) score += 5;
  if (/jumlah|total/.test(text)) score += 3;
  if (/poli|layanan|unit/.test(text)) score += 3;
  if (matrix.length > 3) score += 1;
  if (table.querySelectorAll('table table').length > 10) score -= 2;
  return score;
}

/* -------------------------------------------------------------------------- */
/* Deteksi header & pemetaan kolom                                            */
/* -------------------------------------------------------------------------- */

function cleanHeader(value) {
  return cellText(value)
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyHeader(value) {
  const text = cleanHeader(value);
  if (!text) return null;

  let group = null;
  if (/\bbaru\b|\bnew\b/.test(text)) group = 'baru';
  else if (/\blama\b|\bold\b|\bulang\b/.test(text)) group = 'lama';
  else if (/\bjumlah\b|\btotal\b/.test(text)) group = 'jumlah';
  if (!group) return null;

  let gender = null;
  if (/\b(perempuan|wanita|female|pr)\b/.test(text)) gender = 'p';
  else if (/\b(laki laki|laki|pria|male|lk)\b/.test(text)) gender = 'l';
  else if (/(^|\s)p($|\s)/.test(text)) gender = 'p';
  else if (/(^|\s)l($|\s)/.test(text)) gender = 'l';

  return gender ? `${group}_${gender}` : null;
}

function rowHeaderScore(row) {
  const text = (row || []).join(' ').toLowerCase();
  let score = 0;
  if (/baru/.test(text)) score += 2;
  if (/lama/.test(text)) score += 2;
  if (/jumlah|total/.test(text)) score += 2;
  if (/poli|layanan|unit|klinik/.test(text)) score += 2;
  if (/(^|\s)(l|p|lk|pr)(\s|$)/.test(text)) score += 1;
  return score;
}

function findHeaderRow(matrix) {
  let best = -1;
  let bestScore = 0;
  const limit = Math.min(matrix.length, 40);

  for (let row = 0; row < limit; row += 1) {
    const score = rowHeaderScore(matrix[row]);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore >= 4 ? best : -1;
}

function headerRowIndexes(matrix, headerIndex) {
  const indexes = [headerIndex];

  // Sub-header (L / P) mungkin berada satu baris di bawah header grup.
  const nextRow = matrix[headerIndex + 1] || [];
  const shortGenderCells = nextRow.filter((cell) =>
    /^(l|p|lk|pr|laki|perempuan)$/i.test(cleanHeader(cell))
  ).length;
  if (shortGenderCells >= 2) indexes.push(headerIndex + 1);

  // Header grup (Baru / Lama / Jumlah) bisa berada di atas headerIndex.
  for (
    let row = headerIndex - 1;
    row >= 0 && row >= headerIndex - 2;
    row -= 1
  ) {
    if (rowHeaderScore(matrix[row]) >= 3) indexes.unshift(row);
    else break;
  }

  return [...new Set(indexes)].sort((a, b) => a - b);
}

function buildHeaderMap(matrix, headerIndexes) {
  const map = {};
  const width = Math.max(
    ...matrix.map((row) => (row ? row.length : 0)),
    0
  );

  for (let col = 0; col < width; col += 1) {
    const text = headerIndexes
      .map((row) => (matrix[row] ? matrix[row][col] : ''))
      .map(cleanHeader)
      .filter(Boolean)
      .join(' ');
    const key = classifyHeader(text);
    if (key && map[key] === undefined) map[key] = col;
  }

  return map;
}

function findNameColumn(matrix, headerIndexes, dataRows) {
  for (const rowIndex of headerIndexes) {
    const row = matrix[rowIndex] || [];
    for (let col = 0; col < row.length; col += 1) {
      const text = cleanHeader(row[col]);
      if (
        /(nama.*poli|nama.*layanan|^poli$|^layanan$|^unit$|^klinik$)/.test(
          text
        ) &&
        !/jumlah|total|baru|lama/.test(text)
      ) {
        return col;
      }
    }
  }

  const sample = dataRows.slice(0, 6);
  if (!sample.length) return 1;

  const width = Math.max(...sample.map((row) => (row ? row.length : 0)));
  let fallback = -1;

  for (let col = 0; col < width; col += 1) {
    const values = sample
      .map((row) => (row ? row[col] : ''))
      .filter((value) => cellText(value) !== '');

    if (!values.length) continue;
    const textValues = values.filter((value) => !isNumericCell(value));
    if (textValues.length >= Math.max(2, Math.ceil(values.length * 0.6))) {
      if (col === 1) return col;
      if (fallback === -1) fallback = col;
    }
  }

  return fallback === -1 ? 1 : fallback;
}

function inferColumnMap(matrix, dataRows, nameColumn) {
  const map = {};
  if (!dataRows.length) return map;

  const sample = dataRows.slice(0, 8);
  const width = Math.max(...sample.map((row) => (row ? row.length : 0)));
  const numericColumns = [];

  for (let col = 0; col < width; col += 1) {
    if (col === nameColumn) continue;
    const filled = sample.filter(
      (row) => row && cellText(row[col]) !== ''
    );
    const numeric = filled.filter((row) => isNumericCell(row[col]));
    if (numeric.length >= Math.max(2, Math.ceil(filled.length * 0.6))) {
      numericColumns.push(col);
    }
  }

  // Buang kolom "No" berurutan (1, 2, 3, ...).
  if (numericColumns.length >= 7) {
    const first = numericColumns[0];
    const isSequential = sample.every((row, index) => {
      const value = parseCount(row ? row[first] : '');
      return value === index + 1;
    });
    if (isSequential) numericColumns.shift();
  }

  numericColumns.slice(0, 6).forEach((col, index) => {
    map[COLUMN_ORDER[index]] = col;
  });

  return map;
}

/* -------------------------------------------------------------------------- */
/* Matrix -> rows                                                             */
/* -------------------------------------------------------------------------- */

function parseMatrix(matrix, meta = {}) {
  const warnings = [];
  const rows = [];

  const cleanMatrix = (matrix || []).filter((row) => !isBlankRow(row));
  if (!cleanMatrix.length) {
    return {
      rows: [],
      periode: null,
      warnings: ['File tidak berisi tabel data yang dapat dibaca.'],
      meta,
    };
  }

  const headerIndex = findHeaderRow(cleanMatrix);
  const headerIndexes =
    headerIndex >= 0 ? headerRowIndexes(cleanMatrix, headerIndex) : [];
  const dataStart =
    headerIndexes.length > 0
      ? Math.max(...headerIndexes) + 1
      : 0;

  const rawDataRows = cleanMatrix.slice(dataStart);
  const dataRows = rawDataRows.filter((row) => !isBlankRow(row));

  const nameColumn = findNameColumn(cleanMatrix, headerIndexes, dataRows);
  const headerMap = headerIndexes.length
    ? buildHeaderMap(cleanMatrix, headerIndexes)
    : {};

  let columnMap = headerMap;
  if (Object.keys(headerMap).length < 6) {
    const inferred = inferColumnMap(cleanMatrix, dataRows, nameColumn);
    columnMap = { ...inferred, ...headerMap };
  }

  const hasAnyMap = COLUMN_ORDER.some((key) => columnMap[key] !== undefined);
  if (!hasAnyMap) {
    return {
      rows: [],
      periode: detectPeriod(cleanMatrix),
      warnings: [
        'Header kolom Baru/Lama/Jumlah tidak ditemukan. Pastikan file merupakan ekspor resmi SIMPUS.',
      ],
      meta,
    };
  }

  const missingDetail = [];
  let invalidTotal = 0;
  let skippedRows = 0;

  dataRows.forEach((row) => {
    const rawName = nameColumn >= 0 ? row[nameColumn] : '';
    const name = canonicalPoliName(rawName);

    if (!name) {
      skippedRows += 1;
      return;
    }
    if (FOOTER_LABEL.test(name) || HEADER_LABEL.test(name)) {
      if (HEADER_LABEL.test(name)) skippedRows += 1;
      return;
    }
    if (name.length < 2) {
      skippedRows += 1;
      return;
    }

    const values = {};
    let foundValue = false;

    COLUMN_ORDER.forEach((key) => {
      const col = columnMap[key];
      const parsed = col === undefined ? null : parseCount(row[col]);
      values[key] = parsed === null ? 0 : Math.max(0, parsed);
      if (col !== undefined && parsed !== null) foundValue = true;
    });

    if (!foundValue) {
      skippedRows += 1;
      return;
    }

    if (values.jumlah_l === 0 && values.baru_l + values.lama_l > 0) {
      values.jumlah_l = values.baru_l + values.lama_l;
    }
    if (values.jumlah_p === 0 && values.baru_p + values.lama_p > 0) {
      values.jumlah_p = values.baru_p + values.lama_p;
    }

    if (
      values.jumlah_l !== values.baru_l + values.lama_l ||
      values.jumlah_p !== values.baru_p + values.lama_p
    ) {
      invalidTotal += 1;
    }

    if (values.baru_l + values.baru_p + values.lama_l + values.lama_p === 0) {
      missingDetail.push(name);
    }

    rows.push({
      nama_poli: name,
      ...values,
    });
  });

  const periode =
    detectPeriod(cleanMatrix.slice(0, Math.max(dataStart, 1))) ||
    detectPeriod(cleanMatrix);

  if (!periode) {
    warnings.push(
      'Periode tidak terdeteksi otomatis. Silakan pilih bulan dan tahun pada formulir preview.'
    );
  }

  if (invalidTotal > 0) {
    warnings.push(
      `${invalidTotal} baris memiliki jumlah kunjungan yang tidak sama dengan baru + lama. Periksa kembali data sumber.`
    );
  }

  if (missingDetail.length > 0) {
    warnings.push(
      `${missingDetail.length} poli tidak memiliki rincian baru/lama (diisi 0). Contoh: ${missingDetail
        .slice(0, 3)
        .join(', ')}.`
    );
  }

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} baris kosong/tidak valid dilewati.`);
  }

  if (rows.length === 0) {
    warnings.push(
      'Tidak ada baris poli yang valid. Periksa apakah file berisi tabel kunjungan per poli.'
    );
  }

  return {
    rows,
    periode,
    warnings,
    meta: {
      ...meta,
      headerRow: headerIndex >= 0 ? headerIndex + 1 : null,
      nameColumn,
      columns: columnMap,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

function detectDelimiter(lines) {
  const sample = lines.slice(0, 8).join('\n');
  const counts = {
    ',': (sample.match(/,/g) || []).length,
    ';': (sample.match(/;/g) || []).length,
    '\t': (sample.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells.map(cellText);
}

function parseCsvText(text, meta = {}) {
  const normalized = String(text || '').replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  const delimiter = detectDelimiter(
    lines.filter((line) => line.trim() !== '')
  );
  const matrix = lines
    .filter((line) => line.trim() !== '')
    .map((line) => parseDelimitedLine(line, delimiter));

  return parseMatrix(matrix, {
    ...meta,
    format: 'csv',
    delimiter,
  });
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                       */
/* -------------------------------------------------------------------------- */

function parseHtmlText(html, meta = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));

  if (!tables.length) {
    return {
      rows: [],
      periode: detectPeriod(html),
      warnings: ['Dokumen HTML tidak memiliki elemen <table> yang dapat dibaca.'],
      meta: { ...meta, format: 'html' },
    };
  }

  const candidates = tables
    .map((table) => {
      const matrix = tableToMatrix(table);
      return { table, matrix, score: scoreTable(table, matrix) };
    })
    .sort((a, b) => b.score - a.score || b.matrix.length - a.matrix.length);

  const best = candidates[0];
  const result = parseMatrix(best.matrix, {
    ...meta,
    format: 'html',
    candidateTables: candidates.length,
  });

  if (!result.periode) {
    result.periode = detectPeriod(html);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                       */
/* -------------------------------------------------------------------------- */

async function parseXlsxFile(buffer, meta = {}) {
  let XLSX;
  try {
    XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
  } catch (error) {
    throw new Error(
      'Pembaca file .xlsx memerlukan koneksi internet. ' +
        'Alternatif: simpan ulang data sebagai .csv atau gunakan file ekspor .xls SIMPUS.'
    );
  }

  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File Excel tidak memiliki worksheet.');

  const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  const result = parseMatrix(matrix, {
    ...meta,
    format: 'xlsx',
    sheetName,
    sheetCount: workbook.SheetNames.length,
  });

  if (!result.periode) {
    result.periode = detectPeriod(matrix);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse file yang dipilih admin.
 * @param {File} file
 * @returns {Promise<{rows:Array, periode:object|null, warnings:Array, meta:object}>}
 */
export async function parseSimpusFile(file) {
  if (!file) throw new Error('File belum dipilih.');
  if (file.size > 15 * 1024 * 1024) {
    throw new Error('Ukuran file melebihi 15 MB. Pecah file atau gunakan data per bulan.');
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const meta = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || '',
  };

  // XLSX / XLS zip-based
  if (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return parseXlsxFile(buffer, meta);
  }

  // Deteksi encoding dari 2 KB pertama.
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 2048));
  let text = new TextDecoder('utf-8').decode(bytes);
  const replacementCount = (text.match(/\uFFFD/g) || []).length;

  if (
    /charset\s*=\s*["']?(windows-1252|iso-8859-1|cp1252)/i.test(head) ||
    replacementCount > 3
  ) {
    text = new TextDecoder('windows-1252').decode(bytes);
  }

  // File .xls SIMPUS: HTML yang berisi <table>.
  if (/<table[\s>]/i.test(text) || /<html[\s>]/i.test(text)) {
    return parseHtmlText(text, meta);
  }

  // File OLE binary .xls lama (bukan HTML, bukan zip).
  if (file.name.toLowerCase().endsWith('.xls')) {
    const oleSignature =
      bytes.length > 8 &&
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0;

    if (oleSignature) {
      throw new Error(
        'File .xls biner lama tidak didukung. Ekspor ulang dari SIMPUS (format tabel HTML), ' +
          'atau simpan sebagai .csv / .xlsx.'
      );
    }
  }

  return parseCsvText(text, meta);
}

export { MONTHS_ID, periodLabelFrom, canonicalPoliName };
