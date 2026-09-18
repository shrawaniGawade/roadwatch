"""Reproducible per-image mask matching, not a substitute for defect-level field tests."""
import argparse
import json
import math
from pathlib import Path
import cv2
import numpy as np
from .models import load_model
from .dataset import safe_image


def wilson(success,total):
    if not total: return None
    z=1.959963984540054; p=success/total
    center=(p+z*z/(2*total))/(1+z*z/total)
    half=z*math.sqrt(p*(1-p)/total+z*z/(4*total*total))/(1+z*z/total)
    return [max(0,center-half),min(1,center+half)]


def polygon_mask(polygons,height,width):
    mask=np.zeros((height,width),dtype=np.uint8)
    contours=[np.asarray(p,dtype=np.float32).reshape(-1,2).round().astype(np.int32) for p in polygons]
    cv2.fillPoly(mask,contours,1)
    return mask.astype(bool)


def evaluate(coco,predictions,iou_threshold=.5):
    categories={c["id"]:c["name"] for c in coco["categories"]}
    counts={name:{"tp":0,"fp":0,"fn":0} for name in categories.values()}
    images={im["id"]:im for im in coco["images"]}
    if set(predictions)!=set(images): raise ValueError("predictions_must_cover_every_test_image")
    for iid,im in images.items():
        width,height=im["width"],im["height"]
        if width*height>16_000_000: raise ValueError("evaluation_image_too_large")
        truths=[a for a in coco["annotations"] if a["image_id"]==iid]
        masks=[polygon_mask(a["segmentation"],height,width) for a in truths]
        matched=set()
        for pred in sorted(predictions[iid],key=lambda p:p["confidence"],reverse=True):
            name=pred["type"]
            if name not in counts: raise ValueError("unexpected_prediction_class")
            pmask=polygon_mask([np.asarray(pred["mask"]).reshape(-1).tolist()],height,width)
            options=[]
            for j,(ann,tmask) in enumerate(zip(truths,masks)):
                if j in matched or categories[ann["category_id"]]!=name: continue
                union=np.count_nonzero(pmask|tmask)
                options.append((np.count_nonzero(pmask&tmask)/union if union else 0,j))
            score,index=max(options,default=(0,-1))
            if score>=iou_threshold and index>=0:
                counts[name]["tp"]+=1; matched.add(index)
            else: counts[name]["fp"]+=1
        for j,ann in enumerate(truths):
            if j not in matched: counts[categories[ann["category_id"]]]["fn"]+=1
    for values in counts.values():
        tp,fp,fn=values["tp"],values["fp"],values["fn"]
        values.update(precision=tp/(tp+fp) if tp+fp else None,recall=tp/(tp+fn) if tp+fn else None,
                      precisionCI95=wilson(tp,tp+fp),recallCI95=wilson(tp,tp+fn))
    return {"metric":"per_image_instance_mask_iou","iouThreshold":iou_threshold,"images":len(images),"classes":counts,
            "limitation":"Adjacent frames are correlated. Field defect recall, false assets per lane-km and metric accuracy require independent survey evaluation."}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("split",type=Path); parser.add_argument("--model",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True); parser.add_argument("--iou",type=float,default=.5)
    args=parser.parse_args()
    if not 0<args.iou<=1: parser.error("IoU must be in (0,1]")
    coco=json.loads((args.split/"_annotations.coco.json").read_text()); model=load_model(args.model,allow_experimental=True)
    predictions={}
    for im in coco["images"]:
        image=cv2.imread(str(safe_image(args.split,im["file_name"])))
        if image is None: raise ValueError("invalid_test_image")
        predictions[im["id"]]=model.predict(image)
    result=evaluate(coco,predictions,args.iou)
    result["modelSha256"]=model.manifest.sha256
    args.output.write_text(json.dumps(result,indent=2,allow_nan=False))
    print(json.dumps(result,indent=2))


if __name__=="__main__": main()
