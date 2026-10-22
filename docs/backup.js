// バックアップの暗号化（Web Crypto API）
// AES-GCM 256 ビット。鍵は合言葉から PBKDF2-SHA256 で作る。合言葉はどこにも保存しない

const ITERATIONS = 600000;
const FORMAT = 'cycle-backup';
const VERSION = 1;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s) {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// data（任意のオブジェクト）を暗号化し、ファイルに書く文字列を返す
export async function encryptBackup(data, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toB64(salt) },
    cipher: { name: 'AES-GCM', iv: toB64(iv) },
    data: toB64(cipher),
  });
}

// ファイルの文字列を復号して元のオブジェクトを返す
// 合言葉違い・改ざんは AES-GCM の検証で失敗するので、まとめて同じエラーにする
export async function decryptBackup(text, passphrase) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('バックアップのファイルではありません。');
  }
  if (file.format !== FORMAT || file.version !== VERSION) {
    throw new Error('バックアップのファイルではありません。');
  }
  const key = await deriveKey(passphrase, fromB64(file.kdf.salt), file.kdf.iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.cipher.iv) }, key, fromB64(file.data));
  } catch {
    throw new Error('合言葉が違うか、ファイルが壊れています。');
  }
  return JSON.parse(dec.decode(plain));
}
