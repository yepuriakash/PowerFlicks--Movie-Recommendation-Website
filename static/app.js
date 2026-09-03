// ============================================================================
// POWERFLICKS - APPLICATION STATE
// ============================================================================
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
    detailRequestId: 0,
    searchQuery: ""
};

localStorage.powerFlicksDevice = state.device;
const pendingGets = new Map();

// ============================================================================
// API HELPER
// ============================================================================
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

        let data;
        try {
            data = await response.json();
        } catch {
            data = {};
        }

        if (!response.ok) {
            throw new Error(data.error || "Something went wrong.");
        }

        return data;
    })();

    if (method === "GET") {
        pendingGets.set(url, requestPromise);
        requestPromise.finally(() => {
            if (pendingGets.get(url) === requestPromise) {
                pendingGets.delete(url);
            }
        });
    }

    return requestPromise;
};

// ============================================================================
// UTILITIES
// ============================================================================
const image = (path, size = "w500") =>
    path
        ? `https://image.tmdb.org/t/p/${size}${path}`
        : "https://placehold.co/500x750/172033/a5b1c5?text=No+image";

const esc = (value) =>
    String(value ?? "").replace(
        /[&<>'"]/g,
        (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
        })[char]
    );

// ============================================================================
// WATCHLIST
// ============================================================================
async function getWatchlist() {
    try {
        const data = await api("/api/watchlist");
        state.watchlist = new Set(data.movie_ids || []);
        updateCount();
        updateCarouselWatchlistState();
    } catch (error) {
        console.error("Watchlist error", error);
    }
}

function updateCount() {
    const count = document.querySelector("#watchlist-count");
    if (count) {
        count.textContent = state.watchlist.size;
    }
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
        updateSavedCard(id);
        updateCarouselWatchlistState();

        if (state.view === "watchlist") {
            showWatchlist();
        }
    } catch (error) {
        alert(error.message);
    }
}

function updateSavedCard(id) {
    const cardNode = document.querySelector(`.card[data-movie-id="${id}"]`);
    if (!cardNode) return;

    const save = cardNode.querySelector(".save");
    if (!save) return;

    const saved = state.watchlist.has(id);
    save.textContent = saved ? "✓ In My List" : "+ My List";
    save.classList.toggle("active", saved);
}

// ============================================================================
// MOVIE GRID & CARDS
// ============================================================================
function card(movie) {
    const template = document.querySelector("#card-template");
    if (!template) {
        console.error("Card template #card-template not found.");
        return document.createElement("article");
    }

    const node = template.content.firstElementChild.cloneNode(true);
    const poster = node.querySelector("img");
    const save = node.querySelector(".save");
    const saved = state.watchlist.has(movie.id);

    node.dataset.movieId = String(movie.id);

    if (poster) {
        poster.decoding = "async";
        poster.src = image(movie.poster_path);
        poster.alt = movie.title || movie.name || "Movie poster";
        poster.loading = "lazy";
    }

    const score = node.querySelector(".score");
    if (score) {
        score.textContent = `★ ${Number(movie.vote_average || 0).toFixed(1)}`;
    }

    const title = node.querySelector("h3");
    if (title) {
        title.textContent = movie.title || movie.name || "Untitled";
    }

    const year = node.querySelector("p");
    if (year) {
        year.textContent = (movie.release_date || movie.first_air_date || "").slice(0, 4) || "TBA";
    }

    const posterContainer = node.querySelector(".poster");
    if (posterContainer) {
        posterContainer.onclick = () => detail(movie.id);
        posterContainer.setAttribute("role", "button");
        posterContainer.setAttribute("tabindex", "0");
        posterContainer.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                detail(movie.id);
            }
        };
    }

    if (save) {
        save.textContent = saved ? "✓ In My List" : "+ My List";
        save.classList.toggle("active", saved);
        save.onclick = (event) => {
            event.stopPropagation();
            toggle(movie.id);
        };
    }

    return node;
}

function renderLoading(status = "Loading movies…") {
    const grid = document.querySelector("#movies");
    const statusElement = document.querySelector("#status");
    if (!grid) return;

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 8; i++) {
        const skeleton = document.createElement("article");
        skeleton.className = "card skeleton-card";
        skeleton.setAttribute("aria-hidden", "true");
        fragment.append(skeleton);
    }

    grid.replaceChildren(fragment);
    if (statusElement) {
        statusElement.textContent = status;
    }
}

function render(movies, status = "", replace = true, showEmptyMessage = true) {
    const grid = document.querySelector("#movies");
    const statusElement = document.querySelector("#status");
    if (!grid) return;

    if (replace) {
        grid.replaceChildren();
    }

    if (statusElement) {
        statusElement.textContent = status;
    }

    if (!movies.length && replace && showEmptyMessage) {
        grid.innerHTML = '<p class="empty">No results found.</p>';
        return;
    }

    movies.forEach((movie) => {
        const movieCard = card(movie);
        if (movieCard) {
            grid.append(movieCard);
        }
    });
}

