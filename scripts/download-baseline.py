"""Download a pinned, non-pickle research baseline; never silently deploy it."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

REPO = "subhodeepmoitra/pothole-detection-yolov8"
REVISION = "f829c25ade58a613e4a54ccc3c9759fc82b9e292"
SHA256 = "a8553eb1dd0113fa8d7c8985e21f3a50f8ee641e2fa2a4efc93b14c93932fc5b"
URL = f"https://huggingface.co/{REPO}/resolve/{REVISION}/best.onnx"

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(".local/models/pothole-yolov8"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    artifact = args.output / "best.onnx"
    if not artifact.exists():
        with urllib.request.urlopen(URL, timeout=60) as response:
            content = response.read(32 * 1024 * 1024 + 1)
        if len(content) > 32 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != SHA256:
            raise ValueError("Downloaded artifact failed size/checksum verification")
        artifact.write_bytes(content)
    if hashlib.file_digest(artifact.open("rb"), "sha256").hexdigest() != SHA256:
        raise ValueError("Existing artifact has an unexpected checksum")
    provenance = {
        "sourceUrl": f"https://huggingface.co/{REPO}/tree/{REVISION}",
        "revision": REVISION,
        "trainingDataset": "not supplied by the publisher; ONNX metadata references pothole_dataset.yaml",
        "publisherModelCardLicense": "MIT",
        "embeddedArtifactLicense": "AGPL-3.0; https://ultralytics.com/license",
        "licenseResolution": "unresolved conflict; retain embedded AGPL-3.0 notice; no commercial-rights assertion",
        "evaluationStatus": "experimental, no independent local accuracy or severity validation",
        "classes": ["pothole"],
        "sha256": SHA256,
    }
    raw = (json.dumps(provenance, indent=2) + "\n").encode()
    (args.output / "provenance.json").write_bytes(raw)
    manifest = {
        "schemaVersion": 1, "format": "yolov8-seg-onnx", "name": "Experimental pothole YOLOv8n segmentation",
        "version": REVISION, "artifact": "best.onnx", "sha256": SHA256,
        "license": "AGPL-3.0 embedded; publisher MIT conflict unresolved",
        "sourceUrl": provenance["sourceUrl"], "datasetManifestSha256": hashlib.sha256(raw).hexdigest(),
        "trainedForRoadDamage": True, "validationStatus": "experimental", "classes": ["pothole"],
        "inputSize": [640, 640], "threshold": 0.4,
    }
    path = args.output / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Verified experimental model and provenance: {path.resolve()}")
    print("This is not an approved production detector. See models/BASELINE-NOTICE.md.")

if __name__ == "__main__":
    main()
