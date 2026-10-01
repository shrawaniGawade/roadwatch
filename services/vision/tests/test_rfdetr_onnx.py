from types import SimpleNamespace

import numpy as np
import pytest

from roadwatch_vision.models import RFDetrOnnxModel


def test_rfdetr_onnx_decodes_classes_and_ignores_background():
    model = object.__new__(RFDetrOnnxModel)
    model.input_name = "input"
    model.manifest = SimpleNamespace(
        inputSize=[512, 512],
        mean=[0.485, 0.456, 0.406],
        std=[0.229, 0.224, 0.225],
        classes=["longitudinal_crack", "transverse_crack", "alligator_crack", "pothole"],
        threshold=0.3,
    )
    boxes = np.array([[[0.5, 0.5, 0.4, 0.2], [0.1, 0.1, 0.1, 0.1]]], np.float32)
    logits = np.full((1, 2, 5), -10.0, np.float32)
    logits[0, 0, 3] = 3.0
    logits[0, 1, 4] = 20.0  # Background must never become a road class.

    class Session:
        def run(self, names, feed):
            assert names == ["dets", "labels"]
            assert feed["input"].shape == (1, 3, 512, 512)
            return boxes, logits

    model.session = Session()
    detections = model.predict(np.zeros((200, 400, 3), np.uint8))
    assert len(detections) == 1
    assert detections[0]["type"] == "pothole"
    assert detections[0]["bbox"] == pytest.approx([120, 80, 280, 120])
    assert detections[0]["mask"] == []
    assert detections[0]["measurementReason"] == "box_only_model_no_measured_footprint"
