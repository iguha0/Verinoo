import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import crypto from 'crypto';

const PREFIX = 'ai';

export function generateKeyPair() {
  const pair = nacl.sign.keyPair();
  const privateKey = util.encodeBase64(pair.secretKey);
  const publicKey = Buffer.from(pair.publicKey).toString('hex');
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest();
  const address = `${PREFIX}_${hash.subarray(0, 20).toString('hex')}`;
  return { publicKey, privateKey, address };
}

export function signMessage(message: string | Uint8Array, secretKeyBase64: string): string {
  const secret = util.decodeBase64(secretKeyBase64);
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf-8') : Buffer.from(message);
  return util.encodeBase64(nacl.sign.detached(msg, secret));
}

export function verifySignature(message: string | Uint8Array, signatureBase64: string, publicKeyHex: string): boolean {
  try {
    const pk = Buffer.from(publicKeyHex, 'hex');
    const sig = util.decodeBase64(signatureBase64);
    const msg = typeof message === 'string' ? Buffer.from(message, 'utf-8') : Buffer.from(message);
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

export function publicKeyToAddress(publicKeyHex: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest();
  return `${PREFIX}_${hash.subarray(0, 20).toString('hex')}`;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