// ============================================================================
// EDITORIAL SECTION & DYNAMIC TAB SWITCHING
// ============================================================================
function renderEditorialSection() {
    const container = document.querySelector("#editorial-section");
    if (!container) return;

    container.innerHTML = `
        <div class="editorial-grid">
            <div class="editorial-card">
                <div>
                    <div class="editorial-tag">ACTOR SPOTLIGHT</div>
                    <h3>Iconic Performances</h3>
                    <p>Explore award-winning performances and filmographies from legendary actors across decades.</p>
                </div>
                <button type="button" class="editorial-btn" onclick="switchTab('popular')">
                    EXPLORE ACTION HITS →
                </button>
            </div>

            <div class="editorial-card">
                <div>
                    <div class="editorial-tag">CINEMA STORY</div>
                    <h3>Masterpieces & Classics</h3>
                    <p>Delve into groundbreaking storytelling, masterful direction, and cinema history.</p>
                </div>
                <button type="button" class="editorial-btn" onclick="switchTab('top_rated')">
                    VIEW TOP CLASSICS →
                </button>
            </div>
        </div>
    `;
}

function switchTab(tabName) {
    document.querySelectorAll("nav [data-list]").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.list === tabName);
    });

    load(tabName);

    const sectionHeader = document.querySelector(".section-header");
    if (sectionHeader) {
        sectionHeader.scrollIntoView({ behavior: "smooth" });
    }
}

// ============================================================================
// MOVIE CATEGORY LOADING
// ============================================================================
async function loadPage(page) {
    if (state.loading || page < 1 || page > state.totalPages) return;

    const currentRequest = ++state.requestId;
    state.loading = true;
    renderLoading();
    updatePagination();

    try {
        const data = await api(`/api/movies?list=${encodeURIComponent(state.list)}&page=${page}`);
        if (currentRequest !== state.requestId) return;

        const movies = data.results || [];
        state.totalPages = data.total_pages || 1;
        state.page = page;
        state.movies = movies;

        render(movies, `${movies.length} titles`);
        updatePagination();
    } catch (error) {
        if (currentRequest === state.requestId) {
            const status = document.querySelector("#status");
            if (status) {
                status.textContent = error.message;
            }
        }
    } finally {
        if (currentRequest === state.requestId) {
            state.loading = false;
        }
    }
}

async function load(list = state.list) {
    state.requestId += 1;
    state.list = list;
    state.page = 1;
    state.totalPages = 1;
    state.loading = false;
    state.movies = [];
    state.searchQuery = "";
    state.view = "category";

    renderDidYouMeanBanner(null);

    const peopleSection = document.querySelector("#people-section");
    if (peopleSection) {
        peopleSection.style.display = "none";
    }

    const watchlistBtn = document.querySelector("#watchlist-button");
    if (watchlistBtn) {
        watchlistBtn.classList.remove("selected");
    }

    document.querySelectorAll("nav [data-list]").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.list === list);
    });

    const names = {
        popular: "Popular Movies",
        top_rated: "Top-Rated Movies",
        now_playing: "Now Playing",
        upcoming: "Coming Soon"
    };

    const heading = document.querySelector("#heading");
    if (heading) {
        heading.textContent = names[list] || "Movies";
    }

    await loadPage(1);
}

// ============================================================================
// WATCHLIST VIEW
// ============================================================================
async function showWatchlist() {
    const currentRequest = ++state.requestId;
    state.loading = false;
    state.searchQuery = "";
    state.movies = [];
    state.page = 1;
    state.totalPages = 1;
    state.view = "watchlist";

    renderDidYouMeanBanner(null);

    const peopleSection = document.querySelector("#people-section");
    if (peopleSection) {
        peopleSection.style.display = "none";
    }

    document.querySelectorAll("nav [data-list]").forEach((btn) => {
        btn.classList.remove("selected");
    });

    const headerWatchlistBtn = document.querySelector("#watchlist-button");
    if (headerWatchlistBtn) {
        headerWatchlistBtn.classList.add("selected");
    }

    const heading = document.querySelector("#heading");
    if (heading) {
        heading.textContent = "My List";
    }

    renderLoading("Loading your list…");
    updatePagination();

    if (state.watchlist.size === 0) {
        render([], "Your list is empty. Explore and add movies!", true, true);
        return;
    }

    try {
        const watchlistArray = Array.from(state.watchlist);
        const promises = watchlistArray.map((id) => api(`/api/movies/${id}`));
        const results = await Promise.allSettled(promises);

        if (currentRequest !== state.requestId) return;

        const records = [];
        const invalidIds = [];

        results.forEach((result, index) => {
            if (result.status === "fulfilled" && result.value && !result.value.error) {
                records.push(result.value);
            } else {
                invalidIds.push(watchlistArray[index]);
            }
        });

        invalidIds.forEach((id) => state.watchlist.delete(id));
        updateCount();

        state.movies = records;
        render(records, `${records.length} saved titles`);
    } catch (error) {
        if (currentRequest === state.requestId) {
            render([], error.message, true, false);
        }
    }
}

