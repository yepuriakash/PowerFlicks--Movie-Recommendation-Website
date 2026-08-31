import os
import sqlite3
import threading
import time
from collections import OrderedDict
from contextlib import closing
from copy import deepcopy

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(APP_DIR, "powerflicks.db")
TMDB_BASE = "https://api.themoviedb.org/3"
TOKEN = os.getenv("TMDB_API_TOKEN", "")

# This is deliberately process-local: it keeps local development simple while
# bounding both the number and lifetime of cached TMDB payloads.
TMDB_CACHE_MAX_ITEMS = 256
TMDB_LIST_CACHE_TTL = 5 * 60
TMDB_DETAIL_CACHE_TTL = 30 * 60
TMDB_SEARCH_CACHE_TTL = 3 * 60
TMDB_STALE_TTL = 60 * 60
TMDB_TIMEOUT = 12
TMDB_MAX_ATTEMPTS = 3

_tmdb_cache = OrderedDict()
_tmdb_cache_lock = threading.RLock()
_tmdb_inflight = {}

app = Flask(__name__, static_folder="static")


def db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with closing(db()) as connection:
        connection.executescript("""
        CREATE TABLE IF NOT EXISTS watchlist (
          device_id TEXT NOT NULL,
          movie_id INTEGER NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (device_id, movie_id)
        );
        CREATE TABLE IF NOT EXISTS reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          movie_id INTEGER NOT NULL,
          device_id TEXT NOT NULL,
          author TEXT NOT NULL,
          rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
          comment TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        """)
        connection.commit()


def device_id():
    value = request.headers.get("X-PowerFlicks-Device", "").strip()
    if not value or len(value) > 128:
        return None
    return value


def _cache_key(path, params):
    """Build a stable key from every request value that can change a response."""
    return path, tuple(sorted((str(key), str(value)) for key, value in (params or {}).items()))


def _cached_tmdb_response(key, allow_stale=False):
    now = time.monotonic()
    with _tmdb_cache_lock:
        entry = _tmdb_cache.get(key)
        if not entry:
            return None
        if entry["expires_at"] >= now or (allow_stale and entry["stale_until"] >= now):
            _tmdb_cache.move_to_end(key)
            return deepcopy(entry["data"])
    return None


def _store_tmdb_response(key, data, ttl):
    now = time.monotonic()
    with _tmdb_cache_lock:
        _tmdb_cache[key] = {
            "data": deepcopy(data),
            "expires_at": now + ttl,
            "stale_until": now + ttl + TMDB_STALE_TTL,
        }
        _tmdb_cache.move_to_end(key)
        while len(_tmdb_cache) > TMDB_CACHE_MAX_ITEMS:
            _tmdb_cache.popitem(last=False)


def _is_temporary_tmdb_failure(error):
    response = getattr(error, "response", None)
    return response is None or response.status_code in {429, 502, 503, 504}


def _tmdb_unavailable_error():
    return jsonify(error="Movie service is temporarily unavailable. Please try again."), 502


def _request_tmdb(path, params):
    temporary_failure = False
    for attempt in range(TMDB_MAX_ATTEMPTS):
        try:
            response = requests.get(
                f"{TMDB_BASE}{path}", params=params,
                headers={"Authorization": f"Bearer {TOKEN}", "accept": "application/json"},
                timeout=TMDB_TIMEOUT,
            )
            response.raise_for_status()
            return response.json(), None, False
        except (requests.RequestException, ValueError) as error:
            temporary_failure = _is_temporary_tmdb_failure(error)
            if not temporary_failure or attempt == TMDB_MAX_ATTEMPTS - 1:
                break
            time.sleep(0.25 * (attempt + 1))
    return None, _tmdb_unavailable_error(), temporary_failure


