import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelDir, UINT8_MODEL_SHA256 } from '../src/embedding-model.js';
import { int8MatMulWeights, rewriteMatMulWeightsToUint8 } from '../src/model-u8.js';

// A minimal protobuf writer for the test models.
function varint(n: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
const len = (field: number, body: number[]) => [...varint((field << 3) | 2), ...varint(body.length), ...body];
const num = (field: number, value: number) => [...varint(field << 3), ...varint(value)];
const str = (field: number, s: string) => len(field, [...Buffer.from(s)]);

const INT8 = 3;
const UINT8 = 2;
// TensorProto: dims 1, data_type 2, int32_data 5, name 8, raw_data 9.
const rawTensor = (name: string, type: number, bytes: number[]) => [...num(1, bytes.length), ...num(2, type), ...str(8, name), ...len(9, bytes)];
const packedTensor = (name: string, type: number, values: number[]) =>
  [...num(1, values.length), ...num(2, type), ...len(5, values.flatMap(v => varint(v))), ...str(8, name)];
// NodeProto: input 1, op_type 4.
const node = (op: string, inputs: string[]) => [...inputs.flatMap(i => str(1, i)), ...str(4, op)];
// ModelProto: ir_version 1, graph 7. GraphProto: node 1, initializer 5.
const model = (nodes: number[][], inits: number[][]) =>
  Uint8Array.from([...num(1, 7), ...len(7, [...nodes.flatMap(n => len(1, n)), ...inits.flatMap(t => len(5, t))])]);

const sample = () =>
  model(
    [node('MatMulInteger', ['a', 'w', 'azp', 'wzp']), node('Add', ['x', 'other'])],
    [rawTensor('w', INT8, [0x80, 0x00, 0x7f]), packedTensor('wzp', INT8, [-128, 0, 127]), rawTensor('other', INT8, [0x01])]
  );

describe('rewriteMatMulWeightsToUint8', () => {
  it('shifts the int8 weight and weight zero point of each MatMulInteger to uint8', () => {
    const { bytes, rewritten } = rewriteMatMulWeightsToUint8(sample());
    expect(rewritten).toBe(2);
    const tensors = int8MatMulWeights(bytes);
    expect(tensors.int8).toEqual([]);
    expect(tensors.uint8.sort()).toEqual(['w', 'wzp']);
    // -128, 0 and 127 become 0, 128 and 255: (w - zp) stays the same.
    expect(tensors.data.get('w')).toEqual([0x00, 0x80, 0xff]);
    expect(tensors.data.get('wzp')).toEqual([0x00, 0x80, 0xff]);
  });

  it('leaves a tensor that no MatMulInteger weight input names unchanged', () => {
    const { bytes } = rewriteMatMulWeightsToUint8(sample());
    const before = Buffer.from(sample()).toString('hex');
    expect(Buffer.from(bytes).toString('hex')).toContain(Buffer.from(rawTensor('other', INT8, [0x01])).toString('hex'));
    expect(before).toContain(Buffer.from(rawTensor('other', INT8, [0x01])).toString('hex'));
  });

  it('refuses a MatMulInteger weight that is not an int8 initializer', () => {
    const bad = model([node('MatMulInteger', ['a', 'w', 'azp', 'wzp'])], [rawTensor('w', INT8, [1]), rawTensor('wzp', 1, [0, 0, 0, 0])]);
    expect(() => rewriteMatMulWeightsToUint8(bad)).toThrow(/wzp/);
  });
});

describe('the pinned model after the rewrite', () => {
  const file = join(process.env.EPISODIC_MEMORY_MODEL_DIR ?? modelDir(), 'onnx', 'model_quantized.onnx');

  // test/global-setup.ts downloads the model before the workers start, so the file is present.
  it('has no int8 MatMulInteger weight and the pinned hash', () => {
    const { bytes, rewritten } = rewriteMatMulWeightsToUint8(readFileSync(file));
    expect(rewritten).toBe(144);
    expect(int8MatMulWeights(bytes).int8).toEqual([]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(UINT8_MODEL_SHA256);
  });
});
