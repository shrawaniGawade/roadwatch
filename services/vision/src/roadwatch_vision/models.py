"""Explicit artifact contracts. Never substitute generic COCO classes for road labels."""
import hashlib
import os
from pathlib import Path
from typing import Literal
import cv2
import numpy as np
from pydantic import Field, model_validator
from .schema import CLASSES, StrictModel


class ModelManifest(StrictModel):
    schemaVersion: Literal[1]
    format: Literal["roadwatch-onnx-v1", "rfdetr-seg-small", "rfdetr-onnx", "yolov8-onnx", "yolov8-seg-onnx"]
    name: str = Field(min_length=1,max_length=100)
    version: str = Field(min_length=1,max_length=100)
    artifact: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    license: str = Field(min_length=1,max_length=200)
    sourceUrl: str = Field(pattern=r"^https://")
    datasetManifestSha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    trainedForRoadDamage: Literal[True]
    classes: list[str] = Field(min_length=1,max_length=len(CLASSES))
    inputSize: list[int] = Field(default_factory=lambda:[640,640],min_length=2,max_length=2)
    mean: list[float] = Field(default_factory=lambda:[0,0,0],min_length=3,max_length=3)
    std: list[float] = Field(default_factory=lambda:[1,1,1],min_length=3,max_length=3)
    threshold: float = Field(default=.4,gt=0,lt=1)
    validationStatus: Literal["experimental","field_validated"] = "experimental"

    @model_validator(mode="after")
    def valid_contract(self):
        if len(set(self.classes))!=len(self.classes) or not set(self.classes).issubset(CLASSES):
            raise ValueError("manifest requires unique supported road classes")
        if any(not 32<=n<=2048 for n in self.inputSize) or any(s<=0 for s in self.std):
            raise ValueError("invalid model input shape or normalization")
        return self


def load_manifest(path: Path | None):
    if path is None or not path.is_file():
        raise ValueError("model_not_configured")
    if path.stat().st_size>65536:
        raise ValueError("model_manifest_too_large")
    manifest=ModelManifest.model_validate_json(path.read_text())
    artifact=(path.parent/manifest.artifact).resolve()
    if not artifact.is_relative_to(path.parent.resolve()) or not artifact.is_file():
        raise ValueError("model_artifact_missing")
    with artifact.open("rb") as stream:
        digest=hashlib.file_digest(stream,"sha256").hexdigest()
    if digest!=manifest.sha256:
        raise ValueError("model_checksum_mismatch")
    return manifest,artifact


def masks_to_detections(boxes,scores,class_ids,masks,manifest,image_shape):
    """Contract boxes are normalized XYXY; masks are probabilities in image space."""
    height,width=image_shape[:2]
    boxes=np.asarray(boxes); scores=np.asarray(scores); class_ids=np.asarray(class_ids); masks=np.asarray(masks)
    count=len(scores)
    if boxes.shape!=(count,4) or class_ids.shape!=(count,) or masks.ndim!=3 or masks.shape[0]!=count or count>1000:
        raise ValueError("incompatible_model_outputs")
    if not all(np.isfinite(x).all() for x in (boxes,scores,class_ids,masks)):
        raise ValueError("nonfinite_model_outputs")
    output=[]
    for idx in np.argsort(scores)[::-1][:100]:
        score=float(scores[idx])
        if score<manifest.threshold: continue
        class_id=int(class_ids[idx])
        if not 0<=score<=1 or class_ids[idx]!=class_id or not 0<=class_id<len(manifest.classes):
            raise ValueError("invalid_model_class_or_score")
        bbox=boxes[idx]
        if (bbox<0).any() or (bbox>1).any() or bbox[0]>=bbox[2] or bbox[1]>=bbox[3]:
            raise ValueError("invalid_model_bbox")
        mask=cv2.resize(masks[idx].astype(np.float32),(width,height),interpolation=cv2.INTER_LINEAR)>.5
        contours,hierarchy=cv2.findContours(mask.astype(np.uint8),cv2.RETR_CCOMP,cv2.CHAIN_APPROX_SIMPLE)
        if not contours: continue
        contour=max(contours,key=cv2.contourArea)
        if cv2.contourArea(contour)<4: continue
        # Bound JSON size; record that simplified boundaries are estimates.
        contour=cv2.approxPolyDP(contour,.5,True)
        if len(contour)>1000:
            contour=cv2.approxPolyDP(contour,2,True)
        if len(contour)>1000: raise ValueError("model_mask_too_complex")
        if len(contour)<3: continue
        output.append({"type":manifest.classes[class_id],"confidence":score,
                       "bbox":(bbox*np.array([width,height,width,height])).tolist(),
                       "mask":contour.reshape(-1,2).tolist(),
                       "geometryEligible":len(contours)==1})
    return output


