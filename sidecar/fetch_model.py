"""Докачка весов с ретраями: прокси рвёт длинные соединения, resume идёт по .incomplete."""
import os, sys, time
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
from huggingface_hub import snapshot_download

REPO = sys.argv[1] if len(sys.argv) > 1 else "mobiuslabsgmbh/faster-whisper-large-v3-turbo"
for attempt in range(1, 21):
    try:
        p = snapshot_download(REPO, max_workers=2)
        print(f"DONE {p}", flush=True)
        break
    except Exception as e:
        print(f"attempt {attempt} failed: {type(e).__name__}: {str(e)[:160]}", flush=True)
        time.sleep(3)
else:
    print("GIVE UP", flush=True); sys.exit(1)
