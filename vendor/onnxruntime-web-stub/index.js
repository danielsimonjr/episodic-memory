// The node build of @huggingface/transformers does not import onnxruntime-web, so this onnxruntime-web
// package is a stub. A later import of onnxruntime-web throws at once, and the embedding tests show the failure.
throw new Error('onnxruntime-web is stubbed out; the node build does not use it');
