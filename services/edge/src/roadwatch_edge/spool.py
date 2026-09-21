import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid


class SpoolFull(RuntimeError): pass


def fsync_directory(path):
    fd=os.open(path,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def atomic_write(path:Path,data:bytes):
    temp=path.with_suffix(path.suffix+".part")
    with temp.open("xb") as stream:
        os.chmod(temp,0o600); stream.write(data); stream.flush(); os.fsync(stream.fileno())
    os.replace(temp,path); fsync_directory(path.parent)


class Spool:
    def __init__(self,path:Path,max_bytes=2*1024**3,min_free_bytes=128*1024**2):
        self.path=path.resolve(); self.path.mkdir(parents=True,exist_ok=True); os.chmod(self.path,0o700)
        self.database=self.path/"spool.sqlite3"; self.max_bytes=max_bytes; self.min_free_bytes=min_free_bytes
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS chunks (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
                metadata TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                next_retry REAL NOT NULL DEFAULT 0, lease_until REAL NOT NULL DEFAULT 0,
                error TEXT, receipt TEXT, created_at REAL NOT NULL, acknowledged_at REAL)""")
        os.chmod(self.database,0o600)

    def connect(self):
        db=sqlite3.connect(self.database,timeout=10)
        db.row_factory=sqlite3.Row; db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA synchronous=FULL")
        return db

    def disk_bytes(self):
        return sum(p.stat().st_size for p in self.path.rglob("*") if p.is_file())

    def add(self,data:bytes,metadata:dict):
        if not data or len(data)>32*1024*1024: raise ValueError("capture_size_out_of_bounds")
        if not all(metadata.get(k) for k in ("surveyId","capturedAt")): raise ValueError("survey_and_capture_time_required")
        metadata_bytes=json.dumps(metadata,allow_nan=False).encode()
        if len(metadata_bytes)>262144: raise ValueError("capture_metadata_too_large")
        # Serialize capacity checks and capture finalization across collector processes.
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if self.disk_bytes()+len(data)+len(metadata_bytes)*2+32768>self.max_bytes or shutil.disk_usage(self.path).free-len(data)<self.min_free_bytes:
                raise SpoolFull("spool_capacity_reached_capture_stopped_no_unacknowledged_deletion")
            identity=str(uuid.uuid4()); filename=identity+".jpg"
            manifest={"id":identity,"filename":filename,"sha256":hashlib.sha256(data).hexdigest(),"bytes":len(data),
                      "metadata":metadata,"created_at":time.time()}
            # Ordering: durable media -> durable manifest -> committed SQLite record.
            # Recovery can adopt the manifest if power dies before the SQL commit.
            atomic_write(self.path/filename,data)
            atomic_write(self.path/(identity+".json"),json.dumps(manifest,allow_nan=False).encode())
            self._insert(db,manifest)
        return identity

    @staticmethod
    def _insert(db,manifest):
        db.execute("INSERT OR IGNORE INTO chunks(id,filename,sha256,bytes,metadata,created_at) VALUES (?,?,?,?,?,?)",
                   (manifest["id"],manifest["filename"],manifest["sha256"],manifest["bytes"],json.dumps(manifest["metadata"]),manifest["created_at"]))

    def recover(self):
        report={"adopted":0,"quarantined":0,"interrupted":0}
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            report["interrupted"]=db.execute("UPDATE chunks SET status='pending',lease_until=0 WHERE status='uploading' AND lease_until<?",(time.time(),)).rowcount
            for file in self.path.glob("*.json"):
                try:
                    # Manifest includes the bounded metadata and its envelope.
                    if file.stat().st_size>262144+4096: raise ValueError()
                    m=json.loads(file.read_text())
                    if not re.fullmatch(r"[a-f0-9-]{36}",m["id"]) or m["filename"]!=m["id"]+".jpg" or file.name!=m["id"]+".json": raise ValueError()
                    existing=db.execute("SELECT status FROM chunks WHERE id=?",(m["id"],)).fetchone()
                    if existing:
                        if existing["status"]=="acknowledged":
                            (self.path/m["filename"]).unlink(missing_ok=True); file.unlink(missing_ok=True)
                        continue
                    media=self.path/m["filename"]
                    if not media.is_file() or media.stat().st_size!=m["bytes"]: raise ValueError()
                    with media.open("rb") as stream:
                        if hashlib.file_digest(stream,"sha256").hexdigest()!=m["sha256"]: raise ValueError()
                    self._insert(db,m); report["adopted"]+=1
                except (ValueError,KeyError,OSError,TypeError):
                    quarantine=self.path/"quarantine"; quarantine.mkdir(exist_ok=True)
                    os.replace(file,quarantine/(file.name+".invalid")); report["quarantined"]+=1
            # Incomplete writes have no accepted manifest. Preserve them for diagnosis.
            for part in self.path.glob("*.part"):
                quarantine=self.path/"quarantine"; quarantine.mkdir(exist_ok=True)
                os.replace(part,quarantine/(part.name+".incomplete")); report["quarantined"]+=1
            for image in self.path.glob("*.jpg"):
                if not (self.path/(image.stem+".json")).exists() and not db.execute("SELECT 1 FROM chunks WHERE filename=?",(image.name,)).fetchone():
                    quarantine=self.path/"quarantine"; quarantine.mkdir(exist_ok=True)
                    os.replace(image,quarantine/(image.name+".orphan")); report["quarantined"]+=1
        return report

    def claim(self,lease_seconds=120):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            now=time.time()
            db.execute("UPDATE chunks SET status='pending',lease_until=0 WHERE status='uploading' AND lease_until<?",(now,))
            row=db.execute("SELECT * FROM chunks WHERE status='pending' AND next_retry<=? ORDER BY created_at LIMIT 1",(now,)).fetchone()
            if not row: return None
            db.execute("UPDATE chunks SET status='uploading',lease_until=?,attempts=attempts+1 WHERE id=?",(now+lease_seconds,row["id"]))
            chunk=dict(row); chunk["attempts"]+=1; chunk["metadata"]=json.loads(chunk["metadata"])
            return chunk

    def retry(self,identity,error,retryable=True):
        with self.connect() as db:
            row=db.execute("SELECT attempts FROM chunks WHERE id=?",(identity,)).fetchone()
            if not row: raise ValueError("unknown_chunk")
            attempts=row[0]
            status="pending" if retryable and attempts<20 else "blocked"
            delay=min(300,2**min(attempts,8))
            db.execute("UPDATE chunks SET status=?,next_retry=?,lease_until=0,error=? WHERE id=?",
                       (status,time.time()+delay,error[:100],identity))

    def acknowledge(self,identity,receipt):
        with self.connect() as db:
            row=db.execute("SELECT filename FROM chunks WHERE id=?",(identity,)).fetchone()
            if not row: raise ValueError("unknown_chunk")
            db.execute("UPDATE chunks SET status='acknowledged',acknowledged_at=?,lease_until=0,receipt=?,error=NULL WHERE id=?",
                       (time.time(),json.dumps(receipt)[:65536],identity))
        # A crash after commit leaves redundant bytes, never an unrecorded acknowledgement.
        (self.path/row[0]).unlink(missing_ok=True); (self.path/(identity+".json")).unlink(missing_ok=True)
        fsync_directory(self.path)

    def retry_blocked(self):
        with self.connect() as db:
            return db.execute("UPDATE chunks SET status='pending',attempts=0,next_retry=0,error=NULL WHERE status='blocked'").rowcount

    def status(self):
        with self.connect() as db:
            counts={r[0]:r[1] for r in db.execute("SELECT status,COUNT(*) FROM chunks GROUP BY status")}
        return {"counts":counts,"diskBytes":self.disk_bytes(),"maxBytes":self.max_bytes,
                "backlog":sum(counts.get(k,0) for k in ("pending","uploading","blocked"))}
