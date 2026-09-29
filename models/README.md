Model weights are intentionally excluded from Git. Use an explicit model manifest
with a checksum, supported road classes, source and dataset provenance. The vision
service documents its ONNX contract in `services/vision/README.md`.

Models used for operational decisions must pass local held-out evaluation and
license review. A downloaded public pothole checkpoint is an experimental baseline;
it does not provide measured depth, multiple defect classes or field validation.

The `models` directory is mounted read-only by Compose. Never place a pickle-based
checkpoint from an untrusted source here. ONNX models are still processed with
bounded CPU, memory, dimensions and inference time.