class OnnxRoadModel:
    def __init__(self,manifest,artifact):
        import onnxruntime as ort
        options=ort.SessionOptions(); options.intra_op_num_threads=2; options.inter_op_num_threads=1
        self.session=ort.InferenceSession(str(artifact),sess_options=options,providers=["CPUExecutionProvider"])
        self.manifest=manifest
        inputs=self.session.get_inputs()
        if len(inputs)!=1 or inputs[0].type!="tensor(float)" or inputs[0].shape!=[1,3,*manifest.inputSize]:
            raise ValueError("onnx_input_contract_mismatch")
        self.input_name=inputs[0].name
        if {o.name for o in self.session.get_outputs()}!={"boxes","scores","class_ids","masks"}:
            raise ValueError("onnx_output_contract_mismatch")

    def predict(self,image):
        h,w=self.manifest.inputSize
        rgb=cv2.cvtColor(cv2.resize(image,(w,h)),cv2.COLOR_BGR2RGB).astype(np.float32)/255
        normalized=(rgb-np.array(self.manifest.mean,dtype=np.float32))/np.array(self.manifest.std,dtype=np.float32)
        tensor=normalized.transpose(2,0,1)[None].copy()
        result=self.session.run(["boxes","scores","class_ids","masks"],{self.input_name:tensor})
        return masks_to_detections(*result,self.manifest,image.shape)


class RFDetrRoadModel:
    def __init__(self,manifest,artifact):
        # Only operator-installed, checksummed local trained weights; no default model.
        from rfdetr import RFDETRSegSmall
        self.model=RFDETRSegSmall(pretrain_weights=str(artifact))
        if list(self.model.class_names)!=manifest.classes:
            raise ValueError("checkpoint_class_names_do_not_match_manifest")
        self.manifest=manifest

    def predict(self,image):
        from PIL import Image
        detection=self.model.predict(Image.fromarray(cv2.cvtColor(image,cv2.COLOR_BGR2RGB)),threshold=self.manifest.threshold)
        if detection.mask is None:
            raise ValueError("trained_model_did_not_return_masks")
        h,w=image.shape[:2]
        return masks_to_detections(detection.xyxy/np.array([w,h,w,h]),detection.confidence,
                                  detection.class_id,detection.mask,self.manifest,image.shape)