// ============================================================================
// DYNAMIC HERO CAROUSEL ENGINE
// ============================================================================
const carouselState = {
    slides: [],
    currentIndex: 0,
    timer: null
};

async function initHeroCarousel() {
    carouselState.slides = [];
    carouselState.currentIndex = 0;
    stopCarouselAutoPlay();

    try {
        const [popRes, topRes, nowRes, bdayRes] = await Promise.allSettled([
            api("/api/movies?list=popular&page=1"),
            api("/api/movies?list=top_rated&page=1"),
            api("/api/movies?list=now_playing&page=1"),
            api("/api/spotlight/birthday")
        ]);

        if (popRes.status === "fulfilled" && popRes.value?.results?.[0]) {
            carouselState.slides.push({
                type: "movie",
                kicker: "🔥 POPULAR MOVIE",
                data: popRes.value.results[0]
            });
        }

        if (topRes.status === "fulfilled" && topRes.value?.results?.[0]) {
            carouselState.slides.push({
                type: "movie",
                kicker: "⭐ HIGHLY RATED",
                data: topRes.value.results[0]
            });
        }

        if (nowRes.status === "fulfilled" && nowRes.value?.results?.[0]) {
            carouselState.slides.push({
                type: "movie",
                kicker: "🎬 NOW PLAYING",
                data: nowRes.value.results[0]
            });
        }

        if (bdayRes.status === "fulfilled" && bdayRes.value) {
            const val = bdayRes.value;
            const seenIds = new Set();

            if (val.international_birthday && !seenIds.has(val.international_birthday.id)) {
                seenIds.add(val.international_birthday.id);
                carouselState.slides.unshift({
                    type: "person",
                    kicker: "🎂 BIRTHDAY SPOTLIGHT",
                    data: val.international_birthday
                });
            }

            if (val.indian_birthday && !seenIds.has(val.indian_birthday.id)) {
                seenIds.add(val.indian_birthday.id);
                carouselState.slides.unshift({
                    type: "person",
                    kicker: "🎂 BIRTHDAY SPOTLIGHT",
                    data: val.indian_birthday
                });
            }

            if (val.telugu_birthday && !seenIds.has(val.telugu_birthday.id)) {
                seenIds.add(val.telugu_birthday.id);
                carouselState.slides.unshift({
                    type: "person",
                    kicker: "🎂 BIRTHDAY SPOTLIGHT",
                    data: val.telugu_birthday
                });
            }
        }

        if (carouselState.slides.length > 0) {
            renderCarouselSlide(0);
            startCarouselAutoPlay();
        }
    } catch (error) {
        console.error("Hero carousel load failed", error);
    }
}

