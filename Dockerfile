# true-shuffle — a single long-lived process, on purpose.
#
# Two properties of this app decide the whole shape of this file:
#
#   1. The watcher is an asyncio loop that keeps polling after a response has
#      been sent. That is what makes "close the tab, the run keeps going" true
#      on Spotify. It needs a process that stays alive between requests.
#   2. `runs.advance_lock()` is an in-process asyncio.Lock, and its docstring
#      calls the bug it prevents "the single nastiest bug class in this design":
#      a browser event and the watcher advancing the same run within
#      milliseconds and burning two cards for one song. That lock only holds
#      inside ONE process — so this image runs exactly one worker, and the
#      platform must run exactly one machine. See fly.toml.
# 3.11, because that is the interpreter the 271 tests actually pass on.
# A newer minor is probably fine and is deliberately not assumed.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The database lives on the mounted volume, not in the image: a redeploy
# replaces the image, and every connected account and every run would go with
# it otherwise.
ENV DB_PATH=/data/true_shuffle.db

EXPOSE 8000

# One worker. Not a throughput decision — a correctness one, see above.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