class RFDetrOnnxModel:
    """CPU-only RF-DETR box detector; boxes are not measured road footprints."""
    def __init__(self,manifest,artifact):
        import onnxruntime as ort
        options=ort.SessionOptions(); options.intra_op_num_threads=2; options.inter_op_num_threads=1
        self.session=ort.InferenceSession(str(artifact),sess_options=options,providers=["CPUExecutionProvider"])
        self.manifest=manifest
        inputs=self.session.get_inputs(); outputs={o.name:o for o in self.session.get_outputs()}
        if len(inputs)!=1 or inputs[0].type!="tensor(float)" or inputs[0].shape!=[1,3,*manifest.inputSize]:
            raise ValueError("rfdetr_input_contract_mismatch")
        if set(outputs)!={"dets","labels"} or outputs["dets"].shape[:1]!=[1] or outputs["labels"].shape[:1]!=[1]:
            raise ValueError("rfdetr_output_contract_mismatch")
        if outputs["dets"].shape[-1]!=4 or outputs["labels"].shape[-1]!=len(manifest.classes)+1:
            raise ValueError("rfdetr_class_or_box_count_mismatch")
        self.input_name=inputs[0].name

    def predict(self,image):
        height,width=image.shape[:2]; target_h,target_w=self.manifest.inputSize
        # RF-DETR export expects bilinear resize without antialiasing and ImageNet normalization.
        rgb=cv2.cvtColor(image,cv2.COLOR_BGR2RGB).astype(np.float32)/255
        resized=cv2.resize(rgb,(target_w,target_h),interpolation=cv2.INTER_LINEAR)
        mean=np.asarray(self.manifest.mean,dtype=np.float32)
        std=np.asarray(self.manifest.std,dtype=np.float32)
        tensor=((resized-mean)/std).transpose(2,0,1)[None].copy()
        boxes,logits=self.session.run(["dets","labels"],{self.input_name:tensor})
        classes=len(self.manifest.classes)
        if (boxes.ndim!=3 or logits.ndim!=3 or boxes.shape[0]!=1 or
            boxes.shape[2]!=4 or logits.shape!=(1,boxes.shape[1],classes+1) or
            boxes.shape[1]>1000 or not np.isfinite(boxes).all() or not np.isfinite(logits).all()):
            raise ValueError("invalid_rfdetr_output")
        # The final logit is background; RF-DETR ranks query/class pairs independently.
        scores=1/(1+np.exp(-np.clip(logits[0,:,:classes],-88,88)))
        ranked=np.argsort(scores.reshape(-1))[::-1][:min(boxes.shape[1],100)]
        result=[]
        for flat_index in ranked:
            query_id,class_id=divmod(int(flat_index),classes)
            score=float(scores[query_id,class_id])
            if score<self.manifest.threshold: break
            cx,cy,bw,bh=map(float,boxes[0,query_id])
            x1=max(0,min(width,(cx-bw/2)*width)); y1=max(0,min(height,(cy-bh/2)*height))
            x2=max(0,min(width,(cx+bw/2)*width)); y2=max(0,min(height,(cy+bh/2)*height))
            if x2<=x1 or y2<=y1: continue
            result.append({"type":self.manifest.classes[class_id],"confidence":score,
                           "bbox":[x1,y1,x2,y2],"mask":[],"geometryEligible":False,
                           "measurementReason":"box_only_model_no_measured_footprint"})
        return result


