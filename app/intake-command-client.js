// Pending mutation identity is independent of navigation and ordinary drafts.
export function commandIdentity(kind, targetId = '') { return kind === 'add' ? 'add' : kind + ':' + targetId; }
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
export class PendingCommands {
  #records = new Map();
  #sending = new Map();
  get size() { return this.#records.size; }
  has(key) { return this.#records.has(key); }
  get(key) { return this.#records.get(key); }
  values() { return this.#records.values(); }
  isSending(key) { return this.#sending.has(key); }
  start({kind, targetId = '', path, payload, snapshot, label = ''}) {
    const key = commandIdentity(kind, targetId);
    if (!this.#records.has(key)) this.#records.set(key, freeze({key, kind, targetId, path, label,
      payload: {...structuredClone(payload), requestId: crypto.randomUUID()}, snapshot: structuredClone(snapshot)}));
    return this.#records.get(key);
  }
  acknowledge(key) { this.#records.delete(key); }
  reconcile(key, send) {
    if (this.#sending.has(key)) return this.#sending.get(key);
    const record = this.#records.get(key);
    if (!record) return Promise.reject(new Error('没有待确认的保存'));
    const work = Promise.resolve().then(() => send(record.path, record.payload))
      .then(result => { this.acknowledge(key); return result; })
      .catch(error => { if (error.status && error.status < 500) this.acknowledge(key); throw error; })
      .finally(() => this.#sending.delete(key));
    this.#sending.set(key, work); return work;
  }
}
