"""Local RF-DETR-Seg Small training; requires reviewed data and explicit base artifact."""
import argparse
import hashlib
import json
from pathlib import Path
from .dataset import validate_dataset


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset",type=Path); parser.add_argument("--output",required=True,type=Path)
    parser.add_argument("--base-checkpoint",required=True,type=Path)
    parser.add_argument("--base-sha256",required=True)
    parser.add_argument("--epochs",type=int,default=50); parser.add_argument("--batch-size",type=int,default=2)
    parser.add_argument("--device",default="cpu"); parser.add_argument("--version",required=True)
    args=parser.parse_args()
    if args.epochs<1 or args.batch_size<1: parser.error("epochs and batch size must be positive")
    with args.base_checkpoint.open("rb") as stream:
        if hashlib.file_digest(stream,"sha256").hexdigest()!=args.base_sha256:
            raise ValueError("base_checkpoint_checksum_mismatch")
    license_path=args.dataset/"license-manifest.json"; licenses=json.loads(license_path.read_text())
    groups=set(); classes=None
    for split in ("train","valid","test"):
        data=json.loads((args.dataset/split/"_annotations.coco.json").read_text())
        summary=validate_dataset(data,args.dataset/split,licenses)
        current={im["groupId"] for im in data["images"]}
        if groups&current: raise ValueError("group_leakage_between_splits")
        groups|=current
        if classes is not None and classes!=summary["classes"]: raise ValueError("class_order_mismatch")
        classes=summary["classes"]
    from rfdetr import RFDETRSegSmall
    model=RFDETRSegSmall(pretrain_weights=str(args.base_checkpoint))
    args.output.mkdir(parents=True,exist_ok=False)
    model.train(dataset_dir=str(args.dataset),output_dir=str(args.output),epochs=args.epochs,batch_size=args.batch_size,
                device=args.device,wandb=False,tensorboard=False)
    checkpoint=args.output/"checkpoint_best_total.pth"
    if not checkpoint.is_file(): raise RuntimeError("training_did_not_produce_expected_checkpoint")
    with checkpoint.open("rb") as stream: digest=hashlib.file_digest(stream,"sha256").hexdigest()
    manifest={"schemaVersion":1,"format":"rfdetr-seg-small","name":"roadwatch-rfdetr-seg-small","version":args.version,
              "artifact":checkpoint.name,"sha256":digest,"license":"Apache-2.0; dataset rights in license-manifest.json",
              "sourceUrl":"https://github.com/roboflow/rf-detr","datasetManifestSha256":hashlib.sha256(license_path.read_bytes()).hexdigest(),
              "trainedForRoadDamage":True,"classes":classes}
    (args.output/"model-manifest.json").write_text(json.dumps(manifest,indent=2))
    (args.output/"training-run.json").write_text(json.dumps({"baseSha256":args.base_sha256,"epochs":args.epochs,"batchSize":args.batch_size,"version":args.version,"requiresIndependentAcceptance":True},indent=2))
    print("Training complete. Independent test/field acceptance is required before operational activation.")


if __name__=="__main__": main()
