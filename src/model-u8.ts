/**
 * Rewrite of the int8 MatMulInteger weights of an ONNX model to uint8.
 *
 * The q8 model multiplies uint8 activations by int8 weights. On an x86-64 CPU without VNNI, the
 * onnxruntime u8s8 kernel adds pairs of products in 16-bit lanes, and a long text can saturate
 * a lane. The vectors then differ from the vectors of a VNNI CPU. With uint8 weights the runtime
 * uses the u8u8 kernel, which does not saturate. The rewrite adds 128 to each weight and to each
 * weight zero point, so (weight - zero point) and every integer product stay the same.
 *
 * The module edits the protobuf bytes directly and needs no protobuf library. It reads only the
 * fields below, and copies every other field byte for byte.
 */

const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const NODE_INPUT = 1;
const NODE_OP_TYPE = 4;
const TENSOR_DATA_TYPE = 2;
const TENSOR_INT32_DATA = 5;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const TYPE_UINT8 = 2;
const TYPE_INT8 = 3;
const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

interface Field {
  num: number;
  wire: number;
  /** Start of the tag. */
  start: number;
  /** End of the field. */
  end: number;
  /** The value of a varint field. */
  value: number;
  /** Start and end of the payload of a length-delimited field. */
  body: [number, number];
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('truncated varint in the ONNX model');
    const b = buf[pos++];
    value += (b & 0x7f) * scale;
    scale *= 128;
    if (!(b & 0x80)) return [value, pos];
  }
  throw new Error('varint longer than 10 bytes in the ONNX model');
}

/**
 * The low 8 bits of the varint at `pos`. A negative int32 is a 10-byte varint, and its value does
 * not fit a double, so the low bits come from the first two bytes.
 */
function lowByte(buf: Uint8Array, pos: number): number {
  const b0 = buf[pos];
  return b0 & 0x80 ? (b0 & 0x7f) | ((buf[pos + 1] & 0x01) << 7) : b0;
}

function fields(buf: Uint8Array, from = 0, to = buf.length): Field[] {
  const out: Field[] = [];
  let pos = from;
  while (pos < to) {
    const start = pos;
    const [tag, afterTag] = readVarint(buf, pos);
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    let value = 0;
    let body: [number, number] = [afterTag, afterTag];
    if (wire === WIRE_VARINT) [value, pos] = readVarint(buf, afterTag);
    else if (wire === WIRE_I64) pos = afterTag + 8;
    else if (wire === WIRE_I32) pos = afterTag + 4;
    else if (wire === WIRE_LEN) {
      const [n, afterLen] = readVarint(buf, afterTag);
      body = [afterLen, afterLen + n];
      pos = afterLen + n;
    } else throw new Error(`unsupported protobuf wire type ${wire} in the ONNX model`);
    if (pos > to) throw new Error('truncated field in the ONNX model');
    out.push({ num, wire, start, end: pos, value, body });
  }
  return out;
}

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

const text = (buf: Uint8Array, f: Field) => Buffer.from(buf.subarray(f.body[0], f.body[1])).toString('utf-8');

function lenField(num: number, body: Uint8Array): Uint8Array {
  return Buffer.concat([Uint8Array.from([...encodeVarint(num * 8 + WIRE_LEN), ...encodeVarint(body.length)]), body]);
}

function graphOf(model: Uint8Array): Field {
  const graph = fields(model).filter(f => f.num === MODEL_GRAPH && f.wire === WIRE_LEN);
  if (graph.length !== 1) throw new Error(`expected one graph in the ONNX model, found ${graph.length}`);
  return graph[0];
}

/** Names of the weight (input 1) and weight zero point (input 3) of every MatMulInteger node. */
function weightNames(model: Uint8Array, graph: Field): Set<string> {
  const names = new Set<string>();
  for (const n of fields(model, ...graph.body).filter(f => f.num === GRAPH_NODE && f.wire === WIRE_LEN)) {
    const nf = fields(model, ...n.body);
    const op = nf.find(f => f.num === NODE_OP_TYPE);
    if (!op || text(model, op) !== 'MatMulInteger') continue;
    const inputs = nf.filter(f => f.num === NODE_INPUT).map(f => text(model, f));
    for (const i of [1, 3]) if (inputs[i]) names.add(inputs[i]);
  }
  return names;
}

interface TensorInfo { name: string; type: number; data: Uint8Array }

