from types import SimpleNamespace
import numpy as np
import pytest
from roadwatch_vision.models import YoloV8SegOnnxModel


def test_prototype_mask_removes_letterbox_and_preserves_class():
    # Analytic tensor test, independent of any learned detection performance.
    row=np.zeros((1,37,1),np.float32)
    row[0,:5,0]=[320,320,200,100,.9]; row[0,5,0]=1
    proto=np.zeros((1,32,160,160),np.float32); proto[0,0]=10
    model=object.__new__(YoloV8SegOnnxModel)
    model.prototype_count=32; model.input_name="images"; model.output_names=["output0","output1"]
    model.manifest=SimpleNamespace(inputSize=[640,640],classes=["pothole"],threshold=.4)
    class Session:
        def run(self,names,feed):
            assert feed["images"].shape==(1,3,640,640)
            return row,proto
    model.session=Session()
    result=model.predict(np.zeros((320,640,3),np.uint8))
    assert len(result)==1
    detection=result[0]
    assert detection["bbox"]==pytest.approx([220,110,420,210])
    polygon=np.asarray(detection["mask"])
    assert polygon[:,0].min()==pytest.approx(220,abs=4)
    assert polygon[:,1].min()==pytest.approx(110,abs=4)
    assert polygon[:,0].max()==pytest.approx(420,abs=4)
    assert polygon[:,1].max()==pytest.approx(210,abs=4)
    assert detection["geometryEligible"]
