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
/**
 * Rewrite the int8 weights and weight zero points of every MatMulInteger node to uint8.
 *
 * Each element becomes its low byte XOR 0x80, which is the int8 value plus 128. The data goes to
 * `raw_data`, and `int32_data` is dropped. All other fields keep their bytes and their order.
 * Throws when a weight input is not an int8 initializer, because the shift is then not exact.
 */
export declare function rewriteMatMulWeightsToUint8(model: Uint8Array): {
    bytes: Uint8Array;
    rewritten: number;
};
/**
 * List the MatMulInteger weight initializers of a model by data type.
 *
 * `int8` and `uint8` hold the names; `data` holds the low byte of each element, by name.
 */
export declare function int8MatMulWeights(model: Uint8Array): {
    int8: string[];
    uint8: string[];
    data: Map<string, number[]>;
};