// ============================================================================
// RENDER HERO CAROUSEL SLIDE
// ============================================================================
function renderCarouselSlide(index) {
    if (!carouselState.slides.length) return;

    carouselState.currentIndex = (index + carouselState.slides.length) % carouselState.slides.length;
    const slide = carouselState.slides[carouselState.currentIndex];

    const backdrop = document.querySelector("#spotlight-backdrop");
    const kicker = document.querySelector("#spotlight-kicker");
    const meta = document.querySelector("#spotlight-meta");
    const year = document.querySelector("#spotlight-year");
    const rating = document.querySelector("#spotlight-rating");
    const movieTitle = document.querySelector("#spotlight-movie-title");
    const personWrapper = document.querySelector("#spotlight-person-wrapper");
    const personImg = document.querySelector("#spotlight-person-img");
    const personTitle = document.querySelector("#spotlight-title");
    const personSubtitle = document.querySelector("#spotlight-subtitle");
    const overview = document.querySelector("#spotlight-overview");
    const btnPrimary = document.querySelector("#spotlight-btn-primary");
    const btnSecondary = document.querySelector("#spotlight-btn-secondary");
    const dotsContainer = document.querySelector("#spotlight-dots");

    if (kicker) {
        kicker.textContent = slide.kicker;
    }

    if (slide.type === "movie") {
        const movie = slide.data;
        if (backdrop) {
            backdrop.style.backgroundImage = `url("${image(movie.backdrop_path, "w1280")}")`;
        }
        if (meta) meta.style.display = "flex";
        if (year) {
            year.textContent = (movie.release_date || movie.first_air_date || "").slice(0, 4) || "TBA";
        }
        if (rating) {
            rating.textContent = `★ ${Number(movie.vote_average || 0).toFixed(1)}`;
        }
        if (personWrapper) personWrapper.style.display = "none";
        if (movieTitle) {
            movieTitle.style.display = "block";
            movieTitle.textContent = movie.title || movie.name || "Untitled";
        }
        if (personTitle) personTitle.textContent = "";
        if (personSubtitle) personSubtitle.textContent = "";
        if (overview) {
            overview.textContent = movie.overview || "Discover plot details, reviews, and ratings.";
        }
        if (btnPrimary) {
            btnPrimary.style.display = "inline-flex";
            btnPrimary.textContent = "VIEW DETAILS";
            btnPrimary.onclick = () => detail(movie.id);
        }
        if (btnSecondary) {
            const saved = state.watchlist.has(movie.id);
            btnSecondary.style.display = "inline-flex";
            btnSecondary.textContent = saved ? "✓ IN MY LIST" : "+ MY LIST";
            btnSecondary.classList.toggle("active", saved);
            btnSecondary.onclick = () => toggle(movie.id);
        }
    } else if (slide.type === "person") {
        const person = slide.data;
        const credits = person.combined_credits?.cast || [];
        const topBackdrop = credits.find((credit) => credit.backdrop_path)?.backdrop_path;

        if (backdrop && topBackdrop) {
            backdrop.style.backgroundImage = `url("${image(topBackdrop, "w1280")}")`;
        } else if (backdrop) {
            backdrop.style.backgroundImage = "none";
        }

        if (meta) meta.style.display = "none";
        if (year) year.textContent = "";
        if (rating) rating.textContent = "";
        if (movieTitle) {
            movieTitle.style.display = "none";
            movieTitle.textContent = "";
        }
        if (personWrapper) personWrapper.style.display = "flex";
        if (personImg) {
            personImg.src = image(person.profile_path, "w185");
            personImg.alt = person.name || "Cinema personality";
        }
        if (personTitle) {
            personTitle.textContent = `Happy Birthday, ${person.name || ""}`;
        }
        if (personSubtitle) {
            personSubtitle.textContent = `${person.known_for_department || "Actor"} · Born ${person.birthday || "Today"}`;
        }
        if (overview) {
            overview.textContent = person.biography || "Celebrating contributions to world cinema.";
        }
        if (btnPrimary) {
            btnPrimary.style.display = "inline-flex";
            btnPrimary.textContent = "VIEW PROFILE";
            btnPrimary.onclick = () => showPersonProfile(person.id);
        }
        if (btnSecondary) {
            btnSecondary.style.display = "none";
            btnSecondary.onclick = null;
        }
    }

    if (dotsContainer) {
        dotsContainer.replaceChildren();
        carouselState.slides.forEach((_, idx) => {
            const dot = document.createElement("button");
            dot.type = "button";
            dot.className = "spotlight-dot";
            dot.setAttribute("aria-label", `Go to slide ${idx + 1}`);
            dot.setAttribute("aria-current", String(idx === carouselState.currentIndex));
            dot.onclick = () => {
                renderCarouselSlide(idx);
                startCarouselAutoPlay();
            };
            dotsContainer.append(dot);
        });
    }
}

// ============================================================================
// CAROUSEL AUTO ROTATION
// ============================================================================
function startCarouselAutoPlay() {
    stopCarouselAutoPlay();
    if (carouselState.slides.length <= 1) return;

    carouselState.timer = setInterval(() => {
        renderCarouselSlide(carouselState.currentIndex + 1);
    }, 6000);
}

function stopCarouselAutoPlay() {
    if (carouselState.timer) {
        clearInterval(carouselState.timer);
        carouselState.timer = null;
    }
}

// ============================================================================
// UPDATE CAROUSEL WATCHLIST BUTTON
// ============================================================================
function updateCarouselWatchlistState() {
    const slide = carouselState.slides[carouselState.currentIndex];
    if (!slide || slide.type !== "movie") return;

    const button = document.querySelector("#spotlight-btn-secondary");
    if (!button) return;

    const movie = slide.data;
    const saved = state.watchlist.has(movie.id);
    button.textContent = saved ? "✓ IN MY LIST" : "+ MY LIST";
    button.classList.toggle("active", saved);
}

// ============================================================================
// CAROUSEL CONTROLS & HOVER
// ============================================================================
function setupCarouselControls() {
    const carouselPrev = document.querySelector("#carousel-prev");
    const carouselNext = document.querySelector("#carousel-next");

    if (carouselPrev) {
        carouselPrev.onclick = () => {
            renderCarouselSlide(carouselState.currentIndex - 1);
            startCarouselAutoPlay();
        };
    }
    if (carouselNext) {
        carouselNext.onclick = () => {
            renderCarouselSlide(carouselState.currentIndex + 1);
            startCarouselAutoPlay();
        };
    }
}

function setupCarouselHover() {
    const heroCarousel = document.querySelector(".hero-carousel");
    if (!heroCarousel) return;

    heroCarousel.addEventListener("mouseenter", () => stopCarouselAutoPlay());
    heroCarousel.addEventListener("mouseleave", () => startCarouselAutoPlay());
}

