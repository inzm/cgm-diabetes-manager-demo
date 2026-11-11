/**
 * 決定論的UUID生成 & UUID形式検証ユーティリティ
 *
 * IndexedDB (Dexie.js) と Supabase (PostgreSQL UUID型) の双方で
 * 主キー・外部キーを100%互換の正規UUID形式に統一するためのヘルパー関数群。
 *
 * シード文字列（患者ID + 論理キー / 日時等）から冪等（Idempotent）に
 * UUID v5 相当のフォーマット（xxxxxxxx-xxxx-5xxx-8xxx-xxxxxxxxxxxx）を生成する。
 */

/** RFC 4122 準拠の標準UUID正規表現（v1〜v5対応） */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 決定論的UUID（v5相当: version=5, variant=8）の厳密な正規表現 */
export const UUID_V5_DETERMINISTIC_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 与えられた値が正規のUUID形式（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）であるか判定する
 */
export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * 32bit FNV-1a + MurmurHash3 fmix32 アバランシェミキサー
 * シード文字列とソルトから衝突耐性の高い32bit符号なし整数を生成する
 */
function hash32WithSalt(input: string, salt: number): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // MurmurHash3 finalizer (fmix32)
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * シード文字列から決定論的に標準UUID（xxxxxxxx-xxxx-5xxx-8xxx-xxxxxxxxxxxx）を生成する
 * 同一の seed に対して常に同一のUUID文字列を返す（べき等性の保証）。
 */
export function deterministicUuid(seed: string): string {
  const normalizedSeed = String(seed);
  const h1 = hash32WithSalt(normalizedSeed, 0x9e3779b9);
  const h2 = hash32WithSalt(`v5:part2:${normalizedSeed}`, 0x7f4a7c15);
  const h3 = hash32WithSalt(`v5:part3:${normalizedSeed}`, 0xf39cc060);
  const h4 = hash32WithSalt(`v5:part4:${normalizedSeed}`, 0x517cc1b7);

  const hex1 = h1.toString(16).padStart(8, '0');
  const hex2 = h2.toString(16).padStart(8, '0');
  const hex3 = h3.toString(16).padStart(8, '0');
  const hex4 = h4.toString(16).padStart(8, '0');

  const timeLow = hex1; // 8桁
  const timeMid = hex2.slice(0, 4); // 4桁
  const timeHiAndVersion = `5${hex2.slice(5, 8)}`; // 4桁 (5xxx)
  const clkSeqAndVariant = `8${hex3.slice(1, 4)}`; // 4桁 (8xxx)
  const node = `${hex3.slice(4, 8)}${hex4}`; // 12桁

  return `${timeLow}-${timeMid}-${timeHiAndVersion}-${clkSeqAndVariant}-${node}`;
}

/**
 * 既存のIDが正規UUIDであればそのまま小文字正規化して返し、
 * 旧形式の非UUID文字列（例: `${patientId}_cat_...`）であれば決定論的UUIDへ変換して返す。
 */
export function ensureUuid(idOrSeed: string | undefined | null, fallbackSeed?: string): string {
  if (typeof idOrSeed === 'string' && idOrSeed.trim().length > 0) {
    const trimmed = idOrSeed.trim();
    if (isValidUuid(trimmed)) {
      return trimmed.toLowerCase();
    }
    return deterministicUuid(trimmed);
  }
  if (typeof fallbackSeed === 'string' && fallbackSeed.trim().length > 0) {
    return deterministicUuid(fallbackSeed.trim());
  }
  return crypto.randomUUID();
}
