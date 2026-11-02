// 手写小根堆求 Top-K：堆里始终保留当前最好的 k 个候选，堆顶是"最差的胜出者"。
// 禁止用 Array.sort 做选择；只在最后对 k 个结果排序（契约允许）。

function tieKeyOf(item) {
  if (item && typeof item === "object") {
    if (typeof item.tieKey === "string") return item.tieKey;
    if (item.content_id != null) return String(item.content_id);
    if (item.id != null) return String(item.id);
  }
  return String(item);
}

// a 比 b 差：分数更低，或同分但稳定键更大，或再同则原下标更大。
function isWorse(a, b) {
  if (a.score !== b.score) return a.score < b.score;
  if (a.key !== b.key) return a.key > b.key;
  return a.idx > b.idx;
}

function siftUp(heap, index) {
  let i = index;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    // 堆顶是"最差的胜出者"：新元素若比父节点更差就要上浮。
    if (!isWorse(heap[i], heap[parent])) break;
    const tmp = heap[parent];
    heap[parent] = heap[i];
    heap[i] = tmp;
    i = parent;
  }
}

function siftDown(heap, index) {
  let i = index;
  const n = heap.length;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let worst = i;
    if (left < n && isWorse(heap[left], heap[worst])) worst = left;
    if (right < n && isWorse(heap[right], heap[worst])) worst = right;
    if (worst === i) break;
    const tmp = heap[worst];
    heap[worst] = heap[i];
    heap[i] = tmp;
    i = worst;
  }
}

/**
 * 取分数最高的 k 个候选。
 * 同分时按稳定键升序（item.tieKey > item.content_id > item.id > String(item)），再按原下标升序，
 * 因此输出与候选顺序无关、可逐字节复现。
 * @param {Array} candidates
 * @param {number} k
 * @param {(item:any, index:number)=>number} scoreFn
 */
export function topK(candidates, k, scoreFn) {
  const list = Array.isArray(candidates) ? candidates : [];
  const limit = Math.floor(Number(k));
  if (!Number.isFinite(limit) || limit <= 0 || list.length === 0) return [];
  const score = typeof scoreFn === "function" ? scoreFn : () => 0;
  const cap = Math.min(limit, list.length);
  const heap = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const raw = Number(score(item, i));
    const entry = { score: Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY, key: tieKeyOf(item), idx: i, item };
    if (heap.length < cap) {
      heap.push(entry);
      siftUp(heap, heap.length - 1);
    } else if (isWorse(heap[0], entry)) {
      heap[0] = entry;
      siftDown(heap, 0);
    }
  }
  heap.sort((a, b) => (isWorse(a, b) ? 1 : isWorse(b, a) ? -1 : 0));
  return heap.map((entry) => entry.item);
}
