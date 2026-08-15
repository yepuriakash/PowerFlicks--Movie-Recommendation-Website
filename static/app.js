const state = {
    list: "popular",
    movies: [],
    watchlist: new Set(),
    device: localStorage.powerFlicksDevice || crypto.randomUUID(),
    page: 1,
    totalPages: 1,
    loading: false,
    view: "category",
    requestId: 0,
    searchQuery: ""
};

localStorage.powerFlicksDevice = state.device;

const api = async (url, options = {}) => {
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
};

const image = (path, size = "w500") => path
    ? `https://image.tmdb.org/t/p/${size}${path}`
    : "https://placehold.co/500x750/172033/a5b1c5?text=No+poster";

const esc = (value) => String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
})[character]);

async function getWatchlist() {
    const data = await api("/api/watchlist");
    state.watchlist = new Set(data.movie_ids);
    updateCount();
}

function updateCount() {
    document.querySelector("#watchlist-count").textContent = state.watchlist.size;
}

function card(movie) {
    const node = document.querySelector("#card-template").content.firstElementChild.cloneNode(true);
    const poster = node.querySelector("img");
    const save = node.querySelector(".save");
    const saved = state.watchlist.has(movie.id);

    poster.src = image(movie.poster_path);
    poster.alt = movie.title;
    node.querySelector(".score").textContent = `★ ${Number(movie.vote_average || 0).toFixed(1)}`;
    node.querySelector("h3").textContent = movie.title;
    node.querySelector("p").textContent = (movie.release_date || "").slice(0, 4) || "Release date TBA";
    node.querySelector(".poster").onclick = () => detail(movie.id);

    save.textContent = saved ? "✓ In My List" : "+ My List";
    save.classList.toggle("active", saved);
    save.onclick = () => toggle(movie.id);

    return node;
}

function render(
    movies,
    status = "",
    replace = true,
    showEmptyMessage = true
) {
    const grid = document.querySelector("#movies");
    const statusElement = document.querySelector("#status");

    if (replace) {
        grid.replaceChildren();
    }

    statusElement.textContent = status;

    if (!movies.length && replace && showEmptyMessage) {
        grid.innerHTML = '<p class="empty">No movies found. Try a different search.</p>';
        return;
    }

    const emptyMessage = grid.querySelector(".empty");
    if (emptyMessage && movies.length) {
        emptyMessage.remove();
    }

    movies.forEach((movie) => grid.append(card(movie)));
}

function updatePagination() {
    const pagination = document.querySelector("#pagination");
    pagination.replaceChildren();

    if (state.view !== "category" || state.totalPages <= 1) {
        pagination.hidden = true;
        return;
    }

    pagination.hidden = false;

    const addButton = (label, page, disabled = false, selected = false) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.setAttribute("aria-current", selected ? "page" : "false");
        button.onclick = () => loadPage(page);
        pagination.append(button);
    };

    addButton("Previous", state.page - 1, state.page === 1);

    const firstPage = Math.max(1, state.page - 2);
    const lastPage = Math.min(state.totalPages, state.page + 2);

    if (firstPage > 1) {
        addButton("1", 1);
        if (firstPage > 2) {
            pagination.append("…");
        }
    }

    for (let page = firstPage; page <= lastPage; page += 1) {
        addButton(String(page), page, false, page === state.page);
    }

    if (lastPage < state.totalPages) {
        if (lastPage < state.totalPages - 1) {
            pagination.append("…");
        }
        addButton(String(state.totalPages), state.totalPages);
    }

    addButton("Next", state.page + 1, state.page === state.totalPages);
}

async function loadPage(page) {
    // Prevent duplicate requests.
    if (state.loading) {
        return;
    }

    // Ignore invalid page requests.
    if (page < 1 || page > state.totalPages) {
        return;
    }

    state.loading = true;

    const currentRequest = ++state.requestId;
    render([], "Loading movies…", true, false);
    updatePagination();

    try {
        const data = await api(
            `/api/movies?list=${state.list}&page=${page}`
        );

        // Ignore stale requests if the user changed
        // category/search/list while this request was loading.
        if (currentRequest !== state.requestId) {
            return;
        }

        const movies = data.results || [];

        state.totalPages = data.total_pages || 1;
        state.page = page;
        state.movies = movies;

        render(movies, `${movies.length} titles`);
        updatePagination();
    } catch (error) {
        // A stale request must not overwrite the
        // status of the currently active request.
        if (currentRequest === state.requestId) {
            document.querySelector("#status").textContent = error.message;
        }
    } finally {
        // A stale request must not change the loading
        // state belonging to the current request.
        if (currentRequest === state.requestId) {
            state.loading = false;
        }
    }
}

async function load(list = state.list) {
    state.list = list;
    state.page = 1;
    state.totalPages = 1;
    state.loading = false;
    state.movies = [];
    state.searchQuery = "";
    state.view = "category";

    document.querySelectorAll("nav [data-list]").forEach((button) => {
        button.classList.toggle("selected", button.dataset.list === list);
    });

    const names = {
        popular: "Popular movies",
        top_rated: "Top-rated movies",
        now_playing: "Now playing",
        upcoming: "Coming soon"
    };
    document.querySelector("#heading").textContent = names[list];

    await loadPage(1);
}

async function toggle(id) {
    const present = state.watchlist.has(id);

    try {
        await api("/api/watchlist", {
            method: present ? "DELETE" : "POST",
            body: JSON.stringify({ movie_id: id })
        });

        if (present) {
            state.watchlist.delete(id);
        } else {
            state.watchlist.add(id);
        }

        updateCount();
        render(state.movies, `${state.movies.length} titles`);
    } catch (error) {
        alert(error.message);
    }
}

