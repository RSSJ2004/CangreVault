// Cifrado AES-256-GCM del token de acceso del proveedor antes de guardarlo en la base.
// La clave (BANK_TOKEN_ENCRYPTION_KEY, 32 bytes en base64) vive SOLO en los secretos
// de Edge Functions: quien lea la tabla sin la clave no puede usar el token.

const b64 = {
  enc: (u: Uint8Array) => btoa(String.fromCharCode(...u)),
  dec: (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

export async function importKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error('Falta BANK_TOKEN_ENCRYPTION_KEY');
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = b64.dec(base64Key.trim()); } catch { throw new Error('BANK_TOKEN_ENCRYPTION_KEY no es base64 válido'); }
  if (raw.length !== 32) throw new Error('BANK_TOKEN_ENCRYPTION_KEY debe tener 32 bytes (256 bits)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** `aad` vincula el cifrado al usuario: un texto cifrado copiado a otra fila no descifra. */
export async function encryptToken(key: CryptoKey, token: string, aad: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(token));
  return { ciphertext: b64.enc(new Uint8Array(ct)), iv: b64.enc(iv) };
}

export async function decryptToken(key: CryptoKey, ciphertext: string, iv: string, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv), additionalData: new TextEncoder().encode(aad) }, key, b64.dec(ciphertext));
  return new TextDecoder().decode(pt);
}
