"""Validate COCO polygons and prepare leakage-resistant, reproducible group splits."""
import argparse
import hashlib
import json
from pathlib import Path
import random
import shutil
from .schema import CLASSES


def safe_image(root: Path, filename: str):
    path=(root/filename).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError("image_path_missing_or_outside_dataset")
    return path


def validate_dataset(coco, image_root: Path, license_manifest):
    if license_manifest.get("schemaVersion")!=1 or not license_manifest.get("sources"):
        raise ValueError("license_manifest_required")
    sources={s["id"]:s for s in license_manifest["sources"]}
    for source in sources.values():
        if not all(source.get(k) for k in ("id","url","license","rightsReviewedBy")) or "train" not in source.get("permittedUses",[]):
            raise ValueError("source_training_rights_unresolved")
    categories=sorted(coco.get("categories",[]),key=lambda c:c["id"])
    names=[c["name"] for c in categories]
    if not names or len(set(names))!=len(names) or not set(names).issubset(CLASSES):
        raise ValueError("supported_road_categories_required")
    if [c["id"] for c in categories]!=list(range(len(categories))):
        raise ValueError("category_ids_must_be_contiguous_zero_based")
    images=coco.get("images",[])
    by_id={im["id"]:im for im in images}
    if not images or len(images)!=len(by_id): raise ValueError("image_ids_must_be_unique")
    hashes={}
    for im in images:
        if not im.get("groupId") or im.get("sourceId") not in sources:
            raise ValueError("image_group_and_source_required")
        path=safe_image(image_root,im["file_name"])
        with path.open("rb") as stream: digest=hashlib.file_digest(stream,"sha256").hexdigest()
        if im.get("sha256")!=digest: raise ValueError("image_checksum_mismatch")
        if digest in hashes and hashes[digest]!=im["groupId"]: raise ValueError("duplicate_image_crosses_groups")
        hashes[digest]=im["groupId"]
        if im.get("width",0)<=0 or im.get("height",0)<=0: raise ValueError("image_dimensions_required")
        from PIL import Image
        with Image.open(path) as decoded:
            if decoded.size!=(im["width"],im["height"]): raise ValueError("annotation_image_dimensions_mismatch")
    annotations=coco.get("annotations",[]); annotation_ids=set()
    for ann in annotations:
        if ann["id"] in annotation_ids: raise ValueError("duplicate_annotation_id")
        annotation_ids.add(ann["id"])
        if ann["image_id"] not in by_id or ann["category_id"] not in range(len(names)):
            raise ValueError("invalid_annotation_reference")
        im=by_id[ann["image_id"]]
        box=ann.get("bbox",[])
        if len(box)!=4 or min(box)<0 or min(box[2:])<=0 or box[0]+box[2]>im["width"] or box[1]+box[3]>im["height"]:
            raise ValueError("invalid_annotation_bbox")
        segments=ann.get("segmentation")
        if not isinstance(segments,list) or not segments: raise ValueError("reviewed_polygon_masks_required")
        for polygon in segments:
            if not isinstance(polygon,list) or len(polygon)<6 or len(polygon)%2: raise ValueError("invalid_segmentation_polygon")
            for x,y in zip(polygon[::2],polygon[1::2]):
                if not 0<=x<=im["width"] or not 0<=y<=im["height"]: raise ValueError("polygon_outside_image")
    return {"images":len(images),"annotations":len(annotations),"groups":len({im["groupId"] for im in images}),"classes":names}


def prepare_splits(coco,image_root,license_manifest,output:Path,seed:int=42):
    summary=validate_dataset(coco,image_root,license_manifest)
    groups=sorted({im["groupId"] for im in coco["images"]})
    if len(groups)<3: raise ValueError("at_least_three_independent_groups_required")
    if output.exists(): raise ValueError("output_must_not_exist")
    random.Random(seed).shuffle(groups)
    ntest=max(1,round(.15*len(groups))); nvalid=max(1,round(.15*len(groups)))
    group_sets={"test":set(groups[:ntest]),"valid":set(groups[ntest:ntest+nvalid]),"train":set(groups[ntest+nvalid:])}
    output.mkdir(parents=True)
    for split,selected in group_sets.items():
        target=output/split; target.mkdir()
        images=[]
        for original in coco["images"]:
            if original["groupId"] not in selected: continue
            im=dict(original); source=safe_image(image_root,im["file_name"])
            im["file_name"]=f"{im['id']}{source.suffix.lower()}"
            shutil.copyfile(source,target/im["file_name"]); images.append(im)
        ids={im["id"] for im in images}
        subset={"images":images,"annotations":[a for a in coco["annotations"] if a["image_id"] in ids],"categories":coco["categories"]}
        (target/"_annotations.coco.json").write_text(json.dumps(subset,indent=2,allow_nan=False))
    (output/"license-manifest.json").write_text(json.dumps(license_manifest,indent=2))
    (output/"split-manifest.json").write_text(json.dumps({"schemaVersion":1,"seed":seed,"groupAssignments":{s:sorted(g) for s,g in group_sets.items()},"summary":summary},indent=2))
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("coco",type=Path); parser.add_argument("images",type=Path)
    parser.add_argument("--licenses",required=True,type=Path); parser.add_argument("--output",type=Path)
    parser.add_argument("--seed",type=int,default=42)
    args=parser.parse_args(); coco=json.loads(args.coco.read_text()); licenses=json.loads(args.licenses.read_text())
    result=prepare_splits(coco,args.images,licenses,args.output,args.seed) if args.output else validate_dataset(coco,args.images,licenses)
    print(json.dumps(result,indent=2))


if __name__=="__main__": main()