// ============================================================================
// PERSON PROFILES & MODAL
// ============================================================================
async function showPersonProfile(personId) {
    const modal = document.querySelector("#modal");
    const content = document.querySelector("#modal-content");
    const currentRequest = ++state.detailRequestId;

    if (!modal || !content) return;

    content.innerHTML = '<p style="padding:40px;text-align:center;">Loading profile…</p>';
    if (!modal.open) {
        modal.showModal();
    }

    try {
        const person = await api(`/api/person/${personId}`);
        if (currentRequest !== state.detailRequestId || !modal.open) return;

        const cast = (person.combined_credits?.cast || [])
            .filter((movie) => movie.poster_path)
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
            .slice(0, 8);

        const crew = (person.combined_credits?.crew || [])
            .filter((movie) => movie.poster_path && movie.department === "Directing")
            .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
            .slice(0, 4);

        const renderMiniCards = (items) =>
            items
                .map(
                    (movie) => `
                    <div class="mini-credit-card" onclick="detail(${Number(movie.id)})">
                        <img src="${image(movie.poster_path, "w185")}" alt="${esc(movie.title || movie.name || "Movie poster")}" loading="lazy">
                        <h4>${esc(movie.title || movie.name || "Untitled")}</h4>
                    </div>
                `
                )
                .join("");

        content.innerHTML = `
            <div style="padding:24px;">
                <div style="display:flex;gap:20px;align-items:flex-start;">
                    <img src="${image(person.profile_path, "w185")}" style="width:110px;height:165px;border-radius:8px;object-fit:cover;flex-shrink:0;" alt="${esc(person.name || "Cinema professional")}">
                    <div>
                        <h2 style="font-size:1.8rem;font-weight:800;margin-bottom:4px;">${esc(person.name || "Unknown")}</h2>
                        <p style="color:var(--brand-red);font-size:0.85rem;font-weight:600;margin-bottom:8px;">
                            ${esc(person.known_for_department || "Cinema Professional")} · Born: ${esc(person.birthday || "N/A")} (${esc(person.place_of_birth || "Unknown")})
                        </p>
                        <p style="color:var(--text-secondary);font-size:0.88rem;line-height:1.5;max-height:120px;overflow-y:auto;">
                            ${esc(person.biography || "Biography currently unavailable.")}
                        </p>
                    </div>
                </div>
                ${cast.length ? `<div class="profile-section-title">Acting Credits</div><div class="mini-credit-grid">${renderMiniCards(cast)}</div>` : ""}
                ${crew.length ? `<div class="profile-section-title">Directing Credits</div><div class="mini-credit-grid">${renderMiniCards(crew)}</div>` : ""}
            </div>
        `;
    } catch (error) {
        if (currentRequest === state.detailRequestId) {
            content.innerHTML = `<p style="padding:20px;">${esc(error.message)}</p>`;
        }
    }
}

// ============================================================================
// REVIEW HELPERS & FORM
// ============================================================================
function renderReviewStars(rating) {
    const numericRating = Math.max(0, Math.min(5, Number(rating) || 0));
    return "★".repeat(numericRating) + "☆".repeat(5 - numericRating);
}

function formatDateLabel(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric"
    });
}

function renderExistingReviews(reviews) {
    if (!Array.isArray(reviews) || reviews.length === 0) {
        return `
            <div class="reviews-empty">
                <p>No PowerFlicks reviews yet.</p>
                <p>Be the first to review this movie.</p>
            </div>
        `;
    }

    return reviews
        .map(
            (review) => `
            <article class="review-card">
                <div class="review-header">
                    <div class="review-author-info">
                        <strong class="review-author-name">${esc(review.author || "Anonymous")}</strong>
                        <span class="review-stars" aria-label="${Number(review.rating) || 0} out of 5 stars">
                            ${renderReviewStars(review.rating)}
                        </span>
                    </div>
                    ${review.created_at ? `<span class="review-date-badge">${esc(formatDateLabel(review.created_at))}</span>` : ""}
                </div>
                ${
                    review.comment || review.content
                        ? `<p class="review-comment">${esc(review.comment || review.content)}</p>`
                        : `<p class="review-comment muted-comment"><em>Rating only</em></p>`
                }
            </article>
        `
        )
        .join("");
}

async function refreshModalReviews(movieId) {
    const listContainer = document.querySelector("#modal-reviews-container");
    if (!listContainer) return;

    try {
        const data = await api(`/api/reviews/${movieId}`);
        const reviews = data.reviews || [];
        listContainer.innerHTML = renderExistingReviews(reviews);
    } catch (error) {
        console.error("Failed to refresh reviews", error);
    }
}

