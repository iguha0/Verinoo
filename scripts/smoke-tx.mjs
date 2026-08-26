import { createHash } from 'crypto';
import nacl from 'tweetnacl';
import fs from 'fs';
const key = JSON.parse(fs.readFileSync('/tmp/opencode/smoke_key.json','utf8'));
const secret = Uint8Array.from(Buffer.from(key.secret,'hex'));
function canon(v){ if(v===null||typeof v!=='object')return JSON.stringify(v); if(Array.isArray(v))return '['+v.map(canon).join(',')+']'; const k=Object.keys(v).sort(); return '{'+k.map(x=>JSON.stringify(x)+':'+canon(v[x])).join(',')+'}'; }
const tx = { from: key.addr, to: 'ai_9999999999999999999999999999999999999999', value: 777, nonce: Number(process.argv[2] ?? 1),
             data: { type: 'transfer', data: {} }, publicKey: key.pub };
const payload = { data: tx.data, from: tx.from, nonce: tx.nonce, to: tx.to, value: tx.value };
const canonical = canon(payload);
const txId = createHash('sha256').update(canonical,'utf8').digest('hex');
// ED scheme transports signatures as HEX over the UTF-8 txId bytes
const sigBytes = nacl.sign.detached(Buffer.from(txId,'utf8'), secret);
tx.txId = txId; tx.signature = Buffer.from(sigBytes).toString('hex');
fs.writeFileSync('/tmp/opencode/smoke_tx.json', JSON.stringify(tx));
console.log('txId:', txId.slice(0,16), '| sig HEX len:', tx.signature.length);
