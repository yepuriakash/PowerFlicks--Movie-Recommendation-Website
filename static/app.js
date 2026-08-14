// ========================================
// PowerFlicks - Frontend Application
// ========================================

// ----------------------------------------
// Application State
// ----------------------------------------

const state = {
    list: "popular",
    movies: [],
    watchlist: new Set(),

    device: localStorage.PowerFlicksDevice || crypto.randomUUID(),

    page: 1,
    totalPages: 1,
    loading: false,
    hasMore: true,

    requestId: 0,
    searchQuery: ""
};

localStorage.PowerFlicksDevice = state.device;


// ----------------------------------------
// API Helper
// ----------------------------------------

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


// ----------------------------------------
// Image Helper
// ----------------------------------------

const image = (
    path,
    size = "w500"
) => {
    if (path) {
        return `https://image.tmdb.org/t/p/${size}${path}`;
    }

    return "https://placehold.co/500x750/172033/a5b1c5?text=No+poster";
};


// ----------------------------------------
// HTML Escape Helper
// ----------------------------------------

const esc = (value) => {
    return String(value || "").replace(
        /[&<>'"]/g,
        (character) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
        })[character]
    );
};


// ----------------------------------------
// Watchlist
// ----------------------------------------

async function getWatchlist() {
    const data = await api("/api/watchlist");

    state.watchlist = new Set(data.movie_ids);

    updateCount();
}


function updateCount() {
    document.querySelector("#watchlist-count").textContent =
        state.watchlist.size;
}


// ----------------------------------------
// Movie Card
// ----------------------------------------

function card(movie) {
    const template =
        document.querySelector("#card-template");

    const node =
        template.content.firstElementChild.cloneNode(true);

    const poster =
        node.querySelector("img");

    const score =
        node.querySelector(".score");

    const title =
        node.querySelector("h3");

    const year =
        node.querySelector("p");

    const save =
        node.querySelector(".save");


    poster.src = image(movie.poster_path);
    poster.alt = movie.title;

    score.textContent =
        `★ ${Number(movie.vote_average || 0).toFixed(1)}`;

    title.textContent =
        movie.title;

    year.textContent =
        (movie.release_date || "").slice(0, 4) ||
        "Release date TBA";


    // Open movie details
    node.querySelector(".poster").onclick = () => {
        detail(movie.id);
    };


    // Watchlist button
    const saved =
        state.watchlist.has(movie.id);

    save.textContent =
        saved
            ? "✓ In My List"
            : "+ My List";

    save.classList.toggle(
        "active",
        saved
    );

    save.onclick = () => {
        toggle(movie.id);
    };


    return node;
}


// ----------------------------------------
// Render Movies
// ----------------------------------------

function render(
    movies,
    status = "",
    replace = true
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


    if (!movies.length && replace) {
        grid.innerHTML =
            '<p class="empty">No movies found. Try a different search.</p>';

        return;
    }


    // I Removed the old "No movies found" message(so that when scrolling that issue wont occur when actual movies are being added. )
    const emptyMessage =
        grid.querySelector(".empty");

    if (emptyMessage && movies.length) {
        emptyMessage.remove();
    }


    movies.forEach((movie) => {
        grid.append(card(movie));
    });
}

// ----------------------------------------
// Load Movie Pages
// ----------------------------------------

async function loadNextPage() {
    // Prevent duplicate requests
    if (state.loading) {
        return;
    }

    // No more pages
    if (!state.hasMore) {
        return;
    }

    state.loading = true;

    const currentRequest = ++state.requestId;

    try {
        const data = await api(
            `/api/movies?list=${state.list}&page=${state.page}`
        );

        // The user switched to another category
        // while this request was loading.
        if (currentRequest !== state.requestId) {
            return;
        }

        const movies = data.results || [];

        state.totalPages = data.total_pages || 1;

        state.hasMore =
            state.page < state.totalPages;

        state.movies.push(...movies);

        render(
            movies,
            `${state.movies.length} titles`,
            false
        );

        state.page += 1;

    } catch (error) {
        // Only show the error if this is
        // still the active request.
        if (currentRequest === state.requestId) {
            document.querySelector("#status").textContent =
                error.message;
        }

    } finally {
        // An old request must not change the
        // loading state of a newer request.
        if (currentRequest === state.requestId) {
            state.loading = false;
        }
    }
}

// ----------------------------------------
// Load a Movie Category
// ----------------------------------------

async function load(list = state.list) {

    state.list = list;

    state.page = 1;
    state.totalPages = 1;
    state.hasMore = true;
    state.loading = false;
    state.movies = [];
    state.searchQuery = "";

    state.requestId += 1;


    // Update selected navigation button
    document
        .querySelectorAll("nav [data-list]")
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


    document.querySelector("#heading").textContent =
        names[list];


    // Clear the previous category while the new one loads
    render([], "Loading movies…");

    // Load first page
    await loadNextPage();
}