function setupReviewForm(movieId) {
    const form = document.querySelector("#powerflicks-review-form");
    const ratingInputs = document.querySelectorAll('input[name="review-rating"]');
    const ratingDisplay = document.querySelector("#review-rating-display");

    if (!form) return;

    ratingInputs.forEach((input) => {
        input.addEventListener("change", () => {
            const rating = Number(input.value);
            if (ratingDisplay) {
                ratingDisplay.textContent = `${rating}/5`;
            }
            updateStarVisualState(rating);
        });
    });

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const authorInput = document.querySelector("#review-author");
        const commentInput = document.querySelector("#review-comment");
        const submitButton = document.querySelector("#review-submit");

        const author = authorInput?.value.trim() || "";
        const comment = commentInput?.value.trim() || "";
        const selectedRating = document.querySelector('input[name="review-rating"]:checked');
        const rating = Number(selectedRating?.value) || 0;

        if (!author) {
            alert("Please enter your name.");
            authorInput?.focus();
            return;
        }
        if (!rating) {
            alert("Please select a rating.");
            return;
        }
        if (author.length > 50) {
            alert("Your name must be 50 characters or less.");
            return;
        }
        if (comment.length > 1000) {
            alert("Your review must be 1000 characters or less.");
            return;
        }

        const originalText = submitButton?.textContent || "SUBMIT REVIEW";
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = "SUBMITTING…";
        }

        try {
            await api(`/api/movies/${movieId}/reviews`, {
                method: "POST",
                body: JSON.stringify({ author, rating, comment })
            });

            if (authorInput) authorInput.value = "";
            if (commentInput) commentInput.value = "";
            ratingInputs.forEach((input) => (input.checked = false));
            if (ratingDisplay) ratingDisplay.textContent = "0/5";

            updateStarVisualState(0);

            // Refreshes only the reviews container inside the open modal
            await refreshModalReviews(movieId);
        } catch (error) {
            alert(error.message);
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalText;
            }
        }
    });
}

function updateStarVisualState(rating) {
    const labels = document.querySelectorAll(".review-star-label");
    labels.forEach((label) => {
        const input = label.querySelector("input");
        if (!input) return;
        const value = Number(input.value);
        label.classList.toggle("selected", value <= rating);
    });
}

// ============================================================================
// MOVIE MODAL DETAILS
// ============================================================================
async function detail(id) {
    const modal = document.querySelector("#modal");
    const content = document.querySelector("#modal-content");
    const currentRequest = ++state.detailRequestId;

    if (!modal || !content) return;

    if (modal.open) {
        modal.close();
    }

    content.innerHTML = `
        <div class="movie-detail-modal" style="min-height: 450px; display: flex; align-items: center; justify-content: center; background: #10141c;">
            <div style="text-align: center; color: var(--text-secondary);">
                <div style="display: inline-block; width: 36px; height: 36px; border: 3px solid rgba(229,9,20,0.3); border-radius: 50%; border-top-color: var(--brand-red); animation: spin 0.8s linear infinite;"></div>
                <p style="margin-top: 12px; font-weight: 600; font-size: 0.9rem;">Opening details…</p>
            </div>
        </div>
    `;

    modal.showModal();

    try {
        const movie = await api(`/api/movies/${id}`);
        if (currentRequest !== state.detailRequestId || !modal.open) return;

        const cast = (movie.credits?.cast || []).filter((person) => person.profile_path).slice(0, 8);
        const castMarkup = cast.length
            ? cast
                  .map(
                      (person) => `
                <button type="button" class="cast-card" onclick="showPersonProfile(${Number(person.id)})" aria-label="View ${esc(person.name || "cast member")}">
                    <img src="${image(person.profile_path, "w185")}" alt="${esc(person.name || "Cast member")}" loading="lazy">
                    <div class="cast-card-info">
                        <strong>${esc(person.name || "Unknown")}</strong>
                        <span>${esc(person.character || "")}</span>
                    </div>
                </button>
            `
                  )
                  .join("")
            : '<p class="empty">Cast information is currently unavailable.</p>';

        const reviews = movie.powerflicks_reviews || [];
        const reviewsMarkup = renderExistingReviews(reviews);
        const tmdbRating = Number(movie.vote_average || 0).toFixed(1);

        content.innerHTML = `
            <div class="movie-detail-modal">
                <section class="detail-hero" style="background-image: linear-gradient(0deg, #10141c 0%, rgba(16,20,28,0.65) 60%, rgba(16,20,28,0.2) 100%), url('${image(movie.backdrop_path, "original")}'); background-size:cover; background-position:center;">
                    <div class="detail-hero-content">
                        <p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:6px;">
                            ${movie.release_date?.slice(0, 4) || "TBA"} · ${movie.runtime || "—"} min · ★ ${tmdbRating}
                        </p>
                        <h2>${esc(movie.title || "Untitled")}</h2>
                    </div>
                </section>
                <section class="detail">
                    <p class="genres" style="color:var(--brand-red);font-weight:700;font-size:0.88rem;margin-bottom:12px;">
                        ${(movie.genres || []).map((genre) => esc(genre.name)).join(" · ") || "Genre unavailable"}
                    </p>
                    <p style="color:var(--text-secondary);margin-bottom:28px;line-height:1.6;font-size:0.92rem;">
                        ${esc(movie.overview || "No overview available.")}
                    </p>
                    <section class="movie-cast-section">
                        <div class="profile-section-title">Cast</div>
                        <div class="cast-grid">${castMarkup}</div>
                    </section>
                    <section class="powerflicks-reviews" style="margin-top:36px;">
                        <div class="profile-section-title">PowerFlicks Reviews</div>
                        <div id="modal-reviews-container" class="reviews-list">${reviewsMarkup}</div>
                    </section>
                    <section class="write-review-section" style="margin-top:36px;">
                        <div class="profile-section-title">Write a Review</div>
                        <form id="powerflicks-review-form" class="review-form">
                            <div class="review-form-field">
                                <label for="review-author">Your name</label>
                                <input id="review-author" name="author" type="text" maxlength="50" autocomplete="name" placeholder="Enter your name" required>
                            </div>
                            <div class="review-form-field">
                                <label>Your rating</label>
                                <div class="review-rating-selector" role="radiogroup" aria-label="Movie rating">
                                    ${[1, 2, 3, 4, 5]
                                        .map(
                                            (value) => `
                                        <label class="review-star-label" title="${value} star${value > 1 ? "s" : ""}">
                                            <input type="radio" name="review-rating" value="${value}">
                                            <span>★</span>
                                        </label>
                                    `
                                        )
                                        .join("")}
                                    <span id="review-rating-display" class="review-rating-display">0/5</span>
                                </div>
                            </div>
                            <div class="review-form-field">
                                <label for="review-comment">Your review (optional)</label>
                                <textarea id="review-comment" name="comment" maxlength="1000" rows="4" placeholder="What did you think about this movie? (optional)"></textarea>
                            </div>
                            <button id="review-submit" type="submit" class="btn btn-primary" style="align-self:flex-start;">SUBMIT REVIEW</button>
                        </form>
                    </section>
                </section>
            </div>
        `;

        setupReviewForm(movie.id);
    } catch (error) {
        if (currentRequest === state.detailRequestId) {
            content.innerHTML = `<p style="padding:20px; text-align:center;">${esc(error.message)}</p>`;
        }
    }
}

