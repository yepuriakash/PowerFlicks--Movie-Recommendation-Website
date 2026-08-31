const state = {
    // Keeping the current page and view explicit replaces the previous
    // infinite-scroll-only flow with predictable numbered pagination.
    list: "popular",
    movies: [],
    watchlist: new Set(),
    device: localStorage.powerFlicksDevice || crypto.randomUUID(),
    page: 1,
    totalPages: 1,
    loading: false,
    view: "category",
    requestId: 0,
    detailRequestId: 0,
    // A non-empty query disables category pagination while searching.
    searchQuery: ""
};

localStorage.powerFlicksDevice = state.device;

const pendingGets = new Map();

// Keep the actual response, rather than only remembering that a URL has been
// displayed. This makes successfully prefetched pages immediately reusable.
const moviePageCache = new Map();
const maxCachedMoviePages = 32;
const scheduledPrefetches = new Set();

const nextCategory = {
    popular: "top_rated",
    top_rated: "now_playing",
    now_playing: "upcoming",
    upcoming: "popular"
};

const api = (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();

    if (method === "GET" && pendingGets.has(url)) {
        return pendingGets.get(url);
    }

    const requestPromise = (async () => {
        const response = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                "X-PowerFlicks-Device": state.device,
                ...(options.headers || {})
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Something went wrong");
        }

        return data;
    })();

    if (method === "GET") {
        pendingGets.set(url, requestPromise);

        requestPromise.then(
            () => pendingGets.delete(url),
            () => pendingGets.delete(url)
        );
    }

    return requestPromise;
};

const moviePageUrl = (list, page) =>
    `/api/movies?list=${list}&page=${page}`;

function cachedMoviePage(url) {
    const data = moviePageCache.get(url);

    if (data) {
        // Map insertion order gives this small cache LRU behavior.
        moviePageCache.delete(url);
        moviePageCache.set(url, data);
    }

    return data;
}

function cacheMoviePage(url, data) {
    moviePageCache.delete(url);
    moviePageCache.set(url, data);

    if (moviePageCache.size > maxCachedMoviePages) {
        moviePageCache.delete(
            moviePageCache.keys().next().value
        );
    }

    return data;
}

async function getMoviePage(list, page, options = {}) {
    const url = moviePageUrl(list, page);

    const cached = cachedMoviePage(url);

    if (cached) {
        return cached;
    }

    return cacheMoviePage(
        url,
        await api(url, options)
    );
}

function prefetchMoviePage(list, page) {
    const url = moviePageUrl(list, page);

    if (
        cachedMoviePage(url) ||
        scheduledPrefetches.has(url)
    ) {
        return;
    }

    scheduledPrefetches.add(url);

    const prefetch = async () => {
        try {
            if (!cachedMoviePage(url)) {
                // The backend TMDB cache makes this low-priority warm-up useful
                // without changing the data or state currently on screen.
                await getMoviePage(
                    list,
                    page,
                    { priority: "low" }
                );
            }
        } catch (error) {
            // A later page load can make a normal request if warm-up fails.
        } finally {
            scheduledPrefetches.delete(url);
        }
    };

    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(
            prefetch,
            { timeout: 1500 }
        );
    } else {
        window.setTimeout(prefetch, 250);
    }
}

function prefetchLikelyMoviePages(
    list,
    page,
    totalPages
) {
    if (page < totalPages) {
        prefetchMoviePage(
            list,
            page + 1
        );
    }

    prefetchMoviePage(
        nextCategory[list],
        1
    );
}

const image = (path, size = "w500") =>
    path
        ? `https://image.tmdb.org/t/p/${size}${path}`
        : "https://placehold.co/500x750/172033/a5b1c5?text=No+poster";


// ============================================================================
// UTILITIES
// ============================================================================

const esc = (value) =>
    String(value || "").replace(
        /[&<>'"]/g,
        (character) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
        })[character]
    );


// ============================================================================
// WATCHLIST
// ============================================================================

async function getWatchlist() {
    const data =
        await api("/api/watchlist");

    state.watchlist =
        new Set(data.movie_ids);

    updateCount();

    // Movie cards may already have rendered because startup loading is now
    // parallel. Refresh their saved controls when this data arrives.
    state.movies.forEach(
        (movie) =>
            updateSavedCard(movie.id)
    );

}

