import datetime
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

# ============================================================================
# CACHE CONFIGURATION
# ============================================================================

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


# ============================================================================
# DATABASE
# ============================================================================

def db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    with closing(db()) as connection:
        connection.executescript(
            """
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
            """
        )

        connection.commit()


# ============================================================================
# DEVICE IDENTIFICATION
# ============================================================================

def device_id():
    value = request.headers.get(
        "X-PowerFlicks-Device",
        ""
    ).strip()

    if not value or len(value) > 128:
        return None

    return value


# ============================================================================
# TMDB CACHE HELPERS
# ============================================================================

def _cache_key(path, params):
    """
    Build a stable key from every request value
    that can change a response.
    """
    return (
        path,
        tuple(
            sorted(
                (
                    str(key),
                    str(value)
                )
                for key, value in (params or {}).items()
            )
        )
    )


def _cached_tmdb_response(key, allow_stale=False):
    now = time.monotonic()

    with _tmdb_cache_lock:
        entry = _tmdb_cache.get(key)

        if not entry:
            return None

        if (
            entry["expires_at"] >= now
            or (
                allow_stale
                and entry["stale_until"] >= now
            )
        ):
            _tmdb_cache.move_to_end(key)
            return deepcopy(entry["data"])

    return None


def _store_tmdb_response(key, data, ttl):
    now = time.monotonic()

    with _tmdb_cache_lock:
        _tmdb_cache[key] = {
            "data": deepcopy(data),
            "expires_at": now + ttl,
            "stale_until": (
                now
                + ttl
                + TMDB_STALE_TTL
            ),
        }

        _tmdb_cache.move_to_end(key)

        while len(_tmdb_cache) > TMDB_CACHE_MAX_ITEMS:
            _tmdb_cache.popitem(last=False)


def _is_temporary_tmdb_failure(error):
    response = getattr(error, "response", None)

    return (
        response is None
        or response.status_code in {
            429,
            502,
            503,
            504
        }
    )


def _tmdb_unavailable_error():
    return (
        jsonify(
            error=(
                "Movie service is temporarily unavailable. "
                "Please try again."
            )
        ),
        502,
    )


# ============================================================================
# TMDB REQUEST
# ============================================================================

def _request_tmdb(path, params):
    temporary_failure = False

    for attempt in range(TMDB_MAX_ATTEMPTS):
        try:
            response = requests.get(
                f"{TMDB_BASE}{path}",
                params=params,
                headers={
                    "Authorization": f"Bearer {TOKEN}",
                    "accept": "application/json",
                },
                timeout=TMDB_TIMEOUT,
            )

            response.raise_for_status()

            return response.json(), None, False

        except (
            requests.RequestException,
            ValueError
        ) as error:

            temporary_failure = (
                _is_temporary_tmdb_failure(error)
            )

            if (
                not temporary_failure
                or attempt ==
                TMDB_MAX_ATTEMPTS - 1
            ):
                break

            time.sleep(
                0.25 * (attempt + 1)
            )

    return (
        None,
        _tmdb_unavailable_error(),
        temporary_failure,
    )