/** Read the name, the data type and the low byte of each element of one TensorProto. */
function tensorInfo(buf: Uint8Array, tf: Field[]): TensorInfo {
  const nameField = tf.find(f => f.num === TENSOR_NAME);
  const typeField = tf.find(f => f.num === TENSOR_DATA_TYPE);
  const parts: Uint8Array[] = [];
  const packed: number[] = [];
  for (const f of tf) {
    if (f.num === TENSOR_RAW_DATA) parts.push(buf.subarray(f.body[0], f.body[1]));
    else if (f.num === TENSOR_INT32_DATA && f.wire === WIRE_LEN) {
      for (let p = f.body[0]; p < f.body[1];) {
        packed.push(lowByte(buf, p));
        p = readVarint(buf, p)[1];
      }
    } else if (f.num === TENSOR_INT32_DATA && f.wire === WIRE_VARINT) packed.push(lowByte(buf, readVarint(buf, f.start)[1]));
  }
  if (packed.length) parts.push(Uint8Array.from(packed));
  return { name: nameField ? text(buf, nameField) : '', type: typeField?.value ?? 0, data: Buffer.concat(parts) };
}

/**
 * Rewrite the int8 weights and weight zero points of every MatMulInteger node to uint8.
 *
 * Each element becomes its low byte XOR 0x80, which is the int8 value plus 128. The data goes to
 * `raw_data`, and `int32_data` is dropped. All other fields keep their bytes and their order.
 * Throws when a weight input is not an int8 initializer, because the shift is then not exact.
 */
export function rewriteMatMulWeightsToUint8(model: Uint8Array): { bytes: Uint8Array; rewritten: number } {
  const graph = graphOf(model);
  const targets = weightNames(model, graph);
  const seen = new Set<string>();
  const graphParts: Uint8Array[] = [];
  for (const f of fields(model, ...graph.body)) {
    if (f.num !== GRAPH_INITIALIZER || f.wire !== WIRE_LEN) {
      graphParts.push(model.subarray(f.start, f.end));
      continue;
    }
    const tf = fields(model, ...f.body);
    const info = tensorInfo(model, tf);
    if (!targets.has(info.name)) {
      graphParts.push(model.subarray(f.start, f.end));
      continue;
    }
    if (info.type !== TYPE_INT8) {
      throw new Error(`MatMulInteger weight ${info.name} has data type ${info.type}, not int8 (${TYPE_INT8})`);
    }
    seen.add(info.name);
    const parts: Uint8Array[] = [];
    for (const t of tf) {
      if (t.num === TENSOR_INT32_DATA || t.num === TENSOR_RAW_DATA) continue;
      if (t.num === TENSOR_DATA_TYPE) parts.push(Uint8Array.from([...encodeVarint(TENSOR_DATA_TYPE * 8), ...encodeVarint(TYPE_UINT8)]));
      else parts.push(model.subarray(t.start, t.end));
    }
    const shifted = new Uint8Array(info.data);
    for (let i = 0; i < shifted.length; i++) shifted[i] ^= 0x80;
    parts.push(lenField(TENSOR_RAW_DATA, shifted));
    graphParts.push(lenField(GRAPH_INITIALIZER, Buffer.concat(parts)));
  }
  const missing = [...targets].filter(n => !seen.has(n));
  if (missing.length) throw new Error(`MatMulInteger weight(s) without an initializer: ${missing.join(', ')}`);

  const modelParts: Uint8Array[] = [];
  for (const f of fields(model)) {
    modelParts.push(f.start === graph.start ? lenField(MODEL_GRAPH, Buffer.concat(graphParts)) : model.subarray(f.start, f.end));
  }
  return { bytes: new Uint8Array(Buffer.concat(modelParts)), rewritten: seen.size };
}

/**
 * List the MatMulInteger weight initializers of a model by data type.
 *
 * `int8` and `uint8` hold the names; `data` holds the low byte of each element, by name.
 */
export function int8MatMulWeights(model: Uint8Array): { int8: string[]; uint8: string[]; data: Map<string, number[]> } {
  const graph = graphOf(model);
  const targets = weightNames(model, graph);
  const result = { int8: [] as string[], uint8: [] as string[], data: new Map<string, number[]>() };
  for (const f of fields(model, ...graph.body)) {
    if (f.num !== GRAPH_INITIALIZER || f.wire !== WIRE_LEN) continue;
    const info = tensorInfo(model, fields(model, ...f.body));
    if (!targets.has(info.name)) continue;
    if (info.type === TYPE_INT8) result.int8.push(info.name);
    if (info.type === TYPE_UINT8) result.uint8.push(info.name);
    result.data.set(info.name, [...info.data]);
  }
  return result;
}