function updateCount() {
    document.querySelector(
        "#watchlist-count"
    ).textContent =
        state.watchlist.size;
}


// ============================================================================
// MOVIE CARDS
// ============================================================================

function card(movie) {
    const node =
        document.querySelector(
            "#card-template"
        )
            .content
            .firstElementChild
            .cloneNode(true);

    const poster =
        node.querySelector("img");

    const save =
        node.querySelector(".save");

    const saved =
        state.watchlist.has(movie.id);

    node.dataset.movieId =
        movie.id;

    poster.decoding = "async";

    poster.src =
        image(movie.poster_path);

    poster.alt =
        movie.title;

    node.querySelector(
        ".score"
    ).textContent =
        `★ ${Number(
            movie.vote_average || 0
        ).toFixed(1)}`;

    node.querySelector(
        "h3"
    ).textContent =
        movie.title;

    node.querySelector(
        "p"
    ).textContent =
        (movie.release_date || "")
            .slice(0, 4) ||
        "Release date TBA";

    node.querySelector(
        ".poster"
    ).onclick =
        () => detail(movie.id);

    save.textContent =
        saved
            ? "✓ In My List"
            : "+ My List";

    save.classList.toggle(
        "active",
        saved
    );

    save.onclick =
        () => toggle(movie.id);

    return node;
}


// ============================================================================
// LOADING / RENDERING
// ============================================================================

function renderLoading(
    status = "Loading movies…"
) {
    const grid =
        document.querySelector("#movies");

    const fragment =
        document.createDocumentFragment();

    for (
        let index = 0;
        index < 8;
        index += 1
    ) {
        const skeleton =
            document.createElement("article");

        skeleton.className =
            "card skeleton-card";

        skeleton.setAttribute(
            "aria-hidden",
            "true"
        );

        skeleton.innerHTML = `
            <div class="skeleton-poster"></div>

            <div class="card-copy">
                <span class="skeleton-line skeleton-title"></span>
                <span class="skeleton-line skeleton-meta"></span>
                <span class="skeleton-button"></span>
            </div>
        `;

        fragment.append(skeleton);
    }

    grid.replaceChildren(fragment);

    document.querySelector(
        "#status"
    ).textContent =
        status;
}

function render(
    movies,
    status = "",
    replace = true,
    showEmptyMessage = true
) {
    const grid =
        document.querySelector("#movies");

    const statusElement =
        document.querySelector("#status");

    if (replace) {
        grid.replaceChildren();
    }

    statusElement.textContent =
        status;

    // Loading also renders an empty array. The extra flag prevents the old
    // behavior where a loading screen incorrectly showed "No movies found".
    if (
        !movies.length &&
        replace &&
        showEmptyMessage
    ) {
        grid.innerHTML =
            '<p class="empty">No movies found. Try a different search.</p>';

        return;
    }

    const emptyMessage =
        grid.querySelector(".empty");

    if (
        emptyMessage &&
        movies.length
    ) {
        emptyMessage.remove();
    }

    movies.forEach(
        (movie) =>
            grid.append(
                card(movie)
            )
    );
}


// ============================================================================
// PAGINATION
// ============================================================================

function updatePagination() {
    const pagination =
        document.querySelector("#pagination");

    pagination.replaceChildren();

    // Search and My List are complete result sets, not paged categories.
    if (
        state.view !== "category" ||
        state.totalPages <= 1
    ) {
        pagination.hidden = true;
        return;
    }

    pagination.hidden = false;

    const addButton = (
        label,
        page,
        disabled = false,
        selected = false
    ) => {
        const button =
            document.createElement("button");

        button.type = "button";

        button.textContent =
            label;

        button.disabled =
            disabled;

        button.setAttribute(
            "aria-current",
            selected
                ? "page"
                : "false"
        );

        button.onclick =
            () => loadPage(page);

        pagination.append(button);
    };

    addButton(
        "Previous",
        state.page - 1,
        state.page === 1
    );

    const firstPage =
        Math.max(
            1,
            state.page - 2
        );

    const lastPage =
        Math.min(
            state.totalPages,
            state.page + 2
        );

    if (firstPage > 1) {
        addButton(
            "1",
            1
        );

        if (firstPage > 2) {
            pagination.append("…");
        }
    }

    for (
        let page = firstPage;
        page <= lastPage;
        page += 1
    ) {
        addButton(
            String(page),
            page,
            false,
            page === state.page
        );
    }

    if (
        lastPage <
        state.totalPages
    ) {
        if (
            lastPage <
            state.totalPages - 1
        ) {
            pagination.append("…");
        }

        addButton(
            String(state.totalPages),
            state.totalPages
        );
    }

    addButton(
        "Next",
        state.page + 1,
        state.page === state.totalPages
    );
}


