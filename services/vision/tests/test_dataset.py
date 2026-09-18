import hashlib
import json
import pytest
from PIL import Image
from roadwatch_vision.dataset import prepare_splits,validate_dataset
from roadwatch_vision.evaluation import evaluate


def fixture_data(tmp_path):
    images=[]
    for index in range(6):
        path=tmp_path/f"{index}.png"; Image.new("RGB",(32,32),(index*30,20,30)).save(path)
        images.append({"id":index,"file_name":path.name,"width":32,"height":32,"groupId":f"road-{index//2}","sourceId":"local","sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    coco={"images":images,"categories":[{"id":0,"name":"pothole"}],"annotations":[{"id":i,"image_id":i,"category_id":0,"bbox":[2,2,10,10],"segmentation":[[2,2,12,2,12,12,2,12]]} for i in range(6)]}
    licenses={"schemaVersion":1,"sources":[{"id":"local","url":"https://example.invalid/local","license":"owned","rightsReviewedBy":"test","permittedUses":["train","evaluate"]}]}
    return coco,licenses


def test_group_split_never_leaks_frames(tmp_path):
    coco,licenses=fixture_data(tmp_path); output=tmp_path/"prepared"
    prepare_splits(coco,tmp_path,licenses,output)
    groups=[]
    for split in ("train","valid","test"):
        data=json.loads((output/split/"_annotations.coco.json").read_text())
        groups.append({im["groupId"] for im in data["images"]})
    assert all(groups) and not groups[0]&groups[1] and not groups[1]&groups[2] and not groups[0]&groups[2]


def test_unresolved_rights_and_tampered_image_rejected(tmp_path):
    coco,licenses=fixture_data(tmp_path)
    licenses["sources"][0]["permittedUses"]=[]
    with pytest.raises(ValueError,match="rights_unresolved"): validate_dataset(coco,tmp_path,licenses)
    licenses["sources"][0]["permittedUses"]=["train"]
    coco["images"][0]["sha256"]="a"*64
    with pytest.raises(ValueError,match="checksum_mismatch"): validate_dataset(coco,tmp_path,licenses)


def test_evaluation_counts_misses_and_duplicates(tmp_path):
    coco,_=fixture_data(tmp_path)
    predictions={i:[] for i in range(6)}
    pred={"type":"pothole","confidence":.9,"mask":[[2,2],[12,2],[12,12],[2,12]]}
    predictions[0]=[pred,pred]
    result=evaluate(coco,predictions)["classes"]["pothole"]
    assert (result["tp"],result["fp"],result["fn"])==(1,1,5)
    assert result["precision"]==.5