class YoloV8OnnxModel:
    """Independent raw YOLOv8 box decoder. No segmentation or metric-size claim."""
    def __init__(self,manifest,artifact):
        import onnxruntime as ort
        options=ort.SessionOptions(); options.intra_op_num_threads=2; options.inter_op_num_threads=1
        self.session=ort.InferenceSession(str(artifact),sess_options=options,providers=["CPUExecutionProvider"])
        self.manifest=manifest
        inputs=self.session.get_inputs(); outputs=self.session.get_outputs()
        if len(inputs)!=1 or inputs[0].type!="tensor(float)" or inputs[0].shape!=[1,3,*manifest.inputSize]:
            raise ValueError("yolov8_input_contract_mismatch")
        if len(outputs)!=1 or len(outputs[0].shape)!=3 or outputs[0].shape[:2]!=[1,4+len(manifest.classes)]:
            raise ValueError("yolov8_output_contract_mismatch_box_only_expected")
        self.input_name=inputs[0].name

    def predict(self,image):
        height,width=image.shape[:2]; target_h,target_w=self.manifest.inputSize
        scale=min(target_w/width,target_h/height)
        resized_w,resized_h=round(width*scale),round(height*scale)
        left=(target_w-resized_w)//2; top=(target_h-resized_h)//2
        canvas=np.full((target_h,target_w,3),114,dtype=np.uint8)
        canvas[top:top+resized_h,left:left+resized_w]=cv2.resize(image,(resized_w,resized_h))
        tensor=(cv2.cvtColor(canvas,cv2.COLOR_BGR2RGB).astype(np.float32)/255).transpose(2,0,1)[None].copy()
        raw=self.session.run(None,{self.input_name:tensor})[0]
        if raw.ndim!=3 or raw.shape[0]!=1 or raw.shape[1]!=4+len(self.manifest.classes) or raw.shape[2]>100000 or not np.isfinite(raw).all():
            raise ValueError("invalid_yolov8_output")
        rows=raw[0].T; boxes=[]; scores=[]; labels=[]
        for row in rows:
            class_id=int(np.argmax(row[4:])); score=float(row[4+class_id])
            if score<self.manifest.threshold: continue
            if score>1: raise ValueError("yolov8_logits_not_probabilities")
            cx,cy,bw,bh=map(float,row[:4])
            x1=max(0,(cx-bw/2-left)/scale); y1=max(0,(cy-bh/2-top)/scale)
            x2=min(width,(cx+bw/2-left)/scale); y2=min(height,(cy+bh/2-top)/scale)
            if x2<=x1 or y2<=y1: continue
            boxes.append([x1,y1,x2-x1,y2-y1]); scores.append(score); labels.append(class_id)
        result=[]
        # Class-specific suppression avoids deleting overlapping different classes.
        for class_id in sorted(set(labels)):
            indexes=[i for i,label in enumerate(labels) if label==class_id]
            kept=cv2.dnn.NMSBoxes([boxes[i] for i in indexes],[scores[i] for i in indexes],self.manifest.threshold,.5)
            for local in np.asarray(kept).reshape(-1):
                i=indexes[int(local)]; x,y,w,h=boxes[i]
                result.append({"type":self.manifest.classes[class_id],"confidence":scores[i],"bbox":[x,y,x+w,y+h],
                               "mask":[],"geometryEligible":False,"measurementReason":"box_only_model_no_measured_footprint"})
        return sorted(result,key=lambda d:d["confidence"],reverse=True)[:100]


