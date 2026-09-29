# RoadWatch vision service

This service runs actual local inference and calibrated geometry. It contains **no bundled road model and no production synthetic detector**. Without a valid trained model manifest, `/health` is healthy and `/ready` plus authenticated `/v1/analyze` return 503. Evidence must remain in the operational API for retry or inspection.

## Run and verify

From the repository root:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e 'services/vision[test]' -e 'services/edge[test]'
.venv/bin/python -m pytest services/vision/tests services/edge/tests
export VISION_SERVICE_KEY='use-a-long-random-service-secret'
.venv/bin/uvicorn roadwatch_vision.app:app --host 127.0.0.1 --port 8001
```

Configure a model by setting `VISION_MODEL_MANIFEST` to an absolute JSON path. Experimental artifacts are disabled unless `VISION_ALLOW_EXPERIMENTAL_MODEL=true`. **`NODE_ENV=production` rejects experimental models even if that flag is set.** Setting a manifest to `field_validated` is an operator assertion requiring the independent acceptance evidence specified in the project report; it is not a transformation that improves a model.

`POST /v1/analyze` uses multipart `file` and `metadata` (a JSON string), with `X-Service-Key`. The service authenticates before multipart parsing, limits uploaded bytes, limits pixels/video duration/frames, permits only known media signatures, serializes bounded inference capacity, decodes local files in short-lived subprocesses, and kills overdue workers. No submitted URL is fetched. It supports JPEG, PNG, single-frame WebP, MP4, WebM and AVI. API ingestion may accept a narrower list.

Default limits: 32 MiB upload, 16 million pixels, 60-second video, 1,800 decoded frames, 30 sampled frames, 90-second wall timeout, two simultaneous jobs. Configure `VISION_MAX_UPLOAD_BYTES`, `VISION_MAX_PIXELS`, `VISION_MAX_VIDEO_SECONDS`, `VISION_MAX_DECODED_FRAMES`, `VISION_MAX_SELECTED_FRAMES`, `VISION_TIMEOUT_SECONDS` and `VISION_MAX_CONCURRENCY` within the validated bounds. Keep API upload limits aligned. Deploy with container memory/PID limits, an unprivileged user and read-only model mount; decode subprocesses are lifetime/resource boundaries, not a complete hostile-code sandbox.

## Artifact manifest

```json
{
  "schemaVersion": 1,
  "format": "roadwatch-onnx-v1",
  "name": "operator-trained-road-segmentation",
  "version": "reviewed-release-id",
  "artifact": "road-model.onnx",
  "sha256": "<64 lowercase hexadecimal characters>",
  "license": "<exact code and weight rights>",
  "sourceUrl": "https://your-authorized-model-registry.example/model",
  "datasetManifestSha256": "<hash of the retained dataset/provenance manifest>",
  "trainedForRoadDamage": true,
  "validationStatus": "experimental",
  "classes": ["pothole", "longitudinal_crack", "transverse_crack", "alligator_crack"],
  "inputSize": [640, 640],
  "mean": [0, 0, 0],
  "std": [1, 1, 1],
  "threshold": 0.4
}
```

The model file must be inside the manifest directory. The service verifies SHA-256 and the actual runtime input/output signature. No Python pickle is loaded for ONNX models. The file may have its own upstream license even when the adapter implementation is independent.

Supported formats:

* `roadwatch-onnx-v1`: fixed float32 `[1,3,H,W]` RGB input, resized to `inputSize`, normalized as `(pixel/255 - mean)/std`. Named outputs: `boxes` float `[N,4]` normalized XYXY; `scores` float `[N]` probabilities; `class_ids` integer `[N]`, zero-based indexes into `classes`; `masks` float `[N,Hmask,Wmask]` probabilities in the resized full-image coordinates. The exported graph must output this explicit postprocessed contract. Native RF-DETR exports are not automatically this format.
* `yolov8-onnx`: raw box-only YOLOv8 float output `[1,4+C,N]`. Uses RGB letterbox, class-specific NMS and inverse coordinate mapping. Returns **empty masks and unknown dimensions**, because boxes are not measured footprints.
* `yolov8-seg-onnx`: raw detections `[1,4+C+M,N]` plus prototypes `[1,M,Hm,Wm]`; coefficients are combined with prototypes, cropped to proposals and unletterboxed. Instance masks with multiple components/holes retain a display outline but **withhold metric geometry** pending review.
* `rfdetr-seg-small`: optional `rfdetr` package with explicitly installed, operator-trusted, checksummed local trained checkpoint. Only the Apache-designated RF-DETR-Seg Small variant is selected. The checkpoint's class names must match the manifest exactly. Its training/runtime dependencies are optional; do not expose arbitrary checkpoint upload. PyTorch checkpoints require the upstream safe-loading policy and trusted provenance.

The repository's optional downloaded baseline, if root tooling provisions one, is experimental. Its dataset provenance and accuracy may be unknown, and its embedded weight license may differ from its repository card. Check that local provenance record. Runtime success is not an accuracy or commercial-license approval.

## Calibration and geolocation

Metadata validates timestamps with UTC offsets, finite values and ordered unique telemetry. A planar calibration declares image dimensions, a valid pixel ROI, homography, optional camera intrinsics/distortion, expiry, and uncertainty. `imageToGround` maps **undistorted image pixels to camera-origin ground forward/right coordinates in metres**. `cameraOffsetForwardM` and `cameraOffsetRightM` are offsets from the GNSS antenna to that origin, expressed in vehicle forward/right axes. Heading is clockwise from north. The calibration must correspond to the current mount/attitude or its output must be withheld.

The function computes planar footprint extents and area as **estimated**, never field-verified. Cavity depth stays unknown for RGB. Standalone `stereo_depth` implements `Z=fB/disparity` and first-order disparity uncertainty; `depression_below_plane` accepts independently reconstructed local z-up points and returns depression normal to a qualified intact plane. These functions are tested analytically, but **the HTTP endpoint does not accept an arbitrary RGB video as a stereo depth survey**. A stereo device adapter must supply calibrated paired exposures/point clouds and independent metrology validation before wiring this into live depth results.

To derive defect coordinates, supply a synchronized `trajectory` with position, `horizontalAccuracy95M` and heading. The implementation interpolates only inside a bounded telemetry interval, handles heading wrap and includes antenna-to-camera offsets. It rejects unsupported polar approximation and withholds coordinates when projection or synchronized heading is unavailable. A lone supplied latitude/longitude remains antenna metadata; it is never silently copied to the pothole. For videos, nominal FPS timestamps are insufficient for precision: trajectory projection is disabled unless `videoTiming` is explicitly `constant_fps_verified`. Hardware exposure timing is still the device integrator's responsibility. Approximate frame offsets and their provenance remain visible.

Uncertainty here is conservative engineering propagation, not a neural confidence score. The calibration's `uncertainty95M` must be an empirically established bound on each reconstructed boundary point, including segmentation, pixel simplification and projection error; a camera reprojection residual alone is insufficient. Values remain estimates until the full pipeline and measurement availability pass surveyed reference tests. Masks are simplified for bounded JSON; multi-component/holed masks are ineligible for measurement.

## Dataset, training and evaluation

`roadwatch-dataset input.coco.json images/ --licenses license-manifest.json --output prepared/` validates local COCO polygon masks, image hashes/dimensions, road classes and source rights, then groups by `groupId` into train/valid/test. Supply at least three independent road/session groups; use a stronger corridor grouping for repeated passes. Each image requires `sourceId`, `groupId` and `sha256`; categories must use contiguous zero-based IDs. Source rights manifest:

```json
{"schemaVersion":1,"sources":[{"id":"agency-survey","url":"https://agency.example/survey-agreement","license":"agency-owned-authorized-training","rightsReviewedBy":"authorized data custodian","permittedUses":["train","evaluate"]}]}
```

No declaration resolves rights by itself. Review originals, subset provenance and permitted uses. RDD2022 can seed detection work but does not provide your local pixel masks, surveyed dimensions or comprehensive road conditions. A code license is not an image-data license.

For optional training, install `services/vision[train]`. Run:

```sh
roadwatch-train prepared/ --base-checkpoint approved-seg-small.pth --base-sha256 ACTUAL_SHA256 --output runs/road-v1 --version road-v1 --device cuda
roadwatch-evaluate prepared/test --model runs/road-v1/model-manifest.json --output runs/road-v1/test-results.json
```

Training takes an explicitly supplied local base checkpoint; no weights are implicitly provisioned by this CLI. It validates group leakage and rights first, uses RF-DETR-Seg Small, and writes an experimental manifest. Evaluation matches masks by class and IoU and reports precision/recall with Wilson intervals. It is **per-image instance evaluation**, not unique defect field recall, mAP, metrology validation, or release approval. The test suite includes constant ONNX graphs only as clearly labelled transport/tensor fixtures; these are never activation candidates.

## Upstream attribution and reviewed interfaces

* [FastAPI multipart files](https://fastapi.tiangolo.com/tutorial/request-files/) — FastAPI/MIT; [ONNX Runtime Python API](https://onnxruntime.ai/docs/api/python/api_summary.html) — Microsoft/MIT.
* [OpenCV calibration](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html), [video capture](https://docs.opencv.org/4.x/d8/dfe/classcv_1_1VideoCapture.html) — OpenCV/Apache-2.0 for current code. Binary distributions can contain separately licensed dependencies.
* [RF-DETR official repository](https://github.com/roboflow/rf-detr), [training guide](https://rfdetr.roboflow.com/learn/train/) — exact selected Apache-designated small segmentation artifact; Plus components have different licenses.
* [Ultralytics model/export documentation](https://docs.ultralytics.com/modes/export/) and [licensing](https://www.ultralytics.com/license) — YOLO lineage/weights may be AGPL or commercially licensed. The independent ONNX decoder does not change those rights.
* [RDD2022 author paper](https://arxiv.org/abs/2209.08538), [specific release metadata](https://api.figshare.com/v2/articles/21431547) — dataset and subset rights require independent review.

Dependencies are pinned in `pyproject.toml`; root tooling can generate an environment lock with `uv pip compile` for its deployment platform. Model accuracy, optional RF-DETR GPU training and physical camera calibration cannot be certified by unit tests.