def tmdb(
    path,
    params=None,
    cache_ttl=TMDB_LIST_CACHE_TTL
):
    if not TOKEN:
        return (
            None,
            (
                jsonify(
                    error=(
                        "TMDB is not configured. "
                        "Add TMDB_API_TOKEN to .env."
                    )
                ),
                503,
            ),
        )

    params = params or {}

    key = _cache_key(
        path,
        params
    )

    # ------------------------------------------------------------------------
    # NORMAL CACHE
    # ------------------------------------------------------------------------

    cached = _cached_tmdb_response(key)

    if cached is not None:
        app.logger.info(
            "TMDB cache HIT: %s",
            path
        )

        return cached, None

    # ------------------------------------------------------------------------
    # IN-FLIGHT REQUEST DEDUPLICATION
    # ------------------------------------------------------------------------

    with _tmdb_cache_lock:
        in_flight = _tmdb_inflight.get(key)

        if in_flight is None:
            in_flight = {
                "event": threading.Event(),
                "temporary_failure": False,
            }

            _tmdb_inflight[key] = in_flight

            request_owner = True

        else:
            request_owner = False

    # ------------------------------------------------------------------------
    # WAIT FOR EXISTING REQUEST
    # ------------------------------------------------------------------------

    if not request_owner:
        app.logger.info(
            "TMDB cache MISS "
            "(waiting for in-flight request): %s",
            path
        )

        completed = in_flight["event"].wait(
            TMDB_TIMEOUT * TMDB_MAX_ATTEMPTS + 2
        )

        cached = _cached_tmdb_response(key)

        if cached is not None:
            app.logger.info(
                "TMDB cache HIT: %s",
                path
            )

            return cached, None

        stale = _cached_tmdb_response(
            key,
            allow_stale=True
        )

        if (
            completed
            and in_flight["temporary_failure"]
            and stale is not None
        ):
            app.logger.info(
                "TMDB cache STALE FALLBACK: %s",
                path
            )

            return stale, None

        if not completed:
            app.logger.warning(
                "TMDB cache in-flight wait timed out: %s",
                path
            )

        return (
            None,
            _tmdb_unavailable_error()
        )

    # ------------------------------------------------------------------------
    # OWNER MAKES THE TMDB REQUEST
    # ------------------------------------------------------------------------

    stale = _cached_tmdb_response(
        key,
        allow_stale=True
    )

    app.logger.info(
        "TMDB cache MISS: %s",
        path
    )

    try:
        data, error, temporary_failure = (
            _request_tmdb(
                path,
                params
            )
        )

        if error:
            in_flight[
                "temporary_failure"
            ] = temporary_failure

            if (
                temporary_failure
                and stale is not None
            ):
                app.logger.info(
                    "TMDB cache STALE FALLBACK: %s",
                    path
                )

                return stale, None

            return None, error

        _store_tmdb_response(
            key,
            data,
            cache_ttl
        )

        return data, None

    finally:
        with _tmdb_cache_lock:
            _tmdb_inflight.pop(
                key,
                None
            )

            in_flight[
                "event"
            ].set()


# ============================================================================
# CORE APPLICATION ROUTES
# ============================================================================

@app.get("/")
def index():
    return send_from_directory(
        app.static_folder,
        "index.html"
    )


@app.get("/api/config")
def config():
    return jsonify(
        image_base="https://image.tmdb.org/t/p",
        configured=bool(TOKEN)
    )


@app.get("/api/movies")
def movies():
    endpoint = request.args.get(
        "list",
        "popular"
    )

    allowed = {
        "popular": "/movie/popular",
        "top_rated": "/movie/top_rated",
        "now_playing": "/movie/now_playing",
        "upcoming": "/movie/upcoming",
    }

    if endpoint not in allowed:
        return jsonify(
            error="Unknown movie list."
        ), 400

    page = min(
        max(
            request.args.get(
                "page",
                1,
                type=int
            ),
            1
        ),
        500
    )

    data, error = tmdb(
        allowed[endpoint],
        {
            "language": "en-US",
            "page": page,
        },
        TMDB_LIST_CACHE_TTL
    )

    return error or jsonify(data)


@app.get("/api/search")
def search():
    query = request.args.get(
        "q",
        ""
    ).strip()

    if not query:
        return jsonify(
            results=[]
        )

    data, error = tmdb(
        "/search/movie",
        {
            "query": query,
            "include_adult": "false",
            "language": "en-US",
            "page": 1,
        },
        TMDB_SEARCH_CACHE_TTL
    )

    return error or jsonify(data)


# ============================================================================
# NEW ENHANCEMENTS:
# MULTI-SEARCH, PERSON PROFILES & SPOTLIGHT
# ============================================================================

@app.get("/api/search/multi")
def search_multi():
    query = request.args.get(
        "q",
        ""
    ).strip()

    if not query:
        return jsonify(
            results=[]
        )

    data, error = tmdb(
        "/search/multi",
        {
            "query": query,
            "include_adult": "false",
            "language": "en-US",
            "page": 1,
        },
        TMDB_SEARCH_CACHE_TTL
    )

    return error or jsonify(data)


