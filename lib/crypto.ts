/**
 * Клиентская криптография на Web Crypto API (протокол v2).
 *
 * Каждый клиент генерирует в браузере ДВЕ пары P-256:
 *  - ECDH — вывод общего секрета с каждым собеседником (через HKDF — ключ AES-256-GCM);
 *  - ECDSA — подпись сообщений: получатель проверяет автора, сервер не может
 *    подделать отправителя.
 *
 * Шифрование — AES-256-GCM с дополнительными данными (AAD = roomId|sender|seq):
 * один и тот же ключ пары не позволяет переиграть шифротекст в другом контексте.
 * Если задана секретная фраза комнаты, она входит в HKDF-info и никогда не
 * покидает клиента: сервер без фразы не сможет провести MITM-подмену ключей.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HKDF_INFO_PREFIX = encoder.encode('encrypt-chat/e2e/v2');
const ECDH_ALGO = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA_KEY_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN_ALGO = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface Identity {
  ecdhPrivate: CryptoKey;
  ecdhPublicJwk: JsonWebKey;
  ecdsaPrivate: CryptoKey;
  ecdsaPublicJwk: JsonWebKey;
}

/** Публичный пакет участника: ключи шифрования и подписи (передаётся через сервер). */
export interface PublicKeys {
  ecdh: JsonWebKey;
  ecdsa: JsonWebKey;
}

export function bufToB64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function generateIdentity(): Promise<Identity> {
  const [ecdhPair, ecdsaPair] = await Promise.all([
    crypto.subtle.generateKey(ECDH_ALGO, true, ['deriveKey', 'deriveBits']),
    crypto.subtle.generateKey(ECDSA_KEY_ALGO, true, ['sign', 'verify']),
  ]);
  const [ecdhPublicJwk, ecdsaPublicJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', ecdhPair.publicKey),
    crypto.subtle.exportKey('jwk', ecdsaPair.publicKey),
  ]);
  return { ecdhPrivate: ecdhPair.privateKey, ecdhPublicJwk, ecdsaPrivate: ecdsaPair.privateKey, ecdsaPublicJwk };
}

function importEcPublic(jwk: JsonWebKey, algo: AlgorithmIdentifier, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, algo, true, usages);
}

/**
 * ECDH(мой приватный, его публичный) -> HKDF(секрет комнаты) -> AES-256-GCM.
 * Одинаковая фраза у обеих сторон даёт одинаковый ключ; сервер без фразы
 * вывести ключ не может в принципе.
 */
export async function deriveAesKey(
  privateKey: CryptoKey,
  peerEcdhJwk: JsonWebKey,
  roomSecret: string | null,
): Promise<CryptoKey> {
  const peerPub = await importEcPublic(peerEcdhJwk, ECDH_ALGO, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, privateKey, 256);
  const info = roomSecret
    ? new Uint8Array([...HKDF_INFO_PREFIX, ...encoder.encode(`|secret:${roomSecret}`)])
    : HKDF_INFO_PREFIX;
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptText(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<{ iv: string; data: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return { iv: bufToB64(iv), data: bufToB64(new Uint8Array(ciphertext)) };
}

export async function decryptText(key: CryptoKey, iv: string, data: string, aad: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(iv), additionalData: encoder.encode(aad) },
    key,
    b64ToBytes(data),
  );
  return decoder.decode(plain);
}

/** Каноничная строка для подписи/проверки — детерминированная без JSON-сортировки. */
export function canonicalMessage(roomId: string, from: string, seq: number, ts: number, text: string): string {
  return `v2|${roomId}|${from}|${seq}|${ts}|${text}`;
}

export async function signCanonical(ecdsaPrivate: CryptoKey, canonical: string): Promise<string> {
  const sig = await crypto.subtle.sign(ECDSA_SIGN_ALGO, ecdsaPrivate, encoder.encode(canonical));
  return bufToB64(new Uint8Array(sig));
}

export async function verifyCanonical(
  ecdsaPublicJwk: JsonWebKey,
  canonical: string,
  sigB64: string,
): Promise<boolean> {
  try {
    const pub = await importEcPublic(ecdsaPublicJwk, ECDSA_KEY_ALGO, ['verify']);
    return await crypto.subtle.verify(
      ECDSA_SIGN_ALGO,
      pub,
      b64ToBytes(sigB64),
      encoder.encode(canonical),
    );
  } catch {
    return false;
  }
}

/** Короткий отпечаток ОБЕИХ открытых ключей: SHA-256, 8 байт в hex-группах. */
export async function jwkFingerprint(keys: PublicKeys): Promise<string> {
  const canonical = `EC|P-256|${keys.ecdh.x}|${keys.ecdh.y}|${keys.ecdsa.x}|${keys.ecdsa.y}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(canonical)),
  );
  return [...digest.subarray(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()
    .match(/.{4}/g)!
    .join(' ');
}