def tmdb(path, params=None, cache_ttl=TMDB_LIST_CACHE_TTL):
    if not TOKEN:
        return None, (jsonify(error="TMDB is not configured. Add TMDB_API_TOKEN to .env."), 503)

    params = params or {}
    key = _cache_key(path, params)
    cached = _cached_tmdb_response(key)
    if cached is not None:
        app.logger.info("TMDB cache HIT: %s", path)
        return cached, None

    # A per-key event coalesces simultaneous cache misses without holding the
    # cache lock during the network request.
    with _tmdb_cache_lock:
        in_flight = _tmdb_inflight.get(key)
        if in_flight is None:
            in_flight = {"event": threading.Event(), "temporary_failure": False}
            _tmdb_inflight[key] = in_flight
            request_owner = True
        else:
            request_owner = False

    if not request_owner:
        app.logger.info("TMDB cache MISS (waiting for in-flight request): %s", path)
        completed = in_flight["event"].wait(TMDB_TIMEOUT * TMDB_MAX_ATTEMPTS + 2)
        cached = _cached_tmdb_response(key)
        if cached is not None:
            app.logger.info("TMDB cache HIT: %s", path)
            return cached, None
        stale = _cached_tmdb_response(key, allow_stale=True)
        if completed and in_flight["temporary_failure"] and stale is not None:
            # At this point the owner has completed but did not cache a fresh
            # response, so its temporary failure can safely share this fallback.
            app.logger.info("TMDB cache STALE FALLBACK: %s", path)
            return stale, None
        if not completed:
            app.logger.warning("TMDB cache in-flight wait timed out: %s", path)
        # The owner did not produce cacheable data, so preserve the normal
        # upstream error rather than issuing a second or recursive request.
        return None, _tmdb_unavailable_error()

    stale = _cached_tmdb_response(key, allow_stale=True)
    app.logger.info("TMDB cache MISS: %s", path)
    try:
        data, error, temporary_failure = _request_tmdb(path, params)
        if error:
            in_flight["temporary_failure"] = temporary_failure
            if temporary_failure and stale is not None:
                app.logger.info("TMDB cache STALE FALLBACK: %s", path)
                return stale, None
            return None, error
        _store_tmdb_response(key, data, cache_ttl)
        return data, None
    finally:
        with _tmdb_cache_lock:
            _tmdb_inflight.pop(key, None)
            in_flight["event"].set()


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/config")
def config():
    return jsonify(image_base="https://image.tmdb.org/t/p", configured=bool(TOKEN))


@app.get("/api/movies")
def movies():
    endpoint = request.args.get("list", "popular")
    allowed = {"popular": "/movie/popular", "top_rated": "/movie/top_rated", "now_playing": "/movie/now_playing", "upcoming": "/movie/upcoming"}
    if endpoint not in allowed:
        return jsonify(error="Unknown movie list."), 400
    page = min(max(request.args.get("page", 1, type=int), 1), 500)
    data, error = tmdb(allowed[endpoint], {"language": "en-US", "page": page}, TMDB_LIST_CACHE_TTL)
    return error or jsonify(data)


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify(results=[])
    data, error = tmdb("/search/movie", {"query": query, "include_adult": "false", "language": "en-US", "page": 1}, TMDB_SEARCH_CACHE_TTL)
    return error or jsonify(data)


@app.get("/api/movies/<int:movie_id>")
def movie_detail(movie_id):
    data, error = tmdb(f"/movie/{movie_id}", {"language": "en-US", "append_to_response": "videos,credits,similar"}, TMDB_DETAIL_CACHE_TTL)
    if error:
        return error
    with closing(db()) as connection:
        reviews = connection.execute("SELECT author, rating, comment, created_at FROM reviews WHERE movie_id=? ORDER BY id DESC", (movie_id,)).fetchall()
    data["powerflicks_reviews"] = [dict(row) for row in reviews]
    return jsonify(data)


@app.get("/api/movies/<int:movie_id>/recommendations")
def recommendations(movie_id):
    data, error = tmdb(f"/movie/{movie_id}/recommendations", {"language": "en-US", "page": 1})
    return error or jsonify(data)


@app.route("/api/watchlist", methods=["GET", "POST", "DELETE"])
def watchlist():
    user = device_id()
    if not user:
        return jsonify(error="A valid device identifier is required."), 400
    with closing(db()) as connection:
        if request.method == "GET":
            rows = connection.execute("SELECT movie_id FROM watchlist WHERE device_id=? ORDER BY created_at DESC", (user,)).fetchall()
            return jsonify(movie_ids=[row["movie_id"] for row in rows])
        body = request.get_json(silent=True) or {}
        movie_id = body.get("movie_id")
        if not isinstance(movie_id, int):
            return jsonify(error="movie_id must be an integer."), 400
        if request.method == "POST":
            connection.execute("INSERT OR IGNORE INTO watchlist(device_id, movie_id) VALUES (?, ?)", (user, movie_id))
        else:
            connection.execute("DELETE FROM watchlist WHERE device_id=? AND movie_id=?", (user, movie_id))
        connection.commit()
    return jsonify(ok=True)


@app.post("/api/movies/<int:movie_id>/reviews")
def post_review(movie_id):
    user = device_id()
    body = request.get_json(silent=True) or {}
    author, comment, rating = str(body.get("author", "")).strip(), str(body.get("comment", "")).strip(), body.get("rating")
    if not user or not author or not comment or not isinstance(rating, int) or not 1 <= rating <= 5:
        return jsonify(error="Provide a device ID, name, 1–5 rating, and comment."), 400
    if len(author) > 50 or len(comment) > 1000:
        return jsonify(error="Review is too long."), 400
    with closing(db()) as connection:
        connection.execute("INSERT INTO reviews(movie_id, device_id, author, rating, comment) VALUES (?, ?, ?, ?, ?)", (movie_id, user, author, rating, comment))
        connection.commit()
    return jsonify(ok=True), 201


init_db()

if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true")