// ----------------------------------------
// Watchlist Toggle
// ----------------------------------------

async function toggle(id) {

    const present =
        state.watchlist.has(id);


    try {

        await api(
            "/api/watchlist",
            {
                method: present
                    ? "DELETE"
                    : "POST",

                body: JSON.stringify({
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


        // Re-render current movies
        render(
            state.movies,
            `${state.movies.length} titles`
        );


    } catch (error) {

        alert(error.message);
    }
}


// ----------------------------------------
// My List
// ----------------------------------------

async function showWatchlist() {

    state.requestId += 1;

    state.loading = false;
    state.hasMore = false;
    state.searchQuery = "";
    state.movies = [];


    document.querySelector("#heading").textContent =
        "My List";


    render(
        [],
        "Loading your list…"
    );


    try {

        const records =
            await Promise.all(
                [...state.watchlist].map(
                    (id) =>
                        api(`/api/movies/${id}`)
                )
            );


        state.movies =
            records;


        render(
            records,
            `${records.length} saved titles`
        );


    } catch (error) {

        render(
            [],
            error.message
        );
    }
}


// ----------------------------------------
// Movie Details
// ----------------------------------------

async function detail(id) {

    const modal =
        document.querySelector("#modal");

    const content =
        document.querySelector("#modal-content");


    content.innerHTML =
        '<p class="empty">Loading…</p>';


    modal.showModal();


    try {

        const movie =
            await api(`/api/movies/${id}`);


        const cast =
            (movie.credits?.cast || [])
                .slice(0, 4)
                .map((person) => person.name)
                .join(", ");


        const reviews =
            (movie.PowerFlicks_reviews || [])
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
                .join("")
            ||
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
                    )}');
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
                        cast || "Not available"
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


                        <button class="primary">
                            Post review
                        </button>

                    </form>

                </div>

            </section>
        `;


        // Review submission
        document.querySelector(
            "#review-form"
        ).onsubmit = async (event) => {

            event.preventDefault();


            const form =
                new FormData(event.target);


            try {

                await api(
                    `/api/movies/${id}/reviews`,
                    {
                        method: "POST",

                        body: JSON.stringify({
                            author:
                                form.get("author"),

                            rating:
                                Number(
                                    form.get("rating")
                                ),

                            comment:
                                form.get("comment")
                        })
                    }
                );


                detail(id);


            } catch (error) {

                alert(error.message);
            }
        };


    } catch (error) {

        content.innerHTML =
            `<p class="empty">
                ${esc(error.message)}
            </p>`;
    }
}


// ----------------------------------------
// Search
// ----------------------------------------

let searchTimer;


document.querySelector("#search").oninput =
    (event) => {

        clearTimeout(searchTimer);


        const query =
            event.target.value.trim();


        searchTimer =
            setTimeout(
                async () => {

                    // Empty search → return to category
                    if (!query) {
                        load(state.list);
                        return;
                    }


                    state.searchQuery =
                        query;

                    state.requestId += 1;

                    state.loading = false;
                    state.hasMore = false;


                    document.querySelector(
                        "#heading"
                    ).textContent =
                        `Results for “${query}”`;


                    render(
                        [],
                        "Searching…"
                    );


                    try {

                        const data =
                            await api(
                                `/api/search?q=${encodeURIComponent(
                                    query
                                )}`
                            );


                        state.movies =
                            data.results || [];


                        render(
                            state.movies,
                            `${data.total_results || 0} results`
                        );


                    } catch (error) {

                        render(
                            [],
                            error.message
                        );
                    }

                },
                300
            );
    };


// ----------------------------------------
// Infinite Scroll
// ----------------------------------------

window.addEventListener(
    "scroll",
    () => {

        // Don't paginate search results
        if (state.searchQuery) {
            return;
        }


        // Don't paginate My List
        if (!state.hasMore) {
            return;
        }


        const scrollPosition =
            window.innerHeight +
            window.scrollY;


        const pageHeight =
            document.documentElement.scrollHeight;


        // Start loading when the user is
        // approximately 600px from the bottom.
        if (
            pageHeight - scrollPosition < 600
        ) {
            loadNextPage();
        }
    }
);


// ----------------------------------------
// Navigation
// ----------------------------------------

document
    .querySelectorAll("nav [data-list]")
    .forEach((button) => {

        button.onclick = () => {
            load(button.dataset.list);
        };
    });


document.querySelector(
    "#watchlist-button"
).onclick = showWatchlist;


document.querySelector(
    "#explore"
).onclick = () => {
    load("popular");
};


document.querySelector(
    ".close"
).onclick = () => {
    document.querySelector(
        "#modal"
    ).close();
};


// ----------------------------------------
// Application Startup
// ----------------------------------------

getWatchlist()
    .then(() => load())
    .catch((error) => {

        render(
            [],
            error.message
        );
    });