// ============================================================================
// CATEGORY LOADING
// ============================================================================

async function loadPage(page) {
    // Prevent duplicate requests.
    if (state.loading) {
        return;
    }

    // Ignore invalid page requests.
    if (
        page < 1 ||
        page > state.totalPages
    ) {
        return;
    }

    // Each request gets a generation number. A response from an older page
    // or category is ignored instead of overwriting the current screen.
    const currentRequest =
        ++state.requestId;

    const url =
        moviePageUrl(
            state.list,
            page
        );

    const cached =
        cachedMoviePage(url);

    state.loading = true;

    // Cached and prefetched data should render without a skeleton flash.
    if (!cached) {
        renderLoading();
    }

    updatePagination();

    try {
        const data =
            cached ||
            await getMoviePage(
                state.list,
                page
            );

        // Ignore stale requests if the user changed
        // category/search/list while this request was loading.
        if (
            currentRequest !==
            state.requestId
        ) {
            return;
        }

        const movies =
            data.results || [];

        state.totalPages =
            data.total_pages || 1;

        state.page =
            page;

        state.movies =
            movies;

        render(
            movies,
            `${movies.length} titles`
        );

        updatePagination();

        prefetchLikelyMoviePages(
            state.list,
            page,
            state.totalPages
        );
    } catch (error) {
        // A stale request must not overwrite the
        // status of the currently active request.
        if (
            currentRequest ===
            state.requestId
        ) {
            document.querySelector(
                "#status"
            ).textContent =
                error.message;
        }
    } finally {
        // A stale request must not change the loading
        // state belonging to the current request.
        if (
            currentRequest ===
            state.requestId
        ) {
            state.loading = false;
        }
    }
}

async function load(
    list = state.list
) {
    state.list = list;

    state.page = 1;

    state.totalPages = 1;

    // loadPage() owns loading=true. Resetting here lets the first page of a
    // newly selected category start immediately instead of blocking itself.
    state.loading = false;

    state.movies = [];

    state.searchQuery = "";

    state.view = "category";

    document
        .querySelectorAll(
            "nav [data-list]"
        )
        .forEach((button) => {
            button.classList.toggle(
                "selected",
                button.dataset.list === list
            );
        });

    const names = {
        popular: "Popular movies",
        top_rated: "Top-rated movies",
        now_playing: "Now playing",
        upcoming: "Coming soon"
    };

    document.querySelector(
        "#heading"
    ).textContent =
        names[list];

    await loadPage(1);
}


// ============================================================================
// WATCHLIST TOGGLE
// ============================================================================

async function toggle(id) {
    const present =
        state.watchlist.has(id);

    try {
        await api(
            "/api/watchlist",
            {
                method:
                    present
                        ? "DELETE"
                        : "POST",

                body:
                    JSON.stringify({
                        movie_id: id
                    })
            }
        );

        if (present) {
            state.watchlist.delete(id);
        } else {
            state.watchlist.add(id);
        }

        updateCount();

        updateSavedCard(id);
    } catch (error) {
        alert(error.message);
    }
}

function updateSavedCard(id) {
    const cardNode =
        document.querySelector(
            `.card[data-movie-id="${id}"]`
        );

    if (!cardNode) {
        return;
    }

    const save =
        cardNode.querySelector(".save");

    const saved =
        state.watchlist.has(id);

    save.textContent =
        saved
            ? "✓ In My List"
            : "+ My List";

    save.classList.toggle(
        "active",
        saved
    );

}


// ============================================================================
// MY LIST
// ============================================================================

