// 手写环形队列 + 哈希计数表：记录入窗时累加计数，移出窗口时逐键扣减。
// 计数表键由 keysOf(record) 给出，同一张表可同时维护多族计数（见 constants.js 的 COUNTER_PREFIX）。

const EPS = 1e-9;

function defaultTimeOf(record) {
  return record && typeof record === "object" ? Number(record.at) : Number(record);
}

function defaultKeysOf(record) {
  if (record && Array.isArray(record.keys)) return record.keys;
  return [{ key: "__all__", weight: 1 }];
}

export class RingWindow {
  constructor(options = {}) {
    const cap = Number(options.capacity);
    this._capacity = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 64;
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._size = 0;
    this._counts = new Map();
    this._timeOf = typeof options.timeOf === "function" ? options.timeOf : defaultTimeOf;
    this._keysOf = typeof options.keysOf === "function" ? options.keysOf : defaultKeysOf;
  }

  get size() {
    return this._size;
  }

  get capacity() {
    return this._capacity;
  }

  get counts() {
    return this._counts;
  }

  // 按入窗顺序（要求调用方按时间非降序 push）取第 index 条。
  at(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this._size) return undefined;
    return this._buf[(this._head + index) % this._capacity];
  }

  first() {
    return this.at(0);
  }

  last() {
    return this.at(this._size - 1);
  }

  countOf(key) {
    return this._counts.get(key) ?? 0;
  }

  totalWeight() {
    let sum = 0;
    for (const v of this._counts.values()) sum += v;
    return sum;
  }

  toArray() {
    const out = new Array(this._size);
    for (let i = 0; i < this._size; i += 1) out[i] = this.at(i);
    return out;
  }

  // 键按字符串排序输出，便于逐字节比较与调试。
  toCountObject() {
    const keys = [...this._counts.keys()].sort();
    const out = {};
    for (const k of keys) out[k] = this._counts.get(k);
    return out;
  }

  push(record) {
    if (this._size === this._capacity) this._grow();
    this._buf[(this._head + this._size) % this._capacity] = record;
    this._size += 1;
    this._apply(record, 1);
    return this;
  }

  // 批量过期：从队首连续移出 at < start 的记录（半开区间 [start, end) 的左侧），返回移出条数。
  evictBefore(start) {
    const limit = Number(start);
    if (!Number.isFinite(limit)) return 0;
    let removed = 0;
    while (this._size > 0) {
      const record = this._buf[this._head];
      const at = Number(this._timeOf(record));
      if (Number.isFinite(at) && at >= limit) break;
      this._apply(record, -1);
      this._buf[this._head] = undefined;
      this._head = (this._head + 1) % this._capacity;
      this._size -= 1;
      removed += 1;
    }
    return removed;
  }

  clear() {
    const removed = this._size;
    while (this._size > 0) {
      this._apply(this._buf[this._head], -1);
      this._buf[this._head] = undefined;
      this._head = (this._head + 1) % this._capacity;
      this._size -= 1;
    }
    this._head = 0;
    return removed;
  }

  // 扩容必须按逻辑顺序（head 起）重排；直接拷物理数组会在绕回后打乱时间序。
  _grow() {
    const next = new Array(this._capacity * 2);
    for (let i = 0; i < this._size; i += 1) next[i] = this._buf[(this._head + i) % this._capacity];
    this._buf = next;
    this._capacity = next.length;
    this._head = 0;
  }

  _apply(record, sign) {
    const keys = this._keysOf(record) || [];
    for (const entry of keys) {
      if (!entry || entry.key == null) continue;
      const weight = Number(entry.weight ?? 1);
      if (!Number.isFinite(weight) || weight === 0) continue;
      const key = String(entry.key);
      if (sign > 0) {
        this._counts.set(key, (this._counts.get(key) ?? 0) + weight);
        continue;
      }
      const next = (this._counts.get(key) ?? 0) - weight;
      // 浮点相减可能留下 -1e-17 这类残差；计数只允许取到 0，负值一律夹到 0 并删键。
      if (next <= EPS) this._counts.delete(key);
      else this._counts.set(key, next);
    }
  }
}
