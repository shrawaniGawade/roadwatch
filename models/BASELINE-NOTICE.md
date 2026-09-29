The optional experimental baseline is a YOLOv8n pothole segmentation checkpoint
published by `subhodeepmoitra/pothole-detection-yolov8` on Hugging Face.

- Pinned revision: `f829c25ade58a613e4a54ccc3c9759fc82b9e292`.
- SHA-256: `a8553eb1dd0113fa8d7c8985e21f3a50f8ee641e2fa2a4efc93b14c93932fc5b`.
- The [publisher page](https://huggingface.co/subhodeepmoitra/pothole-detection-yolov8/tree/f829c25ade58a613e4a54ccc3c9759fc82b9e292)
  declares MIT. **The model's embedded metadata declares AGPL-3.0**, attributes
  Ultralytics and links to [Ultralytics licensing](https://www.ultralytics.com/license).
  This conflicting provenance is recorded, not resolved by this project.
- The publisher did not supply auditable training dataset provenance or local
  evaluation results. Invalid expressions in its configuration are not interpreted
  as measured performance. No upstream Python code is downloaded or executed.
- The artifact has one road class (`pothole`), static input `1×3×640×640`, 32 mask
  prototypes and no external tensor files. It does not recognize all eight defect
  classes supported by the application.
- ONNX Runtime executes the graph; this repository implements its own array
  decoding adapter. Model parameters are not included in Git or container images.
- `datasetManifestSha256` points to the downloaded model's **provenance record**,
  which explicitly says the training dataset is unknown. It is not proof of
  training-data permission or coverage.

Download and prepare the local baseline with:

```sh
.venv/bin/python scripts/download-baseline.py
```

Set `VISION_MODEL_MANIFEST` to the printed absolute manifest path and
`VISION_ALLOW_EXPERIMENTAL_MODEL=true` in your local `.env`, then restart the vision
process. `NODE_ENV=production` rejects experimental artifacts. The inference result identifies the experimental
validation status. Do not treat successful model execution as accuracy validation.
Production models need a resolved license, permitted training data, a held-out
local test set, class-specific error bounds, device calibration, and release approval.