async function showWatchlist() {
    // Invalidate any category/search request before loading saved titles.
    const currentRequest =
        ++state.requestId;

    state.loading = false;

    state.searchQuery = "";

    state.movies = [];

    state.page = 1;

    state.totalPages = 1;

    state.view = "watchlist";

    document.querySelector(
        "#heading"
    ).textContent =
        "My List";

    renderLoading(
        "Loading your list…"
    );

    updatePagination();

    try {
        const records = [];

        let unavailable = 0;

        // The previous Promise.all() rejected the entire list when one
        // movie-detail request failed. Loading titles one at a time means
        // available saved movies still appear, even if one is unavailable.
        // It also avoids a burst of requests to the movie service.
        for (
            const id of state.watchlist
        ) {
            try {
                records.push(
                    await api(
                        `/api/movies/${id}`
                    )
                );
            } catch (error) {
                unavailable += 1;
            }

            if (
                currentRequest !==
                state.requestId
            ) {
                return;
            }
        }

        if (
            currentRequest !==
            state.requestId
        ) {
            return;
        }

        state.movies =
            records;

        if (
            !records.length &&
            unavailable
        ) {
            render(
                [],
                "Saved movies are temporarily unavailable. Please try again.",
                true,
                false
            );

            return;
        }

        const status =
            unavailable
                ? `${records.length} saved titles · ${unavailable} unavailable`
                : `${records.length} saved titles`;

        render(
            records,
            status
        );
    } catch (error) {
        if (
            currentRequest ===
            state.requestId
        ) {
            render(
                [],
                error.message
            );
        }
    }
}


// ============================================================================
// MOVIE DETAILS
// ============================================================================

async function detail(id) {
    const modal =
        document.querySelector("#modal");

    const content =
        document.querySelector(
            "#modal-content"
        );

    const currentRequest =
        ++state.detailRequestId;

    content.innerHTML = `
        <div
            class="detail-loading"
            aria-label="Loading movie details"
        >
            <span class="skeleton-poster"></span>
            <span class="skeleton-line skeleton-title"></span>
            <span class="skeleton-line skeleton-copy"></span>
            <span class="skeleton-line skeleton-copy"></span>
        </div>
    `;

    if (!modal.open) {
        modal.showModal();
    }

    try {
        const movie =
            await api(
                `/api/movies/${id}`
            );

        if (
            currentRequest !==
                state.detailRequestId ||
            !modal.open
        ) {
            return;
        }

        const cast =
            (movie.credits?.cast || [])
                .slice(0, 4)
                .map(
                    (person) =>
                        person.name
                )
                .join(", ");

        const reviews =
            (movie.powerflicks_reviews || [])
                .map(
                    (review) => `
                        <div class="review">
                            <strong>
                                ${esc(review.author)}
                            </strong>

                            <small>
                                ★ ${review.rating}/5
                            </small>

                            <br>

                            ${esc(review.comment)}
                        </div>
                    `
                )
                .join("") ||
            "<p>No PowerFlicks reviews yet. Be the first.</p>";

        content.innerHTML = `
            <section
                class="detail-hero"
                style="
                    background-image:
                    linear-gradient(
                        0deg,
                        #111827 0%,
                        transparent 90%
                    ),
                    url('${image(
                        movie.backdrop_path,
                        "original"
                    )}')
                "
            >
                <p>
                    ${movie.release_date?.slice(0, 4) || ""}
                    ·
                    ${movie.runtime || "—"} min
                </p>

                <h2>
                    ${esc(movie.title)}
                </h2>
            </section>

            <section class="detail">
                <p class="genres">
                    ${(movie.genres || [])
                        .map(
                            (genre) =>
                                esc(genre.name)
                        )
                        .join(" · ")}
                </p>

                <p>
                    ${esc(movie.overview)}
                </p>

                <p>
                    <b>Cast:</b>
                    ${esc(
                        cast ||
                        "Not available"
                    )}
                </p>

                <div class="reviews">
                    <h3>
                        Community reviews
                    </h3>

                    ${reviews}

                    <form
                        class="review-form"
                        id="review-form"
                    >
                        <input
                            name="author"
                            maxlength="50"
                            required
                            placeholder="Your name"
                        >

                        <select name="rating">
                            <option value="5">
                                ★★★★★ — Loved it
                            </option>

                            <option value="4">
                                ★★★★ — Great
                            </option>

                            <option value="3">
                                ★★★ — Good
                            </option>

                            <option value="2">
                                ★★ — Fair
                            </option>

                            <option value="1">
                                ★ — Poor
                            </option>
                        </select>

                        <textarea
                            name="comment"
                            maxlength="1000"
                            required
                            placeholder="Share your thoughts"
                        ></textarea>

                        <button
                            class="primary"
                            type="submit"
                        >
                            Post review
                        </button>
                    </form>
                </div>
            </section>
        `;

        document.querySelector(
            "#review-form"
        ).onsubmit =
            async (event) => {
                event.preventDefault();

                const form =
                    new FormData(
                        event.target
                    );

                try {
                    await api(
                        `/api/movies/${id}/reviews`,
                        {
                            method: "POST",

                            body:
                                JSON.stringify({
                                    author:
                                        form.get(
                                            "author"
                                        ),

                                    rating:
                                        Number(
                                            form.get(
                                                "rating"
                                            )
                                        ),

                                    comment:
                                        form.get(
                                            "comment"
                                        )
                                })
                        }
                    );

                    detail(id);
                } catch (error) {
                    alert(
                        error.message
                    );
                }
            };
    } catch (error) {
        if (
            currentRequest ===
                state.detailRequestId &&
            modal.open
        ) {
            content.innerHTML =
                `
                    <p class="empty">
                        ${esc(
                            error.message
                        )}
                    </p>
                `;
        }
    }
}


