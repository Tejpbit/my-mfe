const enc = new TextEncoder();
const dec = new TextDecoder();

export async function deriveRoom(pass) {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('mfe-salt-v1'), iterations: 120000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const digest = await crypto.subtle.digest('SHA-256', enc.encode('mfe-topic:' + pass));
  const hex = [...new Uint8Array(digest)].slice(0, 10).map(b => b.toString(16).padStart(2, '0')).join('');
  return { key, topic: 'mfe/' + hex };
}

async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const buf = new Uint8Array(iv.length + ct.length);
  buf.set(iv);
  buf.set(ct, iv.length);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function decrypt(key, b64) {
  try {
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

export class Net {
  constructor({ uri, pass, onMessage, onStatus }) {
    this.uri = uri;
    this.pass = pass;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.client = null;
    this.key = null;
    this.topic = null;
  }

  async connect() {
    const { key, topic } = await deriveRoom(this.pass);
    this.key = key;
    this.topic = topic;
    this.onStatus('connecting');
    this.client = mqtt.connect(this.uri, {
      clientId: 'mfe_' + Math.random().toString(36).slice(2, 10),
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 8000,
    });
    this.client.on('connect', () => {
      this.onStatus('connected');
      this.client.subscribe(this.topic, { qos: 1 });
    });
    this.client.on('reconnect', () => this.onStatus('connecting'));
    this.client.on('close', () => this.onStatus('offline'));
    this.client.on('error', () => this.onStatus('error'));
    this.client.on('message', async (_topic, payload) => {
      const obj = await decrypt(this.key, payload.toString());
      if (obj) this.onMessage(obj);
    });
  }

  async publish(obj, retain = true) {
    if (!this.client) return;
    const payload = await encrypt(this.key, obj);
    this.client.publish(this.topic, payload, { retain, qos: 1 });
  }

  close() {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
  }
}