@app.get("/api/person/<int:person_id>")
def get_person(person_id):
    """
    Retrieve biography, birth details,
    and full filmography in one request.
    """
    data, error = tmdb(
        f"/person/{person_id}",
        {
            "language": "en-US",
            "append_to_response": "combined_credits",
        },
        TMDB_DETAIL_CACHE_TTL
    )

    return error or jsonify(data)


@app.get("/api/spotlight/birthday")
def get_birthday_spotlight():
    now = datetime.datetime.now()

    month = now.month
    day = now.day

    # ------------------------------------------------------------------------
    # GET POPULAR PEOPLE FROM TMDB
    # ------------------------------------------------------------------------

    data, error = tmdb(
        "/person/popular",
        {
            "language": "en-US",
            "page": 1,
        },
        TMDB_LIST_CACHE_TTL
    )

    if error:
        return error

    candidates = data.get(
        "results",
        []
    )

    selected_person = None

    # ------------------------------------------------------------------------
    # LOOK THROUGH POPULAR PEOPLE FOR
    # A NOTABLE INDIAN CINEMA PERSONALITY
    # ------------------------------------------------------------------------

    for person in candidates:

        # Skip people with very low popularity
        if person.get(
            "popularity",
            0
        ) < 5.0:
            continue

        person_id = person.get("id")

        if not person_id:
            continue

        # Get full person details
        p_data, p_error = tmdb(
            f"/person/{person_id}",
            {
                "language": "en-US"
            },
            TMDB_DETAIL_CACHE_TTL
        )

        if p_error or not p_data:
            continue

        birthday = p_data.get(
            "birthday"
        )

        # Must have a birthday
        if not birthday:
            continue

        try:
            bday = datetime.datetime.strptime(
                birthday,
                "%Y-%m-%d"
            )

            # Birthday must be today
            if (
                bday.month != month
                or bday.day != day
            ):
                continue

        except ValueError:
            continue

        # --------------------------------------------------------------------
        # CHECK BIRTHPLACE FOR INDIAN RELEVANCE
        # --------------------------------------------------------------------

        place = (
            p_data.get(
                "place_of_birth"
            )
            or ""
        ).lower()

        # Indian locations / regions
        indian_locations = [
            "india",
            "mumbai",
            "bombay",
            "delhi",
            "new delhi",
            "hyderabad",
            "telangana",
            "andhra",
            "chennai",
            "tamil nadu",
            "karnataka",
            "kerala",
            "kolkata",
            "west bengal",
            "punjab",
            "maharashtra",
            "uttar pradesh",
            "bihar",
            "rajasthan",
            "gujarat",
            "odisha",
            "assam",
            "jharkhand",
            "madhya pradesh",
            "chhattisgarh",
        ]

        is_indian = any(
            location in place
            for location in indian_locations
        )

        if not is_indian:
            continue

        # We found a valid Indian cinema personality
        selected_person = p_data
        break

    # ------------------------------------------------------------------------
    # NO NOTABLE INDIAN BIRTHDAY TODAY
    # ------------------------------------------------------------------------

    if not selected_person:
        return jsonify({
            "spotlight": None
        }), 200

    # ------------------------------------------------------------------------
    # FETCH MOVIE / TV CREDITS
    # ------------------------------------------------------------------------

    credits, credit_error = tmdb(
        f"/person/{selected_person['id']}/combined_credits",
        {
            "language": "en-US"
        },
        TMDB_DETAIL_CACHE_TTL
    )

    if not credit_error:
        selected_person[
            "combined_credits"
        ] = credits

    return jsonify({
        "spotlight": selected_person
    }), 200


# ============================================================================
# MOVIE DETAILS & REVIEWS
# ============================================================================