// ============================================================================
// SEARCH
// ============================================================================

let searchTimer;

document.querySelector(
    "#search"
).oninput =
    (event) => {
        clearTimeout(
            searchTimer
        );

        const query =
            event.target.value.trim();

        // Invalidate a pending category/search response as soon as the query
        // changes, rather than waiting for the debounce timer to finish.
        const currentRequest =
            ++state.requestId;

        state.searchQuery =
            query;

        state.loading =
            false;

        state.view =
            query
                ? "search"
                : "category";

        updatePagination();

        searchTimer =
            setTimeout(
                async () => {
                    if (
                        currentRequest !==
                        state.requestId
                    ) {
                        return;
                    }

                    if (!query) {
                        load(
                            state.list
                        );

                        return;
                    }

                    document.querySelector(
                        "#heading"
                    ).textContent =
                        `Results for “${query}”`;

                    renderLoading(
                        "Searching…"
                    );

                    updatePagination();

                    try {
                        const data =
                            await api(
                                `/api/search?q=${encodeURIComponent(
                                    query
                                )}`
                            );

                        if (
                            currentRequest !==
                            state.requestId
                        ) {
                            return;
                        }

                        state.movies =
                            data.results || [];

                        render(
                            state.movies,
                            `${data.total_results || 0} results`
                        );
                    } catch (error) {
                        if (
                            currentRequest ===
                            state.requestId
                        ) {
                            render(
                                [],
                                error.message
                            );
                        }
                    }
                },
                300
            );
    };


// ============================================================================
// PAGINATION ELEMENT
// ============================================================================

const pagination =
    document.createElement("nav");

pagination.id =
    "pagination";

pagination.setAttribute(
    "aria-label",
    "Movie pages"
);

document.querySelector(
    "#movies"
).after(pagination);


// ============================================================================
// EVENT LISTENERS
// ============================================================================

document
    .querySelectorAll(
        "nav [data-list]"
    )
    .forEach((button) => {
        button.onclick =
            () =>
                load(
                    button.dataset.list
                );
    });

document.querySelector(
    "#watchlist-button"
).onclick =
    showWatchlist;

document.querySelector(
    "#explore"
).onclick =
    () =>
        load("popular");

document.querySelector(
    "#hero-explore"
).onclick =
    () =>
        load("popular");

document.querySelector(
    "#hero-save"
).onclick =
    showWatchlist;

document.querySelector(
    "#spotlight-action"
).onclick =
    () =>
        load("now_playing");

document.querySelector(
    "#story-action"
).onclick =
    () =>
        load("top_rated");

document.querySelector(
    ".close"
).onclick =
    () =>
        document.querySelector(
            "#modal"
        ).close();

document.querySelector(
    "#modal"
).addEventListener(
    "close",
    () => {
        state.detailRequestId += 1;
    }
);


// ============================================================================
// STARTUP
// ============================================================================

// Loading movies does not depend on the watchlist request. Starting both now
// improves first render while cards still pick up saved state when it arrives.

getWatchlist().catch(
    (error) =>
        console.error(
            "Could not load watchlist:",
            error
        )
);

load();