class YoloV8SegOnnxModel:
    """Independent YOLOv8 prototype-mask decoder; source weights keep their license."""
    def __init__(self,manifest,artifact):
        import onnxruntime as ort
        options=ort.SessionOptions(); options.intra_op_num_threads=2; options.inter_op_num_threads=1
        self.session=ort.InferenceSession(str(artifact),sess_options=options,providers=["CPUExecutionProvider"])
        self.manifest=manifest; inputs=self.session.get_inputs(); outputs=self.session.get_outputs()
        if len(inputs)!=1 or inputs[0].type!="tensor(float)" or inputs[0].shape!=[1,3,*manifest.inputSize]:
            raise ValueError("yolov8_input_contract_mismatch")
        if len(outputs)!=2: raise ValueError("yolov8_seg_output_contract_mismatch")
        detection=[o for o in outputs if len(o.shape)==3]; prototypes=[o for o in outputs if len(o.shape)==4]
        if len(detection)!=1 or len(prototypes)!=1: raise ValueError("yolov8_seg_output_contract_mismatch")
        self.prototype_count=prototypes[0].shape[1]
        if not isinstance(self.prototype_count,int) or not 1<=self.prototype_count<=256 or detection[0].shape[:2]!=[1,4+len(manifest.classes)+self.prototype_count]:
            raise ValueError("yolov8_seg_class_or_mask_count_mismatch")
        self.input_name=inputs[0].name; self.output_names=[detection[0].name,prototypes[0].name]

    def predict(self,image):
        height,width=image.shape[:2]; th,tw=self.manifest.inputSize
        scale=min(tw/width,th/height); rw,rh=round(width*scale),round(height*scale)
        left=(tw-rw)//2; top=(th-rh)//2
        canvas=np.full((th,tw,3),114,dtype=np.uint8)
        canvas[top:top+rh,left:left+rw]=cv2.resize(image,(rw,rh))
        tensor=(cv2.cvtColor(canvas,cv2.COLOR_BGR2RGB).astype(np.float32)/255).transpose(2,0,1)[None].copy()
        raw,proto=self.session.run(self.output_names,{self.input_name:tensor})
        classes=len(self.manifest.classes)
        if raw.ndim!=3 or raw.shape[:2]!=(1,4+classes+self.prototype_count) or raw.shape[2]>100000 or proto.ndim!=4 or proto.shape[:2]!=(1,self.prototype_count):
            raise ValueError("yolov8_seg_runtime_shape_mismatch")
        if not np.isfinite(raw).all() or not np.isfinite(proto).all(): raise ValueError("nonfinite_model_outputs")
        rows=raw[0].T; candidates=[]
        for row in rows:
            label=int(np.argmax(row[4:4+classes])); score=float(row[4+label])
            if score<self.manifest.threshold: continue
            if score>1: raise ValueError("yolov8_logits_not_probabilities")
            cx,cy,bw,bh=map(float,row[:4])
            if bw<=0 or bh<=0: continue
            candidates.append((row,label,score,[cx-bw/2,cy-bh/2,bw,bh]))
        keep=[]
        for label in sorted({c[1] for c in candidates}):
            indexes=[i for i,c in enumerate(candidates) if c[1]==label]
            picked=cv2.dnn.NMSBoxes([candidates[i][3] for i in indexes],[candidates[i][2] for i in indexes],self.manifest.threshold,.5)
            keep.extend(indexes[int(i)] for i in np.asarray(picked).reshape(-1))
        keep=sorted(keep,key=lambda i:candidates[i][2],reverse=True)[:100]
        _,channels,ph,pw=proto.shape; result=[]
        for idx in keep:
            row,label,score,(x,y,bw,bh)=candidates[idx]
            x1=np.clip((x-left)/scale,0,width); y1=np.clip((y-top)/scale,0,height)
            x2=np.clip((x+bw-left)/scale,0,width); y2=np.clip((y+bh-top)/scale,0,height)
            if x2<=x1 or y2<=y1: continue
            logits=(row[4+classes:]@proto[0].reshape(channels,-1)).reshape(ph,pw)
            probabilities=1/(1+np.exp(-np.clip(logits,-30,30)))
            # Crop in prototype coordinates, then undo exactly the letterbox padding.
            grid_x=np.arange(pw)[None,:]; grid_y=np.arange(ph)[:,None]
            crop=(grid_x>=x*pw/tw)&(grid_x<(x+bw)*pw/tw)&(grid_y>=y*ph/th)&(grid_y<(y+bh)*ph/th)
            probabilities*=crop
            padded=cv2.resize(probabilities,(tw,th),interpolation=cv2.INTER_LINEAR)
            native=cv2.resize(padded[top:top+rh,left:left+rw],(width,height),interpolation=cv2.INTER_LINEAR)
            output=masks_to_detections(np.array([[x1/width,y1/height,x2/width,y2/height]]),np.array([score]),
                np.array([label]),native[None],self.manifest,image.shape)
            result.extend(output)
        return result


def load_model(path,allow_experimental=False):
    manifest,artifact=load_manifest(path)
    if manifest.validationStatus=="experimental" and (not allow_experimental or
        (os.getenv("NODE_ENV")=="production" and os.getenv("VISION_ALLOW_PRODUCTION_TRIAL")!="true")):
        raise ValueError("experimental_model_not_enabled")
    return {"roadwatch-onnx-v1":OnnxRoadModel,"rfdetr-seg-small":RFDetrRoadModel,
            "rfdetr-onnx":RFDetrOnnxModel,"yolov8-onnx":YoloV8OnnxModel,
            "yolov8-seg-onnx":YoloV8SegOnnxModel}[manifest.format](manifest,artifact)