@app.get("/api/movies/<int:movie_id>")
def movie_detail(movie_id):
    data, error = tmdb(
        f"/movie/{movie_id}",
        {
            "language": "en-US",
            "append_to_response": (
                "videos,credits,similar"
            ),
        },
        TMDB_DETAIL_CACHE_TTL
    )

    if error:
        return error

    with closing(db()) as connection:
        reviews = connection.execute(
            """
            SELECT
                author,
                rating,
                comment,
                created_at
            FROM reviews
            WHERE movie_id=?
            ORDER BY id DESC
            """,
            (movie_id,)
        ).fetchall()

    data[
        "powerflicks_reviews"
    ] = [
        dict(row)
        for row in reviews
    ]

    return jsonify(data)


@app.get(
    "/api/movies/<int:movie_id>/recommendations"
)
def recommendations(movie_id):
    data, error = tmdb(
        f"/movie/{movie_id}/recommendations",
        {
            "language": "en-US",
            "page": 1,
        }
    )

    return error or jsonify(data)


# ============================================================================
# WATCHLIST
# ============================================================================

@app.route(
    "/api/watchlist",
    methods=[
        "GET",
        "POST",
        "DELETE"
    ]
)
def watchlist():
    user = device_id()

    if not user:
        return jsonify(
            error=(
                "A valid device identifier "
                "is required."
            )
        ), 400

    with closing(db()) as connection:

        # --------------------------------------------------------------------
        # GET WATCHLIST
        # --------------------------------------------------------------------

        if request.method == "GET":
            rows = connection.execute(
                """
                SELECT movie_id
                FROM watchlist
                WHERE device_id=?
                ORDER BY created_at DESC
                """,
                (user,)
            ).fetchall()

            return jsonify(
                movie_ids=[
                    row["movie_id"]
                    for row in rows
                ]
            )

        # --------------------------------------------------------------------
        # ADD / REMOVE MOVIE
        # --------------------------------------------------------------------

        body = request.get_json(
            silent=True
        ) or {}

        movie_id = body.get(
            "movie_id"
        )

        if not isinstance(
            movie_id,
            int
        ):
            return jsonify(
                error=(
                    "movie_id must be "
                    "an integer."
                )
            ), 400

        if request.method == "POST":

            connection.execute(
                """
                INSERT OR IGNORE INTO watchlist(
                    device_id,
                    movie_id
                )
                VALUES (?, ?)
                """,
                (
                    user,
                    movie_id
                )
            )

        else:

            connection.execute(
                """
                DELETE FROM watchlist
                WHERE device_id=?
                AND movie_id=?
                """,
                (
                    user,
                    movie_id
                )
            )

        connection.commit()

        return jsonify(
            ok=True
        )


# ============================================================================
# REVIEWS
# ============================================================================

@app.post(
    "/api/movies/<int:movie_id>/reviews"
)
def post_review(movie_id):
    user = device_id()

    body = request.get_json(
        silent=True
    ) or {}

    author = str(
        body.get(
            "author",
            ""
        )
    ).strip()

    comment = str(
        body.get(
            "comment",
            ""
        )
    ).strip()

    rating = body.get(
        "rating"
    )

    if (
        not user
        or not author
        or not comment
        or not isinstance(
            rating,
            int
        )
        or not 1 <= rating <= 5
    ):
        return jsonify(
            error=(
                "Provide a device ID, "
                "name, 1–5 rating, "
                "and comment."
            )
        ), 400

    if (
        len(author) > 50
        or len(comment) > 1000
    ):
        return jsonify(
            error="Review is too long."
        ), 400

    with closing(db()) as connection:
        connection.execute(
            """
            INSERT INTO reviews(
                movie_id,
                device_id,
                author,
                rating,
                comment
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                movie_id,
                user,
                author,
                rating,
                comment
            )
        )

        connection.commit()

    return jsonify(
        ok=True
    ), 201


# ============================================================================
# INITIALIZE DATABASE
# ============================================================================

init_db()


# ============================================================================
# RUN POWERFLICKS
# ============================================================================

if __name__ == "__main__":
    app.run(
        debug=(
            os.getenv(
                "FLASK_DEBUG",
                "false"
            ).lower() == "true"
        )
    )
