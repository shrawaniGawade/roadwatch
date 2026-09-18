import hashlib
import json
import numpy as np
import onnx
from onnx import TensorProto,helper,numpy_helper
import pytest


@pytest.fixture
def onnx_manifest(tmp_path):
    """Constant graph tests our tensor/transport contract, NOT road model accuracy."""
    arrays={"boxes":np.array([[.1,.1,.8,.8]],np.float32),"scores":np.array([.9],np.float32),
            "class_ids":np.array([0],np.int64),"masks":np.pad(np.ones((1,20,20),np.float32),((0,0),(4,8),(4,8)))}
    outputs=[helper.make_tensor_value_info(k,TensorProto.INT64 if k=="class_ids" else TensorProto.FLOAT,list(a.shape)) for k,a in arrays.items()]
    nodes=[helper.make_node("Constant",[],[k],value=numpy_helper.from_array(a)) for k,a in arrays.items()]
    graph=helper.make_graph(nodes,"TEST_ONLY_STATIC_CONTRACT_FIXTURE",[helper.make_tensor_value_info("image",TensorProto.FLOAT,[1,3,32,32])],outputs)
    model=helper.make_model(graph,opset_imports=[helper.make_opsetid("",18)]); model.ir_version=10
    artifact=tmp_path/"test-only.onnx"; onnx.save(model,str(artifact))
    manifest={"schemaVersion":1,"format":"roadwatch-onnx-v1","name":"TEST-ONLY-NOT-A-DETECTOR","version":"test",
              "artifact":artifact.name,"sha256":hashlib.sha256(artifact.read_bytes()).hexdigest(),"license":"test fixture",
              "sourceUrl":"https://example.invalid/test-fixture","datasetManifestSha256":"0"*64,
              "trainedForRoadDamage":True,"classes":["pothole"],"inputSize":[32,32],"validationStatus":"experimental"}
    path=tmp_path/"manifest.json"; path.write_text(json.dumps(manifest))
    return path