async function showWatchlist() {
    const currentRequest = ++state.requestId;

    state.loading = false;
    state.searchQuery = "";
    state.movies = [];
    state.page = 1;
    state.totalPages = 1;
    state.view = "watchlist";
    document.querySelector("#heading").textContent = "My List";
    render([], "Loading your list…", true, false);
    updatePagination();

    try {
        const records = [];
        let unavailable = 0;

        // Load saved titles one at a time so a large watchlist does not
        // send a burst of detail requests to the movie service. One missing
        // or temporarily unavailable title should not hide the whole list.
        for (const id of state.watchlist) {
            try {
                records.push(await api(`/api/movies/${id}`));
            } catch (error) {
                unavailable += 1;
            }

            if (currentRequest !== state.requestId) {
                return;
            }
        }

        if (currentRequest !== state.requestId) {
            return;
        }

        state.movies = records;
        if (!records.length && unavailable) {
            render(
                [],
                "Saved movies are temporarily unavailable. Please try again.",
                true,
                false
            );
            return;
        }

        const status = unavailable
            ? `${records.length} saved titles · ${unavailable} unavailable`
            : `${records.length} saved titles`;
        render(records, status);
    } catch (error) {
        if (currentRequest === state.requestId) {
            render([], error.message);
        }
    }
}

async function detail(id) {
    const modal = document.querySelector("#modal");
    const content = document.querySelector("#modal-content");
    content.innerHTML = '<p class="empty">Loading…</p>';
    modal.showModal();

    try {
        const movie = await api(`/api/movies/${id}`);
        const cast = (movie.credits?.cast || []).slice(0, 4).map((person) => person.name).join(", ");
        const reviews = (movie.powerflicks_reviews || []).map((review) => `
            <div class="review">
                <strong>${esc(review.author)}</strong>
                <small>★ ${review.rating}/5</small><br>
                ${esc(review.comment)}
            </div>
        `).join("") || "<p>No PowerFlicks reviews yet. Be the first.</p>";

        content.innerHTML = `
            <section class="detail-hero" style="background-image:linear-gradient(0deg,#111827 0%,transparent 90%),url('${image(movie.backdrop_path, "original")}')">
                <p>${movie.release_date?.slice(0, 4) || ""} · ${movie.runtime || "—"} min</p>
                <h2>${esc(movie.title)}</h2>
            </section>
            <section class="detail">
                <p class="genres">${(movie.genres || []).map((genre) => esc(genre.name)).join(" · ")}</p>
                <p>${esc(movie.overview)}</p>
                <p><b>Cast:</b> ${esc(cast || "Not available")}</p>
                <div class="reviews">
                    <h3>Community reviews</h3>
                    ${reviews}
                    <form class="review-form" id="review-form">
                        <input name="author" maxlength="50" required placeholder="Your name">
                        <select name="rating">
                            <option value="5">★★★★★ — Loved it</option>
                            <option value="4">★★★★ — Great</option>
                            <option value="3">★★★ — Good</option>
                            <option value="2">★★ — Fair</option>
                            <option value="1">★ — Poor</option>
                        </select>
                        <textarea name="comment" maxlength="1000" required placeholder="Share your thoughts"></textarea>
                        <button class="primary">Post review</button>
                    </form>
                </div>
            </section>
        `;

        document.querySelector("#review-form").onsubmit = async (event) => {
            event.preventDefault();
            const form = new FormData(event.target);

            try {
                await api(`/api/movies/${id}/reviews`, {
                    method: "POST",
                    body: JSON.stringify({
                        author: form.get("author"),
                        rating: Number(form.get("rating")),
                        comment: form.get("comment")
                    })
                });
                detail(id);
            } catch (error) {
                alert(error.message);
            }
        };
    } catch (error) {
        content.innerHTML = `<p class="empty">${esc(error.message)}</p>`;
    }
}

let searchTimer;
document.querySelector("#search").oninput = (event) => {
    clearTimeout(searchTimer);

    const query = event.target.value.trim();
    const currentRequest = ++state.requestId;
    state.searchQuery = query;
    state.loading = false;
    state.view = query ? "search" : "category";
    updatePagination();

    searchTimer = setTimeout(async () => {
        if (currentRequest !== state.requestId) {
            return;
        }

        if (!query) {
            load(state.list);
            return;
        }

        document.querySelector("#heading").textContent = `Results for “${query}”`;
        render([], "Searching…", true, false);
        updatePagination();

        try {
            const data = await api(`/api/search?q=${encodeURIComponent(query)}`);

            if (currentRequest !== state.requestId) {
                return;
            }

            state.movies = data.results || [];
            render(state.movies, `${data.total_results || 0} results`);
        } catch (error) {
            if (currentRequest === state.requestId) {
                render([], error.message);
            }
        }
    }, 300);
};

const pagination = document.createElement("nav");
pagination.id = "pagination";
pagination.setAttribute("aria-label", "Movie pages");
document.querySelector("#movies").after(pagination);

document.querySelectorAll("nav [data-list]").forEach((button) => {
    button.onclick = () => load(button.dataset.list);
});
document.querySelector("#watchlist-button").onclick = showWatchlist;
document.querySelector("#explore").onclick = () => load("popular");
document.querySelector(".close").onclick = () => document.querySelector("#modal").close();

getWatchlist().then(() => load()).catch((error) => render([], error.message));
