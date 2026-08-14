import os
import sqlite3
from contextlib import closing

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

load_dotenv()

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(APP_DIR, "PowerFlicks.db")
TMDB_BASE = "https://api.themoviedb.org/3"
TOKEN = os.getenv("TMDB_API_TOKEN", "")

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


def tmdb(path, params=None):
    if not TOKEN:
        return None, (jsonify(error="TMDB is not configured. Add TMDB_API_TOKEN to .env."), 503)
    try:
        response = requests.get(
            f"{TMDB_BASE}{path}", params=params or {},
            headers={"Authorization": f"Bearer {TOKEN}", "accept": "application/json"}, timeout=12,
        )
        response.raise_for_status()
        return response.json(), None
    except requests.RequestException:
        return None, (jsonify(error="Movie service is temporarily unavailable. Please try again."), 502)


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
    data, error = tmdb(allowed[endpoint], {"language": "en-US", "page": page})
    return error or jsonify(data)


@app.get("/api/search")
def search():
    query = request.args.get("q", "").strip()
    if not query:
        return jsonify(results=[])
    data, error = tmdb("/search/movie", {"query": query, "include_adult": "false", "language": "en-US", "page": 1})
    return error or jsonify(data)


@app.get("/api/movies/<int:movie_id>")
def movie_detail(movie_id):
    data, error = tmdb(f"/movie/{movie_id}", {"language": "en-US", "append_to_response": "videos,credits,similar"})
    if error:
        return error
    with closing(db()) as connection:
        reviews = connection.execute("SELECT author, rating, comment, created_at FROM reviews WHERE movie_id=? ORDER BY id DESC", (movie_id,)).fetchall()
    data["PowerFlicks_reviews"] = [dict(row) for row in reviews]
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