// ============================================================================
// DYNAMIC FUZZY MATCHING / "DID YOU MEAN?" ENGINE
// ============================================================================
function getLevenshteinDistance(a, b) {
    const matrix = Array.from({ length: a.length + 1 }, () =>
        Array(b.length + 1).fill(0)
    );

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[a.length][b.length];
}

function normalizeString(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findDynamicSuggestion(userQuery, movies) {
    if (!userQuery || userQuery.trim().length < 3 || !movies.length) return null;

    const rawQuery = userQuery.trim().toLowerCase();
    const cleanQuery = normalizeString(userQuery);

    let bestMatch = null;
    let lowestDistance = Infinity;

    for (const movie of movies) {
        const canonicalTitle = movie.title || movie.name;
        if (!canonicalTitle) continue;

        const cleanTitle = normalizeString(canonicalTitle);

        if (cleanQuery === cleanTitle && rawQuery !== canonicalTitle.toLowerCase()) {
            return canonicalTitle;
        }

        const maxAllowedDistance = Math.min(3, Math.floor(cleanQuery.length / 3));
        const distance = getLevenshteinDistance(cleanQuery, cleanTitle);

        if (distance > 0 && distance <= maxAllowedDistance && distance < lowestDistance) {
            lowestDistance = distance;
            bestMatch = canonicalTitle;
        }
    }

    return bestMatch;
}

function renderDidYouMeanBanner(suggestion) {
    let banner = document.querySelector("#did-you-mean-banner");

    if (!suggestion) {
        if (banner) banner.remove();
        return;
    }

    const moviesGrid = document.querySelector("#movies");
    if (!moviesGrid) return;

    if (!banner) {
        banner = document.createElement("div");
        banner.id = "did-you-mean-banner";
        banner.className = "did-you-mean-banner";
        moviesGrid.parentNode.insertBefore(banner, moviesGrid);
    }

    banner.innerHTML = `
        <span>Did you mean: </span>
        <button type="button" class="did-you-mean-link" onclick="applySuggestion('${esc(suggestion)}')">
            ${esc(suggestion)}
        </button>?
    `;
}

function applySuggestion(suggestedQuery) {
    const searchInput = document.querySelector("#search");
    if (searchInput) {
        searchInput.value = suggestedQuery;
        searchInput.dispatchEvent(new Event("input"));
    }
}

// ============================================================================
// LIVE SEARCH AUTOCOMPLETE DROPDOWN
// ============================================================================

function renderSearchSuggestions(results) {
    const dropdown = document.querySelector("#search-suggestions");
    if (!dropdown) return;

    if (!results || results.length === 0) {
        dropdown.hidden = true;
        dropdown.innerHTML = "";
        return;
    }

    const items = results.slice(0, 5).map((item) => {
        const title = esc(item.title || item.name || "Untitled");
        const poster = image(item.poster_path || item.profile_path, "w185");
        const type = item.media_type === "person" ? "Actor / Crew" : "Movie";
        const year = (item.release_date || item.first_air_date || "").slice(0, 4);
        const meta = year ? `${type} · ${year}` : type;

        return `
            <div class="suggestion-item" onclick="selectSuggestion(${Number(item.id)}, '${item.media_type}')">
                <img src="${poster}" class="suggestion-thumb" alt="${title}" loading="lazy">
                <div class="suggestion-info">
                    <span class="suggestion-title">${title}</span>
                    <span class="suggestion-meta">${meta}</span>
                </div>
            </div>
        `;
    }).join("");

    dropdown.innerHTML = items;
    dropdown.hidden = false;
}

function selectSuggestion(id, mediaType) {
    const dropdown = document.querySelector("#search-suggestions");
    if (dropdown) dropdown.hidden = true;

    if (mediaType === "person") {
        showPersonProfile(id);
    } else {
        detail(id);
    }
}

// Hide dropdown when clicking anywhere outside search box
document.addEventListener("click", (event) => {
    const searchBox = document.querySelector(".search-box");
    const dropdown = document.querySelector("#search-suggestions");
    if (searchBox && dropdown && !searchBox.contains(event.target)) {
        dropdown.hidden = true;
    }
});

// ============================================================================
// TMDB MULTI-SEARCH ENGINE WITH AUTO-CORRECT
// ============================================================================
let searchTimer;
const searchInput = document.querySelector("#search");

if (searchInput) {
    searchInput.oninput = (event) => {
        clearTimeout(searchTimer);
        const query = event.target.value.trim();
        const currentRequest = ++state.requestId;

        state.searchQuery = query;
        state.loading = false;
        state.view = query ? "search" : "category";

        searchTimer = setTimeout(async () => {
            if (currentRequest !== state.requestId) return;

            if (!query) {
                renderDidYouMeanBanner(null);
                renderSearchSuggestions([]); // Hide dropdown on clear
                load(state.list);
                return;
            }

            const heading = document.querySelector("#heading");
            if (heading) heading.textContent = `Results for “${query}”`;

            renderLoading("Searching catalog…");

            try {
                const data = await api(`/api/search/multi?q=${encodeURIComponent(query)}`);
                if (currentRequest !== state.requestId) return;

                const results = data.results || [];
                const people = results.filter((result) => result.media_type === "person");
                const movies = results.filter((result) => result.media_type === "movie" || result.media_type === "tv");

                const peopleSection = document.querySelector("#people-section");
                const peopleGrid = document.querySelector("#people-grid");

                if (peopleSection && peopleGrid) {
                    if (people.length > 0) {
                        peopleSection.style.display = "block";
                        peopleGrid.innerHTML = people
                            .slice(0, 6)
                            .map(
                                (person) => `
                                <div class="person-card" onclick="showPersonProfile(${Number(person.id)})">
                                    <img src="${image(person.profile_path, "w185")}" class="person-avatar" alt="${esc(person.name || "Cinema professional")}" loading="lazy">
                                    <div class="person-info">
                                        <h3>${esc(person.name || "Unknown")}</h3>
                                        <p>${esc(person.known_for_department || "Cinema Professional")}</p>
                                    </div>
                                </div>
                            `
                            )
                            .join("");
                    } else {
                        peopleSection.style.display = "none";
                        peopleGrid.replaceChildren();
                    }
                }

                // 1. POPULATE LIVE TYPEAHEAD DROPDOWN
                renderSearchSuggestions(results);

                // 2. CALCULATE DYNAMIC "DID YOU MEAN?" BANNER FOR GRID
                const suggestion = findDynamicSuggestion(query, movies);
                renderDidYouMeanBanner(suggestion);

                state.movies = movies;
                state.totalPages = 1;
                state.page = 1;

                render(movies, `${movies.length} titles found`);
                updatePagination();
            } catch (error) {
                if (currentRequest === state.requestId) {
                    render([], error.message, true, false);
                }
            }
        }, 250);
    };
}

// ============================================================================
// PAGINATION
// ============================================================================
function updatePagination() {
    const pagination = document.querySelector("#pagination");
    if (!pagination) return;

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
        if (selected) {
            button.setAttribute("aria-current", "page");
        }
        button.onclick = () => loadPage(page);
        pagination.append(button);
    };

    addButton("Previous", state.page - 1, state.page === 1);
    addButton(`${state.page} / ${state.totalPages}`, state.page, true, true);
    addButton("Next", state.page + 1, state.page === state.totalPages);
}

// ============================================================================
// EVENT BINDINGS
// ============================================================================
document.querySelectorAll("nav [data-list]").forEach((button) => {
    button.onclick = () => load(button.dataset.list);
});

const headerWatchlistBtn = document.querySelector("#watchlist-button");
if (headerWatchlistBtn) {
    headerWatchlistBtn.onclick = (event) => {
        event.preventDefault();
        showWatchlist();
    };
}

const closeModalBtn = document.querySelector(".close");
if (closeModalBtn) {
    closeModalBtn.onclick = () => {
        state.detailRequestId += 1;
        const modal = document.querySelector("#modal");
        if (modal?.open) {
            modal.close();
        }
    };
}

const modal = document.querySelector("#modal");
if (modal) {
    modal.addEventListener("close", () => {
        state.detailRequestId += 1;
    });
}

// ============================================================================
// INITIALIZE POWERFLICKS
// ============================================================================
async function initialize() {
    setupCarouselControls();
    setupCarouselHover();
    renderEditorialSection();
    await getWatchlist();
    await Promise.allSettled([load(), initHeroCarousel()]);
}

initialize();
