# PowerFlix

A Flask web app that uses the [TMDB API](https://developer.themoviedb.org/docs/getting-started) for correct, current movie posters, backdrops, titles, cast, discovery, search, and recommendations. The browser talks only to this backend: the TMDB token stays in `.env`.

## Run locally

1. Create a TMDB account, then create a **Read Access Token** in its API settings.
2. Copy `.env.example` to `.env` and add the token.
3. Run:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000`.

## Publish it

Deploy this folder to Render, Railway, Fly.io, or any service that supports Python. Configure:

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app`
- Environment variable: `TMDB_API_TOKEN` (the token from TMDB)

The included `Procfile` is recognized by several hosts. Never commit `.env` or expose the token in browser JavaScript.

## Backend features

- Server-side TMDB proxy with timeouts and error handling.
- SQLite-backed per-device watchlist and community reviews.
- Input validation and parameterized SQL queries.
- Same-origin API routes, avoiding client-side token/CORS issues.

For a multi-user production release, replace the anonymous device ID with real authentication and move SQLite to managed Postgres.
